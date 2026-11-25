import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { utf8CtypeFor } from './utf8Locale'

describe('utf8CtypeFor', () => {
  it('gives a macOS environment with no locale a UTF-8 LC_CTYPE', () => {
    expect(utf8CtypeFor({ PATH: '/usr/bin' }, 'darwin')).toBe('en_US.UTF-8')
  })

  it('counts an empty locale variable as unset', () => {
    expect(utf8CtypeFor({ LANG: '', LC_ALL: '', LC_CTYPE: '' }, 'darwin')).toBe('en_US.UTF-8')
  })

  it('leaves any locale the environment already names alone, even C', () => {
    expect(utf8CtypeFor({ LANG: 'ko_KR.UTF-8' }, 'darwin')).toBeNull()
    expect(utf8CtypeFor({ LANG: 'C' }, 'darwin')).toBeNull()
    expect(utf8CtypeFor({ LC_ALL: 'C' }, 'darwin')).toBeNull()
    expect(utf8CtypeFor({ LC_CTYPE: 'UTF-8' }, 'darwin')).toBeNull()
  })

  it('changes nothing off macOS', () => {
    expect(utf8CtypeFor({}, 'linux')).toBeNull()
    expect(utf8CtypeFor({}, 'win32')).toBeNull()
  })
})

// The value has to be a locale this macOS has: one it does not know reads as C, and the fix does nothing. wc -m counts
// characters by LC_CTYPE, so one Hangul syllable is 1 under a UTF-8 locale and 3 (its bytes) under C. The same decoding
// is what made pbcopy turn non-ASCII text into an empty clipboard (measured 2026-11-25), which a test must not touch.
describe.runIf(process.platform === 'darwin')('utf8CtypeFor — on this Mac', () => {
  const count = (env: Record<string, string>): string =>
    execFileSync('/usr/bin/wc', ['-m'], { input: '한', env, encoding: 'utf8' }).trim()

  it('names a locale that makes programs read UTF-8', () => {
    const base = { PATH: '/usr/bin:/bin' }
    expect(count(base)).toBe('3')
    expect(count({ ...base, LC_CTYPE: utf8CtypeFor(base, 'darwin')! })).toBe('1')
  })
})
