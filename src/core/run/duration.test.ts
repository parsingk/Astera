import { describe, it, expect } from 'vitest'
import { formatRunDuration } from './duration'

const T0 = 1_700_000_000_000

describe('formatRunDuration', () => {
  // A running run ticks once a second; tenths would only flicker
  it('a running run reads mm:ss, never tenths', () => {
    expect(formatRunDuration({ startedAt: T0 }, T0 + 4_200)).toBe('00:04')
    expect(formatRunDuration({ startedAt: T0 }, T0 + 59_900)).toBe('00:59')
    expect(formatRunDuration({ startedAt: T0 }, T0 + 61_000)).toBe('01:01')
  })

  it('a running run past an hour reads h:mm:ss', () => {
    expect(formatRunDuration({ startedAt: T0 }, T0 + 3_600_000)).toBe('1:00:00')
    expect(formatRunDuration({ startedAt: T0 }, T0 + 3_723_000)).toBe('1:02:03')
  })

  // A finished run's total is read at the precision a test suite reports its time
  it('a finished run under a minute reads tenths of a second', () => {
    expect(formatRunDuration({ startedAt: T0, exitedAt: T0 + 4_200 }, T0 + 999_999)).toBe('4.2s')
    expect(formatRunDuration({ startedAt: T0, exitedAt: T0 + 59_900 }, T0)).toBe('59.9s')
  })

  it('a finished run from a minute reads mm:ss, from an hour h:mm:ss', () => {
    expect(formatRunDuration({ startedAt: T0, exitedAt: T0 + 60_000 }, T0)).toBe('01:00')
    expect(formatRunDuration({ startedAt: T0, exitedAt: T0 + 3_600_000 }, T0)).toBe('1:00:00')
  })

  it('a finished run ignores now; a running run follows it', () => {
    const done = { startedAt: T0, exitedAt: T0 + 5_000 }
    expect(formatRunDuration(done, T0 + 1)).toBe(formatRunDuration(done, T0 + 1_000_000))
    expect(formatRunDuration({ startedAt: T0 }, T0 + 1_000)).not.toBe(formatRunDuration({ startedAt: T0 }, T0 + 2_000))
  })

  it('a clock that runs behind the start never goes negative', () => {
    expect(formatRunDuration({ startedAt: T0 }, T0 - 500)).toBe('00:00')
  })
})
