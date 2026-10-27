// Which shell startup files a command reads on macOS and Linux (enforce and sandbox design §8): a file read at a
// session's every command can set a variable the Credentials list took away. Each startup file exports a marker of its
// own, and each mode prints its environment.
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const STARTUP_FILES = ['.profile', '.bash_profile', '.bash_login', '.bashrc', '.zshenv', '.zprofile', '.zshrc', '.zlogin']
// A login bash reads the first of .bash_profile, .bash_login and .profile, so .profile shows only in a home without the
// two before it (Ubuntu's default home has neither)
export const SHELL_MODES = [
  { argv: ['bash', '-c'] },
  { argv: ['bash', '-lc'] },
  { argv: ['bash', '-lc'], without: ['.bash_profile', '.bash_login'] },
  { argv: ['zsh', '-c'] },
  { argv: ['zsh', '-lc'] }
]

/** `.bash_profile` → `ASTERA_PROBE_BASH_PROFILE`. */
export const markerOf = (file) => `ASTERA_PROBE_${file.slice(1).toUpperCase()}`

/** The startup files whose marker an environment listing holds, in STARTUP_FILES order. */
export function markersIn(envText) {
  const set = new Set(envText.split('\n').map((l) => l.split('=')[0]))
  return STARTUP_FILES.filter((f) => set.has(markerOf(f)))
}

/** Writes the startup files under `home` (all but the mode's `without`) and runs each mode's `env`. `run(argv, env)` →
 *  `{ missing, out, timedOut }`; a shell that hung reads nothing and says so. */
export function measureShells(home, run, base = process.env) {
  return SHELL_MODES.map(({ argv, without = [] }) => {
    for (const f of STARTUP_FILES) {
      if (without.includes(f)) rmSync(path.join(home, f), { force: true })
      else writeFileSync(path.join(home, f), `export ${markerOf(f)}=1\n`)
    }
    const r = run([...argv, 'env'], { ...base, HOME: home })
    const timedOut = r.timedOut === true
    return {
      mode: argv.join(' ') + (without.length > 0 ? ` without ${without.join(', ')}` : ''),
      missing: r.missing,
      timedOut,
      read: r.missing || timedOut ? [] : markersIn(r.out)
    }
  })
}
