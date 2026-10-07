import { describe, it, expect } from 'vitest'
import { openRemoteLink, RECONNECT_STEPS_MS, type RemoteTarget } from './link'
import { RemoteError, type CallReply, type RuntimeLink } from './client'
import type { HelloFrame } from './frames'

const target: RemoteTarget = { runtimeId: 'rt_a', address: '10.0.0.2', port: 47831, fingerprint: 'F'.repeat(43), token: 'tok' }
const hello = (over: Partial<HelloFrame> = {}): HelloFrame => ({
  t: 'hello', runtimeId: 'rt_a', displayName: 'Office', asteraVersion: '1.4.8', hostProtocol: 4, gatewayProtocol: 1, bootId: 'boot1',
  platform: 'win32', pathStyle: 'windows', permission: 'full-control', capabilities: [], ...over
})

type Sent = { cmd: string; args: Record<string, unknown>; o?: { request?: string; retry?: true } }
/** A scripted Runtime: each connection answers calls through `answer`, which may drop the connection instead. */
function fakeRuntime(o: {
  connectFails?: (n: number) => Error | null
  hello?: HelloFrame
  authFails?: RemoteError
  answer?: (s: Sent, conn: number) => CallReply | 'drop' | 'hang' | RemoteError | { dropWith: string }
  connectHangs?: (n: number) => boolean
}) {
  const sent: Array<Sent & { conn: number }> = []
  let conns = 0
  let auths = 0
  const connect = async (): Promise<RuntimeLink> => {
    const n = ++conns
    const fail = o.connectFails?.(n) ?? null
    if (fail) throw fail
    if (o.connectHangs?.(n)) await new Promise(() => {})
    let closeIt!: (v: { code?: string }) => void
    const closed = new Promise<{ code?: string }>((r) => (closeIt = r))
    let gone = false
    const waiting: Array<(e: Error) => void> = []
    const link: RuntimeLink = {
      auth: async () => {
        auths++
        if (o.authFails) throw o.authFails
        return o.hello ?? hello()
      },
      redeem: async () => ({ clientId: 'c', token: 't' }),
      call: (cmd, args, co) =>
        new Promise((resolve, reject) => {
          if (gone) return reject(new RemoteError('RUNTIME_OFFLINE', 'closed'))
          const s = { cmd, args, ...(co ? { o: co } : {}) }
          sent.push({ ...s, conn: n })
          const a = o.answer ? o.answer(s, n) : { status: 200, body: { ok: true } }
          if (a === 'hang') return
          if (a === 'drop' || (typeof a === 'object' && 'dropWith' in a)) {
            gone = true
            const code = a === 'drop' ? 'RUNTIME_OFFLINE' : a.dropWith
            reject(Object.assign(new RemoteError(code, 'the connection to the Runtime closed'), { lost: true }))
            for (const w of waiting.splice(0)) w(new RemoteError('RUNTIME_OFFLINE', 'closed'))
            closeIt({})
            return
          }
          if (a instanceof RemoteError) return reject(a)
          resolve(a)
        }),
      close: () => {
        gone = true
        closeIt({})
      },
      closed
    }
    return link
  }
  return { connect, sent, conns: () => conns, auths: () => auths }
}

const fastLink = (rt: ReturnType<typeof fakeRuntime>, over: Partial<Parameters<typeof openRemoteLink>[0]> = {}) => {
  const sleeps: number[] = []
  let clock = 0
  const link = openRemoteLink({
    target,
    client: { surface: 'cli' },
    connect: rt.connect as never,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    random: () => 0.5,
    now: () => clock,
    reconnectForMs: 60_000,
    ...over
  })
  return { link, sleeps, advance: (ms: number) => void (clock += ms) }
}

describe('openRemoteLink (remote runtime design §2.8, §3.9)', () => {
  it('signs in once at the first call and reuses the connection', async () => {
    const rt = fakeRuntime({})
    const { link } = fastLink(rt)
    expect(await link.call('jobs-list', {})).toEqual({ status: 200, body: { ok: true } })
    expect(await link.call('runs-list', {})).toEqual({ status: 200, body: { ok: true } })
    expect(rt.conns()).toBe(1)
    expect(rt.auths()).toBe(1)
    expect(link.hello()).toMatchObject({ runtimeId: 'rt_a', bootId: 'boot1' })
  })

  it('refuses a Runtime of another remote protocol before any call, naming both', async () => {
    const rt = fakeRuntime({ hello: hello({ gatewayProtocol: 2 }) })
    const { link } = fastLink(rt)
    const r = await link.call('jobs-list', {})
    expect(r).toMatchObject({ code: 'RUNTIME_PROTOCOL_MISMATCH' })
    expect((r as RemoteError).message).toMatch(/2.*1|1.*2/)
    expect(rt.sent).toEqual([])
  })

  it('a different key is RUNTIME_IDENTITY_CHANGED, and is not retried', async () => {
    const rt = fakeRuntime({ connectFails: () => Object.assign(new Error('different identity'), { code: 'RUNTIME_IDENTITY_CHANGED' }) })
    const { link, sleeps } = fastLink(rt)
    expect(await link.call('jobs-list', {})).toMatchObject({ code: 'RUNTIME_IDENTITY_CHANGED' })
    expect(rt.conns()).toBe(1)
    expect(sleeps).toEqual([])
  })

  it('a revoked pairing is RUNTIME_AUTH_FAILED, and is not retried', async () => {
    const rt = fakeRuntime({ authFails: new RemoteError('RUNTIME_AUTH_FAILED', 'unknown token') })
    const { link } = fastLink(rt)
    expect(await link.call('jobs-list', {})).toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
    expect(rt.conns()).toBe(1)
  })

  it('a change whose connection drops is sent again with its request id and retry: true', async () => {
    const rt = fakeRuntime({ answer: (_s, conn) => (conn === 1 ? 'drop' : { status: 200, body: { id: 'job_1' }, replayed: true }) })
    const { link } = fastLink(rt)
    const r = await link.call('jobs-create', { cwd: 'C:/p' }, { request: 'req-1' })
    expect(r).toEqual({ status: 200, body: { id: 'job_1' }, replayed: true })
    expect(rt.sent.map((s) => ({ conn: s.conn, o: s.o }))).toEqual([
      { conn: 1, o: { request: 'req-1' } },
      { conn: 2, o: { request: 'req-1', retry: true } }
    ])
  })

  it('a read whose connection drops is simply sent again, with no request id', async () => {
    const rt = fakeRuntime({ answer: (_s, conn) => (conn === 1 ? 'drop' : { status: 200, body: [] }) })
    const { link } = fastLink(rt)
    expect(await link.call('jobs-list', {})).toEqual({ status: 200, body: [] })
    expect(rt.sent.map((s) => s.o)).toEqual([undefined, undefined])
  })

  it('out of reconnect time: a change is RUNTIME_OUTCOME_UNKNOWN, a read RUNTIME_OFFLINE', async () => {
    const down = (n: number) => (n === 1 ? null : Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }))
    const rt = fakeRuntime({ connectFails: down, answer: () => 'drop' })
    const { link } = fastLink(rt)
    const r = await link.call('jobs-run', { id: 'job_1' }, { request: 'req-2' })
    expect(r).toMatchObject({ code: 'RUNTIME_OUTCOME_UNKNOWN' })
    const rt2 = fakeRuntime({ connectFails: down, answer: () => 'drop' })
    expect(await fastLink(rt2).link.call('jobs-list', {})).toMatchObject({ code: 'RUNTIME_OFFLINE' })
  })

  it('a Runtime that never answered a change is RUNTIME_OFFLINE: nothing was sent', async () => {
    const rt = fakeRuntime({ connectFails: () => Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    const { link } = fastLink(rt)
    expect(await link.call('jobs-run', { id: 'job_1' }, { request: 'req-3' })).toMatchObject({ code: 'RUNTIME_OFFLINE' })
  })

  it('backs off 1 s, 2 s, 5 s, 10 s, then 30 s, with jitter around each', async () => {
    const rt = fakeRuntime({ connectFails: (n) => (n === 1 ? null : Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' })), answer: () => 'drop' })
    const jitters = [0, 0.99, 0.5, 0.25, 0.75, 0.5]
    let i = 0
    const { link, sleeps } = fastLink(rt, { random: () => jitters[i++ % jitters.length], reconnectForMs: 100_000 })
    await link.call('jobs-list', {})
    expect(sleeps.length).toBeGreaterThanOrEqual(5)
    sleeps.slice(0, 5).forEach((ms, k) => {
      const base = RECONNECT_STEPS_MS[k]
      expect(ms, `step ${k}`).toBeGreaterThanOrEqual(base * 0.5)
      expect(ms, `step ${k}`).toBeLessThanOrEqual(Math.min(base * 1.5, 30_000))
    })
  })

  it('a reply that does not come in time is REMOTE_TIMEOUT', async () => {
    const rt = fakeRuntime({ answer: () => 'hang' })
    const { link } = fastLink(rt, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) })
    expect(await link.call('jobs-list', {}, { timeoutMs: 20 })).toMatchObject({ code: 'REMOTE_TIMEOUT' })
  })

  it("the Runtime's own refusal of a call is its answer, not a lost connection", async () => {
    const rt = fakeRuntime({ answer: () => new RemoteError('RUNTIME_BUSY', 'too many calls') })
    const { link } = fastLink(rt)
    expect(await link.call('jobs-list', {})).toMatchObject({ code: 'RUNTIME_BUSY' })
    expect(rt.sent).toHaveLength(1)
  })

  // Final review C1: a connection the Gateway closed with a code (busy, silent, bad frame) lost the call; it is not the
  // Runtime's answer to it.
  it('a change whose connection was closed with a code is sent again as a retry, not answered with that code', async () => {
    const rt = fakeRuntime({ answer: (_s, conn) => (conn === 1 ? { dropWith: 'RUNTIME_BUSY' } : { status: 200, body: { id: 'job_1' }, replayed: true }) })
    const { link } = fastLink(rt)
    expect(await link.call('jobs-run', { id: 'job_1' }, { request: 'req-9' })).toEqual({ status: 200, body: { id: 'job_1' }, replayed: true })
    expect(rt.sent.map((x) => x.o)).toEqual([{ request: 'req-9' }, { request: 'req-9', retry: true }])
  })

  it('a revocation that closes the connection mid-call is final', async () => {
    const rt = fakeRuntime({ answer: () => ({ dropWith: 'RUNTIME_AUTH_FAILED' }) })
    const { link } = fastLink(rt)
    expect(await link.call('jobs-run', { id: 'job_1' }, { request: 'req-10' })).toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
    expect(rt.conns()).toBe(1)
  })

  // Final review I1: the reconnect window starts at the loss, not at the call.
  it('a long call that drops late still gets its whole reconnect window', async () => {
    let h!: ReturnType<typeof fastLink>
    const rt = fakeRuntime({
      connectFails: (n) => (n === 2 ? Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) : null),
      answer: (_s, conn) => {
        if (conn === 1) {
          h.advance(10 * 60_000)
          return 'drop'
        }
        return { status: 200, body: { merged: true } }
      }
    })
    h = fastLink(rt)
    expect(await h.link.call('run-merge', { run: 'r' }, { request: 'req-11' })).toEqual({ status: 200, body: { merged: true } })
  })

  // Final review I3: a Runtime that is not there says so at once, and a hung connect does not hang the call.
  it('a fresh call to a Runtime that cannot be reached is RUNTIME_OFFLINE at once, with no backoff', async () => {
    const rt = fakeRuntime({ connectFails: () => Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    const { link, sleeps } = fastLink(rt)
    expect(await link.call('jobs-list', {})).toMatchObject({ code: 'RUNTIME_OFFLINE' })
    expect(sleeps).toEqual([])
    expect(rt.conns()).toBe(1)
  })

  it('a connect that never completes is RUNTIME_OFFLINE after the connect timeout', async () => {
    const rt = fakeRuntime({ connectHangs: () => true })
    const { link } = fastLink(rt, { connectTimeoutMs: 20 })
    expect(await link.call('jobs-list', {})).toMatchObject({ code: 'RUNTIME_OFFLINE' })
  })

  it('a reply timeout drops the connection, so the next call opens a new one', async () => {
    const rt = fakeRuntime({ answer: (_s, conn) => (conn === 1 ? 'hang' : { status: 200, body: [] }) })
    const { link } = fastLink(rt)
    expect(await link.call('jobs-list', {}, { timeoutMs: 20 })).toMatchObject({ code: 'REMOTE_TIMEOUT' })
    expect(await link.call('jobs-list', {})).toEqual({ status: 200, body: [] })
    expect(rt.conns()).toBe(2)
  })

  // A retry that finds its own first attempt still running (409 with its request id) asks again until it is done.
  it('a retry answered "already running" waits and asks again, and gets the replay', async () => {
    let asks = 0
    const rt = fakeRuntime({
      answer: (_s, conn) => {
        if (conn === 1) return 'drop'
        asks++
        return asks < 3 ? { status: 409, body: { error: 'request req-12 is already running', requestId: 'req-12' } } : { status: 200, body: { id: 'job_1' }, replayed: true }
      }
    })
    const { link, sleeps } = fastLink(rt)
    expect(await link.call('run-merge', { run: 'r' }, { request: 'req-12' })).toEqual({ status: 200, body: { id: 'job_1' }, replayed: true })
    expect(sleeps.length).toBe(2)
    expect(rt.sent.slice(1).every((x) => x.o?.retry === true)).toBe(true)
  })
})
