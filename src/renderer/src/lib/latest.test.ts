import { describe, it, expect } from 'vitest'
import { createLatest, settledPairs } from './latest'

// Audit UI-6, UI-8: two reads in flight for the same view (the model list of account A, then of B; two window focuses)
// let the older answer land last and overwrite the newer one.
describe('createLatest', () => {
  it('only the newest ticket is current', () => {
    const latest = createLatest()
    const a = latest.next()
    const b = latest.next()
    expect(latest.isCurrent(a)).toBe(false)
    expect(latest.isCurrent(b)).toBe(true)
  })
})

// Audit UI-8: one account removed mid-read rejected the whole Promise.all, unhandled, and the round set nothing.
describe('settledPairs', () => {
  it('keeps the answers that came, and leaves out the ones that failed', async () => {
    const out = await settledPairs(['a', 'b', 'c'], async (id) => {
      if (id === 'b') throw new Error('gone')
      return id.toUpperCase()
    })
    expect(out).toEqual({ a: 'A', c: 'C' })
  })
})
