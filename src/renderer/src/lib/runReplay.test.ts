// Second pass R2-7: the Run console asked for its replay and listened for live output at once, so a chunk printed while
// the replay was on its way was written live first and again inside the replay, out of order.
import { describe, it, expect } from 'vitest'
import { createReplayJoin } from './runReplay'

describe('createReplayJoin', () => {
  it('holds live output until the replay, then writes only what the replay did not have', () => {
    const out: string[] = []
    const j = createReplayJoin((s) => out.push(s))
    j.live('cd', 4) // chars 2..4, also in the replay
    j.live('ef', 6) // chars 4..6, after it
    expect(out).toEqual([])
    j.replay('abcd', 4)
    expect(out.join('')).toBe('abcdef')
  })

  it('writes the part of a chunk the replay cut through', () => {
    const out: string[] = []
    const j = createReplayJoin((s) => out.push(s))
    j.live('cdef', 6)
    j.replay('abcd', 4)
    expect(out.join('')).toBe('abcdef')
  })

  it('writes live output straight through once the replay is in', () => {
    const out: string[] = []
    const j = createReplayJoin((s) => out.push(s))
    j.replay('ab', 2)
    j.live('cd', 4)
    j.live('cd', 4) // a repeat of what was written
    expect(out.join('')).toBe('abcd')
  })

  it('a chunk with no position is written as it comes, after the replay', () => {
    const out: string[] = []
    const j = createReplayJoin((s) => out.push(s))
    j.live('x')
    j.replay('ab', 2)
    j.live('y')
    expect(out.join('')).toBe('abxy')
  })
})
