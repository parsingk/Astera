// The adopter's rolling decision (S6 plan R18, design §3A.5), pure so it is tested apart from ipc.ts.
import { parseRollSnapshot, type RollSnapshot } from '../../core/rolling/snapshot'

export type AdoptRolling =
  | { kind: 'host' }
  | { kind: 'restore'; snap: RollSnapshot }
  | { kind: 'register' }
  | { kind: 'keep' }
  | { kind: 'none' }

/** R18: what the adopter does with a session's rolling, from its note and the Host's features.
 *  `hasChain`: whether the session's own coordinator already holds a chain for it (carry C-I1). */
export function adoptRollingOf(a: {
  restore: Record<string, unknown>
  hostRolls: boolean
  rollAccounts: number
  hasChain?: boolean
}): AdoptRolling {
  if (a.rollAccounts < 1) return { kind: 'none' }
  // R3: a session the Host took stays the Host's while that Host rolls (ruling R8: ownership never
  // returns to a reopened app). In front of a Host that does not (an older one after a downgrade, or
  // none), this app is the only one left to roll it.
  if (a.hostRolls && a.restore.rolledBy === 'host') return { kind: 'host' }
  // C-I1: a chain this app still holds (a reconnect it was mid-roll across, preflight R11) is left
  // exactly as it is. A restore would refuse it, and registering from zero as that refusal's fallback
  // would replace it and orphan its timers — a second wait firing, a second prompt typed.
  if (a.hasChain) return { kind: 'keep' }
  const snap = parseRollSnapshot(a.restore.roll)
  return snap ? { kind: 'restore', snap } : { kind: 'register' }
}

/** Preflight C10: the session a roll replaced, when adopting this one owes the Work Unit fork, else
 *  null. Once per roll: the note keeps `rolledFrom` for the pty's life, and `forkSeen` records the roll
 *  whose fork was already made — a later adoption forking again would skip transcript lines written
 *  while the app was closed. A pushed Host roll (`adopting`) forwards its own fork with its rekey. */
export function adoptForkOf(a: { restore: Record<string, unknown>; adopting: boolean }): string | null {
  const rolledFrom = typeof a.restore.rolledFrom === 'string' ? a.restore.rolledFrom : null
  if (!rolledFrom || a.restore.forkSeen === rolledFrom || a.adopting) return null
  return rolledFrom
}

/** What the adopter does, handed in by ipc.ts, so the decisions below are pinned by tests and ipc.ts is
 *  left with one closure each (Task 14 fix round 1, 5). `has`, `restore` and `registerAsBefore` are on
 *  the session's own coordinator; `unregister` is on both. */
export interface AdoptRollingActs {
  has(): boolean
  restore(snap: RollSnapshot, report: boolean): boolean
  registerAsBefore(): void
  unregister(): void
  fork(from: string): void
  rememberForkSeen(from: string): void
}

/** The adopter's rolling and its Work Unit fork, from its note (adoptRollingOf, adoptForkOf).
 *  `pendingFork`: a forwarded Host rekey whose fork was made while the note could not take its forkSeen
 *  (hostRollView.takePendingFork) — written now, and not forked again. */
export function applyAdoptRolling(
  a: { restore: Record<string, unknown>; hostRolls: boolean; rollAccounts: number; adopting: boolean; pendingFork: string | null },
  d: AdoptRollingActs
): AdoptRolling {
  const decision = adoptRollingOf({ restore: a.restore, hostRolls: a.hostRolls, rollAccounts: a.rollAccounts, hasChain: d.has() })
  if (decision.kind === 'restore') {
    // `report` only for a chain the Host last ran (a Host-marked note in front of a Host that no longer
    // rolls): its native id and roll config went into the Host's state, not this app's. A snapshot this
    // app (or its earlier instance, which shares the state) wrote needs neither.
    const ok = d.restore(decision.snap, a.restore.rolledBy === 'host')
    // A refused restore (the snapshot does not describe this session) registers from zero — unless a
    // chain exists by now after all, which a restore also refuses (C-I1).
    if (!ok && !d.has()) d.registerAsBefore()
  } else if (decision.kind === 'register') d.registerAsBefore()
  else if (decision.kind === 'host') {
    // The Host rolls it; this app shows it through hostRollView (S6 R3, ruling R8). The belt (preflight
    // R11): a chain this app still held from before a socket drop (it was mid-roll then) goes now.
    d.unregister()
  }
  // 'keep' and 'none' touch nothing.
  const restore = a.pendingFork ? { ...a.restore, forkSeen: a.pendingFork } : a.restore
  const forkFrom = adoptForkOf({ restore, adopting: a.adopting })
  if (forkFrom) {
    d.fork(forkFrom)
    d.rememberForkSeen(forkFrom)
  } else if (a.pendingFork) d.rememberForkSeen(a.pendingFork)
  return decision
}
