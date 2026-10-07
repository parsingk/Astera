import { describe, it, expect } from 'vitest'
import { X509Certificate, createPublicKey, createHash, generateKeyPairSync } from 'node:crypto'
import { buildCertificate, certificatePem, spkiSha256 } from './cert'

const pair = () => generateKeyPairSync('ec', { namedCurve: 'P-256' })
const now = new Date('2026-10-07T00:00:00Z')

describe('buildCertificate (remote runtime design §4.2)', () => {
  it('builds a certificate Node parses and verifies, with the fixed shape', () => {
    const { privateKey, publicKey } = pair()
    const x = new X509Certificate(buildCertificate({ privateKey, publicKey, runtimeId: 'rt_1', san: '192.168.0.7', now }))
    expect(x.verify(publicKey)).toBe(true)
    expect(x.subject).toBe('CN=astera-runtime-rt_1')
    expect(x.issuer).toBe('CN=astera-runtime-rt_1')
    expect(x.subjectAltName).toBe('IP Address:192.168.0.7')
    expect(new Date(x.validFrom).toISOString()).toBe('2026-10-06T00:00:00.000Z')
    expect(new Date(x.validTo).toISOString()).toBe('2036-10-07T00:00:00.000Z')
    expect(x.serialNumber.length).toBeGreaterThanOrEqual(30)
  })
  it('takes a DNS name, an IPv6 address, or no SAN at all', () => {
    const { privateKey, publicKey } = pair()
    expect(new X509Certificate(buildCertificate({ privateKey, publicKey, runtimeId: 'r', san: 'box.tail1.ts.net', now })).subjectAltName).toBe('DNS:box.tail1.ts.net')
    expect(new X509Certificate(buildCertificate({ privateKey, publicKey, runtimeId: 'r', san: 'fd7a::1', now })).subjectAltName).toBe('IP Address:FD7A:0:0:0:0:0:0:1')
    expect(new X509Certificate(buildCertificate({ privateKey, publicKey, runtimeId: 'r', now })).subjectAltName).toBeUndefined()
  })
  it('pins the SPKI: the hash matches one computed independently, survives a reissue, and changes with the key', () => {
    const a = pair()
    const independent = createHash('sha256').update(createPublicKey(a.privateKey).export({ type: 'spki', format: 'der' })).digest('base64url')
    expect(spkiSha256(a.publicKey)).toBe(independent)
    const first = new X509Certificate(buildCertificate({ ...a, runtimeId: 'r', now }))
    const again = new X509Certificate(buildCertificate({ ...a, runtimeId: 'r', now: new Date('2027-01-01T00:00:00Z') }))
    expect(first.raw.equals(again.raw)).toBe(false)
    expect(spkiSha256(first.publicKey)).toBe(spkiSha256(again.publicKey))
    expect(spkiSha256(pair().publicKey)).not.toBe(independent)
  })
  it('writes PEM Node reads back', () => {
    const { privateKey, publicKey } = pair()
    const der = buildCertificate({ privateKey, publicKey, runtimeId: 'r', now })
    expect(new X509Certificate(certificatePem(der)).raw.equals(der)).toBe(true)
  })
})
