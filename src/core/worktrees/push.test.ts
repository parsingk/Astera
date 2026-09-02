import { describe, it, expect } from 'vitest'
import { normalizeBaseForGh, parsePushState, PUSH_STATE_FORMAT, readPushState } from './push'

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

describe('normalizeBaseForGh', () => {
  // The rule this repo already paid for once: a local branch can contain a slash too.
  // fetchBaseRef's comment records a shape-based split sending git to a remote that did not
  // exist. Astera names branches <user>/<slug>, so this is the ordinary case here.
  it('strips a real remote prefix', async () => {
    expect(await normalizeBaseForGh('/r', 'origin/main', async () => true)).toBe('main')
  })

  it('leaves a local branch that merely looks remote alone', async () => {
    expect(await normalizeBaseForGh('/r', 'parsingk/maple', async () => false)).toBe(
      'parsingk/maple'
    )
  })

  it('leaves a name with no slash alone without asking', async () => {
    let asked = false
    const probe = async (): Promise<boolean> => {
      asked = true
      return true
    }
    expect(await normalizeBaseForGh('/r', 'develop', probe)).toBe('develop')
    expect(asked).toBe(false)
  })

  it('strips only the first segment', async () => {
    expect(await normalizeBaseForGh('/r', 'origin/release/1.2', async () => true)).toBe(
      'release/1.2'
    )
  })
})

describe('readPushState', () => {
  it('asks git once per base and merges the results', async () => {
    const calls: string[][] = []
    const got = await readPushState('/r', ['develop', 'main'], {
      run: async (args) => {
        calls.push(args)
        return { ok: true, stdout: `b${calls.length}|1 0||`, stderr: '' }
      },
      versionOk: async () => true
    })
    expect(calls).toHaveLength(2)
    expect(calls[0].join(' ')).toContain('develop')
    expect(calls[1].join(' ')).toContain('main')
    expect(Object.keys(got).sort()).toEqual(['b1', 'b2'])
  })

  it('de-duplicates repeated bases', async () => {
    let n = 0
    await readPushState('/r', ['develop', 'develop'], {
      run: async () => {
        n += 1
        return { ok: true, stdout: '', stderr: '' }
      },
      versionOk: async () => true
    })
    expect(n).toBe(1)
  })

  // Not knowing the count is no reason to withhold the action, so this returns empty rather
  // than throwing — the row simply shows nothing and the menu still offers Create.
  it('returns empty when git is too old, without running anything', async () => {
    let ran = false
    const got = await readPushState('/r', ['develop'], {
      run: async () => {
        ran = true
        return { ok: true, stdout: 'x|1 0||', stderr: '' }
      },
      versionOk: async () => false
    })
    expect(got).toEqual({})
    expect(ran).toBe(false)
  })

  it('a failed git call contributes nothing and does not throw', async () => {
    const got = await readPushState('/r', ['develop'], {
      run: async () => ({ ok: false, stdout: '', stderr: 'boom' }),
      versionOk: async () => true
    })
    expect(got).toEqual({})
  })

  it('substitutes the base into the format rather than appending it', async () => {
    let fmt = ''
    await readPushState('/r', ['develop'], {
      run: async (args) => {
        fmt = args.find((a) => a.startsWith('--format=')) ?? ''
        return { ok: true, stdout: '', stderr: '' }
      },
      versionOk: async () => true
    })
    expect(fmt).toContain('%(ahead-behind:develop)')
    expect(fmt).not.toContain('<base>')
  })
})
