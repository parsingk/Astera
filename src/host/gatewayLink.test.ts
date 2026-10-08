import { describe, it, expect, vi } from 'vitest'
import { PassThrough, Writable } from 'node:stream'
import { CONNS_PER_CLIENT, SUBS_PER_CONN, attachGatewayLink } from './gatewayLink'
import { createControllerRegistry, sha256Base64url } from './controllers'
import type { OrchCaller } from '../core/host/orchProtocol'
import { PtyRegistry, type RegistryPty } from './registry'

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

const setup = async (o: { hardCap?: number; output?: Writable; orch?: (c: Seen) => Promise<{ status: number; body: unknown }>; ptys?: PtyRegistry; streamPerKey?: number; controllers?: ReturnType<typeof createControllerRegistry>; replyMax?: number } = {}) => {
  const input = new PassThrough()
  const output = o.output ?? new PassThrough()
  const frames: Array<Record<string, unknown>> = []
  if (!o.output) output.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach((l) => frames.push(JSON.parse(l))))
  const controllers = o.controllers ?? createControllerRegistry()
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
    ...(o.hardCap ? { hardCap: o.hardCap } : {}),
    ...(o.ptys ? { ptys: o.ptys } : {}),
    ...(o.streamPerKey ? { streamPerKey: o.streamPerKey } : {}),
    ...(o.replyMax ? { replyMax: o.replyMax } : {})
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
  // Second pass RR-7: a sign-in that arrived while the Host was still reading its paired clients (right after a restart,
  // the secret store's checks take a while on Windows) was refused as final, and the controller gave up.
  it('answers a sign-in that arrives while the paired clients are still loading once they are loaded', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const controllers = createControllerRegistry({
      records: {
        load: async () => {
          await gate
          return [{ clientId: 'cli_1', name: 'laptop', tokenHash: sha256Base64url('tok'), permission: 'read-only', createdAt: '2026-10-08T00:00:00.000Z', lastSeenAt: null }]
        },
        save: async () => {}
      }
    })
    void controllers.load()
    const s = await setup({ controllers })
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url('tok') })
    await s.settle()
    release()
    await s.settle()
    expect(s.frames).toMatchObject([{ t: 'authed', conn: 'c1', ok: true }])
  })

  // Security audit SEC-2: one paired client, even read-only, could hold every signed-in slot with idle connections.
  it(`a client already on CONNS_PER_CLIENT connections is answered busy`, async () => {
    const s = await setup()
    const c = await s.pairClient('read-only')
    for (let i = 0; i <= CONNS_PER_CLIENT; i++) s.send({ t: 'auth', conn: `c${i}`, tokenHash: sha256Base64url(c.token) })
    await s.settle()
    const answers = s.frames.filter((f) => f.t === 'authed')
    expect(answers.filter((f) => f.ok === true)).toHaveLength(CONNS_PER_CLIENT)
    expect(answers[CONNS_PER_CLIENT]).toEqual({ t: 'authed', conn: `c${CONNS_PER_CLIENT}`, ok: false, code: 'RUNTIME_BUSY' })
    s.send({ t: 'conn-closed', conn: 'c0' })
    s.send({ t: 'auth', conn: 'again', tokenHash: sha256Base64url(c.token) })
    await s.settle()
    expect(s.frames.at(-1)).toMatchObject({ t: 'authed', conn: 'again', ok: true })
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
  // Phase 3 minor: nobody is left to receive the token, so the record it would unlock is removed again.
  it('removes the client record of a pairing that completed after its connection closed', async () => {
    const s = await setup()
    const code = s.controllers.createPairing({ permission: 'read-only' }).code
    s.input.write(`${JSON.stringify({ t: 'redeem', conn: 'c9', code, name: 'laptop' })}
${JSON.stringify({ t: 'conn-closed', conn: 'c9' })}
`)
    await s.settle()
    expect(s.controllers.list()).toEqual([])
    expect(s.frames.some((f) => f.t === 'redeemed')).toBe(false)
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
    // Results wait on their own lane up to its budget (SEC-1); past it their refusals fill the control lane.
    const s = await setup({ output: never, hardCap: 2000, replyMax: 1000 })
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

describe('large replies on the link (Phase 3 review C1)', () => {
  it('sends a result over 512 KiB as chunk frames that each fit the link cap', async () => {
    const body = { big: 'a'.repeat(1_600_000) }
    const s = await setup({ orch: async () => ({ status: 200, body }) })
    const c = await s.pairClient()
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    s.send({ t: 'call', conn: 'c1', id: '1', cmd: 'state-get', args: {} })
    await new Promise((r) => setTimeout(r, 100))
    const chunks = s.frames.filter((f) => f.t === 'chunk')
    expect(chunks.length).toBeGreaterThanOrEqual(3)
    for (const f of chunks) expect(JSON.stringify(f).length).toBeLessThan(1 << 20)
    expect(chunks.every((f) => f.conn === 'c1')).toBe(true)
    expect(s.frames.some((f) => f.t === 'result')).toBe(false)
  })

  // Security audit SEC-1: the chunks went on the control lane, so a reply of 6 MiB or more, or 32 replies of 400 KiB at
  // once, passed the 8 MiB hard cap and the Host killed its Gateway: every controller cut off, by a read-only one.
  const slowGateway = () => {
    const out = new Writable({ highWaterMark: 16 * 1024, write: (_c, _e, cb) => void setImmediate(cb) })
    const lines: Array<Record<string, unknown>> = []
    let carry = ''
    const write = out.write.bind(out)
    out.write = ((chunk: string, ...rest: unknown[]) => {
      const parts = (carry + String(chunk)).split(String.fromCharCode(10))
      carry = parts.pop() ?? ''
      parts.filter(Boolean).forEach((l) => lines.push(JSON.parse(l)))
      return (write as (c: string, ...r: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof out.write
    return { out, lines }
  }
  const joined = (lines: Array<Record<string, unknown>>): Map<string, string> => {
    const by = new Map<string, Buffer[]>()
    for (const f of lines) if (f.t === 'chunk') by.set(f.ref as string, [...(by.get(f.ref as string) ?? []), Buffer.from(f.data as string, 'base64')])
    return new Map([...by].map(([k, v]) => [k, Buffer.concat(v).toString('utf8')]))
  }
  it('a 7 MiB result arrives whole, and the Gateway is not killed', async () => {
    const g = slowGateway()
    const s = await setup({ output: g.out, orch: async () => ({ status: 200, body: { big: 'a'.repeat(7 << 20) } }) })
    const c = await s.pairClient('read-only')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    s.send({ t: 'call', conn: 'c1', id: '1', cmd: 'state-get', args: {} })
    await vi.waitFor(() => expect(g.lines.filter((f) => f.t === 'chunk').length).toBe(Math.ceil(((7 << 20) + 80) / (512 * 1024))), { timeout: 10_000, interval: 10 })
    expect(s.events).not.toContain('hardcap')
    const [whole] = [...joined(g.lines).values()]
    expect((JSON.parse(whole) as { body: { big: string } }).body.big.length).toBe(7 << 20)
  })
  it('32 results of 400 KiB at once all arrive, and the Gateway is not killed', async () => {
    const g = slowGateway()
    const s = await setup({ output: g.out, orch: async () => ({ status: 200, body: { big: 'b'.repeat(400 * 1024) } }) })
    const c = await s.pairClient('read-only')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    for (let i = 0; i < 32; i++) s.send({ t: 'call', conn: 'c1', id: String(i), cmd: 'jobs-list', args: {} })
    await vi.waitFor(() => expect(g.lines.filter((f) => f.t === 'result' || f.t === 'chunk').length).toBeGreaterThanOrEqual(32), { timeout: 10_000, interval: 10 })
    await new Promise((r) => setTimeout(r, 200))
    expect(s.events).not.toContain('hardcap')
  })
  it('a result past the replies’ budget is answered RUNTIME_BUSY instead', async () => {
    const lines: Array<Record<string, unknown>> = []
    const held: Array<() => void> = []
    let carry = ''
    const out = new Writable({
      highWaterMark: 1,
      write: (chunk: Buffer, _e, cb) => {
        const parts = (carry + chunk.toString()).split(String.fromCharCode(10))
        carry = parts.pop() ?? ''
        parts.filter(Boolean).forEach((l) => lines.push(JSON.parse(l)))
        held.push(cb)
      }
    })
    const s = await setup({ output: out, replyMax: 2 << 20, orch: async () => ({ status: 200, body: { big: 'c'.repeat(1 << 20) } }) })
    const c = await s.pairClient('read-only')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    await s.settle()
    for (let i = 0; i < 4; i++) s.send({ t: 'call', conn: 'c1', id: String(i), cmd: 'jobs-list', args: {} })
    await s.settle()
    for (let i = 0; i < 40; i++) {
      held.splice(0).forEach((cb) => cb())
      await new Promise((r) => setImmediate(r))
    }
    expect(s.events).not.toContain('hardcap')
    const busy = lines.filter((f) => f.t === 'result' && f.status === 503)
    expect(busy.length).toBeGreaterThan(0)
    expect(busy[0]).toMatchObject({ body: { code: 'RUNTIME_BUSY' } })
  })
})

// Remote runtime design §3.7 (Phase 8): a paired controller subscribes to a pty and gets a checkpoint or the events
// from its seq, then live output; an overflow ends the stream with OUTPUT_GAP; a closed connection drops its streams.
describe('attachGatewayLink pty subscriptions (Phase 8)', () => {
  const ptyRig = () => {
    let emit: (d: string) => void = () => {}
    let exit: (e: { exitCode: number }) => void = () => {}
    const pty: RegistryPty = {
      pid: 1,
      onData: (cb) => void (emit = cb),
      onExit: (cb) => void (exit = cb),
      write: () => {},
      resize: () => {},
      kill: () => {},
      pause: () => {},
      resume: () => {}
    }
    const registry = new PtyRegistry({ spawn: () => pty, log: () => {}, bootId: 'boot-1' })
    registry.open({ id: 'p1', file: 'sh', args: [], opts: { cwd: 'D:/p', cols: 40, rows: 5, env: {} } })
    return { registry, emit: (d: string) => emit(d), exit: (c: number) => exit({ exitCode: c }) }
  }
  const ready = async (o: { streamPerKey?: number } = {}) => {
    const p = ptyRig()
    const s = await setup({ ptys: p.registry, ...o })
    const c = await s.pairClient('read-only')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    await s.settle()
    s.frames.length = 0
    return { ...s, ...p }
  }
  const of = (frames: Array<Record<string, unknown>>, t: string) => frames.filter((f) => f.t === t)
  /** Waits for a condition rather than a fixed time: the first live terminal loads @xterm/headless, which a loaded CI
   *  runner takes far longer than 20 ms to do (Windows CI, 2026-10-08). */
  const eventually = (check: () => void): Promise<void> => vi.waitFor(check, { timeout: 10_000, interval: 10 })

  it('a read-only controller subscribes: subscribed, then a checkpoint with the gap, then live output', async () => {
    const s = await ready()
    s.emit('before')
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1' })
    await eventually(() => expect(of(s.frames, 'checkpoint')).toHaveLength(1))
    expect(of(s.frames, 'subscribed')).toEqual([{ t: 'subscribed', conn: 'c1', sub: 's1', pty: 'p1', bootId: 'boot-1' }])
    const [cp] = of(s.frames, 'checkpoint') as Array<{ checkpoint: { watermark: number; state: string }; gap: unknown }>
    expect(cp.checkpoint.watermark).toBe(1)
    expect(cp.checkpoint.state).toContain('before')
    expect(cp.gap).toEqual({ firstSeq: 1, lastSeq: 1 })
    s.emit('after')
    await eventually(() => expect(of(s.frames, 'pty-out')).toEqual([{ t: 'pty-out', conn: 'c1', sub: 's1', events: [{ seq: 2, kind: 'data', data: 'after' }] }]))
  })

  // Phase 8 review I3: a checkpoint is stream output, not control: a large one never trips the link's hard cap.
  it('a checkpoint larger than the control cap goes on the stream lane and arrives whole', async () => {
    const p = ptyRig()
    // A Gateway that takes each line slowly, so what waits on the link is counted against the caps.
    const out = new Writable({ highWaterMark: 1, write: (_c, _e, cb) => void setTimeout(cb, 5) })
    const lines: Array<Record<string, unknown>> = []
    const write = out.write.bind(out)
    out.write = ((chunk: string, ...rest: unknown[]) => {
      String(chunk).split(String.fromCharCode(10)).filter(Boolean).forEach((l) => lines.push(JSON.parse(l)))
      return (write as (c: string, ...r: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof out.write
    const s = await setup({ ptys: p.registry, hardCap: 64 * 1024, output: out })
    const c = await s.pairClient('read-only')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    await s.settle()
    // A colour change on every cell: the serialized screen carries an SGR per cell, well over the 64 KiB cap.
    const E = String.fromCharCode(27)
    const row = Array.from({ length: 35 }, (_, x) => `${E}[3${x % 8}mw`).join('')
    for (let i = 0; i < 1000; i++) p.emit(row + String.fromCharCode(13, 10))
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1' })
    await eventually(() => expect(of(lines, 'checkpoint')).toHaveLength(1))
    expect(s.events).not.toContain('hardcap')
    const [cp] = of(lines, 'checkpoint') as Array<{ checkpoint: { state: string } }>
    expect(cp.checkpoint.state.length).toBeGreaterThan(64 * 1024)
  })

  it('a held fromSeq on the same boot replays the events and no checkpoint', async () => {
    const s = await ready()
    s.emit('one')
    s.emit('two')
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1', fromSeq: 2, bootId: 'boot-1' })
    await eventually(() => expect(of(s.frames, 'pty-out')).toHaveLength(1))
    expect(of(s.frames, 'checkpoint')).toEqual([])
    expect(of(s.frames, 'pty-out').flatMap((f) => (f.events as Array<{ seq: number }>).map((e) => e.seq))).toEqual([2])
  })

  it('a cursor from an earlier boot gets a checkpoint (OUTPUT_GAP)', async () => {
    const s = await ready()
    s.emit('one')
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1', fromSeq: 1, bootId: 'boot-0' })
    await eventually(() => expect(of(s.frames, 'checkpoint')).toHaveLength(1))
  })

  it('an unknown pty is RUNTIME_NOT_FOUND; an unauthenticated connection RUNTIME_AUTH_FAILED', async () => {
    const s = await ready()
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'nope' })
    s.send({ t: 'subscribe', conn: 'c9', sub: 's2', pty: 'p1' })
    await eventually(() => expect(of(s.frames, 'sub-error')).toHaveLength(2))
    // The refusal for an unauthenticated connection is immediate, the unknown pty's after the replay: compared unordered.
    expect(of(s.frames, 'sub-error').map((f) => [f.sub, f.code]).sort()).toEqual([['s1', 'RUNTIME_NOT_FOUND'], ['s2', 'RUNTIME_AUTH_FAILED']])
  })

  it('the 65th subscription on one connection is RUNTIME_BUSY', async () => {
    const s = await ready()
    for (let i = 0; i < SUBS_PER_CONN + 1; i++) s.send({ t: 'subscribe', conn: 'c1', sub: `s${i}`, pty: 'p1' })
    await eventually(() => expect(of(s.frames, 'subscribed')).toHaveLength(SUBS_PER_CONN))
    expect(of(s.frames, 'sub-error').map((f) => f.code)).toEqual(['RUNTIME_BUSY'])
  })

  it('unsubscribe and a closed connection stop the output', async () => {
    const s = await ready()
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1' })
    await eventually(() => expect(of(s.frames, 'checkpoint')).toHaveLength(1))
    s.send({ t: 'unsubscribe', conn: 'c1', sub: 's1' })
    s.send({ t: 'subscribe', conn: 'c1', sub: 's2', pty: 'p1' })
    await eventually(() => expect(of(s.frames, 'checkpoint')).toHaveLength(2))
    s.send({ t: 'conn-closed', conn: 'c1' })
    await s.settle()
    s.frames.length = 0
    s.emit('nobody')
    await s.settle()
    expect(of(s.frames, 'pty-out')).toEqual([])
  })

  it('an overflow ends the stream with output-gap, and nothing more is sent on it', async () => {
    // A slow Gateway: each line takes a while to be taken, so the stream backs up past its budget, and the gap (a
    // control line) still goes out once the link drains.
    const out = new Writable({ highWaterMark: 1, write: (_c, _e, cb) => void setTimeout(cb, 20) })
    const p = ptyRig()
    const s = await setup({ ptys: p.registry, output: out, streamPerKey: 64 })
    const frames: Array<Record<string, unknown>> = []
    const write = out.write.bind(out)
    out.write = ((chunk: string, ...rest: unknown[]) => {
      String(chunk).split(String.fromCharCode(10)).filter(Boolean).forEach((l) => frames.push(JSON.parse(l)))
      return (write as (c: string, ...r: unknown[]) => boolean)(chunk, ...rest)
    }) as typeof out.write
    const c = await s.pairClient('read-only')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    await s.settle()
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1' })
    await s.settle()
    for (let i = 0; i < 20; i++) p.emit(`chunk ${i} ${'x'.repeat(40)}`)
    await eventually(() => expect(frames.some((f) => f.t === 'output-gap' && f.sub === 's1')).toBe(true))
    const gap = frames.findIndex((f) => f.t === 'output-gap' && f.sub === 's1')
    p.emit('after the gap')
    await new Promise((r) => setTimeout(r, 100))
    expect(frames.slice(gap).some((f) => f.t === 'pty-out' && JSON.stringify(f).includes('after the gap'))).toBe(false)
  })

  // Phase 8 review M5: a terminal that cannot catch up with the output is not "no such pty": the stream ends with a gap
  // and the controller subscribes again.
  it('a replay that stays behind the output ends the stream with output-gap, never RUNTIME_NOT_FOUND', async () => {
    const ptys = { bootId: 'b', onEvent: () => () => {}, replayFrom: async () => 'behind' as const }
    const s = await setup({ ptys: ptys as never })
    const c = await s.pairClient('read-only')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    await s.settle()
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1' })
    await s.settle()
    expect(of(s.frames, 'sub-error')).toEqual([])
    expect(of(s.frames, 'output-gap')).toMatchObject([{ sub: 's1', code: 'OUTPUT_GAP' }])
  })

  // Phase 8 review M6: what arrives while a replay is computed is held, within the stream's budget; past it the stream
  // ends with a gap rather than holding without bound.
  it('output held during a slow replay past the stream budget ends the stream with output-gap', async () => {
    let tell: (id: string, e: { seq: number; kind: 'data'; data: string }) => void = () => {}
    let finish: (v: unknown) => void = () => {}
    const ptys = {
      bootId: 'b',
      onEvent: (cb: typeof tell) => ((tell = cb), () => {}),
      replayFrom: () => new Promise((r) => (finish = r))
    }
    const s = await setup({ ptys: ptys as never, streamPerKey: 1_000 })
    const c = await s.pairClient('read-only')
    s.send({ t: 'auth', conn: 'c1', tokenHash: sha256Base64url(c.token) })
    await s.settle()
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1' })
    await s.settle()
    for (let seq = 1; seq <= 10; seq++) tell('p1', { seq, kind: 'data', data: 'x'.repeat(200) })
    finish({ gap: null, checkpoint: null, events: [] })
    await s.settle()
    expect(of(s.frames, 'output-gap')).toMatchObject([{ sub: 's1' }])
    expect(of(s.frames, 'pty-out')).toEqual([])
  })

  // Phase 8 review M9: a revoked connection streams nothing more, without waiting for the Gateway to report it closed.
  it('closeConns drops that connection’s subscriptions at once', async () => {
    const s = await ready()
    s.send({ t: 'subscribe', conn: 'c1', sub: 's1', pty: 'p1' })
    await eventually(() => expect(of(s.frames, 'checkpoint')).toHaveLength(1))
    s.link.closeConns([{ linkGen: 1, conn: 'c1' }])
    s.frames.length = 0
    s.emit('after the revocation')
    await s.settle()
    expect(of(s.frames, 'pty-out')).toEqual([])
  })
})
