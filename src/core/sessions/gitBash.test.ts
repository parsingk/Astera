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
    expect(findGitBash(env, only('E:\\programs\\Git\\cmd\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe'))).toBe(
      'E:\\programs\\Git\\bin\\bash.exe'
    )
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

  // P1 carry-over 4: a Cygwin or MSYS2 bash earlier on PATH is not Git Bash, and handing it over breaks
  // the hooks in a different way. Git for Windows is looked for first; a plain bash on PATH comes after.
  it('prefers the Git whose cmd\\git.exe is on PATH over a Cygwin bash earlier on PATH', () => {
    const env = { PATH: 'C:\\cygwin64\\bin;E:\\programs\\Git\\cmd' }
    const fs = only('C:\\cygwin64\\bin\\bash.exe', 'E:\\programs\\Git\\cmd\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe')
    expect(findGitBash(env, fs)).toBe('E:\\programs\\Git\\bin\\bash.exe')
  })

  it('prefers the Git whose bin\\git.exe is on PATH over an MSYS2 bash earlier on PATH', () => {
    const env = { PATH: 'C:\\msys64\\usr\\bin;E:\\programs\\Git\\bin' }
    const fs = only('C:\\msys64\\usr\\bin\\bash.exe', 'E:\\programs\\Git\\bin\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe')
    expect(findGitBash(env, fs)).toBe('E:\\programs\\Git\\bin\\bash.exe')
  })

  it('prefers Program Files\\Git over a Cygwin or MSYS2 bash on PATH', () => {
    const env = { PATH: 'C:\\msys64\\usr\\bin;C:\\cygwin64\\bin' }
    const fs = only('C:\\msys64\\usr\\bin\\bash.exe', 'C:\\cygwin64\\bin\\bash.exe', 'C:\\Program Files\\Git\\bin\\bash.exe')
    expect(findGitBash(env, fs)).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  })

  it('takes a plain bash on PATH only when no Git for Windows is found, and never a sibling guessed from it', () => {
    // A bash beside no git.exe is not taken as a Git install root: E:\tools\bin\bash.exe is not looked for
    // from E:\tools\cmd, which was the old guess.
    expect(findGitBash({ PATH: 'E:\\tools\\cmd;C:\\cygwin64\\bin' }, only('E:\\tools\\bin\\bash.exe', 'C:\\cygwin64\\bin\\bash.exe'))).toBe(
      'C:\\cygwin64\\bin\\bash.exe'
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
    expect(findGitBash({ Path: 'E:\\programs\\Git\\cmd' }, only('E:\\programs\\Git\\cmd\\git.exe', 'E:\\programs\\Git\\bin\\bash.exe'))).toBe(
      'E:\\programs\\Git\\bin\\bash.exe'
    )
    expect(findGitBash({}, () => true)).toBeNull()
  })
})
