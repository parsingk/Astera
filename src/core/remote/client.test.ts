import { describe, it, expect, afterEach } from 'vitest'
import tls from 'node:tls'
import { generateKeyPairSync } from 'node:crypto'
import { buildCertificate, certificatePem, spkiSha256 } from './cert'
import { connectRuntime, RemoteError } from './client'

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
