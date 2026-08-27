// Block records and retry planning for rolling accounts. A pure decision layer shared by the claude
// and codex coordinators — where RollCycle decides "what to do next", this decides "which account is
// usable right now". Timers and state publishing stay owned by each coordinator.
//
// There is deliberately no coordinator base class (it was estimated and then closed). Both
// coordinators now carry the stateSeq generation guard in pushState — codex gained one the moment its
// in-place resume gave it a deferred publish of its own — but the timer sets in disposeChain still
// differ (5 for claude / 3 for codex), and lifting timer lifetimes up into a common parent is the axis
// of this app that has produced the most bugs.

/** Record of one account being blocked. at=reset time; if unknown (null), treat it as blocked until since+RETRY_FALLBACK_MS. */
export interface BlockRecord {
  at: number | null
  weekly: boolean
  since: number // when it was recorded — the expiry basis when reset is unknown
}

// Retry schedule: targeted retry based on the reset time. The fallback interval when reset is unknown
// (the phrase alone was accepted), the floor (anti-hammering), and the margin just after reset.
export const RETRY_FALLBACK_MS = 15 * 60_000
export const RETRY_MIN_FLOOR_MS = 60_000
export const RETRY_MARGIN_MS = 60_000

/** Only the part of a chain that retry decisions need — the coordinator's Chain also carries timers, so we do not take it as-is. */
export interface RetryState {
  accountIds: string[]
  currentIndex: number
  recovery: (BlockRecord | null)[]
}

/** Up to this time we consider that account unusable */
export function blockedUntil(rec: BlockRecord): number {
  return rec.at ?? rec.since + RETRY_FALLBACK_MS
}

/** The one that keeps the account unusable for longer. Used both when two chains record a block on
 *  the same account and when a chain's own record is merged with what another chain found.
 *
 *  Why "longer" and not "newer": a record whose reset time is unknown (at === null) expires after
 *  RETRY_FALLBACK_MS, so a newer but blind record would shorten a block another chain has real
 *  evidence for. The account is unusable until the latest time anyone can justify. */
export function laterBlock(a: BlockRecord | null, b: BlockRecord | null): BlockRecord | null {
  if (!a) return b
  if (!b) return a
  return blockedUntil(b) > blockedUntil(a) ? b : a
}

/** Walks once around from fromIndex for an account usable right now. Skips the current account. null if there is none. */
export function pickAvailable(state: RetryState, fromIndex: number, now: number): number | null {
  const n = state.accountIds.length
  for (let k = 0; k < n; k++) {
    const idx = (fromIndex + k) % n
    if (idx === state.currentIndex) continue
    const rec = state.recovery[idx]
    if (!rec || blockedUntil(rec) <= now) return idx
  }
  return null
}

/** Retry plan when every account is blocked — target the account with the earliest effective recovery
 *  time. No record is treated as now+fallback so it gets rechecked soon. retryAt is clamped to the
 *  floor (MIN_FLOOR), and a real reset gets the margin (MARGIN) added. */
export function planRetry(
  state: RetryState,
  now: number
): { target: number; retryAt: number; weekly: boolean } {
  let best = { target: 0, at: Infinity, hasReset: false, weekly: false }
  for (let i = 0; i < state.accountIds.length; i++) {
    const rec = state.recovery[i]
    const at = rec ? blockedUntil(rec) : now + RETRY_FALLBACK_MS
    if (at < best.at) best = { target: i, at, hasReset: !!rec?.at, weekly: rec ? rec.weekly : false }
  }
  const base = best.hasReset ? best.at + RETRY_MARGIN_MS : best.at
  return { target: best.target, retryAt: Math.max(base, now + RETRY_MIN_FLOOR_MS), weekly: best.weekly }
}
