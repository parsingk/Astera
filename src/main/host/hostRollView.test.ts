import { describe, it, expect, vi } from 'vitest'
import { createHostRollView, withHostRollHold, orchHoldsSession, hostForced, announcesAdopted } from './hostRollView'
import type { OrchState } from '../../core/orchestration/state'
import type { HostMessage } from '../../core/host/protocol'

describe('createHostRollView (S6 §3.4)', () => {
  it('adopts the new pty, then forwards the rekey, then delivers the old session’s held exit — in that order', async () => {
    const order: string[] = []
    let finishAdopt: () => void = () => {}
    const v = createHostRollView({
      adopt: (p) => new Promise<void>((r) => { order.push(`adopt ${p}`); finishAdopt = r }),
      forward: (c, p) => order.push(`${c} ${(p as { oldSessionId?: string }).oldSessionId ?? ''}`),
      log: () => {}
    })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: { id: 's2', accountId: 'a2', cwd: 'D:/p', status: 'running', title: 't' }, ptyId: 'p2' })
    expect(v.holds('s1')).toBe(true)
    expect(v.adopting('s2')).toBe(true) // the adopter leaves the Work Unit fork to the forwarded rekey (C10)
    v.hold({ sessionId: 's1', exitCode: 1 }, () => order.push('exit s1'))
    await Promise.resolve()
    expect(order).toEqual(['adopt p2'])
    finishAdopt()
    await vi.waitFor(() => expect(order).toEqual(['adopt p2', 'session:rolled s1', 'exit s1']))
    expect(v.holds('s1')).toBe(false)
    expect(v.adopting('s2')).toBe(false)
  })
  it('adopts the new chat proc of a pushed chat roll before it forwards the rekey', async () => {
    const order: string[] = []
    const view = createHostRollView({
      adopt: async (ptyId, procId) => { order.push(`adopt ${ptyId} ${procId}`) },
      forward: (channel) => order.push(`forward ${channel}`),
      log: () => {}
    })
    view.pushed({ t: 'session-rolled', oldSessionId: 'c1', info: { id: 'c2', accountId: 'a2', cwd: 'D:/p', status: 'running', title: 't', kind: 'chat' }, ptyId: null, procId: 'p2' })
    await vi.waitFor(() => expect(order).toEqual(['adopt null p2', 'forward session:rolled']))
  })
  // Fix round 1, M1: the adopter re-pointed the tab itself (the sweep beat the push); the push that
  // follows adopts and settles as usual, and does not forward the same rekey a second time.
  it('forwards an adopter re-point once, and a later push for that roll does not forward it again', async () => {
    const order: string[] = []
    const view = createHostRollView({
      adopt: async (ptyId, procId) => { order.push(`adopt ${ptyId} ${procId}`) },
      forward: (channel, p) => order.push(`forward ${channel} ${(p as { oldSessionId: string }).oldSessionId}`),
      log: () => {}
    })
    const info = { id: 'c2', accountId: 'a2', cwd: 'D:/p', status: 'running' as const, title: 't', kind: 'chat' as const }
    view.repointed('c1', info)
    expect(order).toEqual(['forward session:rolled c1'])
    expect(view.knows('c2')).toBe(true)
    view.pushed({ t: 'session-rolled', oldSessionId: 'c1', info, ptyId: null, procId: 'p2' })
    const delivered: string[] = []
    view.hold({ sessionId: 'c1', exitCode: 1 }, () => delivered.push('exit c1'))
    await vi.waitFor(() => expect(delivered).toEqual(['exit c1']))
    expect(order).toEqual(['forward session:rolled c1', 'adopt null p2'])
    // A second roll of the same new id is a new roll, forwarded again.
    view.pushed({ t: 'session-rolled', oldSessionId: 'c1', info, ptyId: null, procId: 'p2' })
    await vi.waitFor(() => expect(order.filter((x) => x.startsWith('forward')).length).toBe(2))
  })
  it('a re-point forwards the codex dest it is handed, and none when it has none (CT-16)', () => {
    const payloads: unknown[] = []
    const view = createHostRollView({ adopt: async () => {}, forward: (_c, p) => payloads.push(p), log: () => {} })
    const info = { id: 'c2', accountId: 'a2', cwd: 'D:/p', status: 'running' as const, title: 't', kind: 'chat' as const }
    view.repointed('c1', info, 'C:/acc2/sessions/rollout-x.jsonl')
    view.repointed('c3', { ...info, id: 'c4' }, null)
    expect(payloads).toEqual([
      { oldSessionId: 'c1', info, dest: 'C:/acc2/sessions/rollout-x.jsonl' },
      { oldSessionId: 'c3', info: { ...info, id: 'c4' } }
    ])
  })
  it('keeps the last lasting state per session, clears it on none, and follows a rekey', async () => {
    const v = createHostRollView({ adopt: async () => {}, forward: () => {}, log: () => {} })
    v.pushed({ t: 'roll-state', event: { sessionId: 's1', state: 'waiting', nextRetryAt: 'x' } })
    v.pushed({ t: 'roll-state', event: { sessionId: 's1', state: 'nudged' } })
    expect(v.stateOf('s1')?.state).toBe('waiting')
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: { id: 's2', accountId: 'a2', cwd: 'D:/p', status: 'running', title: 't' }, ptyId: null })
    await vi.waitFor(() => expect(v.stateOf('s2')?.state).toBe('waiting'))
    expect(v.stateOf('s1')).toBeNull()
    v.pushed({ t: 'roll-state', event: { sessionId: 's2', state: 'none' } })
    expect(v.stateOf('s2')).toBeNull()
  })
  // S6-17: an adoption that fails forwards the rekey to the app's own taps (the Work Unit fork, the
  // schedule, Slack) but not to the renderer, which would re-point the old tab at a session the app
  // does not hold. The old tab closes on the released exit and the next sweep's adopter announces the
  // new session.
  it('an adoption that fails forwards the rekey without the renderer, releases the exit, and says why', async () => {
    const logs: string[] = []
    const delivered: string[] = []
    const calls: Array<[string, unknown]> = []
    const v = createHostRollView({ adopt: async () => { throw new Error('socket closed') }, forward: (c, _p, o) => calls.push([c, o]), log: (m) => logs.push(m) })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: { id: 's2', accountId: 'a2', cwd: 'D:/p', status: 'running', title: 't' }, ptyId: 'p2' })
    v.hold({ sessionId: 's1', exitCode: 1 }, (e) => delivered.push(e.sessionId))
    await vi.waitFor(() => expect(delivered).toEqual(['s1']))
    expect(calls).toEqual([['session:rolled', { orchestration: false, renderer: false }]])
    expect(logs.join('\n')).toMatch(/socket closed/)
  })
  it('an adoption that resolves without holding the new session (the sweep was not answered) keeps the rekey from the renderer', async () => {
    const calls: Array<[string, unknown]> = []
    const v = createHostRollView({ adopt: async () => {}, forward: (c, _p, o) => calls.push([c, o]), log: () => {}, isAdopted: () => false })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: rolled, ptyId: 'p2' })
    await vi.waitFor(() => expect(v.adopting('s2')).toBe(false))
    expect(calls).toEqual([['session:rolled', { orchestration: false, renderer: false }]])
  })
  it('an adoption that threw after another sweep took the new session back still tells the renderer', async () => {
    const calls: Array<[string, unknown]> = []
    const v = createHostRollView({ adopt: async () => { throw new Error('late') }, forward: (c, _p, o) => calls.push([c, o]), log: () => {}, isAdopted: () => true })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: rolled, ptyId: 'p2' })
    await vi.waitFor(() => expect(v.adopting('s2')).toBe(false))
    expect(calls).toEqual([['session:rolled', { orchestration: false }]])
  })

  // Fix round 1, 5: a Host roll's fan-out never runs the app's orchestration tap — the Host rekeyed.
  it('forwards both pushes without the orchestration tap', async () => {
    const calls: Array<[string, unknown]> = []
    const v = createHostRollView({ adopt: async () => {}, forward: (c, _p, o) => calls.push([c, o]), log: () => {} })
    v.pushed({ t: 'roll-state', event: { sessionId: 's1', state: 'waiting' } })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: rolled, ptyId: null })
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls).toEqual([
      ['session:rollState', { orchestration: false }],
      ['session:rolled', { orchestration: false }]
    ])
  })
  // Fix round 1, 4: what rolling.state may ask the Host about.
  it('knows the sessions the Host has told it about, and nothing else', async () => {
    const v = createHostRollView({ adopt: async () => {}, forward: () => {}, log: () => {} })
    expect(v.knows('s1')).toBe(false)
    v.pushed({ t: 'roll-state', event: { sessionId: 's1', state: 'none' } })
    v.pushed({ t: 'session-rolled', oldSessionId: 's5', info: rolled, ptyId: null })
    expect(v.knows('s1')).toBe(true)
    expect(v.knows('s2')).toBe(true)
    expect(v.knows('s9')).toBe(false)
  })
  // Fix round 1, 3: a rekey forwarded for a session whose adoption failed leaves its forkSeen pending.
  it('keeps a pending forkSeen for a rekey whose new session was not adopted, handed out once', async () => {
    const v = createHostRollView({ adopt: async () => { throw new Error('socket closed') }, forward: () => {}, log: () => {}, isAdopted: () => false })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: rolled, ptyId: 'p2' })
    await vi.waitFor(() => expect(v.adopting('s2')).toBe(false))
    expect(v.takePendingFork('s2')).toBe('s1')
    expect(v.takePendingFork('s2')).toBeNull()
  })
  it('leaves nothing pending when the new session was adopted', async () => {
    const v = createHostRollView({ adopt: async () => {}, forward: () => {}, log: () => {}, isAdopted: () => true })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: rolled, ptyId: 'p2' })
    await vi.waitFor(() => expect(v.adopting('s2')).toBe(false))
    expect(v.takePendingFork('s2')).toBeNull()
  })
})

const rolled = { id: 's2', accountId: 'a2', cwd: 'D:/p', status: 'running' as const, title: 't' }

// Fix round 1, I2: the old session's exit waits for the app's mirror to stop naming it.
describe('createHostRollView: the exit waits for the orchestration mirror (fix round 1, I2)', () => {
  const setup = (owned: { v: boolean }, logs: string[] = []) => {
    const delivered: string[] = []
    const v = createHostRollView({
      adopt: async () => {},
      forward: () => {},
      log: (m) => logs.push(m),
      orchHolds: (id) => id === 's1' && owned.v,
      settleMs: 15_000,
      pollMs: 250
    })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: rolled, ptyId: null })
    v.hold({ sessionId: 's1', exitCode: 1 }, (e) => delivered.push(e.sessionId))
    return { v, delivered }
  }
  it('is not delivered while the old id owns an open Dispatch, and is once an orch-state push shows it moved', async () => {
    vi.useFakeTimers()
    try {
      const owned = { v: true }
      const { v, delivered } = setup(owned)
      await vi.advanceTimersByTimeAsync(100)
      expect(delivered).toEqual([])
      expect(v.holds('s1')).toBe(true)
      owned.v = false
      v.pushed({ t: 'orch-state', state: {}, version: 2 } as unknown as HostMessage)
      await vi.advanceTimersByTimeAsync(0)
      expect(delivered).toEqual(['s1'])
      expect(v.holds('s1')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
  it('is delivered by the poll once the mirror moves, with no push', async () => {
    vi.useFakeTimers()
    try {
      const owned = { v: true }
      const { delivered } = setup(owned)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(delivered).toEqual([])
      owned.v = false
      await vi.advanceTimersByTimeAsync(250)
      expect(delivered).toEqual(['s1'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('is delivered anyway at the timeout, and says so', async () => {
    vi.useFakeTimers()
    try {
      const logs: string[] = []
      const { delivered } = setup({ v: true }, logs)
      await vi.advanceTimersByTimeAsync(14_900)
      expect(delivered).toEqual([])
      await vi.advanceTimersByTimeAsync(200)
      expect(delivered).toEqual(['s1'])
      expect(logs.join(' ')).toMatch(/15000ms/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('orchHoldsSession (fix round 1, I2)', () => {
  const state = (o: Partial<OrchState>): OrchState => ({ runs: [], dispatches: [], ...o }) as unknown as OrchState
  it('an open Dispatch or a coordinator slot on the id holds it; a closed Dispatch or no mirror does not', () => {
    expect(orchHoldsSession(state({ dispatches: [{ sessionId: 's1' }] as never }), 's1')).toBe(true)
    expect(orchHoldsSession(state({ dispatches: [{ sessionId: 's1', endedAt: 'x' }] as never }), 's1')).toBe(false)
    expect(orchHoldsSession(state({ runs: [{ coordinatorSessionId: 's1' }] as never }), 's1')).toBe(true)
    expect(orchHoldsSession(state({ dispatches: [{ sessionId: 's2' }] as never }), 's1')).toBe(false)
    expect(orchHoldsSession(null, 's1')).toBe(false)
  })
})

// Fix round 1, 5: the exit hold pinned as a wrapper rather than a line in onSessionExit.
describe('withHostRollHold', () => {
  it('passes an exit the view does not hold straight through, and a held one once released — once', async () => {
    const v = createHostRollView({ adopt: async () => {}, forward: () => {}, log: () => {} })
    const seen: string[] = []
    const onExit = withHostRollHold(v, (e) => seen.push(e.sessionId))
    onExit({ sessionId: 's9', exitCode: 0 })
    expect(seen).toEqual(['s9'])
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: rolled, ptyId: 'p2' })
    onExit({ sessionId: 's1', exitCode: 1 })
    expect(seen).toEqual(['s9'])
    await vi.waitFor(() => expect(seen).toEqual(['s9', 's1']))
  })
})

describe('hostForced (S6 final review M1)', () => {
  it('reads forced:false as nothing happened, logs the reason and does not throw', () => {
    const logs: string[] = []
    expect(hostForced({ forced: false, why: 'the chain did not act (roll state: waiting)' }, 's1', (m) => logs.push(m))).toBe(false)
    expect(logs).toEqual(['roll-force on s1: nothing happened (the chain did not act (roll state: waiting))'])
  })
  it('reads forced:true, and an older Host’s answer with no flag, as forced', () => {
    const log = vi.fn()
    expect(hostForced({ forced: true }, 's1', log)).toBe(true)
    expect(hostForced({}, 's1', log)).toBe(true)
    expect(hostForced(null, 's1', log)).toBe(true)
    expect(log).not.toHaveBeenCalled()
  })
})

// Task 18 e2e (B2): the new half of a Host roll came up as a second tab beside the old one. The adopter's
// `session:created` built a tab, then `session:rolled` re-pointed the old tab at the same id.
describe('announcesAdopted (S6 §3.4)', () => {
  const info = { id: 's2', accountId: 'a2', cwd: 'D:/p', status: 'running' as const, title: 't' }
  it('does not announce the new half of a Host roll whose old session the app shows', () => {
    let finish: () => void = () => {}
    const v = createHostRollView({ adopt: () => new Promise<void>((r) => { finish = r }), forward: () => {}, log: () => {} })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info, ptyId: 'p2' })
    expect(v.rolledFrom('s2')).toBe('s1')
    expect(announcesAdopted(v, 's2', (id) => id === 's1')).toBe(false)
    finish()
  })
  it('announces it when the app never showed the old session: nothing would re-point a tab', () => {
    const v = createHostRollView({ adopt: () => new Promise<void>(() => {}), forward: () => {}, log: () => {} })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info, ptyId: 'p2' })
    expect(announcesAdopted(v, 's2', () => false)).toBe(true)
  })
  it('announces every other adopted session, and a roll no longer in flight', async () => {
    const v = createHostRollView({ adopt: async () => {}, forward: () => {}, log: () => {} })
    expect(v.rolledFrom('s9')).toBeNull()
    expect(announcesAdopted(v, 's9', () => true)).toBe(true)
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info, ptyId: 'p2' })
    await vi.waitFor(() => expect(v.adopting('s2')).toBe(false))
    expect(v.rolledFrom('s2')).toBeNull()
    expect(announcesAdopted(v, 's2', () => true)).toBe(true)
  })
})
