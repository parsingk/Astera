import { describe, it, expect, vi } from 'vitest'
import { createHostRollView } from './hostRollView'

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
  it('an adoption that fails still forwards and releases the exit, and says why', async () => {
    const logs: string[] = []
    const delivered: string[] = []
    const v = createHostRollView({ adopt: async () => { throw new Error('socket closed') }, forward: () => {}, log: (m) => logs.push(m) })
    v.pushed({ t: 'session-rolled', oldSessionId: 's1', info: { id: 's2', accountId: 'a2', cwd: 'D:/p', status: 'running', title: 't' }, ptyId: 'p2' })
    v.hold({ sessionId: 's1', exitCode: 1 }, (e) => delivered.push(e.sessionId))
    await vi.waitFor(() => expect(delivered).toEqual(['s1']))
    expect(logs.join('\n')).toMatch(/socket closed/)
  })
})
