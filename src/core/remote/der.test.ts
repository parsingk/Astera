import { describe, it, expect } from 'vitest'
import { bitString, ctx, int, nul, octetString, oid, seq, set, time, tlv, utf8 } from './der'

const hex = (b: Buffer): string => b.toString('hex')

describe('DER writer (remote runtime design §4.2)', () => {
  it('writes short and long lengths', () => {
    expect(hex(tlv(0x04, Buffer.alloc(3)))).toBe('0403000000')
    expect(hex(tlv(0x04, Buffer.alloc(200))).slice(0, 6)).toBe('0481c8')
    expect(hex(tlv(0x04, Buffer.alloc(300))).slice(0, 8)).toBe('0482012c')
  })
  it('writes integers as positive, minimal two’s complement', () => {
    expect(hex(int(0))).toBe('020100')
    expect(hex(int(2))).toBe('020102')
    expect(hex(int(128))).toBe('02020080')
    expect(hex(int(Buffer.from([0x00, 0x00, 0x7f])))).toBe('02017f')
    expect(hex(int(Buffer.from([0xff, 0x01])))).toBe('020300ff01')
  })
  it('writes object identifiers', () => {
    expect(hex(oid('1.2.840.10045.2.1'))).toBe('06072a8648ce3d0201')
    expect(hex(oid('2.5.4.3'))).toBe('0603550403')
  })
  it('writes UTCTime before 2050 and GeneralizedTime from 2050', () => {
    expect(time(new Date('2026-10-07T01:02:03Z')).toString('latin1')).toBe('\x17\x0d261007010203Z')
    expect(time(new Date('2050-01-01T00:00:00Z')).toString('latin1')).toBe('\x18\x0f20500101000000Z')
  })
  it('writes the rest of the fixed shape', () => {
    expect(hex(nul())).toBe('0500')
    expect(hex(bitString(Buffer.from([0xab])))).toBe('030200ab')
    expect(hex(octetString(Buffer.from([1])))).toBe('040101')
    expect(hex(utf8('a'))).toBe('0c0161')
    expect(hex(seq(nul(), nul()))).toBe('300405000500')
    expect(hex(set(nul()))).toBe('31020500')
    expect(hex(ctx(0, int(2)))).toBe('a003020102')
    expect(hex(ctx(7, Buffer.from([1]), false))).toBe('870101')
  })
})
