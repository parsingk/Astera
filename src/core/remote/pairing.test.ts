import { describe, it, expect } from 'vitest'
import { formatPairing, parsePairing } from './pairing'

const FP = 'A'.repeat(42) + 'w'

describe('the pairing string (remote runtime design §4.4)', () => {
  it('round-trips an IPv4 address, an IPv6 address and a DNS name', () => {
    for (const address of ['192.168.0.7', 'fd7a:115c::1', 'desk.tail1.ts.net']) {
      const s = formatPairing({ address, port: 47831, code: 'ABCDE23456', fingerprint: FP })
      expect(s.startsWith('astera-pair:v1:')).toBe(true)
      expect(parsePairing(s)).toEqual({ address, port: 47831, code: 'ABCDE23456', fingerprint: FP })
    }
    expect(formatPairing({ address: 'fd7a::1', port: 1, code: 'C', fingerprint: FP })).toContain('[fd7a::1]')
  })
  it('refuses another prefix, another version, a bad port and a fingerprint that is not 43 base64url characters', () => {
    expect(parsePairing(`astera-pairing:v1:a:1:C:${FP}`)).toHaveProperty('error')
    expect(parsePairing(`astera-pair:v2:a:1:C:${FP}`)).toHaveProperty('error')
    expect(parsePairing(`astera-pair:v1:a:0:C:${FP}`)).toHaveProperty('error')
    expect(parsePairing(`astera-pair:v1:a:99999:C:${FP}`)).toHaveProperty('error')
    expect(parsePairing('astera-pair:v1:a:1:C:short')).toHaveProperty('error')
    expect(parsePairing(`  astera-pair:v1:a:1:ABCDE23456:${FP}  `)).toMatchObject({ code: 'ABCDE23456' })
  })
})
