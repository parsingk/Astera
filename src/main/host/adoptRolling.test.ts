import { describe, it, expect } from 'vitest'
import { adoptRollingOf, adoptForkOf } from './adoptRolling'

const snap = { v: 1, provider: 'claude', accountIds: ['a1'], currentIndex: 0, streak: 0, recovery: [null], blocks: {}, wait: null, inPlaceUsed: false, rolledAt: null, awaitingPrompt: false,
  // The provider's own block is required (parseRollSnapshot refuses a claude snapshot without one).
  claude: { sessionId: null, transcriptPath: null, tailOffset: null, tailSince: null }, writtenAt: 1 }

describe('adoptRollingOf (S6 R18)', () => {
  it('leaves a Host-owned session to a Host that rolls', () => {
    expect(adoptRollingOf({ restore: { rolledBy: 'host', roll: snap }, hostRolls: true, rollAccounts: 1 })).toEqual({ kind: 'host' })
  })
  it('a reconnect after a socket drop restores the chain from its snapshot, not from zero (preflight R10)', () => {
    // The drop disposed the app's chains (the lost-sight exit); the note still carries this app's snapshot.
    expect(adoptRollingOf({ restore: { roll: snap }, hostRolls: true, rollAccounts: 1 })).toMatchObject({ kind: 'restore' })
  })
  it('restores from a snapshot nobody took (a new instance inside the grace), and registers an old note', () => {
    expect(adoptRollingOf({ restore: { roll: snap }, hostRolls: true, rollAccounts: 1 }).kind).toBe('restore')
    expect(adoptRollingOf({ restore: {}, hostRolls: true, rollAccounts: 1 })).toEqual({ kind: 'register' })
  })
  it('rolls a Host-marked session itself in front of a Host that does not roll (an older one)', () => {
    expect(adoptRollingOf({ restore: { rolledBy: 'host', roll: snap }, hostRolls: false, rollAccounts: 1 }).kind).toBe('restore')
  })
  it('does nothing for a session with no chain', () => {
    expect(adoptRollingOf({ restore: { roll: snap }, hostRolls: true, rollAccounts: 0 })).toEqual({ kind: 'none' })
  })
  // Carry C-I1 (Task 6 review): a chain this app still holds is never registered over — neither restored
  // (restore refuses it) nor registered from zero as the fallback of that refusal.
  it('keeps a chain this app already holds rather than restoring or registering a second one', () => {
    expect(adoptRollingOf({ restore: { roll: snap }, hostRolls: true, rollAccounts: 1, hasChain: true })).toEqual({ kind: 'keep' })
    expect(adoptRollingOf({ restore: {}, hostRolls: false, rollAccounts: 1, hasChain: true })).toEqual({ kind: 'keep' })
    // A corrupt snapshot would otherwise fall to 'register' — still kept.
    expect(adoptRollingOf({ restore: { roll: { v: 9 } }, hostRolls: true, rollAccounts: 1, hasChain: true })).toEqual({ kind: 'keep' })
  })
  it('still leaves a Host-owned session to a Host that rolls when a stale chain is held (the belt drops it)', () => {
    expect(adoptRollingOf({ restore: { rolledBy: 'host', roll: snap }, hostRolls: true, rollAccounts: 1, hasChain: true })).toEqual({ kind: 'host' })
  })
})

describe('adoptForkOf (preflight C10)', () => {
  it('forks once from the session a roll replaced, the first time the new session is adopted', () => {
    expect(adoptForkOf({ restore: { rolledFrom: 's1' }, adopting: false })).toBe('s1')
  })
  it('does not fork again on a later adoption, once forkSeen names the same roll', () => {
    expect(adoptForkOf({ restore: { rolledFrom: 's1', forkSeen: 's1' }, adopting: false })).toBeNull()
  })
  it('forks for a newer roll although an older one was seen (forkSeen names another session)', () => {
    expect(adoptForkOf({ restore: { rolledFrom: 's2', forkSeen: 's1' }, adopting: false })).toBe('s2')
  })
  it('leaves the fork of a pushed Host roll to its forwarded rekey', () => {
    expect(adoptForkOf({ restore: { rolledFrom: 's1' }, adopting: true })).toBeNull()
  })
  it('forks nothing for a session no roll started', () => {
    expect(adoptForkOf({ restore: {}, adopting: false })).toBeNull()
    expect(adoptForkOf({ restore: { rolledFrom: 7 }, adopting: false })).toBeNull()
  })
})
