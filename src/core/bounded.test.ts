// Small bounded collections for what a long-running process remembers only to say a thing once, or to answer a late
// question (performance audit H5): past their cap the oldest goes.
import { describe, it, expect } from 'vitest'
import { onceBounded, setBounded } from './bounded'

describe('onceBounded', () => {
  it('says a key is new once, and forgets the oldest past the cap', () => {
    const seen = new Set<string>()
    expect(onceBounded(seen, 'a', 2)).toBe(true)
    expect(onceBounded(seen, 'a', 2)).toBe(false)
    onceBounded(seen, 'b', 2)
    onceBounded(seen, 'c', 2)
    expect([...seen]).toEqual(['b', 'c'])
    expect(onceBounded(seen, 'a', 2)).toBe(true)
  })
})

describe('setBounded', () => {
  it('keeps the newest entries, a rewrite counting as new', () => {
    const m = new Map<string, number>()
    setBounded(m, 'a', 1, 2)
    setBounded(m, 'b', 2, 2)
    setBounded(m, 'a', 3, 2)
    setBounded(m, 'c', 4, 2)
    expect([...m]).toEqual([['a', 3], ['c', 4]])
  })
})
