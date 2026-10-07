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
