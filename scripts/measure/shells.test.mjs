// Which shell startup files a command reads (enforce and sandbox design §8): each file exports a marker of its own.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SHELL_MODES, STARTUP_FILES, markerOf, markersIn, measureShells } from './shells.mjs'

describe('shell startup files', () => {
  it('reads which startup files a shell ran', () => {
    expect(markersIn('ASTERA_PROBE_ZSHENV=1\nPATH=/bin\nASTERA_PROBE_PROFILE=1\n')).toEqual(['.profile', '.zshenv'])
    expect(markersIn('PATH=/bin\n')).toEqual([])
  })

  // Final review M6: bash's login files are read first-found, so .profile shows only without the two before it
  it('names each file’s marker after the file', () => {
    expect(STARTUP_FILES).toEqual(['.profile', '.bash_profile', '.bash_login', '.bashrc', '.zshenv', '.zprofile', '.zshrc', '.zlogin'])
    expect(markerOf('.bash_profile')).toBe('ASTERA_PROBE_BASH_PROFILE')
    expect(SHELL_MODES).toEqual([
      { argv: ['bash', '-c'] },
      { argv: ['bash', '-lc'] },
      { argv: ['bash', '-lc'], without: ['.bash_profile', '.bash_login'] },
      { argv: ['zsh', '-c'] },
      { argv: ['zsh', '-lc'] }
    ])
  })

  it('runs each mode in a home with its files, and says when a shell hung', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'astera-shells-'))
    try {
      const seen = []
      const run = (argv) => {
        seen.push(STARTUP_FILES.filter((f) => existsSync(path.join(home, f))))
        return argv[0] === 'zsh' ? { missing: false, out: '', timedOut: true } : { missing: false, out: `${markerOf('.profile')}=1\n` }
      }
      const r = measureShells(home, run, {})
      expect(r.map((m) => m.mode)).toEqual(['bash -c', 'bash -lc', 'bash -lc without .bash_profile, .bash_login', 'zsh -c', 'zsh -lc'])
      expect(seen[2]).not.toContain('.bash_profile')
      expect(seen[2]).not.toContain('.bash_login')
      expect(seen[3]).toEqual(STARTUP_FILES)
      expect(r[2]).toMatchObject({ read: ['.profile'], timedOut: false })
      expect(r[3]).toMatchObject({ read: [], timedOut: true })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
