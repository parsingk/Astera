import { describe, it, expect } from 'vitest'
import { findGitBash } from './gitBash'

/** A probe that says yes only for the listed absolute paths. */
const only = (...paths: string[]) => (p: string): boolean => paths.includes(p)

describe('findGitBash', () => {
  it('keeps a value the user already set, without probing', () => {
    let probed = 0
    const found = findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: 'E:/git/bin/bash.exe' }, () => {
      probed++
      return true
    })
    expect(found).toBeNull() // null means "nothing to add"
    expect(probed).toBe(0)
  })

  it('finds bash next to the git on PATH', () => {
    const env = { PATH: 'C:\\Windows\\System32;E:\\programs\\Git\\cmd' }
    expect(findGitBash(env, only('E:\\programs\\Git\\bin\\bash.exe'))).toBe('E:\\programs\\Git\\bin\\bash.exe')
  })

  it('accepts a PATH entry that is already the bin directory', () => {
    const env = { PATH: 'E:\\programs\\Git\\bin' }
    expect(findGitBash(env, only('E:\\programs\\Git\\bin\\bash.exe'))).toBe('E:\\programs\\Git\\bin\\bash.exe')
  })

  it('falls back to the usual install roots', () => {
    expect(findGitBash({ PATH: 'C:\\Windows\\System32' }, only('C:\\Program Files\\Git\\bin\\bash.exe'))).toBe(
      'C:\\Program Files\\Git\\bin\\bash.exe'
    )
  })

  it('never returns the WSL bash in System32', () => {
    const env = { PATH: 'C:\\Windows\\System32' }
    expect(findGitBash(env, only('C:\\Windows\\System32\\bash.exe'))).toBeNull()
  })

  it('returns null when no Git Bash exists', () => {
    expect(findGitBash({ PATH: 'C:\\Windows\\System32' }, () => false)).toBeNull()
  })

  it('reads PATH whatever its case, and tolerates an absent PATH', () => {
    expect(findGitBash({ Path: 'E:\\programs\\Git\\cmd' }, only('E:\\programs\\Git\\bin\\bash.exe'))).toBe(
      'E:\\programs\\Git\\bin\\bash.exe'
    )
    expect(findGitBash({}, () => true)).toBeNull()
  })
})
