// The Runtime's certificate (remote runtime design §4.2): one fixed shape, written with `der.ts` and signed with
// `node:crypto`, so no certificate dependency. Trust is the SPKI pin (§4.1), so the dates are long and the
// certificate can be reissued on the same key without any client noticing.
import { createHash, randomBytes, sign, type KeyObject } from 'node:crypto'
import { isIP } from 'node:net'
import { bitString, ctx, int, octetString, oid, seq, set, time, utf8 } from './der'

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2'
const COMMON_NAME = '2.5.4.3'
const SUBJECT_ALT_NAME = '2.5.29.17'
const DAY_MS = 24 * 60 * 60 * 1000

/** The pin: SHA-256 of the key's SubjectPublicKeyInfo DER, base64url. */
export const spkiSha256 = (key: KeyObject): string =>
  createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64url')

const ipv6Bytes = (ip: string): Buffer => {
  const parts = (s: string): number[] => (s === '' ? [] : s.split(':').map((h) => parseInt(h, 16)))
  const [head, tail = ''] = ip.split('::')
  const h = parts(head)
  const t = ip.includes('::') ? parts(tail) : []
  const words = [...h, ...Array<number>(8 - h.length - t.length).fill(0), ...t]
  const out = Buffer.alloc(16)
  words.forEach((w, i) => out.writeUInt16BE(w, i * 2))
  return out
}

const altName = (san: string): Buffer => {
  const kind = isIP(san)
  if (kind === 4) return ctx(7, Buffer.from(san.split('.').map(Number)), false)
  if (kind === 6) return ctx(7, ipv6Bytes(san), false)
  return ctx(2, Buffer.from(san, 'ascii'), false)
}

export function buildCertificate(a: {
  privateKey: KeyObject
  publicKey: KeyObject
  runtimeId: string
  san?: string
  now: Date
  serial?: Buffer
}): Buffer {
  const name = seq(set(seq(oid(COMMON_NAME), utf8(`astera-runtime-${a.runtimeId}`))))
  const notBefore = new Date(a.now.getTime() - DAY_MS)
  const notAfter = new Date(a.now.getTime())
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 10)
  const algorithm = seq(oid(ECDSA_WITH_SHA256))
  const tbs = seq(
    ctx(0, int(2)),
    int(a.serial ?? randomBytes(16)),
    algorithm,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    a.publicKey.export({ type: 'spki', format: 'der' }),
    ...(a.san ? [ctx(3, seq(seq(oid(SUBJECT_ALT_NAME), octetString(seq(altName(a.san))))))] : [])
  )
  const signature = sign('sha256', tbs, { key: a.privateKey, dsaEncoding: 'der' })
  return seq(tbs, algorithm, bitString(signature))
}

export const certificatePem = (der: Buffer): string =>
  `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})(?!$)/g, '$1\n')}\n-----END CERTIFICATE-----\n`
