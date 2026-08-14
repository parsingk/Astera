// PATH recovery for the GUI app on macOS and Linux.
//
// A .app launched from Finder (or the Dock, or LaunchServices) never goes through a login shell, so
// it only gets launchd's default PATH (/usr/bin:/bin:/usr/sbin:/sbin). Everything this app spawns is
// a tool the user installed themselves — claude (~/.local/bin), codex (npm global), git (Xcode CLT or
// homebrew), node, gradle. Without recovery, session creation fails outright.
//
// Linux has the same gap for the same reason: an app started from a .desktop entry inherits the
// systemd user-session environment and never sources ~/.bashrc or ~/.zshrc (and on Wayland often not
// ~/.profile either), so nvm's shims and ~/.local/bin are missing. Launched from a terminal it works
// by accident — the parent shell's PATH is inherited — which is why the deb/AppImage install path is
// the one that breaks. Windows is the exception: PATH there is a machine/user environment variable
// that a GUI process already inherits, so no shell is launched.
//
// Why process.env.PATH is patched directly: session env is built by SessionManager.spawn as
// { ...process.env } (core/sessions/manager.ts:153), TerminalManager's exists() reads
// process.env.PATH directly (main/terminalManager.ts:15), and jdkScanner and git spawn do the same.
// Fixing one place carries through everywhere.
//
// Why an actual login shell gets run: PATH can be assembled from any of .zshrc/.zprofile/.bash_profile,
// and homebrew/mise/asdf/nvm all evaluate shellenv from within an rc file. Statically listing candidate
// directories would miss every one of them.
import { execFile } from 'node:child_process'

/** Wraps the value in markers to separate PATH from whatever banners/warnings the rc file prints. */
const START = '__ASTERA_PATH__'
const END = '__END__'
const PROBE = `printf '%s%s%s' '${START}' "$PATH" '${END}'`

/** Keeps startup from stalling if the rc file hangs forever (e.g. a prompt waiting for input). */
const PROBE_TIMEOUT_MS = 5_000

/** Extracts just PATH from the probe output. Returns null if the markers are missing or empty in between. */
export function parseLoginPath(stdout: string): string | null {
  const start = stdout.indexOf(START)
  if (start === -1) return null
  const from = start + START.length
  const end = stdout.indexOf(END, from)
  if (end === -1) return null
  const value = stdout.slice(from, end).trim()
  return value === '' ? null : value
}

/**
 * Puts the login PATH first, with the rest of the existing PATH's unique entries after it.
 *
 * Why merge instead of replace: some entries launchd added may not be in the login shell (an MDM
 * profile on a managed Mac, for instance), and losing those would go unnoticed. Why login PATH goes
 * first: whatever order the user set in their rc file (e.g. homebrew ahead of /usr/bin) is that
 * user's intent.
 */
export function mergePath(current: string | undefined, loginPath: string | null): string | undefined {
  if (loginPath === null) return current
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of [...loginPath.split(':'), ...(current ?? '').split(':')]) {
    if (part === '' || seen.has(part)) continue
    seen.add(part)
    out.push(part)
  }
  return out.length > 0 ? out.join(':') : current
}

/**
 * The shell to probe. SHELL being empty is rare, but if it is, fall back to the platform's default:
 * zsh is macOS's login shell, and /bin/sh is the only shell POSIX guarantees exists on Linux (naming
 * bash would break a musl/dash-only image). Both accept -ilc.
 */
export function probeShell(platform: NodeJS.Platform, shell: string | undefined): string {
  return shell || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
}

/** Asks the login shell for PATH. On win32 the shell isn't even launched. */
export async function readLoginPath(opts: {
  platform: NodeJS.Platform
  shell: string | undefined
  run: (file: string, args: string[]) => Promise<string>
}): Promise<string | null> {
  if (opts.platform === 'win32') return null
  const shell = probeShell(opts.platform, opts.shell)
  try {
    // Why -i (interactive) is included: version managers like nvm/mise only initialize in an rc file
    // (.zshrc, .bashrc), and an rc file is often not read by non-interactive shells.
    return parseLoginPath(await opts.run(shell, ['-ilc', PROBE]))
  } catch {
    return null // A probe failure must not block app startup
  }
}

function runShell(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' }, (err, stdout) => {
      // Treated as success if stdout has the markers even when the exit code is nonzero — it's
      // common for the rc file's last command to fail and leave the shell exiting non-zero.
      if (err && !stdout) reject(err)
      else resolve(stdout)
    })
  })
}

/** Updates process.env.PATH to the login shell's PATH. Does nothing on win32. */
export async function applyLoginPath(log: (m: string) => void): Promise<void> {
  const before = process.env.PATH
  const loginPath = await readLoginPath({
    platform: process.platform,
    shell: process.env.SHELL,
    run: runShell
  })
  if (loginPath === null) {
    // Only where a probe actually ran — on win32 there is no failure to report.
    if (process.platform !== 'win32') log('loginPath: probe failed, keeping the inherited PATH')
    return
  }
  const merged = mergePath(before, loginPath)
  if (merged && merged !== before) {
    process.env.PATH = merged
    log(`loginPath: PATH restored from ${probeShell(process.platform, process.env.SHELL)}`)
  }
}
