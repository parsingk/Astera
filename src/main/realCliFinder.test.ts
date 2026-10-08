import { describe, it, expect } from 'vitest'
import { createRealCliFinder } from './realCliFinder'

// Performance audit M8: Settings' Higgsfield list looked the real CLI up on PATH two times plus once per account, each
// a synchronous read of every name, folder and extension on main's thread (a dead network folder on PATH stalled the
// app for each). The candidates are now read asynchronously, and one answer serves the calls of a few seconds.
describe('createRealCliFinder', () => {
  // A finder shaped like findRealHiggsfield: it reads each candidate in order and returns the first one there.
  const CANDIDATES = ['/a/hf', '/b/hf', '/c/hf']
  const find = (read: (p: string) => string | null): string | null => CANDIDATES.find((c) => read(c) !== null) ?? null

  it('reads every candidate asynchronously and answers the first one there', async () => {
    const asyncReads: string[] = []
    const f = createRealCliFinder({
      find,
      readAsync: async (p) => {
        asyncReads.push(p)
        return p === '/b/hf' ? 'program' : null
      },
      now: () => 0
    })
    expect(await f.find()).toBe('/b/hf')
    expect(asyncReads.sort()).toEqual(CANDIDATES)
  })

  it('answers from one lookup for a few seconds, then looks again', async () => {
    let lookups = 0
    let t = 0
    const f = createRealCliFinder({
      find,
      readAsync: async (p) => {
        if (p === '/a/hf') lookups++
        return null
      },
      now: () => t,
      ttlMs: 5_000
    })
    await Promise.all([f.find(), f.find(), f.find()])
    await f.find()
    expect(lookups).toBe(1)
    t += 5_001
    expect(await f.find()).toBeNull()
    expect(lookups).toBe(2)
  })
})
