import { describe, it, expect } from 'vitest'
import { coarseDuration } from './relativeTime'

describe('coarseDuration', () => {
  it('is one unit, in the app language', () => {
    expect(coarseDuration(47 * 60_000, 'ko')).toBe('47분')
    expect(coarseDuration(47 * 60_000, 'en')).toBe('47m')
    expect(coarseDuration(3 * 3_600_000 + 54 * 60_000, 'ko')).toBe('3시간')
    expect(coarseDuration(3 * 3_600_000 + 54 * 60_000, 'en')).toBe('3h')
    expect(coarseDuration(4 * 24 * 3_600_000, 'ko')).toBe('4일')
    expect(coarseDuration(4 * 24 * 3_600_000, 'en')).toBe('4d')
  })

  // The overlay's time columns are 6.4ch wide; a second unit does not fit, and for "when does this
  // window roll" the leading unit is the whole answer.
  it('drops the remainder rather than showing two units', () => {
    expect(coarseDuration(25 * 3_600_000, 'en')).toBe('1d')
    expect(coarseDuration(59 * 60_000 + 59_000, 'en')).toBe('60m')
  })

  it('rounds a sub-minute duration up, never to zero', () => {
    expect(coarseDuration(30_000, 'ko')).toBe('1분')
    expect(coarseDuration(0, 'ko')).toBe('1분')
    expect(coarseDuration(-5000, 'ko')).toBe('1분')
  })

  it('the hour boundary reads as hours, not 60 minutes', () => {
    expect(coarseDuration(60 * 60_000, 'en')).toBe('1h')
    expect(coarseDuration(24 * 3_600_000, 'en')).toBe('1d')
  })
})
