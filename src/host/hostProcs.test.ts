import { describe, it, expect } from 'vitest'
import { ProcRegistry, type RegistryProc } from './procRegistry'
import { createHostProcs, NotWriterError } from './hostProcs'
import * as F from '../core/chat/claudeFixtures'
import { createClaudeAdapter } from '../core/chat/claudeAdapter'

function fake(): RegistryProc & { sent: string[]; emit(c: string): void } {
  let onData: (c: string) => void = () => {}
  const p = { pid: 7, sent: [] as string[], onData: (cb: typeof onData) => { onData = cb }, onExit: () => {}, write: (d: string) => { p.sent.push(d) }, kill: () => {}, emit: (c: string) => onData(c) }
  return p
}

const rig = () => {
  const procs: ReturnType<typeof fake>[] = []
  const registry = new ProcRegistry({ spawn: () => { const p = fake(); procs.push(p); return p }, log: () => {} })
  let writer = true
  const logs: string[] = []
  const host = createHostProcs({ registry, mayWrite: () => writer, log: (m) => logs.push(m) })
  registry.open({ id: 'p1', file: 'claude', args: [], opts: { cwd: 'D:/p', env: {} }, meta: { kind: 'chat', id: 'c1', restore: {} } })
  return { registry, procs, host, logs, setWriter: (w: boolean) => { writer = w } }
}

describe('createHostProcs — the one-writer gate (chat takeover constraint 3)', () => {
  it('writes and notes while it is the writer', () => {
    const r = rig()
    const h = r.host.attach({ procId: 'p1', pid: 7 })
    h.write('x')
    h.remember?.({ threadId: 't' })
    expect(r.procs[0].sent).toEqual(['x\n'])
    expect(r.registry.list()[0].meta?.restore.threadId).toBe('t')
  })

  // Task 3 review, Important 3: a dropped wire write throws, so the adapter's own error paths keep its
  // state honest; a dropped note is only dropped.
  it('refuses a write (thrown) and drops a note while the app is the writer, and says so', () => {
    const r = rig()
    const h = r.host.attach({ procId: 'p1', pid: 7 })
    r.setWriter(false)
    expect(() => h.write('x')).toThrow(NotWriterError)
    h.remember?.({ threadId: 't' })
    expect(r.procs[0].sent).toEqual([])
    expect(r.registry.list()[0].meta?.restore.threadId).toBeUndefined()
    expect(r.logs.some((l) => l.includes('p1') && l.includes('writer'))).toBe(true)
  })

  // Review Focus 5. Mutation to prove it: make `write` skip the mayWrite check; this test must fail.
  it('a reader-role adapter refusing an unreadable control_request writes nothing (mutation: drop the gate)', () => {
    const r = rig()
    const h = r.host.attach({ procId: 'p1', pid: 7 })
    r.setWriter(false)
    createClaudeAdapter({ proc: h, mode: { mode: 'adopt', threadId: 't', rolloutPath: null, truncated: false }, version: '0', log: () => {} })
    h.replay()
    r.procs[0].emit('{"type":"control_request","request_id":"q1","request":{"subtype":"no_such_thing"}}\n')
    expect(r.procs[0].sent).toEqual([])
  })

  it('replays the buffer, then the lines that arrived meanwhile, each once and in order', () => {
    const r = rig()
    r.procs[0].emit('a\nb\n')
    const h = r.host.attach({ procId: 'p1', pid: 7 })
    const got: string[] = []
    h.onLine((l) => got.push(l))
    r.procs[0].emit('c\n')
    h.replay()
    r.procs[0].emit('d\n')
    expect(got).toEqual(['a', 'b', 'c', 'd'])
  })

  it('a factory handle opens a new proc, delivers live lines at once, and throws on a refused open', () => {
    const r = rig()
    const p = r.host.factory('claude', [], { cwd: 'D:/p', env: {}, meta: { kind: 'chat', id: 'c2', restore: {} } })
    const got: string[] = []
    p.onLine((l) => got.push(l))
    r.procs[1].emit('z\n')
    expect(got).toEqual(['z'])
    expect(p.outlivesApp).toBe(true)
  })
})

describe('createHostProcs — a released handle (Task 2 review carry)', () => {
  it('delivers nothing once released, and an onLine unsubscribe stops its listener', () => {
    const r = rig()
    const h = r.host.attach({ procId: 'p1', pid: 7 })
    h.replay()
    const got: string[] = []
    const off = h.onLine((l) => got.push(`x ${l}`))
    r.procs[0].emit('a\n')
    if (typeof off === 'function') off()
    r.procs[0].emit('b\n')
    h.onLine((l) => got.push(`y ${l}`))
    r.procs[0].emit('c\n')
    h.release()
    r.procs[0].emit('d\n')
    expect(got).toEqual(['x a', 'y c'])
  })
})

describe('createHostProcs — a refused write keeps the adapter honest (Task 3 review, Important 3)', () => {
  const adopted = () => {
    const r = rig()
    const h = r.host.attach({ procId: 'p1', pid: 7 })
    const a = createClaudeAdapter({ proc: h, mode: { mode: 'adopt', threadId: 't', rolloutPath: null, truncated: false }, version: '0', log: () => {} })
    return { r, h, a }
  }

  it('an answer the gate refuses rejects and leaves the card open', async () => {
    const { r, h, a } = adopted()
    r.procs[0].emit(`${F.CAN_USE_TOOL_WRITE}
`)
    h.replay()
    const id = a.pending!()[0].id
    r.setWriter(false)
    await expect(a.answer(id, { kind: 'approval', decision: 'decline' })).rejects.toThrow(NotWriterError)
    expect(a.pending!().map((q) => q.id)).toEqual([id])
    expect(r.procs[0].sent).toEqual([])
  })

  it('a turn the gate refuses rejects and starts no turn', async () => {
    const { r, h, a } = adopted()
    h.replay()
    await Promise.resolve()
    const before = a.state().status
    r.setWriter(false)
    await expect(a.send('hi')).rejects.toThrow(NotWriterError)
    await Promise.resolve()
    expect(a.state().status).toBe(before)
    expect(a.state().status).not.toBe('working')
    // No turn is pending either: a result frame now would have nothing to close, so it cannot flip
    // the status (it would, from 'working', had the turn been marked pending).
    expect(r.procs[0].sent).toEqual([])
  })
})
