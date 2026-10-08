import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import { PassThrough } from 'node:stream'
import { generateKeyPairSync } from 'node:crypto'
import { buildCertificate, certificatePem, spkiSha256 } from '../../core/remote/cert'
import { connectRuntime, type RuntimeLink } from '../../core/remote/client'
import { sha256Base64url } from '../../host/controllers'
import { bindCode, startGateway, type GatewayHandle, type GatewayLimits } from './gateway'

const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    certPem: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_test', san: '127.0.0.1', now: new Date() })),
    spkiSha256: spkiSha256(publicKey)
  }
})()

const HELLO = {
  t: 'hello' as const,
  runtimeId: 'rt_test',
  displayName: 'test',
  asteraVersion: '9.9.9',
  hostProtocol: 4,
  gatewayProtocol: 1,
  bootId: 'b',
  platform: 'win32',
  pathStyle: 'windows' as const,
  permission: 'full-control' as const,
  capabilities: []
}

const open: Array<{ gw: GatewayHandle; links: RuntimeLink[] }> = []
afterEach(async () => {
  for (const o of open.splice(0)) {
    for (const l of o.links) l.close()
    await o.gw.close()
  }
})

/** A Gateway on 127.0.0.1:0 whose link is two in-memory streams, with a fake Host that records what reaches it. */
const start = async (limits: Partial<GatewayLimits> = {}, host?: (f: Record<string, unknown>, reply: (m: unknown) => void) => void, now?: () => number) => {
  const toHost = new PassThrough()
  const fromHost = new PassThrough()
  const seen: Array<Record<string, unknown>> = []
  const raw: string[] = []
  const reply = (m: unknown): void => void fromHost.write(`${JSON.stringify(m)}\n`)
  let buf = ''
  toHost.on('data', (d: Buffer) => {
    raw.push(d.toString())
    buf += d.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const f = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>
      buf = buf.slice(nl + 1)
      seen.push(f)
      if (host) host(f, reply)
      else if (f.t === 'auth') reply({ t: 'authed', conn: f.conn, ok: f.tokenHash === sha256Base64url('good-token'), hello: HELLO })
      else if (f.t === 'call') reply({ t: 'result', conn: f.conn, id: f.id, status: 200, body: { cmd: f.cmd } })
    }
  })
  const gw = await startGateway({ identity, listen: '127.0.0.1', port: 0, link: { input: fromHost, output: toHost }, limits, ...(now ? { now } : {}) })
  if ('error' in gw) throw new Error(gw.error.message)
  const entry = { gw, links: [] as RuntimeLink[] }
  open.push(entry)
  const connect = async (o: { pin?: string; answerPings?: boolean } = {}) => {
    const l = await connectRuntime({ host: '127.0.0.1', port: gw.port, pin: o.pin ?? identity.spkiSha256, answerPings: o.answerPings })
    entry.links.push(l)
    return l
  }
  return { gw, seen, raw, reply, connect }
}

const until = async (ok: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('startGateway (remote runtime design §2.3, §3.1, §3.2)', () => {
  it('says it is ready on the link with its port and fingerprint', async () => {
    const g = await start()
    expect(g.seen[0]).toEqual({ t: 'gateway-ready', port: g.gw.port, address: '127.0.0.1', fingerprint: identity.spkiSha256 })
  })
  it('authenticates by hash: the token never crosses the link, and a good one gets the hello', async () => {
    const g = await start()
    const l = await g.connect()
    expect(await l.auth('good-token', { name: 'laptop', surface: 'cli' })).toMatchObject({ runtimeId: 'rt_test', permission: 'full-control' })
    expect(g.raw.join('')).not.toContain('good-token')
    expect(g.seen.find((f) => f.t === 'auth')).toMatchObject({ tokenHash: sha256Base64url('good-token') })
  })
  it('closes a bad token with RUNTIME_AUTH_FAILED', async () => {
    const g = await start()
    const l = await g.connect()
    await expect(l.auth('bad', {})).rejects.toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
  })
  it('forwards calls with its own connection id and nothing a controller claimed (Review Focus 1)', async () => {
    const g = await start()
    const l = await g.connect()
    await l.auth('good-token', {})
    expect(await l.call('jobs-list', { status: 'running' })).toEqual({ status: 200, body: { cmd: 'jobs-list' } })
    const call = g.seen.find((f) => f.t === 'call')!
    expect(Object.keys(call).sort()).toEqual(['args', 'cmd', 'conn', 'id', 't'])
  })
  it('refuses a call before auth', async () => {
    const g = await start()
    const l = await g.connect()
    await expect(l.call('jobs-list', {})).rejects.toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
    expect(g.seen.some((f) => f.t === 'call')).toBe(false)
  })
  it('answers the call over the in-flight budget with RUNTIME_BUSY itself', async () => {
    const g = await start({ inFlight: 2 }, (f, reply) => {
      if (f.t === 'auth') reply({ t: 'authed', conn: f.conn, ok: true, hello: HELLO })
    })
    const l = await g.connect()
    await l.auth('t', {})
    void l.call('runs-follow', {}).catch(() => {})
    void l.call('runs-follow', {}).catch(() => {})
    await expect(l.call('jobs-list', {})).rejects.toMatchObject({ code: 'RUNTIME_BUSY' })
    expect(g.seen.filter((f) => f.t === 'call')).toHaveLength(2)
  })
  it('refuses a connection over the connection budget with RUNTIME_BUSY', async () => {
    const g = await start({ connections: 1 })
    const first = await g.connect()
    await first.auth('good-token', {})
    const second = await g.connect()
    expect(await second.closed).toMatchObject({ code: 'RUNTIME_BUSY' })
  })
  it('closes a peer that never speaks, and frees its slot (Review Focus 5)', async () => {
    const g = await start({ connections: 1, firstFrameMs: 100 })
    const silent = await g.connect()
    expect(await silent.closed).toMatchObject({ code: 'REMOTE_TIMEOUT' })
    const next = await g.connect()
    await expect(next.auth('good-token', {})).resolves.toMatchObject({ runtimeId: 'rt_test' })
  })
  it('closes a peer that stops answering pings', async () => {
    const g = await start({ pingMs: 40, silenceMs: 120 })
    const l = await g.connect({ answerPings: false })
    await l.auth('good-token', {})
    expect(await l.closed).toMatchObject({ code: 'REMOTE_TIMEOUT' })
  })
  it('limits pairing attempts per address without asking the Host', async () => {
    const g = await start({ redeemPerMinute: 2 }, (f, reply) => {
      if (f.t === 'redeem') reply({ t: 'redeemed', conn: f.conn, ok: false, reason: 'unknown' })
    })
    for (let i = 0; i < 2; i++) await expect((await g.connect()).redeem('WRONG', 'x', {})).rejects.toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
    await expect((await g.connect()).redeem('WRONG', 'x', {})).rejects.toMatchObject({ code: 'RUNTIME_BUSY' })
    expect(g.seen.filter((f) => f.t === 'redeem')).toHaveLength(2)
  })
  it('sends a large result as chunks the client puts back together', async () => {
    const big = 'é'.repeat(800 * 1024)
    const g = await start({}, (f, reply) => {
      if (f.t === 'auth') reply({ t: 'authed', conn: f.conn, ok: true, hello: HELLO })
      if (f.t === 'call') reply({ t: 'result', conn: f.conn, id: f.id, status: 200, body: { big } })
    })
    const l = await g.connect()
    await l.auth('t', {})
    expect(await l.call('state-get', {})).toEqual({ status: 200, body: { big } })
  })
  it('closes a connection the Host says to close, with the Host’s code, and tells the Host it closed', async () => {
    const g = await start()
    const l = await g.connect()
    await l.auth('good-token', {})
    const conn = g.seen.find((f) => f.t === 'auth')!.conn
    g.reply({ t: 'close-conn', conn, code: 'RUNTIME_AUTH_FAILED' })
    expect(await l.closed).toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
    await until(() => g.seen.some((f) => f.t === 'conn-closed' && f.conn === conn))
  })
  // Phase 3 minor: every bind failure has its code, not only a port in use.
  it('names each bind failure: in use, denied, and an address this machine does not have', () => {
    expect(bindCode(Object.assign(new Error('x'), { code: 'EADDRINUSE' }))).toBe('BIND_IN_USE')
    expect(bindCode(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('BIND_DENIED')
    expect(bindCode(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe('BIND_DENIED')
    expect(bindCode(Object.assign(new Error('x'), { code: 'EADDRNOTAVAIL' }))).toBe('BIND_ADDRESS')
  })
  it('reports an address this machine does not have as gateway-failed BIND_ADDRESS', async () => {
    const toHost = new PassThrough()
    const lines: string[] = []
    toHost.on('data', (d: Buffer) => lines.push(d.toString()))
    // 192.0.2.1 is TEST-NET-1 (RFC 5737): never an address of this machine.
    const gw = await startGateway({ identity, listen: '192.0.2.1', port: 0, link: { input: new PassThrough(), output: toHost } })
    expect(gw).toMatchObject({ error: { code: 'BIND_ADDRESS' } })
    expect(JSON.parse(lines.join(''))).toMatchObject({ t: 'gateway-failed', code: 'BIND_ADDRESS' })
  })
  it('reports a port in use as gateway-failed BIND_IN_USE', async () => {
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as net.AddressInfo).port
    const toHost = new PassThrough()
    const lines: string[] = []
    toHost.on('data', (d: Buffer) => lines.push(d.toString()))
    const gw = await startGateway({ identity, listen: '127.0.0.1', port, link: { input: new PassThrough(), output: toHost } })
    blocker.close()
    expect(gw).toMatchObject({ error: { code: 'BIND_IN_USE' } })
    expect(JSON.parse(lines.join(''))).toMatchObject({ t: 'gateway-failed', code: 'BIND_IN_USE' })
  })
})

describe('the Gateway before the handshake (Phase 3 review)', () => {
  it('drops a TCP peer that never finishes the TLS handshake after the first-frame time', async () => {
    const g = await start({ firstFrameMs: 150 })
    const raw = net.connect(g.gw.port, '127.0.0.1')
    raw.on('error', () => {})
    const closedAt = await new Promise<number>((resolve) => {
      const t0 = Date.now()
      raw.once('close', () => resolve(Date.now() - t0))
    })
    expect(closedAt).toBeLessThan(2000)
  })
  it('leaves a connection that finished its handshake alone after that time', async () => {
    const g = await start({ firstFrameMs: 150 })
    const l = await g.connect()
    await l.auth('good-token', {})
    await new Promise((r) => setTimeout(r, 400))
    expect((await l.call('jobs-list', {})).status).toBe(200)
  })

  // Phase 3 minor: the per-address redeem record forgets an address whose attempts are all over a minute old.
  it('forgets the redeem attempts of an address once they are a minute old', async () => {
    let t = 1_000_000
    const g = await start({}, undefined, () => t)
    const c = await g.connect()
    void c.redeem('AAAAAAAAAA', 'x', {}).catch(() => {})
    await until(() => g.seen.some((f) => f.t === 'redeem'))
    expect(g.gw.stats().redeemAddresses).toBe(1)
    t += 61_000
    await g.connect()
    await until(() => g.gw.stats().redeemAddresses === 0)
  })
})

// Remote runtime design §3.7 and §3.1 (Phase 8): the Gateway forwards a connection's subscriptions to the Host and the
// Host's stream frames back to that connection alone, each connection with its own stream budget. A controller that
// stops reading loses only its own streams (OUTPUT_GAP), and the Host is told to stop sending them.
describe('the Gateway and pty subscriptions (Phase 8)', () => {
  /** A controller on a raw TLS socket: it sends frames as given and keeps every frame it receives. */
  const raw = async (port: number) => {
    const tls = await import('node:tls')
    const sock = tls.connect({ host: '127.0.0.1', port, rejectUnauthorized: false })
    await new Promise((r) => sock.once('secureConnect', r))
    const got: Array<Record<string, unknown>> = []
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (d: string) => {
      buf += d
      let nl: number
      while ((nl = buf.indexOf(String.fromCharCode(10))) >= 0) {
        got.push(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>)
        buf = buf.slice(nl + 1)
      }
    })
    sock.on('error', () => {})
    const send = (m: unknown): void => void sock.write(JSON.stringify(m) + String.fromCharCode(10))
    return { sock, got, send }
  }
  const hostThatStreams = () => {
    const subs: Array<Record<string, unknown>> = []
    let reply: (m: unknown) => void = () => {}
    const host = (f: Record<string, unknown>, r: (m: unknown) => void): void => {
      reply = r
      if (f.t === 'auth') r({ t: 'authed', conn: f.conn, ok: f.tokenHash === sha256Base64url('good-token'), hello: HELLO })
      if (f.t === 'subscribe' || f.t === 'unsubscribe') subs.push(f)
    }
    return { host, subs, reply: (m: unknown) => reply(m) }
  }

  it('forwards a subscription with its connection, and the Host frames back without it', async () => {
    const h = hostThatStreams()
    const g = await start({}, h.host)
    const c = await raw(g.gw.port)
    c.send({ t: 'auth', token: 'good-token', client: {} })
    await until(() => c.got.some((f) => f.t === 'hello'))
    c.send({ t: 'subscribe', sub: 's1', pty: 'p1', fromSeq: 3, bootId: 'b' })
    await until(() => h.subs.length === 1)
    const conn = h.subs[0].conn as string
    expect(h.subs[0]).toEqual({ t: 'subscribe', conn, sub: 's1', pty: 'p1', fromSeq: 3, bootId: 'b' })
    h.reply({ t: 'subscribed', conn, sub: 's1', pty: 'p1', bootId: 'b' })
    h.reply({ t: 'pty-out', conn, sub: 's1', events: [{ seq: 3, kind: 'data', data: 'hi' }] })
    h.reply({ t: 'output-gap', conn, sub: 's1', firstSeq: 4, lastSeq: 9, code: 'OUTPUT_GAP' })
    await until(() => c.got.some((f) => f.t === 'output-gap'))
    expect(c.got.filter((f) => f.t !== 'hello' && f.t !== 'ping')).toEqual([
      { t: 'subscribed', sub: 's1', pty: 'p1', bootId: 'b' },
      { t: 'pty-out', sub: 's1', events: [{ seq: 3, kind: 'data', data: 'hi' }] },
      { t: 'output-gap', sub: 's1', firstSeq: 4, lastSeq: 9, code: 'OUTPUT_GAP' }
    ])
    c.send({ t: 'unsubscribe', sub: 's1' })
    await until(() => h.subs.length === 2)
    expect(h.subs[1]).toEqual({ t: 'unsubscribe', conn, sub: 's1' })
    c.sock.destroy()
  })

  // Phase 8 review I3: a checkpoint is stream output: a large one never closes the connection as a control backlog would.
  it('a checkpoint larger than the connection queue reaches the controller, which stays connected', async () => {
    const h = hostThatStreams()
    const g = await start({ queuePerConn: 64 * 1024 }, h.host)
    const c = await raw(g.gw.port)
    c.send({ t: 'auth', token: 'good-token', client: {} })
    await until(() => c.got.some((f) => f.t === 'hello'))
    c.send({ t: 'subscribe', sub: 's1', pty: 'p1' })
    await until(() => h.subs.length === 1)
    const conn = h.subs[0].conn as string
    h.reply({ t: 'subscribed', conn, sub: 's1', pty: 'p1', bootId: 'b' })
    const state = 'z'.repeat(200 * 1024)
    h.reply({ t: 'checkpoint', conn, sub: 's1', checkpoint: { watermark: 3, cols: 80, rows: 24, state, pending: '' }, gap: { firstSeq: 1, lastSeq: 3 } })
    await until(() => c.got.some((f) => f.t === 'checkpoint'), 5_000)
    expect((c.got.find((f) => f.t === 'checkpoint') as { checkpoint: { state: string } }).checkpoint.state).toBe(state)
    expect(c.got.some((f) => f.t === 'closing')).toBe(false)
    expect(c.sock.destroyed).toBe(false)
    c.sock.destroy()
  })

  // Phase 8 review M8: stream output counts in the whole Gateway's budget too; past it the fullest connection goes.
  it('stream output past the Gateway total closes the connection holding the most', async () => {
    const h = hostThatStreams()
    const g = await start({ queuePerConn: 8 << 20, queueTotal: 512 * 1024 }, h.host)
    const c = await raw(g.gw.port)
    c.send({ t: 'auth', token: 'good-token', client: {} })
    await until(() => c.got.some((f) => f.t === 'hello'))
    c.send({ t: 'subscribe', sub: 's1', pty: 'p1' })
    await until(() => h.subs.length === 1)
    const conn = h.subs[0].conn as string
    c.sock.pause()
    const chunk = 'q'.repeat(32 * 1024)
    // More than the operating system buffers for a socket that is not read (tens of MB on Windows loopback).
    for (let seq = 1; seq <= 1500; seq++) {
      h.reply({ t: 'pty-out', conn, sub: 's1', events: [{ seq, kind: 'data', data: chunk }] })
      if (seq % 50 === 0) await new Promise((r) => setTimeout(r, 1))
    }
    c.sock.resume()
    // The connection goes (its `closing` frame waits behind the output already queued, so it may not be read before
    // the socket is ended). One stream past its own share would only end that stream and keep the connection.
    await until(() => c.sock.destroyed, 10_000)
    expect(c.got.some((f) => f.t === 'output-gap')).toBe(false)
    c.sock.destroy()
  }, 30_000)

  it('refuses a subscription before auth', async () => {
    const h = hostThatStreams()
    const g = await start({}, h.host)
    const c = await raw(g.gw.port)
    c.send({ t: 'subscribe', sub: 's1', pty: 'p1' })
    await until(() => c.got.some((f) => f.t === 'error'))
    expect(c.got.find((f) => f.t === 'error')).toMatchObject({ code: 'RUNTIME_AUTH_FAILED' })
    expect(h.subs).toEqual([])
    c.sock.destroy()
  })

  it('a controller that stops reading loses only its own stream, and the Host is told to stop it', async () => {
    const h = hostThatStreams()
    const g = await start({ queuePerConn: 256 * 1024 }, h.host)
    const slow = await raw(g.gw.port)
    const fast = await raw(g.gw.port)
    for (const c of [slow, fast]) c.send({ t: 'auth', token: 'good-token', client: {} })
    await until(() => slow.got.some((f) => f.t === 'hello') && fast.got.some((f) => f.t === 'hello'))
    slow.send({ t: 'subscribe', sub: 's', pty: 'p1' })
    fast.send({ t: 'subscribe', sub: 'f', pty: 'p1' })
    await until(() => h.subs.length === 2)
    const connOf = (sub: string) => h.subs.find((f) => f.sub === sub)?.conn as string
    slow.sock.pause()
    // Output as a busy pty makes it, in bursts the reading connection keeps up with: the stopped one falls behind by
    // more than its queue (and than what the operating system buffers for it), the reading one never does.
    const chunk = 'y'.repeat(32 * 1024)
    const n = 600
    for (let seq = 1; seq <= n; seq++) {
      h.reply({ t: 'pty-out', conn: connOf('s'), sub: 's', events: [{ seq, kind: 'data', data: chunk }] })
      h.reply({ t: 'pty-out', conn: connOf('f'), sub: 'f', events: [{ seq, kind: 'data', data: chunk }] })
      if (seq % 4 === 0) await new Promise((r) => setTimeout(r, 2))
    }
    await until(() => h.subs.some((f) => f.t === 'unsubscribe' && f.sub === 's'), 10_000)
    await until(() => fast.got.filter((f) => f.t === 'pty-out').length === n, 10_000)
    expect(fast.got.some((f) => f.t === 'output-gap')).toBe(false)
    slow.sock.resume()
    await until(() => slow.got.some((f) => f.t === 'output-gap' && f.sub === 's'), 10_000)
    slow.sock.destroy()
    fast.sock.destroy()
  }, 30_000)
})
