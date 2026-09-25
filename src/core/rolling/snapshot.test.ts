import { describe, it, expect } from 'vitest'
import { parseRollSnapshot, snapshotKey, ROLL_SNAPSHOT_VERSION, type RollSnapshot } from './snapshot'

const good = (): RollSnapshot => ({
  v: ROLL_SNAPSHOT_VERSION,
  provider: 'claude',
  accountIds: ['a1', 'a2'],
  currentIndex: 1,
  streak: 1,
  recovery: [{ at: 1000, weekly: false, since: 10 }, null],
  blocks: { a1: { at: 1000, weekly: false, since: 10 } },
  wait: null,
  inPlaceUsed: false,
  rolledAt: 500,
  awaitingPrompt: true,
  claude: { sessionId: 'cs', transcriptPath: 'x.jsonl', tailOffset: 42, tailSince: 400 },
  writtenAt: 600
})

describe('parseRollSnapshot (S6 R4)', () => {
  it('accepts a v1 snapshot, through a JSON round trip', () => {
    expect(parseRollSnapshot(JSON.parse(JSON.stringify(good())))).toEqual(good())
  })
  it.each([
    ['another version', { v: 2 }],
    ['an unknown provider', { provider: 'gemini' }],
    ['an index outside the chain', { currentIndex: 2 }],
    ['a recovery of another length', { recovery: [null] }],
    ['a non-string account', { accountIds: ['a1', 7] }],
    ['a wait without a time', { wait: { target: 0, weekly: false } }],
    ['a negative offset', { claude: { sessionId: null, transcriptPath: null, tailOffset: -1, tailSince: null } }]
  ])('refuses %s', (_why, patch) => {
    expect(parseRollSnapshot({ ...good(), ...patch })).toBeNull()
  })
  it('accepts a codex snapshot with a full last state, and refuses one whose state is half there', () => {
    const state = {
      primary: { usedPercent: 100, resetsAt: 2000 },
      secondary: null,
      reachedType: null,
      error: { message: 'limit', at: 1500 },
      priorReset: null,
      at: 1600
    }
    const codex = (s: unknown): unknown => ({
      ...good(),
      provider: 'codex',
      claude: undefined,
      codex: { sessionId: 't', rolloutPath: 'r.jsonl', tailOffset: 7, state: s }
    })
    expect(parseRollSnapshot(JSON.parse(JSON.stringify(codex(state))))).not.toBeNull()
    expect(parseRollSnapshot(codex({ primary: null }))).toBeNull()
    expect(parseRollSnapshot(codex({ ...state, primary: { usedPercent: '100', resetsAt: null } }))).toBeNull()
  })
  it('refuses what is not an object at all', () => {
    for (const v of [null, undefined, 'x', 3, []]) expect(parseRollSnapshot(v)).toBeNull()
  })
  it('snapshotKey ignores writtenAt and nothing else', () => {
    expect(snapshotKey({ ...good(), writtenAt: 1 })).toBe(snapshotKey({ ...good(), writtenAt: 2 }))
    expect(snapshotKey({ ...good(), streak: 2 })).not.toBe(snapshotKey(good()))
  })
})
