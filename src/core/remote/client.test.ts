import { describe, it, expect, afterEach } from 'vitest'
import tls from 'node:tls'
import { generateKeyPairSync } from 'node:crypto'
import { buildCertificate, certificatePem, spkiSha256 } from './cert'
import { CONTROLLER_REASSEMBLY_MAX, connectRuntime, RemoteError } from './client'
import { GATEWAY_LIMITS } from '../../cli/runtime/gateway'
import { REMOTE_RESET_MAX } from '../../main/remote/remoteStreams'

const identity = (() => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    cert: certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_hb', san: '127.0.0.1', now: new Date() })),
    pin: spkiSha256(publicKey)
  }
})()

const servers: tls.Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
})

/** A TLS server that accepts and then never sends a byte, as a half-open link looks from the controller. */
async function silentServer(): Promise<{ port: number; got: string[] }> {
  const got: string[] = []
  const server = tls.createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.3' }, (s) => {
    s.setEncoding('utf8')
    s.on('data', (d: string) => got.push(d))
    s.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as { port: number }).port, got }
}

describe('connectRuntime heartbeat (remote runtime design §3.1, N14)', () => {
  it('pings while connected and drops a silent link, failing its calls as lost', async () => {
    const srv = await silentServer()
    const link = await connectRuntime({ host: '127.0.0.1', port: srv.port, pin: identity.pin, heartbeat: { everyMs: 20, silenceMs: 120 } })
    const call = link.call('jobs-list', {}).catch((e: unknown) => e)
    const closed = await link.closed
    expect(closed).toEqual({})
    const err = (await call) as RemoteError & { lost?: boolean }
    expect(err).toBeInstanceOf(RemoteError)
    expect(err.lost).toBe(true)
    expect(srv.got.join('')).toContain('"t":"ping"')
  })
})

// Phase 8 review M9: subscription frames are validated before they reach a stream, and a refused stream's handler goes.
describe('connectRuntime subscriptions', () => {
  it('passes valid frames to the stream, drops malformed ones, and forgets a refused stream', async () => {
    let peer: tls.TLSSocket | null = null
    const server = tls.createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.3' }, (s) => {
      peer = s
      s.on('error', () => {})
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const link = await connectRuntime({ host: '127.0.0.1', port: (server.address() as { port: number }).port, pin: identity.pin })
    const got: Array<Record<string, unknown>> = []
    link.subscribe?.('s1', 'p1', {}, (f) => void got.push(f as unknown as Record<string, unknown>))
    const until = async (ok: () => boolean): Promise<void> => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
    }
    await until(() => peer !== null)
    const say = (m: unknown): void => void (peer as unknown as tls.TLSSocket).write(JSON.stringify(m) + String.fromCharCode(10))
    say({ t: 'pty-out', sub: 's1', events: [{ seq: 'x', kind: 'data', data: 'bad' }] })
    say({ t: 'pty-out', sub: 's1', events: [{ seq: 1, kind: 'data', data: 'good' }] })
    await until(() => got.length >= 1)
    say({ t: 'sub-error', sub: 's1', code: 'RUNTIME_NOT_FOUND', message: 'gone' })
    say({ t: 'pty-out', sub: 's1', events: [{ seq: 2, kind: 'data', data: 'after' }] })
    await until(() => got.length >= 2)
    await new Promise((r) => setTimeout(r, 50))
    expect(got.map((f) => f.t)).toEqual(['pty-out', 'sub-error'])
    expect(JSON.stringify(got[0])).toContain('good')
    link.close()
    ;(peer as unknown as tls.TLSSocket).destroy()
  })
})


// Security audit SEC-4: the controller took a Runtime's hello and paired frames as they came. A capabilities field that
// was not a list threw later in the link and ended the CLI or MCP process; a runtimeId that was not an id was kept.
// Final review M-3: the Gateway lets one connection hold up to 96 MiB of reply pieces (about 72 MiB once decoded), and
// a checkpoint can be arriving beside it; the controller's total must hold both, or a legitimate large reply cuts the link.
describe('the controller’s reassembly total', () => {
  it('holds the largest reply a Gateway lets one connection have, beside the checkpoints of a few tabs reconnecting', () => {
    expect(CONTROLLER_REASSEMBLY_MAX).toBeGreaterThanOrEqual(Math.ceil((GATEWAY_LIMITS.replyPerConn * 3) / 4) + 4 * REMOTE_RESET_MAX)
  })
})

describe('connectRuntime checks what a Runtime says about itself', () => {
  /** A TLS server that answers the first frame with `answer`. */
  async function answering(answer: unknown): Promise<number> {
    const server = tls.createServer({ key: identity.key, cert: identity.cert, minVersion: 'TLSv1.3' }, (s) => {
      s.on('error', () => {})
      s.once('data', () => s.write(`${JSON.stringify(answer)}\n`))
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    return (server.address() as { port: number }).port
  }
  const HELLO = {
    t: 'hello',
    runtimeId: 'rt_ok',
    displayName: 'office',
    asteraVersion: '1.0.0',
    hostProtocol: 4,
    gatewayProtocol: 1,
    bootId: 'b',
    platform: 'win32',
    pathStyle: 'windows',
    permission: 'read-only',
    capabilities: ['remote.jobs']
  }
  it('takes a well-formed hello', async () => {
    const link = await connectRuntime({ host: '127.0.0.1', port: await answering(HELLO), pin: identity.pin })
    await expect(link.auth('t', {})).resolves.toMatchObject({ runtimeId: 'rt_ok', capabilities: ['remote.jobs'] })
    link.close()
  })
  for (const [what, bad] of [
    ['capabilities that are not a list', { ...HELLO, capabilities: 7 }],
    ['a runtimeId that is not an id', { ...HELLO, runtimeId: '../x' }],
    ['a permission it does not know', { ...HELLO, permission: 'owner' }],
    ['a display name that is not a short string', { ...HELLO, displayName: 'x'.repeat(5000) }]
  ] as const)
    it(`fails the sign-in on ${what}, and closes`, async () => {
      const link = await connectRuntime({ host: '127.0.0.1', port: await answering(bad), pin: identity.pin })
      await expect(link.auth('t', {})).rejects.toMatchObject({ code: 'REMOTE_BAD_FRAME' })
      await link.closed
    })
  it('fails a pairing whose answer has no token', async () => {
    const link = await connectRuntime({ host: '127.0.0.1', port: await answering({ t: 'paired', clientId: 'cli_1' }), pin: identity.pin })
    await expect(link.redeem('CODE', 'me', {})).rejects.toMatchObject({ code: 'REMOTE_BAD_FRAME' })
  })
})
