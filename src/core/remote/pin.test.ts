import { describe, it, expect, afterEach } from 'vitest'
import tls from 'node:tls'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { buildCertificate, certificatePem, spkiSha256 } from './cert'
import { connectPinned } from './pin'

const servers: tls.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.close()
})

/** A TLS 1.3 server with a fresh identity that records every application byte it receives. */
const serve = async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const cert = certificatePem(buildCertificate({ privateKey, publicKey, runtimeId: 'r', san: '127.0.0.1', now: new Date() }))
  const received: Buffer[] = []
  const server = tls.createServer({ key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert, minVersion: 'TLSv1.3' }, (s) => {
    s.on('data', (d: Buffer) => received.push(d))
    s.on('error', () => {})
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { port: (server.address() as AddressInfo).port, pin: spkiSha256(publicKey), received }
}

describe('connectPinned (remote runtime design §4.3)', () => {
  it('connects over TLS 1.3 when the pin matches', async () => {
    const s = await serve()
    const sock = await connectPinned({ host: '127.0.0.1', port: s.port, pin: s.pin })
    expect(sock.getProtocol()).toBe('TLSv1.3')
    sock.write('hello')
    await new Promise((r) => setTimeout(r, 50))
    expect(Buffer.concat(s.received).toString()).toBe('hello')
    sock.destroy()
  })
  it('refuses a wrong pin before writing a single byte', async () => {
    const s = await serve()
    const other = spkiSha256(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey)
    await expect(connectPinned({ host: '127.0.0.1', port: s.port, pin: other })).rejects.toMatchObject({ code: 'RUNTIME_IDENTITY_CHANGED' })
    await new Promise((r) => setTimeout(r, 50))
    expect(s.received).toHaveLength(0)
  })
  // Ruling M3 (Phase 2 plan): why the pin is not checked in checkServerIdentity.
  it('Node skips checkServerIdentity for a self-signed certificate and keeps the socket open', async () => {
    const s = await serve()
    let called = false
    const sock = tls.connect({
      host: '127.0.0.1',
      port: s.port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      checkServerIdentity: () => {
        called = true
        return new Error('wrong pin')
      }
    })
    await new Promise((r) => sock.once('secureConnect', r))
    expect(called).toBe(false)
    expect(sock.destroyed).toBe(false)
    sock.destroy()
  })
})
