/** Pacing rules for gh calls (design doc §4). Pure — the coordinator owns the clock and the
 *  timers; this module only answers "may a call happen now, and for which repo". */

export const REPO_INTERVAL_MS = 60_000
export const MIN_SPACING_MS = 10_000
export const BREAKER_HOLD_MS = 300_000

export interface PacingState {
  lastFetchByRepo: Record<string, number>
  lastCallAt: number // any gh pr list call, success or failure — spacing counts them all
  breakerUntil: number // 0 = closed
}

export function initialPacing(): PacingState {
  return { lastFetchByRepo: {}, lastCallAt: 0, breakerUntil: 0 }
}

export function isBroken(state: PacingState, now: number): boolean {
  return now < state.breakerUntil
}

/** The next repo allowed to fetch at `now`, or null. Force skips the per-repo interval — it is
 *  the manual-refresh path — but never the spacing or the breaker. Among due repos the
 *  longest-unfetched wins, so a starved repo cannot be shadowed by an always-due neighbour. */
export function pickDue(state: PacingState, repos: string[], now: number, force: boolean): string | null {
  if (isBroken(state, now)) return null
  if (now - state.lastCallAt < MIN_SPACING_MS) return null
  const due = repos.filter(
    (r) => force || now - (state.lastFetchByRepo[r] ?? 0) >= REPO_INTERVAL_MS
  )
  if (due.length === 0) return null
  return due.reduce((oldest, r) =>
    (state.lastFetchByRepo[r] ?? 0) < (state.lastFetchByRepo[oldest] ?? 0) ? r : oldest
  )
}

export function noteCall(state: PacingState, repo: string, now: number): PacingState {
  return {
    ...state,
    lastFetchByRepo: { ...state.lastFetchByRepo, [repo]: now },
    lastCallAt: now
  }
}

export function tripBreaker(state: PacingState, now: number): PacingState {
  return { ...state, breakerUntil: now + BREAKER_HOLD_MS }
}
