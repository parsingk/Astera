import { describe, it, expect } from 'vitest'
import { lastByState } from './stateMemo'

// Audit OR-6: `runs follow` and `check --wait` probe every 50 ms, and each probe counted the Run's whole timeline again
// though the state had not changed since the last one. The state is replaced, never mutated, on every commit, so the
// last answer is kept for as long as the same state object is asked about.
describe('lastByState', () => {
  it('computes once per state object, and again for a new one', () => {
    let calls = 0
    const count = lastByState((s: { n: number }) => {
      calls++
      return s.n * 2
    })
    const a = { n: 1 }
    expect(count(a)).toBe(2)
    expect(count(a)).toBe(2)
    expect(calls).toBe(1)
    const b = { n: 5 }
    expect(count(b)).toBe(10)
    expect(calls).toBe(2)
  })
})
