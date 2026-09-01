import type { WorktreeInfo } from '../core/types'
import type { GhProbe, RepoPrSnapshot } from '../core/github/types'
import { classifyGhFailure, gh, probeGh, type GhResult } from '../core/github/gh'
import { PR_LIST_ARGS, parsePrList } from '../core/github/prs'
import { initialPacing, isBroken, noteCall, pickDue, tripBreaker, type PacingState } from '../core/github/pacing'

/** The timer just nudges tick(); tick() gates itself, so a running timer with nothing to do
 *  costs nothing. 5s halves the worst-case wait behind the 10s spacing. */
const TICK_MS = 5_000

export interface GithubPrsDeps {
  registry: { list(): WorktreeInfo[] }
  settings: { getGithubPolling(): boolean }
  send: (channel: 'github:prs-updated' | 'github:status', payload: unknown) => void
  /** Injectable for tests; production uses the real gh with cwd = the repository. */
  fetchPrList?: (repoPath: string) => Promise<GhResult>
  probe?: () => Promise<GhProbe>
  now?: () => number
}

export interface GithubPrs {
  start(): Promise<void>
  status(): GhProbe
  recheck(): Promise<GhProbe>
  prs(): Record<string, RepoPrSnapshot>
  refresh(opts?: { force?: boolean }): Promise<void>
  subscribe(): void
  unsubscribe(): void
  stop(): void
  tick(): Promise<void>
}

/** Per-repository PR cache with paced refresh (design doc §4). Owns nothing about display —
 *  it fetches, classifies failures, and pushes snapshots; the renderer joins them onto rows. */
export function createGithubPrs(deps: GithubPrsDeps): GithubPrs {
  const fetchPrList = deps.fetchPrList ?? ((repoPath: string) => gh(PR_LIST_ARGS, { cwd: repoPath }))
  const probe = deps.probe ?? (() => probeGh())
  const now = deps.now ?? (() => Date.now())

  let current: GhProbe = { kind: 'error' }
  let pacing: PacingState = initialPacing()
  const cache: Record<string, RepoPrSnapshot> = {}
  const forcePending = new Set<string>()
  // Repos where `gh pr list` answered "no git remotes found" — that verdict cannot change
  // without a config change, so remembering it stops a dead repo from costing a spawn every
  // minute. Cleared only when the repo drops out of the registry (finding 4).
  const noRemoteRepos = new Set<string>()
  let subscribers = 0
  let timer: NodeJS.Timeout | null = null
  let inFlight = false

  const repoPaths = (): string[] => [...new Set(deps.registry.list().map((w) => w.repoPath))]

  const sendStatus = (): void => deps.send('github:status', current)
  const sendSnapshot = (repoRoot: string): void =>
    deps.send('github:prs-updated', { repoRoot, snapshot: cache[repoRoot] })

  const ensureTimer = (): void => {
    if (subscribers > 0 && timer === null) timer = setInterval(() => void tick(), TICK_MS)
  }
  const dropTimer = (): void => {
    if (subscribers === 0 && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  const markAllStale = (): void => {
    for (const repoRoot of Object.keys(cache)) {
      if (cache[repoRoot].stale) continue
      cache[repoRoot] = { ...cache[repoRoot], stale: true }
      sendSnapshot(repoRoot)
    }
  }

  async function tick(): Promise<void> {
    if (inFlight || current.kind !== 'connected') return
    const t = now()
    if (isBroken(pacing, t)) return
    const repos = repoPaths()
    noRemoteRepos.forEach((r) => {
      if (!repos.includes(r)) noRemoteRepos.delete(r) // a removed worktree's repo must not pin the memo forever
    })
    forcePending.forEach((r) => {
      // a removed worktree's repo must not pin the queue; a memoized no-remote repo can never
      // succeed, so a forced refresh must not resurrect it either
      if (!repos.includes(r) || noRemoteRepos.has(r)) forcePending.delete(r)
    })
    const activeRepos = repos.filter((r) => !noRemoteRepos.has(r))
    // Forced repos are the manual path and are served even while polling is off or nobody
    // subscribes; the background sweep needs polling on and a visible panel.
    const forced = activeRepos.filter((r) => forcePending.has(r))
    const background = subscribers > 0 && deps.settings.getGithubPolling()
    const candidates = forced.length > 0 ? forced : background ? activeRepos : []
    const repo = pickDue(pacing, candidates, t, forced.length > 0)
    if (repo === null) return
    pacing = noteCall(pacing, repo, t) // failures count for spacing too
    inFlight = true
    try {
      const r = await fetchPrList(repo)
      const byBranch = r.ok ? parsePrList(r.stdout) : null
      if (r.ok && byBranch !== null) {
        forcePending.delete(repo)
        cache[repo] = { byBranch, fetchedAt: new Date(now()).toISOString(), stale: false }
        sendSnapshot(repo)
        return
      }
      forcePending.delete(repo) // no retry loops — the next interval is the retry
      if (r.spawnError === 'ENOENT') {
        // A missing cwd and a missing gh binary raise the same ENOENT, so this code alone
        // cannot tell "gh vanished" from "the worktree's repo folder was deleted" — only the
        // probe (a fresh `gh auth status`) is the authority on which one it is (finding 4).
        current = await probe()
        sendStatus()
        return
      }
      const kind = classifyGhFailure(r.stderr, r.spawnError)
      if (kind === 'rate-limit') {
        pacing = tripBreaker(pacing, now())
        markAllStale()
      } else if (kind === 'auth') {
        current = { kind: 'not-authenticated' }
        forcePending.clear()
        sendStatus()
      } else if (kind === 'no-remote') {
        noRemoteRepos.add(repo)
      } else if (kind === 'truncated') {
        // A maxBuffer overflow is a structural condition, not a transient blip — it must not
        // blend into the silent 'other' retry below (finding 1).
        console.error(
          `[github] gh pr list for ${repo} produced more output than gh() could buffer; the response was truncated. PR badges for this repo will not update until the payload shrinks.`
        )
      }
      // network / not-found / other: keep the last snapshot silently; the interval retries
    } finally {
      inFlight = false
    }
  }

  return {
    async start(): Promise<void> {
      current = await probe()
      sendStatus()
    },
    status: () => current,
    async recheck(): Promise<GhProbe> {
      current = await probe()
      sendStatus()
      return current
    },
    // Gated on connection, not just filtered from display: while disconnected nothing will ever
    // refresh these snapshots (tick() returns early), so handing them back unconditionally would
    // let a stale, unlabeled PR state come straight back on the next mount (finding 2). The cache
    // itself is kept untouched so a later reconnect can repopulate it.
    prs: () => (current.kind === 'connected' ? { ...cache } : {}),
    async refresh(opts?: { force?: boolean }): Promise<void> {
      // PATH is captured once at launch (applyLoginPath, before the window opens) — a mid-session
      // gh install can never be found, so re-probing here on every ⟳ and panel expand is provably
      // futile (minor: refresh() re-probing when not-installed).
      if (current.kind === 'not-installed') return
      // Heals "logged in after app start" without a settings visit — the probe is local and cheap
      if (current.kind !== 'connected') {
        const probed = await this.recheck()
        if (probed.kind !== 'connected') return
      }
      if (opts?.force) for (const r of repoPaths()) forcePending.add(r)
      await tick()
    },
    subscribe(): void {
      subscribers += 1
      ensureTimer()
    },
    unsubscribe(): void {
      subscribers = Math.max(0, subscribers - 1)
      dropTimer()
    },
    stop(): void {
      subscribers = 0
      dropTimer()
    },
    tick
  }
}
