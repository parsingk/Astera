// Where a CLI actually is on this machine, checked fresh against the OS's own PATH rather than this
// process's possibly-stale copy of it (core/install/cliInstall.ts's locateCommandFor explains why:
// Windows keeps the authoritative PATH in the Machine/User environment blocks, and a POSIX login shell
// rebuilds it from the profile files an installer edited).
//
// Split out of ipc.ts (where `locateCli` started, backing `system.checkCliInstalled` and
// `adoptInstalledCli`) so `core.ts`'s `createCore` — which needs it for design F5's bypass detection,
// well before `registerIpc` ever runs — and ipc.ts's own two callers can share one implementation
// instead of growing a second copy.
import { execFile } from 'node:child_process'
import { existsSync, promises as fs, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  PROFILE_PATH_LINE,
  addUserPathCommand,
  locateCommandFor,
  parseLocated,
  profileFileFor,
  unpathedInstallDir,
  type InstallCommand
} from '../core/install/cliInstall'
import { isVoltaManagedPath, type BypassSignal } from '../core/sessions/retryBypass'
import type { Provider } from '../core/providers/meta'

/**
 * Read-only on purpose — no PATH mutation here. `ipc.ts`'s `adoptInstalledCli` is the same probe plus
 * that mutation, kept there for its one call site (right after an install).
 */
export async function locateCli(cli: 'claude' | 'codex'): Promise<string | null> {
  const plan = locateCommandFor(cli, process.platform, process.env.SHELL ?? '/bin/sh')
  if (plan === null) return null
  const found = await new Promise<string | null>((resolve) => {
    execFile(plan.command, plan.args, { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      // An interactive shell whose rc file's last command failed exits non-zero with the answer printed
      // (loginPath.ts's runShell takes it the same way).
      if (err && !stdout) return resolve(null)
      resolve(parseLocated(stdout))
    })
  })
  // Checked on disk before it is believed: a shell that answers with something that is not there
  // would put a directory on PATH that hides nothing and helps nobody.
  return found !== null && existsSync(found) ? found : null
}

export interface AfterInstallDeps {
  platform: string
  home: string
  exists: (file: string) => boolean
  locate: (cli: 'claude' | 'codex') => Promise<string | null>
  run: (command: InstallCommand) => Promise<boolean>
  /** macOS and Linux: the person's shell and zsh's ZDOTDIR, which pick the file the PATH line goes in. */
  shell?: string
  zdotdir?: string
  addToProfile: (file: string, line: string) => Promise<boolean>
}

/**
 * Where a CLI the app just installed is. When the machine cannot say but the folder its installer
 * documents holds it (Claude Code leaves PATH alone: cliInstall.ts's unpathedInstallDir), that folder is
 * put on PATH first, as the installer's note asks the person to: on Windows in the user's own Path, on
 * macOS and Linux by the note's line in the shell's own file. The app, the Host and every terminal
 * opened from then on find it there.
 */
export async function findAfterInstall(cli: 'claude' | 'codex', deps: AfterInstallDeps): Promise<string | null> {
  const found = await deps.locate(cli)
  if (found !== null) return found
  const dir = unpathedInstallDir(cli, deps.platform, deps.home)
  if (dir === null) return null
  const win = deps.platform === 'win32'
  const exe = win ? path.win32.join(dir, `${cli}.exe`) : path.posix.join(dir, cli)
  if (!deps.exists(exe)) return null
  if (win) {
    if (!(await deps.run(addUserPathCommand(dir)))) return null
  } else {
    const file = profileFileFor({ shell: deps.shell, platform: deps.platform, home: deps.home, zdotdir: deps.zdotdir, exists: deps.exists })
    if (file === null || !(await deps.addToProfile(file, PROFILE_PATH_LINE))) return null
  }
  return (await deps.locate(cli)) ?? exe
}

/** Adds a line to a shell profile file once, on a line of its own, making the file when it is not
 *  there; false when it cannot be read or written. */
export async function addToProfile(file: string, line: string): Promise<boolean> {
  try {
    const text = await fs.readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return ''
      throw e
    })
    if (text.split('\n').some((l) => l.trim() === line)) return true
    await fs.appendFile(file, `${text === '' || text.endsWith('\n') ? '' : '\n'}${line}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Runs one of cliInstall.ts's commands, answering whether it ended well. */
export const runInstallCommand = (c: InstallCommand): Promise<boolean> =>
  new Promise((resolve) => execFile(c.command, c.args, { timeout: 30_000, windowsHide: true }, (err) => resolve(err === null)))

/**
 * design F5: whether a bypassable toolchain manager is actually in the way of this CLI — checked once,
 * before a chat session spawns (`core.ts`'s startup warm-up), so a death this fast without a word of
 * protocol can offer a button backed by real evidence rather than a guess. Either signal is enough,
 * checked in confidence order:
 *  - `locateCli`'s own resolved path answers the first door directly: Volta's shim (and the tool image
 *    one level under it) lives under a `Volta` directory (`isVoltaManagedPath`, core — pure, tested
 *    there). Resolved through `realpath` first — fix round 1's minors — so a shim that is itself a
 *    symlink into the Volta tree is not missed just because the link lives somewhere else; a broken
 *    link or a permission error falls back to the un-resolved path rather than failing detection.
 *  - `VOLTA_HOME` being set at all answers the second door, where the CLI's own wrapper is not itself
 *    the shim but the `node` it execs is (`codex.cmd` calling `node`, and `node` is what Volta actually
 *    gates) — the environment read stays here, in main. This signal is weaker (fix round 1 / Important
 *    4): it proves Volta is installed and active on this machine, not that it gated *this* launch, so
 *    it is returned as its own, less confident case rather than folded into the same `true` the path
 *    match gets.
 */
export async function detectBypassableManager(cli: Provider): Promise<BypassSignal> {
  const resolved = await locateCli(cli)
  if (resolved !== null) {
    const real = (() => {
      try {
        return realpathSync(resolved)
      } catch {
        return resolved
      }
    })()
    if (isVoltaManagedPath(real) || isVoltaManagedPath(resolved)) return 'path'
  }
  if (process.env.VOLTA_HOME !== undefined) return 'voltaHome'
  return null
}
