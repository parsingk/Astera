import { describe, it, expect, vi } from 'vitest'
import { takeOverSessions, takeOverChats } from './takeover'
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

const rig = (entries: PtyEntry[], over: { hasApp?: boolean; holders?: Record<string, number[]>; chains?: string[]; restoreOk?: boolean; restoreThrows?: boolean } = {}) => {
  const logs: string[] = []
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
    restore: (info) => {
      order.push(`restore ${info.id}`)
      if (over.restoreThrows) throw new Error('boom')
      return over.restoreOk ?? true
    },
    log: (m) => logs.push(m)
  })
  return { r, order, logs }
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
    ['the snapshot sits on another account than the note (restore would refuse it)', [entry('s1', { roll: snap({ currentIndex: 1 }) })], {}],
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
  it('a restore that throws after the mark takes the mark back, and says so (fix round 1)', () => {
    const { r, order, logs } = rig([entry('s1', { roll: snap() })], { restoreThrows: true })
    expect(r.taken).toEqual([])
    expect(r.skipped.map((x) => x.sessionId)).toEqual(['s1'])
    expect(order).toEqual(['resume p-s1', 'note p-s1 {"rolledBy":"host"}', 'restore s1', 'note p-s1 {"rolledBy":null}'])
    expect(logs.join('\n')).toMatch(/boom/)
  })
  it('records a snapshot on another account than the note as skipped, with its reason (fix round 1)', () => {
    const { r } = rig([entry('s1', { roll: snap({ currentIndex: 1 }) })])
    expect(r.skipped).toEqual([{ sessionId: 's1', why: expect.stringMatching(/account/) }])
  })
})

const chatEntry = (id: string, restore: Record<string, unknown>, alive = true) =>
  entry(id, { provider: 'claude', unattendedPermission: 'hold', ...restore }, alive, 'chat')

const chatRig = (entries: PtyEntry[], over: { hasApp?: boolean; holders?: Record<string, number[]>; chains?: string[]; held?: string[]; restoreOk?: boolean; restoreThrows?: boolean; adoptOk?: boolean; adoptFailed?: Map<string, string>; logs?: string[] } = {}) => {
  const order: string[] = []
  const r = takeOverChats({
    hasApp: () => over.hasApp ?? false, announces: () => true, retiring: () => false,
    entries: () => entries,
    holdersOf: (p) => over.holders?.[p] ?? [],
    note: (p, patch) => order.push(`note ${p} ${JSON.stringify(patch)}`),
    hasChain: (id) => (over.chains ?? []).includes(id),
    held: (id) => (over.held ?? []).includes(id),
    restore: (info) => { order.push(`restore ${info.id} ${info.kind}`); if (over.restoreThrows) throw new Error('boom'); return over.restoreOk ?? true },
    unregister: (id) => order.push(`unregister ${id}`),
    adopt: (e) => { order.push(`adopt ${e.id}`); return over.adoptOk ?? true },
    ...(over.adoptFailed ? { adoptFailed: over.adoptFailed } : {}),
    log: (m) => { over.logs?.push(m) }
  })
  return { r, order }
}

describe('takeOverChats (chat takeover spec §3.3)', () => {
  it('marks, restores the chain as a chat chain, then adopts, in that order', () => {
    const { r, order } = chatRig([chatEntry('c1', { roll: snap() })])
    expect(r.taken).toEqual(['c1'])
    expect(r.adopted).toEqual(['c1'])
    expect(order).toEqual(['note p-c1 {"rolledBy":"host"}', 'restore c1 chat', 'adopt p-c1'])
  })
  it('adopts a proc with no chain, and writes no mark (P3)', () => {
    const { r, order } = chatRig([chatEntry('c1', { rollAccountIds: undefined })])
    expect(r.taken).toEqual([])
    expect(r.adopted).toEqual(['c1'])
    expect(order).toEqual(['adopt p-c1'])
  })
  it('adopts but restores nothing when the snapshot is missing, and logs why', () => {
    const { r, order } = chatRig([chatEntry('c1', {})])
    expect(order).toEqual(['adopt p-c1'])
    expect(r.skipped[0].why).toMatch(/snapshot/)
  })
  it.each([
    ['an app is attached', [chatEntry('c1', { roll: snap() })], { hasApp: true }],
    ['an app from before chat takeover wrote the note (no unattendedPermission)', [entry('c1', { provider: 'claude', roll: snap() }, true, 'chat')], {}],
    ['a socket still holds it', [chatEntry('c1', { roll: snap() })], { holders: { 'p-c1': [3] } }],
    ['the Host already holds an adapter on it', [chatEntry('c1', { roll: snap() })], { held: ['c1'] }],
    ['it has ended', [chatEntry('c1', { roll: snap() }, false)], {}]
  ])('takes nothing when %s', (_why, entries, over) => {
    const { r, order } = chatRig(entries as PtyEntry[], over)
    expect(r.taken).toEqual([])
    expect(r.adopted).toEqual([])
    expect(order).toEqual([])
  })
  it('takes the mark back and drops the chain when the adopt fails after a restore', () => {
    const { r, order } = chatRig([chatEntry('c1', { roll: snap() })], { adoptOk: false })
    expect(r.taken).toEqual([])
    expect(order).toEqual(['note p-c1 {"rolledBy":"host"}', 'restore c1 chat', 'adopt p-c1', 'unregister c1', 'note p-c1 {"rolledBy":null}'])
  })
  it('restores no second chain for a proc the Host already rolls, but still adopts it', () => {
    const { order } = chatRig([chatEntry('c1', { roll: snap(), rolledBy: 'host' })], { chains: ['c1'] })
    expect(order).toEqual(['adopt p-c1'])
  })
  // Minor 3, M10: the chat pass takes its mark back on a refused or a throwing restore, and still adopts.
  it.each([
    ['refuses', { restoreOk: false }],
    ['throws', { restoreThrows: true }]
  ])('takes the mark back when the restore %s, and still adopts', (_why, over) => {
    const { r, order } = chatRig([chatEntry('c1', { roll: snap() })], over)
    expect(r.taken).toEqual([])
    expect(r.adopted).toEqual(['c1'])
    expect(order).toEqual(['note p-c1 {"rolledBy":"host"}', 'restore c1 chat', 'note p-c1 {"rolledBy":null}', 'adopt p-c1'])
  })
  // Minor 1: an adopt that failed is not tried again on every tick, until the proc's note changes or it ends.
  it('does not retry a failed adopt on a later pass until the note changes, and says so once', () => {
    const failed = new Map<string, string>()
    const logs: string[] = []
    const e1 = chatEntry('c1', { roll: snap() })
    const first = chatRig([e1], { adoptOk: false, adoptFailed: failed, logs })
    expect(first.order).toContain('adopt p-c1')
    const again = chatRig([e1], { adoptOk: false, adoptFailed: failed, logs })
    expect(again.order).toEqual([])
    expect(logs.filter((m) => /not tried again/.test(m))).toHaveLength(1)
    // The mark the failure took back is not a change of the note.
    const unmarked = chatEntry('c1', { roll: snap(), rolledBy: null })
    expect(chatRig([unmarked], { adoptOk: false, adoptFailed: failed, logs }).order).toEqual([])
    // A changed note is tried again.
    const changed = chatEntry('c1', { roll: snap(), unattendedPermission: 'deny-after-60s' })
    expect(chatRig([changed], { adoptFailed: failed }).order).toContain('adopt p-c1')
    expect(failed.size).toBe(0)
  })
  it('forgets a failed adopt once its proc has ended', () => {
    const failed = new Map<string, string>()
    chatRig([chatEntry('c1', {})], { adoptOk: false, adoptFailed: failed })
    expect(failed.has('p-c1')).toBe(true)
    chatRig([chatEntry('c1', {}, false)], { adoptFailed: failed })
    expect(failed.has('p-c1')).toBe(false)
  })
})
