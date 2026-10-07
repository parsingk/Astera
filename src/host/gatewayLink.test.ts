import { describe, it, expect } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import { attachGatewayLink } from './gatewayLink'
import { createControllerRegistry, sha256Base64url } from './controllers'
import type { OrchCaller } from '../core/host/orchProtocol'

const HELLO = {
  runtimeId: 'rt',
  displayName: 'd',
  asteraVersion: '9.9.9',
  hostProtocol: 4,
  gatewayProtocol: 1,
  bootId: 'b',
  platform: 'win32',
  pathStyle: 'windows' as const,
  capabilities: ['remote.jobs']
}

type Seen = { cmd: string; args: Record<string, unknown>; sessionId: string; from?: OrchCaller; request?: string; retry?: true }

const setup = async (o: { hardCap?: number; output?: Writable; orch?: (c: Seen) => Promise<{ status: number; body: unknown }> } = {}) => {
  const input = new PassThrough()
  const output = o.output ?? new PassThrough()
  const frames: Array<Record<string, unknown>> = []
  if (!o.output) output.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => frames.push(JSON.parse(l))))
  const controllers = createControllerRegistry()
  const calls: Seen[] = []
  const logs: string[] = []
  const events: string[] = []
  const link = attachGatewayLink({
    linkGen: 1,
    input,
    output,
    controllers,
    orch: {
      call: async (c) => {
        calls.push(c as Seen)
        return o.orch ? o.orch(c as Seen) : { status: 200, body: { ok: c.cmd } }
      }
    },
    hello: () => HELLO,
    log: (m) => logs.push(m),
    onReady: () => events.push('ready'),
    onFailed: (f) => events.push(`failed:${f.code}`),
    onHardCap: () => events.push('hardcap'),
    ...(o.hardCap ? { hardCap: o.hardCap } : {})
  })
  const send = (m: unknown): void => void input.write(`${JSON.stringify(m)}\n`)
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))
  const pairClient = async (permission: 'read-only' | 'full-control' = 'read-only') => {
    const got = await controllers.redeem(controllers.createPairing({ permission }).code, 'laptop')
    if (!got.ok) throw new Error('redeem')
    return got
  }
  return { link, input, output, frames, controllers, calls, logs, events, send, settle, pairClient }
}

describe('attachGatewayLink (remote runtime design §2.4, §3.3)', () => {
  it('binds a connection whose token hash is paired and answers the hello with the record’s permission', async () => {
    const s = await setup()
    const c = await s.pairClient('read-only')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    s.send({ t: 'auth', conn: 'c2', tokenHash: sha256Base64url('nope') })
    await s.settle()
    expect(s.frames).toEqual([
      { t: 'authed', conn: 'c1', ok: true, hello: { t: 'hello', ...HELLO, permission: 'read-only' } },
      { t: 'authed', conn: 'c2', ok: false }
    ])
    expect(s.controllers.principalFor(1, 'c1')).toMatchObject({ clientId: c.clientId })
  })
  it('runs a call as the bound principal only, whatever the frame claimed (Review Focus 1)', async () => {
    const s = await setup()
    const c = await s.pairClient('full-control')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    s.send({ t: 'call', conn: 'c1', id: '1', cmd: 'runs-stop', args: { id: 'r' }, role: 'app', permission: 'full-control', session: 'coord', request: 'r-1' })
    await s.settle()
    expect(s.calls).toHaveLength(1)
    expect(s.calls[0]).toMatchObject({ cmd: 'runs-stop', args: { id: 'r' }, sessionId: '', request: 'r-1' })
    expect(s.calls[0].from).toMatchObject({ role: 'controller', principal: { clientId: c.clientId, name: 'laptop', permission: 'full-control' } })
    expect(s.frames.at(-1)).toEqual({ t: 'result', conn: 'c1', id: '1', status: 200, body: { ok: 'runs-stop' } })
  })
  it('answers a call on a connection nobody bound with RUNTIME_AUTH_FAILED, running nothing', async () => {
    const s = await setup()
    s.send({ t: 'call', conn: 'c9', id: '1', cmd: 'jobs-list', args: {} })
    await s.settle()
    expect(s.calls).toHaveLength(0)
    expect(s.frames).toEqual([{ t: 'result', conn: 'c9', id: '1', status: 401, body: { error: 'this connection is not authenticated', code: 'RUNTIME_AUTH_FAILED' } }])
  })
  it('drops the reply of a call whose client was revoked while it ran', async () => {
    let finish!: (r: { status: number; body: unknown }) => void
    const s = await setup({ orch: () => new Promise((r) => (finish = r)) })
    const c = await s.pairClient('full-control')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    s.send({ t: 'call', conn: 'c1', id: '1', cmd: 'jobs-list', args: {} })
    await s.settle()
    await s.controllers.revoke(c.clientId)
    finish({ status: 200, body: {} })
    await s.settle()
    expect(s.frames.filter((f) => f.t === 'result')).toEqual([])
  })
  it('pairs a redeem without writing the code or the token to its log', async () => {
    const s = await setup()
    const { code } = s.controllers.createPairing({ permission: 'read-only' })
    s.send({ t: 'redeem', conn: 'c1', code, name: 'laptop' })
    s.send({ t: 'redeem', conn: 'c2', code: 'WRONGWRONG', name: 'x' })
    await s.settle()
    const ok = s.frames.find((f) => f.conn === 'c1')!
    expect(ok).toMatchObject({ t: 'redeemed', ok: true, clientId: expect.any(String), token: expect.any(String) })
    expect(s.frames.find((f) => f.conn === 'c2')).toEqual({ t: 'redeemed', conn: 'c2', ok: false, reason: 'unknown' })
    expect(s.logs.join('\n')).not.toContain(code)
    expect(s.logs.join('\n')).not.toContain(ok.token as string)
  })
  it('closes the connections it is told to, and forgets a closed one', async () => {
    const s = await setup()
    const c = await s.pairClient()
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    await s.settle()
    s.link.closeConns([{ linkGen: 1, conn: 'c1' }, { linkGen: 0, conn: 'old' }])
    await s.settle()
    expect(s.frames.at(-1)).toEqual({ t: 'close-conn', conn: 'c1', code: 'RUNTIME_AUTH_FAILED' })
    expect(s.frames.filter((f) => f.t === 'close-conn')).toHaveLength(1)
    s.send({ t: 'conn-closed', conn: 'c1' })
    await s.settle()
    expect(s.controllers.principalFor(1, 'c1')).toBeNull()
  })
  it('reports ready and failed, and refuses a frame the Gateway may not send', async () => {
    const s = await setup()
    s.send({ t: 'gateway-ready', port: 1, address: '127.0.0.1', fingerprint: 'f' })
    s.send({ t: 'gateway-failed', code: 'BIND_IN_USE', message: 'm' })
    s.send({ t: 'state-put', conn: 'c1', state: {} })
    await s.settle()
    expect(s.events).toEqual(['ready', 'failed:BIND_IN_USE'])
    expect(s.logs.some((l) => /refused a link frame/.test(l))).toBe(true)
    expect(s.calls).toHaveLength(0)
  })
  it('asks for the Gateway to be killed when its output to it passes the hard cap (Review Focus 2)', async () => {
    const never = new Writable({ highWaterMark: 1, write: () => {} })
    const s = await setup({ output: never, hardCap: 2000 })
    const c = await s.pairClient()
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    for (let i = 0; i < 40; i++) s.send({ t: 'call', conn: 'c1', id: String(i), cmd: 'jobs-list', args: {} })
    await s.settle()
    expect(s.events).toContain('hardcap')
  })
  it('asks for the Gateway to be killed when it sends a line over the cap', async () => {
    const s = await setup()
    s.input.write('x'.repeat((1 << 20) + 2048))
    await s.settle()
    expect(s.events).toContain('hardcap')
  })
  it('drops every binding of its generation when detached', async () => {
    const s = await setup()
    const c = await s.pairClient()
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    await s.settle()
    s.link.detach()
    expect(s.controllers.principalFor(1, 'c1')).toBeNull()
  })
})
