import { describe, it, expect } from 'vitest'
import { PUSH_STATE_FORMAT, parsePushState } from './push'

describe('parsePushState', () => {
  it('reads ahead and behind against the base', () => {
    expect(parsePushState('feat/x|3 0|origin/feat/x|ahead 3')).toEqual({
      'feat/x': { ahead: 3, behind: 0, hasUpstream: true, upstreamGone: false }
    })
  })

  it('a branch with no upstream still has an ahead count', () => {
    expect(parsePushState('feat/x|2 0||')).toEqual({
      'feat/x': { ahead: 2, behind: 0, hasUpstream: false, upstreamGone: false }
    })
  })

  it('a deleted upstream reads as gone, not as present', () => {
    const got = parsePushState('feat/x|0 1|origin/feat/x|gone')
    expect(got['feat/x'].hasUpstream).toBe(true)
    expect(got['feat/x'].upstreamGone).toBe(true)
  })

  // The distinction this whole module turns on: an unresolvable base is unknown, not zero.
  // Rendering unknown as "nothing to push" would silently hide a branch that has work on it.
  it('an empty ahead-behind is null, not 0', () => {
    expect(parsePushState('feat/x||origin/feat/x|')).toEqual({
      'feat/x': { ahead: null, behind: null, hasUpstream: true, upstreamGone: false }
    })
  })

  it('keeps branch names that contain slashes intact', () => {
    const got = parsePushState('parsingk/maple|1 0||')
    expect(Object.keys(got)).toEqual(['parsingk/maple'])
    expect(got['parsingk/maple'].ahead).toBe(1)
  })

  it('parses several lines and skips malformed ones without sinking the rest', () => {
    const got = parsePushState(['a|1 0||', 'garbage-with-no-pipes', 'b|0 0||'].join('\n'))
    expect(Object.keys(got).sort()).toEqual(['a', 'b'])
  })

  // `|` is legal in a git ref name, so a pipe-bearing branch produces more than four fields.
  // Admitting it would silently shift every field one place along — worse than skipping it.
  it('skips a line with too many fields, not just too few', () => {
    const got = parsePushState(['feat|x|1 0|origin/feat|x|', 'ok|1 0||'].join('\n'))
    expect(Object.keys(got)).toEqual(['ok'])
  })

  it('empty output is an empty map, not a throw', () => {
    expect(parsePushState('')).toEqual({})
  })

  it('the exported format carries all four fields the parser reads', () => {
    for (const atom of ['refname:short', 'ahead-behind:', 'upstream:short', 'upstream:track'])
      expect(PUSH_STATE_FORMAT).toContain(atom)
  })
})
