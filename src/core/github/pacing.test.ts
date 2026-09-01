import { describe, it, expect } from 'vitest'
import {
  BREAKER_HOLD_MS,
  MIN_SPACING_MS,
  REPO_INTERVAL_MS,
  initialPacing,
  isBroken,
  noteCall,
  pickDue,
  tripBreaker
} from './pacing'

const T0 = 1_000_000

describe('pacing', () => {
  it('a never-fetched repo is due immediately', () => {
    expect(pickDue(initialPacing(), ['a', 'b'], T0, false)).toBe('a')
  })

  it('a fetched repo is not due again inside the interval, and is after', () => {
    const s = noteCall(initialPacing(), 'a', T0)
    expect(pickDue(s, ['a'], T0 + REPO_INTERVAL_MS - 1, false)).toBeNull()
    expect(pickDue(s, ['a'], T0 + REPO_INTERVAL_MS, false)).toBe('a')
  })

  it('spacing gates every call, whatever the repo', () => {
    const s = noteCall(initialPacing(), 'a', T0)
    expect(pickDue(s, ['b'], T0 + MIN_SPACING_MS - 1, false)).toBeNull()
    expect(pickDue(s, ['b'], T0 + MIN_SPACING_MS, false)).toBe('b')
  })

  it('force skips the interval but not the spacing', () => {
    const s = noteCall(initialPacing(), 'a', T0)
    expect(pickDue(s, ['a'], T0 + MIN_SPACING_MS, true)).toBe('a') // interval not yet over
    expect(pickDue(s, ['a'], T0 + MIN_SPACING_MS - 1, true)).toBeNull() // spacing still holds
  })

  it('the breaker blocks everything, force included, until the hold passes', () => {
    const s = tripBreaker(initialPacing(), T0)
    expect(isBroken(s, T0 + BREAKER_HOLD_MS - 1)).toBe(true)
    expect(pickDue(s, ['a'], T0 + BREAKER_HOLD_MS - 1, true)).toBeNull()
    expect(isBroken(s, T0 + BREAKER_HOLD_MS)).toBe(false)
    expect(pickDue(s, ['a'], T0 + BREAKER_HOLD_MS, true)).toBe('a')
  })

  it('picks the longest-unfetched repo first', () => {
    let s = noteCall(initialPacing(), 'a', T0)
    s = noteCall(s, 'b', T0 + MIN_SPACING_MS)
    const later = T0 + REPO_INTERVAL_MS + MIN_SPACING_MS
    expect(pickDue(s, ['b', 'a'], later, false)).toBe('a')
  })
})
