import { describe, it, expect } from 'vitest'
import { dropKeys } from './dropKeys'

// Performance audit (renderer, small): the per-session marks (working, roll and schedule banners, a remote tab's status)
// kept an entry for every session the app ever showed.
describe('dropKeys', () => {
  it('drops the entries of sessions that went', () => {
    expect(dropKeys({ a: 1, b: 2, c: 3 }, new Set(['b']))).toEqual({ a: 1, c: 3 })
  })
  it('answers the same object when none of them is there, so a state setter changes nothing', () => {
    const rec = { a: 1 }
    expect(dropKeys(rec, new Set(['b']))).toBe(rec)
  })
})
