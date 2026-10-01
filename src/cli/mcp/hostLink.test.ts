import { describe, it, expect, vi } from 'vitest'
import type { HostConnection } from '../../core/host/connect'
import type { ClientMessage, HostMessage } from '../../core/host/protocol'
import { openHostLink } from './hostLink'

function fakeConn(features = ['orch', 'mcp']) {
  const listeners = new Set<(m: HostMessage) => void>()
  const closers = new Set<() => void>()
  const sent: ClientMessage[] = []
  const conn: HostConnection = {
    hello: { host: '9.9.9', pid: 1, startedAt: 't0', features },
    call: (m) => void sent.push(m),
    onMessage: (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    onClose: (cb) => (closers.add(cb), () => closers.delete(cb)),
    close: () => closers.forEach((c) => c())
  }
  return {
    conn,
    sent,
    push: (m: HostMessage) => listeners.forEach((l) => l(m)),
    drop: () => closers.forEach((c) => c())
  }
}

describe('openHostLink', () => {
  it('gives each call its own id and matches replies by it', async () => {
    const f = fakeConn()
    const link = openHostLink({ connect: async () => f.conn, startHost: async () => false, log: () => {} })
    const a = link.call('jobs-list', {})
    const b = link.call('projects-list', {})
    await new Promise((r) => setImmediate(r))
    const [ca, cb] = f.sent as Array<{ call: string }>
    expect(ca.call).not.toBe(cb.call)
    f.push({ t: 'orch-result', call: cb.call, status: 200, body: 'B' } as HostMessage)
    f.push({ t: 'orch-result', call: ca.call, status: 200, body: 'A' } as HostMessage)
    expect(await a).toMatchObject({ status: 200, body: 'A' })
    expect(await b).toMatchObject({ status: 200, body: 'B' })
  })

  it('ignores broadcasts', async () => {
    const f = fakeConn()
    const link = openHostLink({ connect: async () => f.conn, startHost: async () => false, log: () => {} })
    const p = link.call('jobs-list', {})
    await new Promise((r) => setImmediate(r))
    f.push({ t: 'orch-state', state: {}, version: 1 } as unknown as HostMessage)
    f.push({ t: 'orch-result', call: (f.sent[0] as { call: string }).call, status: 200, body: [] } as HostMessage)
    expect(await p).toMatchObject({ status: 200 })
  })

  it('passes the request id through', async () => {
    const f = fakeConn()
    const link = openHostLink({ connect: async () => f.conn, startHost: async () => false, log: () => {} })
    void link.call('jobs-create', { objective: 'x' }, 'req-1')
    await new Promise((r) => setImmediate(r))
    expect(f.sent[0]).toMatchObject({ t: 'orch-call', cmd: 'jobs-create', session: '', request: 'req-1' })
  })

  it('refuses a Host without the mcp feature', async () => {
    const f = fakeConn(['orch'])
    const link = openHostLink({ connect: async () => f.conn, startHost: async () => false, log: () => {} })
    expect(await link.call('jobs-list', {})).toMatchObject({ code: 'VERSION_MISMATCH' })
  })

  it('starts a Host when none answers, then connects', async () => {
    const f = fakeConn()
    let started = 0
    let tries = 0
    const link = openHostLink({
      connect: async () => (tries++ === 0 ? { error: 'unreachable' } : f.conn),
      startHost: async () => (started++, true),
      log: () => {}
    })
    const p = link.call('jobs-list', {})
    await new Promise((r) => setTimeout(r, 10))
    f.push({ t: 'orch-result', call: (f.sent[0] as { call: string }).call, status: 200, body: [] } as HostMessage)
    expect(await p).toMatchObject({ status: 200 })
    expect(started).toBe(1)
  })

  it('answers HOST_NOT_RUNNING when no Host answers and none can be started', async () => {
    const link = openHostLink({ connect: async () => ({ error: 'unreachable' }), startHost: async () => false, log: () => {} })
    expect(await link.call('jobs-list', {})).toMatchObject({ code: 'HOST_NOT_RUNNING' })
  })

  it('answers PERMISSION_DENIED for an impostor, and never starts a Host beside it', async () => {
    let started = 0
    const link = openHostLink({ connect: async () => ({ error: 'impostor' }), startHost: async () => (started++, true), log: () => {} })
    expect(await link.call('jobs-list', {})).toMatchObject({ code: 'PERMISSION_DENIED' })
    expect(started).toBe(0)
  })

  it('a close fails the pending call and the next call reconnects', async () => {
    const first = fakeConn()
    const second = fakeConn()
    const conns = [first.conn, second.conn]
    const link = openHostLink({ connect: async () => conns.shift()!, startHost: async () => false, log: () => {} })
    const p = link.call('jobs-list', {})
    await new Promise((r) => setImmediate(r))
    first.drop()
    expect(await p).toMatchObject({ code: 'HOST_NOT_RUNNING' })
    const q = link.call('jobs-list', {})
    await new Promise((r) => setImmediate(r))
    second.push({ t: 'orch-result', call: (second.sent[0] as { call: string }).call, status: 200, body: [] } as HostMessage)
    expect(await q).toMatchObject({ status: 200 })
  })

  it('two calls during the first connect share one attempt, and a failure is not reused', async () => {
    const f = fakeConn()
    let connects = 0
    const link = openHostLink({
      connect: async () => (connects++ === 0 ? { error: 'unreachable' } : f.conn),
      startHost: async () => false,
      log: () => {}
    })
    const [x, y] = await Promise.all([link.call('jobs-list', {}), link.call('jobs-list', {})])
    expect(x).toMatchObject({ code: 'HOST_NOT_RUNNING' })
    expect(y).toMatchObject({ code: 'HOST_NOT_RUNNING' })
    expect(connects).toBe(1)
    void link.call('jobs-list', {})
    await new Promise((r) => setImmediate(r))
    expect(connects).toBe(2)
    expect(f.sent).toHaveLength(1)
  })

  it('a call the Host never answers times out and a late reply is ignored', async () => {
    const f = fakeConn()
    const link = openHostLink({ connect: async () => f.conn, startHost: async () => false, log: () => {}, timeoutMs: 20 })
    const r = await link.call('jobs-list', {})
    expect(r).toMatchObject({ code: 'TIMEOUT' })
    expect((r as { message: string }).message).toContain('jobs-list')
    expect(() => f.push({ t: 'orch-result', call: (f.sent[0] as { call: string }).call, status: 200, body: [] } as HostMessage)).not.toThrow()
  })

  it('answers TIMEOUT at 50 s by default, before a client cuts the call at 60 s', async () => {
    vi.useFakeTimers()
    try {
      const f = fakeConn()
      const link = openHostLink({ connect: async () => f.conn, startHost: async () => false, log: () => {} })
      let r: unknown
      void link.call('runs-get', { id: 'run_1' }).then((x) => (r = x))
      await vi.advanceTimersByTimeAsync(49_999)
      expect(r).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1)
      expect(r).toMatchObject({ code: 'TIMEOUT' })
      expect((r as { message: string }).message).toContain('within 50 s')
      expect((r as { message: string }).message).toContain('re-read with a get_ tool')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a jobs-run that times out says the Run may still be starting and to check with get_job', async () => {
    const f = fakeConn()
    const link = openHostLink({ connect: async () => f.conn, startHost: async () => false, log: () => {}, timeoutMs: 20 })
    const r = (await link.call('jobs-run', { id: 'job_1' })) as { code: string; message: string }
    expect(r.code).toBe('TIMEOUT')
    expect(r.message).toContain('the Run may still be starting')
    expect(r.message).toContain('get_job')
  })

  it('after close, calls answer HOST_NOT_RUNNING without connecting', async () => {
    let connects = 0
    let started = 0
    const f = fakeConn()
    const link = openHostLink({ connect: async () => (connects++, f.conn), startHost: async () => (started++, true), log: () => {} })
    link.close()
    expect(await link.call('jobs-list', {})).toMatchObject({ code: 'HOST_NOT_RUNNING', message: 'the MCP server is shutting down' })
    expect(connects + started).toBe(0)
  })

  it('a call whose connection closed while it waited for it is not sent there', async () => {
    const f = fakeConn()
    const link = openHostLink({ connect: async () => f.conn, startHost: async () => false, log: () => {}, timeoutMs: 50 })
    const p = link.call('jobs-list', {})
    await new Promise((r) => setImmediate(r))
    f.push({ t: 'orch-result', call: (f.sent[0] as { call: string }).call, status: 200, body: [] } as HostMessage)
    await p
    // `call` runs up to `await mine` at once; the close lands before it resumes.
    const q = link.call('jobs-list', {}, 'req-2')
    f.drop()
    expect(await q).toMatchObject({ code: 'HOST_NOT_RUNNING', message: expect.stringContaining('retry with the same requestId') })
    expect(f.sent).toHaveLength(1)
  })

  it('a stale connection closing does not fail calls pending on the current one', async () => {
    const first = fakeConn()
    const second = fakeConn()
    const conns = [first.conn, second.conn]
    const link = openHostLink({ connect: async () => conns.shift()!, startHost: async () => false, log: () => {} })
    const p = link.call('jobs-list', {})
    await new Promise((r) => setImmediate(r))
    first.drop()
    await p
    const q = link.call('jobs-list', {})
    await new Promise((r) => setImmediate(r))
    first.drop()
    const third = link.call('jobs-list', {})
    await new Promise((r) => setImmediate(r))
    expect(second.sent).toHaveLength(2)
    for (const m of second.sent as Array<{ call: string }>) second.push({ t: 'orch-result', call: m.call, status: 200, body: [] } as HostMessage)
    expect(await q).toMatchObject({ status: 200 })
    expect(await third).toMatchObject({ status: 200 })
  })
})
