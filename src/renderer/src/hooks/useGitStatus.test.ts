import { describe, it, expect } from 'vitest'
import { nextGitStatus } from './useGitStatus'

describe('nextGitStatus', () => {
  const prev = { '/r/a.ts': 'modified' as const }

  // git.status answers null when git failed or timed out. The badges are kept — clearing them would
  // flicker and claim a clean tree — but they are marked stale so the explorer can say so.
  it('an unknown answer (null) keeps the last badges and marks them stale', () => {
    expect(nextGitStatus(prev, null)).toEqual({ fileState: prev, stale: true })
  })

  it('a real answer replaces the badges and clears stale', () => {
    const map = { '/r/b.ts': 'new' as const }
    expect(nextGitStatus(prev, map)).toEqual({ fileState: map, stale: false })
  })

  // Second pass R2-8: every watcher batch asked git again and the answer always replaced the map, so the explorer
  // drew again with nothing changed while an agent wrote files. The same badges keep the same object.
  it('an answer with the same badges keeps the map it had', () => {
    expect(nextGitStatus(prev, { '/r/a.ts': 'modified' }).fileState).toBe(prev)
  })

  it('an empty answer is a clean tree, not unknown', () => {
    expect(nextGitStatus(prev, {})).toEqual({ fileState: {}, stale: false })
  })
})
