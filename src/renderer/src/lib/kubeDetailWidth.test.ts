import { describe, it, expect } from 'vitest'
import { DETAIL_DEFAULT, DETAIL_MIN, DETAIL_STEP, clampDetailWidth, readDetailWidth } from './kubeDetailWidth'

// The detail column's width: at least 280, and never so wide that the table beside it (with the tree) drops under 240.
describe('clampDetailWidth', () => {
  it('keeps a width that fits', () => {
    expect(clampDetailWidth(400, 1200, 212)).toBe(400)
  })

  it('raises a narrow width to the minimum', () => {
    expect(clampDetailWidth(100, 1200, 212)).toBe(DETAIL_MIN)
  })

  it('leaves the table 240px past the tree', () => {
    // 1000 - 212 - 240 = 548
    expect(clampDetailWidth(900, 1000, 212)).toBe(548)
  })

  it('keeps the minimum when the body is too narrow for both', () => {
    expect(clampDetailWidth(500, 600, 212)).toBe(DETAIL_MIN)
  })

  it('answers a whole number in range for a fractional or non-finite wish', () => {
    expect(clampDetailWidth(400.6, 1200, 212)).toBe(401)
    expect(clampDetailWidth(Number.NaN, 1200, 212)).toBe(DETAIL_DEFAULT)
  })
})

describe('readDetailWidth', () => {
  it('reads a stored width', () => {
    expect(readDetailWidth('450')).toBe(450)
  })

  it('falls back to 380 for nothing or junk', () => {
    for (const raw of [null, '', 'wide', 'NaN', 'Infinity', '-5', '0', '12']) expect(readDetailWidth(raw)).toBe(380)
  })
})

describe('step', () => {
  it('is 16px', () => {
    expect(DETAIL_STEP).toBe(16)
  })
})
