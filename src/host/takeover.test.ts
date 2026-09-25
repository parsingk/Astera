import { describe, it, expect, vi } from 'vitest'
import { takeOverSessions } from './takeover'
import type { PtyEntry } from '../core/host/protocol'
import type { RollSnapshot } from '../core/rolling/snapshot'

const snap = (over: Partial<RollSnapshot> = {}): RollSnapshot => ({
  v: 1, provider: 'claude', accountIds: ['a1', 'a2'], currentIndex: 0, streak: 0, recovery: [null, null], blocks: {},
  wait: null, inPlaceUsed: false, rolledAt: null, awaitingPrompt: false,
  // parseRollSnapshot requires the provider's own block (Task 6).
  claude: { sessionId: null, transcriptPath: null, tailOffset: null, tailSince: null }, writtenAt: 1, ...over
})
const entry = (id: string, restore: Record<string, unknown>, alive = true, kind: 'session' | 'run' | 'terminal' | 'chat' = 'session'): PtyEntry => ({
  id: `p-${id}`, pid: 1, alive, meta: { kind, id, restore: { accountId: 'a1', cwd: 'D:/p', title: 't', rollAccountIds: ['a1', 'a2'], ...restore } }
})

const rig = (entries: PtyEntry[], over: { hasApp?: boolean; holders?: Record<string, number[]>; chains?: string[]; restoreOk?: boolean } = {}) => {
  const order: string[] = []
  const r = takeOverSessions({
    resume: (p) => order.push(`resume ${p}`),
    hasApp: () => over.hasApp ?? false,
    announces: () => true,
    retiring: () => false,
    entries: () => entries,
    holdersOf: (p) => over.holders?.[p] ?? [],
    note: (p, patch) => order.push(`note ${p} ${JSON.stringify(patch)}`),
    hasChain: (id) => (over.chains ?? []).includes(id),
    restore: (info) => { order.push(`restore ${info.id}`); return over.restoreOk ?? true },
    log: () => {}
  })
  return { r, order }
}

describe('takeOverSessions (S6 R2, design §3A.3)', () => {
  it('takes a snapshotted app session: marks it, then restores it, in that order', () => {
    const { r, order } = rig([entry('s1', { roll: snap() })])
    expect(r.taken).toEqual(['s1'])
    // R31 (preflight R4): a pause a gone app left is released first, then the mark, then the chain.
    expect(order).toEqual(['resume p-s1', 'note p-s1 {"rolledBy":"host"}', 'restore s1'])
  })
  it.each([
    ['an app is attached', [entry('s1', { roll: snap() })], { hasApp: true }],
    ['the Host already owns it', [entry('s1', { roll: snap(), rolledBy: 'host' })], {}],
    ['a pre-S6 app wrote no snapshot', [entry('s1', {})], {}],
    ['the snapshot names other accounts', [entry('s1', { roll: snap({ accountIds: ['a1', 'a9'] }) })], {}],
    ['a socket still holds it', [entry('s1', { roll: snap() })], { holders: { 'p-s1': [4] } }],
    ['the Host has a chain for it', [entry('s1', { roll: snap() })], { chains: ['s1'] }],
    ['it has exited', [entry('s1', { roll: snap() }, false)], {}]
  ])('takes nothing when %s', (_why, entries, over) => {
    const { r, order } = rig(entries as PtyEntry[], over as never)
    expect(r.taken).toEqual([])
    expect(order.filter((x) => x.startsWith('restore'))).toEqual([])
    expect(order.filter((x) => x.startsWith('note'))).toEqual([])
    expect(order.filter((x) => x.startsWith('resume'))).toEqual([])
  })
  it('takes nothing of a chat session or a run', () => {
    const { r } = rig([entry('c1', { roll: snap() }, true, 'chat'), entry('r1', { roll: snap() }, true, 'run')])
    expect(r.taken).toEqual([])
  })
  it('a restore that refuses after the mark takes the mark back', () => {
    const { r, order } = rig([entry('s1', { roll: snap() })], { restoreOk: false })
    expect(r.taken).toEqual([])
    expect(order).toEqual(['resume p-s1', 'note p-s1 {"rolledBy":"host"}', 'restore s1', 'note p-s1 {"rolledBy":null}'])
  })
})
