// Which shell startup files a command reads on macOS and Linux (enforce and sandbox design §8): a file read at a
// session's every command can set a variable the Credentials list took away. Each startup file exports a marker of its
// own, and each mode prints its environment.
import { writeFileSync } from 'node:fs'
import path from 'node:path'

export const STARTUP_FILES = ['.profile', '.bash_profile', '.bashrc', '.zshenv', '.zprofile', '.zshrc']
export const SHELL_MODES = [
  ['bash', '-c'],
  ['bash', '-lc'],
  ['zsh', '-c'],
  ['zsh', '-lc']
]

/** `.bash_profile` → `ASTERA_PROBE_BASH_PROFILE`. */
export const markerOf = (file) => `ASTERA_PROBE_${file.slice(1).toUpperCase()}`

/** The startup files whose marker an environment listing holds, in STARTUP_FILES order. */
export function markersIn(envText) {
  const set = new Set(envText.split('\n').map((l) => l.split('=')[0]))
  return STARTUP_FILES.filter((f) => set.has(markerOf(f)))
}

/** Writes every startup file under `home` and runs each mode's `env`. `run(argv, env)` → `{ missing, out }`. */
export function measureShells(home, run, base = process.env) {
  for (const f of STARTUP_FILES) writeFileSync(path.join(home, f), `export ${markerOf(f)}=1\n`)
  return SHELL_MODES.map(([shell, mode]) => {
    const r = run([shell, mode, 'env'], { ...base, HOME: home })
    return { mode: `${shell} ${mode}`, missing: r.missing, read: r.missing ? [] : markersIn(r.out) }
  })
}
