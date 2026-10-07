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
