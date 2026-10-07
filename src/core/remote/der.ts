// A DER writer for exactly the types the Runtime's certificate needs (remote runtime design §4.2): nothing here
// parses, and nothing writes a type the certificate does not use.

const length = (n: number): Buffer => {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

export const tlv = (tag: number, body: Buffer): Buffer => Buffer.concat([Buffer.from([tag]), length(body.length), body])
export const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items))
export const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items))
export const nul = (): Buffer => Buffer.from([0x05, 0x00])
export const octetString = (b: Buffer): Buffer => tlv(0x04, b)
export const bitString = (b: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0x00]), b]))
export const utf8 = (s: string): Buffer => tlv(0x0c, Buffer.from(s, 'utf8'))
/** Context-specific tag `[n]`, constructed unless told otherwise (SubjectAltName's names are primitive). */
export const ctx = (n: number, body: Buffer, constructed = true): Buffer => tlv((constructed ? 0xa0 : 0x80) | n, body)

/** A non-negative integer: big-endian, no leading zero bytes, and a 0x00 in front when the top bit is set. */
export const int = (v: Buffer | number): Buffer => {
  let b = typeof v === 'number' ? Buffer.from(v.toString(16).padStart(2, '0').replace(/^(.(..)*)$/, '0$1'), 'hex') : v
  let i = 0
  while (i < b.length - 1 && b[i] === 0) i++
  b = b.subarray(i)
  if (b.length === 0) b = Buffer.from([0])
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return tlv(0x02, b)
}

export const oid = (dotted: string): Buffer => {
  const [a, b, ...rest] = dotted.split('.').map(Number)
  const out = [40 * a + b]
  for (const n of rest) {
    const chunk: number[] = [n & 0x7f]
    for (let v = Math.floor(n / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80)
    out.push(...chunk)
  }
  return tlv(0x06, Buffer.from(out))
}

/** UTCTime for 1950 to 2049, GeneralizedTime otherwise (RFC 5280 §4.1.2.5). */
export const time = (d: Date): Buffer => {
  const digits = d.toISOString().slice(0, 19).replace(/[-:T]/g, '')
  const year = d.getUTCFullYear()
  return year >= 1950 && year < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'latin1'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'latin1'))
}
