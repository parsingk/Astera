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
import type { CheckResult, GitHubGateKind, JobSourceRef } from '../core/orchestration/types'
import { t as translate, type Lang } from '../core/i18n'
import { openLifecycleTaskOf } from '../core/orchestration/lifecycleTask'
import type { GhFailed } from '../core/github/gh'
import { issueBodyHash, type GhIssue } from '../core/github/issue'
import { EVIDENCE_TRIES, GITHUB_CI_CHECK, type CiVerdict, type GitHubBinding, type GitHubCiCheck, type GitHubCiFailure, type GitHubLifecyclePolicy, type RunGitHubState } from '../core/github/lifecycle'
import { evaluateCi } from '../core/github/ciVerdict'
import { ciCheckResult } from '../core/github/ciResult'
import { ciFailureEvidence, type RawAnnotation } from '../core/github/evidence'
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
/** How often a lifecycle Run's source issue is looked at (§6). */
export const ISSUE_MS = 300_000
/** How long a head is read as new: right after a push it has no check for a few seconds (measured on the sandbox,
 *  2026-10-18), so a head with none is read again soon this long after it was first seen (the grace of design L23). */
export const NEW_HEAD_MS = 180_000
/** A pushed head with no check at all this long after its wait began asks a person (design §4.4 grace, L23). */
export const NO_CI_GRACE_MS = 180_000
const READS_AT_ONCE = 2
/** gh's words for a job log asked for while its Actions run still goes (measured on the sandbox, 2026-10-18). */
const STILL_RUNNING = /is still in progress; logs will be available when it is complete/i

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
  /** The source issue, read as the Job's source was (`readIssue`). */
  readIssue(cwd: string, number: number): Promise<{ ok: true; issue: GhIssue } | GhFailed>
  /** A failed Actions job's log (`gh run view --job <id> --log-failed`). */
  readJobLog(cwd: string, repo: GitHubRepo, jobId: number): Promise<{ ok: true; log: string } | GhFailed>
  /** A check run's annotations. */
  readAnnotations(cwd: string, repo: GitHubRepo, checkRunId: number): Promise<{ ok: true; annotations: RawAnnotation[] } | GhFailed>
  /** TaskValidation.settleHandedOff (G3b1): a lifecycle round settled with CI's verdict on the head it pushed. */
  settle?(a: { taskId: string; result: CheckResult; since?: string }): Promise<void>
  /** `lifecycle-gate` (G3b2): a GitHub question about the round `since` names, which keeps the round's wait. */
  openGitHubGate?(a: { taskId: string; since: string; kind: GitHubGateKind; question: string; options: string[] }): Promise<{ status: number; body: unknown }>
  /** Whether the PR's head is in the history of the head Astera pushed, read in the Run root (G3b2): an earlier head of
   *  Astera's own is GitHub catching up; one not in it is someone else's. Absent: a head that differs only waits. */
  ancestry?(cwd: string, head: string, sha: string): Promise<'ancestor' | 'not' | 'unknown'>
  /** The person's language, for the questions (G3b2). */
  lang?(): Lang
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
  source: JobSourceRef | undefined
  state: RunGitHubState | undefined
  /** The Run's lifecycle round handed over at github:ci (G3b1): CI on `sha`, once the Host pushed it, settles it.
   *  `waitingSince` (G3b2) is when the current wait began; `noCi` a person's choice to go on without CI. */
  round?: Round
}

interface Round {
  taskId: string
  since: string
  sha?: string
  waitingSince: string
  noCi?: true
}

/** Each wait is decided once: a person's "wait again" begins another (G3b2). */
const decisionOf = (round: Round): string => `${round.taskId}@${round.since}@${round.waitingSince}`
const short = (sha: string): string => sha.slice(0, 7)

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
  /** When each Run's source issue is next looked at. */
  const issueAt = new Map<string, number>()
  /** Each Run's PR head and when it was first seen. */
  const headSeen = new Map<string, { sha: string; at: number }>()
  /** Runs whose record answered 404: deleted, never read again. */
  const gone = new Set<string>()
  /** Each Run's lifecycle wait already settled or asked about (`decisionOf`): a verdict read again is not news. */
  const decided = new Map<string, string>()
  /** Each Run's pushed wait last seen (`since@sha@waitingSince`): a round pushed again, or waited on again, is read at
   *  once, not when the verdict before put the next read (G3b1 final review M1). */
  const roundSeen = new Map<string, string>()
  let holdUntil = 0
  let lowUntil = 0
  let timer: ReturnType<typeof setInterval> | null = null

  const jittered = (ms: number): number => Math.round(ms * (1 + (random() * 2 - 1) * JITTER))
  const spaced = (ms: number): number => jittered(now() < lowUntil ? Math.max(ms, LOW_BUDGET_MS) : ms)

  const targetsOf = (s: OrchState): Target[] => {
    const out: Target[] = []
    for (const run of s.runs) {
      if (gone.has(run.id) || run.worktree === undefined) continue
      const job = s.jobs.find((j) => j.id === run.jobId)
      const policy = job?.github
      if (!policy) continue
      const gs = run.githubState
      const open = openLifecycleTaskOf(s, run.id)
      const wait = open?.status === 'validating' ? open.ciWait : undefined
      const round: Round | undefined =
        open && wait
          ? { taskId: open.id, since: wait.since, sha: wait.sha, waitingSince: wait.waitingSince ?? wait.since, ...(wait.noCi ? { noCi: true as const } : {}) }
          : undefined
      // A closed PR is read no more, unless a round waits on it: a person is asked (G3b2)
      if (gs?.pr && gs.pr.state !== 'open' && round?.sha === undefined) continue
      if (!gs?.binding && now() - Date.parse(run.createdAt) > UNBOUND_MAX_AGE_MS) continue
      const worktree = d.worktreeOf(run.worktree)
      if (!worktree) continue
      // A round waiting to be pushed is bound by the Host's carrier (lifecycleCi), which may be making the PR right now:
      // binding it here first would log a PR Astera made as found
      if (!gs?.binding && round && round.sha === undefined) continue
      out.push({ runId: run.id, cwd: run.worktree, worktree, policy, source: job?.source, state: gs, ...(round ? { round } : {}) })
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

  /** A rate limit on any read holds every read: the budget is the person's, one for all of them (final review M4). */
  const noteRateLimit = (kind: string): void => {
    if (kind === 'rate-limit') holdUntil = now() + RATE_HOLD_MS
  }

  const failed = async (t: Target, f: { kind: string; message: string }, changed?: true): Promise<void> => {
    noteRateLimit(f.kind)
    const n = failures.get(t.runId) ?? 0
    failures.set(t.runId, n + 1)
    nextAt.set(t.runId, now() + jittered(ERROR_BACKOFF_MS[Math.min(n, ERROR_BACKOFF_MS.length - 1)]))
    // Once per kind: the Run carries the kind it last failed with, and the same failure again says nothing new.
    if (t.state?.lastReadError?.kind !== f.kind) d.log(`github watch: run ${t.runId}: ${f.message}`)
    // An issue change seen earlier in this pass is kept: the next look is ISSUE_MS away (final review M8).
    await record(t.runId, { lastReadError: { kind: f.kind }, ...(changed ? { sourceChanged: true as const } : {}) })
    // GitHub refusing this account's reads will not pass by waiting: a waiting round asks at once (design §6.2)
    if (f.kind === 'auth' && t.round?.sha !== undefined && decided.get(t.runId) !== decisionOf(t.round))
      await ask(t.runId, t.round, 'github-ci-outside', say('jobs.gate.github.q.auth', { reason: f.message }), ['wait', 'mark-failed'])
  }

  const say = (key: Parameters<typeof translate>[1], params: Record<string, string | number>): string => translate(d.lang?.() ?? 'en', key, params)

  /** A GitHub question about a waiting round, once per wait (G3b2). A refusal because the round moved (4xx) settles
   *  the wait; a Host that could not write the question (5xx, a throw) is asked again on the next read. */
  const ask = async (runId: string, round: Round, kind: GitHubGateKind, question: string, options: string[]): Promise<void> => {
    decided.set(runId, decisionOf(round))
    try {
      const r = await d.openGitHubGate?.({ taskId: round.taskId, since: round.since, kind, question, options })
      if (r && r.status >= 400) {
        d.log(`github watch: run ${runId}: the ${kind} question could not be opened: ${JSON.stringify(r.body)}`)
        if (r.status >= 500) decided.delete(runId)
      }
    } catch (e) {
      d.log(`github watch: run ${runId}: the ${kind} question could not be opened: ${message(e)}`)
      decided.delete(runId)
    }
  }

  /** A failed check's evidence (design §4.7), fetched once per commit and check: a record that already holds it for this
   *  commit and check is reused, so a failure read every PENDING_MS costs no log download (G2 Review Focus 4), unless it
   *  is incomplete and a read can still complete it (G2 final review I1). gh gives no job log while any job of the
   *  Actions run is still going (measured), so none is asked for then; a check run another app made has no job log, and
   *  a commit status nothing to read at all (final review M1). A read that fails leaves the evidence with what was read;
   *  a rate limit holds every read. */
  const evidenceFor = async (t: Target, repo: GitHubRepo, sha: string, check: GitHubCiCheck, checks: GitHubCiCheck[]): Promise<GitHubCiFailure> => {
    const runGoing = check.ciRunId !== undefined && checks.some((c) => c.ciRunId === check.ciRunId && c.status !== 'completed')
    const known = t.state?.ci?.sha === sha && t.state.ci.failure?.externalId === check.externalId ? t.state.ci.failure : undefined
    if (known && (!known.incomplete || (known.incomplete.reason === 'run-in-progress' ? runGoing : known.incomplete.tries >= EVIDENCE_TRIES)))
      return known
    if (check.jobId === undefined) return ciFailureEvidence({ check })
    const [log, annotations] = await Promise.all([
      check.ciRunId !== undefined && !runGoing ? d.readJobLog(t.cwd, repo, check.jobId) : undefined,
      d.readAnnotations(t.cwd, repo, check.jobId)
    ])
    let reason: 'run-in-progress' | 'read-failed' | undefined = runGoing ? 'run-in-progress' : undefined
    for (const r of [log, annotations])
      if (r && !r.ok) {
        noteRateLimit(r.kind)
        if (STILL_RUNNING.test(r.message)) reason ??= 'run-in-progress'
        else if (r.kind !== 'not-found') reason = 'read-failed'
        // A run still going is not a failed read, and is not logged as one.
        if (!STILL_RUNNING.test(r.message)) d.log(`github watch: run ${t.runId}: the evidence of ${check.name} could not be read: ${r.message}`)
      }
    const evidence = ciFailureEvidence({ check, ...(log?.ok ? { log: log.log } : {}), ...(annotations.ok ? { annotations: annotations.annotations } : {}) })
    if (!reason) return evidence
    const tries = (known?.incomplete?.tries ?? 0) + (reason === 'read-failed' ? 1 : 0)
    return { ...evidence, incomplete: { reason, tries } }
  }

  /** The required check names of a base's branch rules, or null when they could not be read: a pass then waits
   *  (evaluateCi). Only an answer is kept for RULES_TTL_MS, a repository with no rules (404) among them; a failure is
   *  asked again on the next read (final review I2). */
  const ruleNamesFor = async (t: Target, repo: GitHubRepo, base: string): Promise<string[] | null> => {
    const key = `${repo.host}/${repoSlug(repo)}#${base}`
    const cached = rules.get(key)
    if (cached && cached.until > now()) return cached.names
    const r = await d.ruleCheckNames(t.cwd, repo, base)
    if (!r.ok && r.kind !== 'not-found') {
      noteRateLimit(r.kind)
      d.log(`github watch: the branch rules of ${repoSlug(repo)} ${base} could not be read: ${r.message}`)
      return null
    }
    const names = r.ok ? r.names : []
    rules.set(key, { names, until: now() + RULES_TTL_MS })
    return names
  }

  /** Whether the source issue's body changed since the Job was made (§6), looked at every ISSUE_MS from the first time
   *  the Run is seen. Undefined when it is not time, or nothing changed, or the issue could not be read. */
  const sourceChange = async (t: Target): Promise<true | undefined> => {
    const src = t.source
    if (src?.id !== 'github' || src.capturedBodyHash === undefined || t.state?.sourceChanged) return undefined
    const at = issueAt.get(t.runId)
    if (at === undefined) {
      issueAt.set(t.runId, now() + jittered(ISSUE_MS))
      return undefined
    }
    if (at > now()) return undefined
    issueAt.set(t.runId, now() + jittered(ISSUE_MS))
    const r = await d.readIssue(t.cwd, Number(src.itemId))
    if (!r.ok) {
      noteRateLimit(r.kind)
      d.log(`github watch: run ${t.runId}: the source issue could not be read: ${r.message}`)
      return undefined
    }
    if (r.issue.updatedAt === src.capturedUpdatedAt) return undefined
    return issueBodyHash(r.issue.body) !== src.capturedBodyHash ? true : undefined
  }

  const readOne = async (t: Target): Promise<void> => {
    const repo = await repoFor(t.cwd)
    if (repo === null) return failed(t, { kind: 'no-github-origin', message: "this Run's folder has no GitHub origin" })
    const changed = await sourceChange(t)
    let binding: GitHubBinding | undefined = t.state?.binding
    const patch: RunGitHubPatch = {}
    if (!binding) {
      const base = await d.baseBranch(t.worktree.repoPath, t.worktree.baseRef)
      const found = await d.findOpenPrs(t.cwd, repo, t.worktree.branch, base)
      if (!found.ok) return failed(t, found, changed)
      if (found.prs.length !== 1) {
        failures.delete(t.runId)
        nextAt.set(t.runId, now() + spaced(UNBOUND_MS))
        await record(t.runId, {
          prCandidates: found.prs.length > 1 ? found.prs.map((p) => p.number) : null,
          lastReadError: null,
          ...(changed ? { sourceChanged: true as const } : {})
        })
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
    if (!r.ok) return failed(t, r, changed)
    const read = r.read
    if (read.rateLimit && read.rateLimit.remaining < read.rateLimit.limit * LOW_BUDGET_SHARE)
      lowUntil = Date.parse(read.rateLimit.resetAt) || now() + LOW_BUDGET_MS
    const names = t.policy.ci.mode === 'required' ? await ruleNamesFor(t, repo, read.baseBranch) : []
    const ev = evaluateCi(read, t.policy.ci, names)
    // Evidence only for the head: a verdict of another commit is not news (final review I1), and its log would be stale.
    const failure =
      ev.verdict === 'failed' && ev.failing && read.commitSha === read.headSha ? await evidenceFor(t, repo, read.commitSha, ev.failing, read.checks) : undefined
    patch.read = {
      headSha: read.headSha,
      pr: {
        state: read.state,
        isDraft: read.isDraft,
        baseBranch: read.baseBranch,
        ...(read.mergeStateStatus ? { mergeStateStatus: read.mergeStateStatus } : {}),
        ...(read.reviewDecision ? { reviewDecision: read.reviewDecision } : {})
      },
      ci: {
        sha: read.commitSha,
        basis: ev.basis,
        verdict: ev.verdict,
        ...(ev.failing ? { failing: ev.failing.name } : {}),
        ...(ev.failing?.detailsUrl ? { failingUrl: ev.failing.detailsUrl } : {}),
        ...(failure ? { failure } : {}),
        checks: read.checks
      }
    }
    patch.lastReadError = null
    if (changed) patch.sourceChanged = true
    failures.delete(t.runId)
    // Checks of a commit that is not the head yet are read again soon, however settled they look (final review I1), and so
    // is a new head with no check yet: its checks are seconds away. So is incomplete evidence a read can still complete:
    // a job log comes the moment its run ends (G2 final review I1).
    const seen = headSeen.get(t.runId)
    if (seen?.sha !== read.headSha) headSeen.set(t.runId, { sha: read.headSha, at: now() })
    const newHead = now() - (headSeen.get(t.runId)?.at ?? now()) < NEW_HEAD_MS
    const completable = failure?.incomplete !== undefined && (failure.incomplete.reason === 'run-in-progress' || failure.incomplete.tries < EVIDENCE_TRIES)
    const round = t.round
    // A waiting round with no check yet is read soon: its grace runs out in minutes (G3b2)
    const awaited = round?.sha !== undefined && read.checks.length === 0
    const soon = ev.verdict === 'pending' || read.commitSha !== read.headSha || (ev.verdict === 'none' && newHead) || completable || awaited
    nextAt.set(t.runId, now() + spaced(soon ? PENDING_MS : SETTLED_MS))
    await record(t.runId, patch)
    if (round?.sha === undefined || decided.get(t.runId) === decisionOf(round)) return
    const sha = round.sha
    const pr = binding.number
    // design §4.3: the bound PR closed or merged under a waiting round asks a person (G3b2)
    if (read.state !== 'open')
      return read.state === 'merged'
        ? ask(t.runId, round, 'github-pr-closed', say('jobs.gate.github.q.merged', { pr }), ['mark-failed'])
        : ask(t.runId, round, 'github-pr-closed', say('jobs.gate.github.q.closed', { pr }), ['wait', 'mark-failed'])
    // design §4.4 S2: a head that is not the pushed one is GitHub catching up when it is Astera's own earlier head, and
    // someone else's when it is not in Astera's history
    if (read.headSha !== sha) {
      if ((await d.ancestry?.(t.cwd, read.headSha, sha)) !== 'not') return
      await record(t.runId, { externalHead: { sha: read.headSha } })
      return ask(t.runId, round, 'github-external-head', say('jobs.gate.github.q.externalHead', { branch: binding.headBranch, sha: short(read.headSha) }), ['continue', 'mark-failed'])
    }
    // CI on the head the Host pushed settles the round, and only that head (design §4.4)
    if (read.commitSha !== sha) return
    if (read.checks.length === 0) {
      if (now() - Date.parse(round.waitingSince) < NO_CI_GRACE_MS) return
      return ask(t.runId, round, 'github-no-ci', say('jobs.gate.github.q.noCi', { sha: short(sha), minutes: NO_CI_GRACE_MS / 60_000, pr }), ['wait', 'no-ci', 'mark-failed'])
    }
    await settleRound(t.runId, round, ev.verdict, failure, binding)
  }

  /** A round's verdict, once (G3b1, design §4.6): a pass or a code failure settles it through settleHandedOff; a cause
   *  outside the code asks a person (G3b2's Gate, G4's rerun); a failure whose evidence a later read can still complete
   *  waits for it (G2 final review I1). */
  const settleRound = async (runId: string, round: Round, verdict: CiVerdict, failure: GitHubCiFailure | undefined, binding: GitHubBinding): Promise<void> => {
    const key = decisionOf(round)
    if (decided.get(runId) === key) return
    if (verdict === 'failed' && failure?.incomplete && !(failure.incomplete.reason === 'read-failed' && failure.incomplete.tries >= EVIDENCE_TRIES)) return
    const result = ciCheckResult({ verdict, ...(failure ? { failure } : {}), prUrl: binding.url, since: round.since, now: new Date(now()).toISOString() })
    if (result) {
      decided.set(runId, key)
      await d.settle?.({ taskId: round.taskId, result, since: round.since })
      return
    }
    if (verdict !== 'failed' || !failure) return
    await ask(runId, round, 'github-ci-outside', say('jobs.gate.github.q.outside', { class: failure.class, summary: failure.summary }), ['wait', 'mark-failed'])
  }

  /** What a waiting round decides without a read (G3b2): a person's choice to go on without CI settles it passed, and a
   *  wait past the Job's cap asks, however the reads go (design §4.4, §6.2). */
  const decideUnread = async (t: Target): Promise<void> => {
    const round = t.round
    if (round?.sha === undefined || decided.get(t.runId) === decisionOf(round)) return
    if (round.noCi) {
      decided.set(t.runId, decisionOf(round))
      await record(t.runId, { noCi: { sha: round.sha } })
      const at = new Date(now()).toISOString()
      const result: CheckResult = {
        configId: GITHUB_CI_CHECK,
        name: 'GitHub CI',
        status: 'passed',
        summary: `No CI ran on ${short(round.sha)}; a person chose to go on without CI.`,
        startedAt: round.since,
        endedAt: at,
        ...(t.state?.binding ? { externalUrl: t.state.binding.url } : {})
      }
      // A settle that could not be written is tried again on the next read
      await d.settle?.({ taskId: round.taskId, result, since: round.since }).catch((e: unknown) => {
        d.log(`github watch: run ${t.runId}: going on without CI could not be recorded: ${message(e)}`)
        decided.delete(t.runId)
      })
      return
    }
    const minutes = t.policy.ciWaitMinutes
    if (now() - Date.parse(round.waitingSince) < minutes * 60_000) return
    await ask(t.runId, round, 'github-ci-cap', say('jobs.gate.github.q.cap', { sha: short(round.sha), minutes, pr: t.state?.binding?.number ?? 0 }), ['wait', 'mark-failed'])
  }

  /** Drops what is kept for Runs and folders no longer watched, so a Host that lives for weeks (`runtime serve`) does not
   *  grow with every Run it ever watched; a Run that comes back starts afresh (final review M5). Runs being read keep
   *  theirs until the read settles. */
  const forgetOthers = (targets: Target[]): void => {
    const runIds = new Set(targets.map((t) => t.runId))
    const cwds = new Set(targets.map((t) => t.cwd))
    for (const map of [nextAt, failures, issueAt, headSeen, decided, roundSeen]) for (const id of map.keys()) if (!runIds.has(id) && !inFlight.has(id)) map.delete(id)
    for (const cwd of repos.keys()) if (!cwds.has(cwd)) repos.delete(cwd)
  }

  const tick = async (): Promise<void> => {
    if (latest === null || now() < holdUntil) return
    const targets = targetsOf(latest)
    forgetOthers(targets)
    for (const t of targets) {
      const key = t.round?.sha === undefined ? undefined : `${t.round.since}@${t.round.sha}@${t.round.waitingSince}`
      // A read in flight sets its own next read when it ends: the round is taken up on the tick after
      if (key === undefined || inFlight.has(t.runId) || roundSeen.get(t.runId) === key) continue
      roundSeen.set(t.runId, key)
      nextAt.delete(t.runId)
    }
    const due = targets.filter((t) => !inFlight.has(t.runId) && (nextAt.get(t.runId) ?? 0) <= now())
    const work = due.slice(0, Math.max(0, READS_AT_ONCE - inFlight.size))
    await Promise.all(
      work.map(async (t) => {
        inFlight.add(t.runId)
        try {
          // What the round decides without a read comes first, at the read's own pace, so a question that could not be
          // written is asked again no faster than the Run is read
          await decideUnread(t)
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
