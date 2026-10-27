// Which shell startup files a command reads (enforce and sandbox design §8): each file exports a marker of its own.
import { describe, it, expect } from 'vitest'
import { SHELL_MODES, STARTUP_FILES, markerOf, markersIn } from './shells.mjs'

describe('shell startup files', () => {
  it('reads which startup files a shell ran', () => {
    expect(markersIn('ASTERA_PROBE_ZSHENV=1\nPATH=/bin\nASTERA_PROBE_PROFILE=1\n')).toEqual(['.profile', '.zshenv'])
    expect(markersIn('PATH=/bin\n')).toEqual([])
  })

  it('names each file’s marker after the file', () => {
    expect(STARTUP_FILES).toEqual(['.profile', '.bash_profile', '.bashrc', '.zshenv', '.zprofile', '.zshrc'])
    expect(markerOf('.bash_profile')).toBe('ASTERA_PROBE_BASH_PROFILE')
    expect(SHELL_MODES).toEqual([
      ['bash', '-c'],
      ['bash', '-lc'],
      ['zsh', '-c'],
      ['zsh', '-lc']
    ])
  })
})
