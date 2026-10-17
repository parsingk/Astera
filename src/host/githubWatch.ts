// The Host's watch over the pull requests of GitHub lifecycle Runs (design 2026-10-17 §6.2), read-only in G1: it binds
// the one open PR of a Run's branch, reads that PR's head and checks, judges CI under the Job's policy, and records
// what it read through `runs-github-record`. Nothing here writes to GitHub, and nothing here throws.
//
// One tick every TICK_MS reads the Runs that are due. Reads are spaced by what they found: a CI still running is read
// again in PENDING_MS, a settled one in SETTLED_MS, a Run with no PR yet in UNBOUND_MS, each jittered by ±JITTER so
// Runs do not read in step. A rate-limit answer holds every read for RATE_HOLD_MS; a GraphQL budget under
// LOW_BUDGET_SHARE of its limit stretches every spacing to LOW_BUDGET_MS until it resets. A failed read backs off
// along ERROR_BACKOFF_MS. The timer is unref'd: the watch never keeps the Host up (design L15).
import type { OrchState } from '../core/orchestration/state'
import type { GhFailed } from '../core/github/gh'
import type { GitHubBinding, GitHubLifecyclePolicy, RunGitHubState } from '../core/github/lifecycle'
import { evaluateCi } from '../core/github/ciVerdict'
import type { OpenPr } from '../core/github/prBinding'
import type { PrStateRead } from '../core/github/prState'
import { parseGitHubRemote, repoSlug, type GitHubRepo } from '../core/github/remote'
import type { RunGitHubPatch } from '../core/github/runState'

export const TICK_MS = 5_000
export const PENDING_MS = 20_000
export const SETTLED_MS = 120_000
export const UNBOUND_MS = 120_000
/** A Run with no PR is looked for this long after it was made, then left alone (G3 binds the PRs it opens itself). */
export const UNBOUND_MAX_AGE_MS = 3 * 24 * 60 * 60_000
export const RATE_HOLD_MS = 300_000
export const LOW_BUDGET_MS = 120_000
export const LOW_BUDGET_SHARE = 0.1
export const ERROR_BACKOFF_MS = [20_000, 40_000, 80_000, 120_000] as const
/** How long the branch rules of one base are trusted before they are read again. */
export const RULES_TTL_MS = 600_000
export const JITTER = 0.2
const READS_AT_ONCE = 2

export interface WatchedWorktree {
  repoPath: string
  branch: string
  baseRef: string
}

export interface GithubWatchDeps {
  /** `runs-github-record` as the Host itself. */
  record(args: { runId: string; patch: RunGitHubPatch }): Promise<{ status: number; body: unknown }>
  worktreeOf(path: string): WatchedWorktree | null
  /** The branch a stored baseRef names on GitHub (`normalizeBaseForGh`). */
  baseBranch(repoPath: string, baseRef: string): Promise<string>
  originOf(cwd: string): Promise<string | null>
  findOpenPrs(cwd: string, repo: GitHubRepo, branch: string, base: string): Promise<{ ok: true; prs: OpenPr[] } | GhFailed>
  readPrState(cwd: string, repo: GitHubRepo, number: number): Promise<{ ok: true; read: PrStateRead } | GhFailed>
  ruleCheckNames(cwd: string, repo: GitHubRepo, branch: string): Promise<{ ok: true; names: string[] } | GhFailed>
  log(m: string): void
  /** Epoch milliseconds. */
  now?(): number
  /** [0, 1), for the jitter. */
  random?(): number
}

export interface GithubWatch {
  onState(s: OrchState): void
  /** One pass: reads every due Run, at most READS_AT_ONCE at a time, and settles when they are recorded. */
  tick(): Promise<void>
  start(): void
  stop(): void
}

interface Target {
  runId: string
  cwd: string
  worktree: WatchedWorktree
  policy: GitHubLifecyclePolicy
  state: RunGitHubState | undefined
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createGithubWatch(d: GithubWatchDeps): GithubWatch {
  const now = d.now ?? Date.now
  const random = d.random ?? Math.random
  let latest: OrchState | null = null
  const nextAt = new Map<string, number>()
  const failures = new Map<string, number>()
  const inFlight = new Set<string>()
  /** A folder's repository, once its origin named one. A folder with none is asked again next time. */
  const repos = new Map<string, GitHubRepo>()
  const rules = new Map<string, { names: string[]; until: number }>()
  /** Runs whose record answered 404: deleted, never read again. */
  const gone = new Set<string>()
  let holdUntil = 0
  let lowUntil = 0
  let timer: ReturnType<typeof setInterval> | null = null

  const jittered = (ms: number): number => Math.round(ms * (1 + (random() * 2 - 1) * JITTER))
  const spaced = (ms: number): number => jittered(now() < lowUntil ? Math.max(ms, LOW_BUDGET_MS) : ms)

  const targetsOf = (s: OrchState): Target[] => {
    const out: Target[] = []
    for (const run of s.runs) {
      if (gone.has(run.id) || run.worktree === undefined) continue
      const policy = s.jobs.find((j) => j.id === run.jobId)?.github
      if (!policy) continue
      const gs = run.githubState
      if (gs?.pr && gs.pr.state !== 'open') continue
      if (!gs?.binding && now() - Date.parse(run.createdAt) > UNBOUND_MAX_AGE_MS) continue
      const worktree = d.worktreeOf(run.worktree)
      if (!worktree) continue
      out.push({ runId: run.id, cwd: run.worktree, worktree, policy, state: gs })
    }
    return out
  }

  const record = async (runId: string, patch: RunGitHubPatch): Promise<void> => {
    try {
      const r = await d.record({ runId, patch })
      if (r.status === 404) gone.add(runId)
      else if (r.status >= 300) d.log(`github watch: recording run ${runId} answered ${r.status}: ${JSON.stringify(r.body)}`)
    } catch (e) {
      d.log(`github watch: recording run ${runId} failed: ${message(e)}`)
    }
  }

  const repoFor = async (cwd: string): Promise<GitHubRepo | null> => {
    const known = repos.get(cwd)
    if (known) return known
    const origin = await d.originOf(cwd)
    const repo = origin === null ? null : parseGitHubRemote(origin)
    if (repo) repos.set(cwd, repo)
    return repo
  }

  const failed = async (t: Target, f: { kind: string; message: string }): Promise<void> => {
    if (f.kind === 'rate-limit') holdUntil = now() + RATE_HOLD_MS
    const n = failures.get(t.runId) ?? 0
    failures.set(t.runId, n + 1)
    nextAt.set(t.runId, now() + jittered(ERROR_BACKOFF_MS[Math.min(n, ERROR_BACKOFF_MS.length - 1)]))
    // Once per kind: the Run carries the kind it last failed with, and the same failure again says nothing new.
    if (t.state?.lastReadError?.kind !== f.kind) d.log(`github watch: run ${t.runId}: ${f.message}`)
    await record(t.runId, { lastReadError: { kind: f.kind } })
  }

  const ruleNamesFor = async (t: Target, repo: GitHubRepo, base: string): Promise<string[]> => {
    const key = `${repo.host}/${repoSlug(repo)}#${base}`
    const cached = rules.get(key)
    if (cached && cached.until > now()) return cached.names
    const r = await d.ruleCheckNames(t.cwd, repo, base)
    // A rules read that fails does not stop the watch: the suites and isRequired still guard a pass (design S1).
    if (!r.ok) d.log(`github watch: the branch rules of ${repoSlug(repo)} ${base} could not be read: ${r.message}`)
    const names = r.ok ? r.names : []
    rules.set(key, { names, until: now() + RULES_TTL_MS })
    return names
  }

  const readOne = async (t: Target): Promise<void> => {
    const repo = await repoFor(t.cwd)
    if (repo === null) return failed(t, { kind: 'no-github-origin', message: "this Run's folder has no GitHub origin" })
    let binding: GitHubBinding | undefined = t.state?.binding
    const patch: RunGitHubPatch = {}
    if (!binding) {
      const base = await d.baseBranch(t.worktree.repoPath, t.worktree.baseRef)
      const found = await d.findOpenPrs(t.cwd, repo, t.worktree.branch, base)
      if (!found.ok) return failed(t, found)
      if (found.prs.length !== 1) {
        failures.delete(t.runId)
        nextAt.set(t.runId, now() + spaced(UNBOUND_MS))
        await record(t.runId, { prCandidates: found.prs.length > 1 ? found.prs.map((p) => p.number) : null, lastReadError: null })
        return
      }
      binding = {
        repository: repoSlug(repo),
        ...(repo.host !== 'github.com' ? { host: repo.host } : {}),
        number: found.prs[0].number,
        url: found.prs[0].url,
        baseBranch: base,
        headBranch: t.worktree.branch,
        createdByAstera: false,
        boundAt: new Date(now()).toISOString()
      }
      patch.binding = binding
    }
    const r = await d.readPrState(t.cwd, repo, binding.number)
    if (!r.ok) return failed(t, r)
    const read = r.read
    if (read.rateLimit && read.rateLimit.remaining < read.rateLimit.limit * LOW_BUDGET_SHARE)
      lowUntil = Date.parse(read.rateLimit.resetAt) || now() + LOW_BUDGET_MS
    const names = t.policy.ci.mode === 'required' ? await ruleNamesFor(t, repo, read.baseBranch) : []
    const ev = evaluateCi(read, t.policy.ci, names)
    patch.read = {
      headSha: read.headSha,
      pr: {
        state: read.state,
        isDraft: read.isDraft,
        baseBranch: read.baseBranch,
        ...(read.mergeStateStatus ? { mergeStateStatus: read.mergeStateStatus } : {}),
        ...(read.reviewDecision ? { reviewDecision: read.reviewDecision } : {})
      },
      ci: { sha: read.commitSha, basis: ev.basis, verdict: ev.verdict, ...(ev.failing ? { failing: ev.failing.name } : {}), checks: read.checks }
    }
    patch.lastReadError = null
    failures.delete(t.runId)
    nextAt.set(t.runId, now() + spaced(ev.verdict === 'pending' ? PENDING_MS : SETTLED_MS))
    await record(t.runId, patch)
  }

  const tick = async (): Promise<void> => {
    if (latest === null || now() < holdUntil) return
    const due = targetsOf(latest).filter((t) => !inFlight.has(t.runId) && (nextAt.get(t.runId) ?? 0) <= now())
    const work = due.slice(0, Math.max(0, READS_AT_ONCE - inFlight.size))
    await Promise.all(
      work.map(async (t) => {
        inFlight.add(t.runId)
        try {
          await readOne(t)
        } catch (e) {
          d.log(`github watch: run ${t.runId}: ${message(e)}`)
          nextAt.set(t.runId, now() + jittered(SETTLED_MS))
        } finally {
          inFlight.delete(t.runId)
        }
      })
    )
  }

  return {
    onState: (s) => {
      latest = s
    },
    tick,
    start: () => {
      if (timer) return
      timer = setInterval(() => void tick(), TICK_MS)
      timer.unref?.()
    },
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
