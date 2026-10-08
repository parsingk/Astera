// Whether this codex accepts `--no-daemon`, asked of the binary itself (measured 2026-10-07, codex 0.160).
//
// Codex 0.160's TUI attaches to a shared app-server daemon, one per CODEX_HOME, and its shell tool runs in
// that daemon's environment, not in the environment the TUI was started with. The daemon is started by
// whichever TUI comes first and keeps that TUI's environment for as long as it lives. Every session this
// app starts carries its own ASTERA_SESSION, ASTERA_PROFILE_DIR and ASTERA_CLI, so a worker attached to a
// daemon another session started runs `astera` as that other session. On the development machine a daemon
// a development-profile worker had started four days earlier sent a release worker's `astera ask` to the
// development profile's Host, which was not running (HOST_NOT_RUNNING); a Host that was running would have
// taken the call under the other session's name. Measured with a marker variable in a pty-started TUI:
// with the daemon up, the shell saw the daemon's values; with `--no-daemon`, its own. The config switch
// `features.daemon_auto_start=false` does not help: it only stops a TUI from starting a daemon, and a TUI
// still attaches to one that is already running.
//
// The flag is new, and a codex that does not know it refuses to start, so it goes only to a binary whose
// `--help` names it. The answer is kept per binary (its real path, modification time and size, so an
// update is asked again) and for TTL_MS at most, which is what catches an update of a posix codex this
// module finds by name and cannot stat.
import { execFile, spawnSync } from 'node:child_process'
import { promises as fsp, realpathSync, statSync } from 'node:fs'
import type { ResolveExecutable, SpawnCommand } from './commands'
import { resolveWindowsExecutable, warmWindowsExecutable, windowsSpawn } from './windowsExecutable'

const TTL_MS = 10 * 60 * 1000
/** `codex --help` answers in about 80 ms; a binary that has not answered in this long is not asked again
 *  until the TTL, and is treated as not knowing the flag. */
const HELP_TIMEOUT_MS = 5_000

/** stdout of a `--help` run, or null when it did not exit cleanly. Sync on purpose: the command builder
 *  it feeds is sync, and the run happens once per binary per TTL_MS. */
function runHelp(cmd: SpawnCommand): string | null {
  const r = spawnSync(cmd.file, cmd.args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: HELP_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null
}

/** `runHelp` off the calling thread (second pass M2-1): what a spawn's prepare runs, so the spawn finds the answer. */
function runHelpAsync(cmd: SpawnCommand): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd.file, cmd.args, { windowsHide: true, encoding: 'utf8', timeout: HELP_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
  })
}

async function fileIdentityAsync(file: string): Promise<string> {
  try {
    const real = await fsp.realpath(file)
    const st = await fsp.stat(real)
    return `${real}|${st.mtimeMs}|${st.size}`
  } catch {
    return file
  }
}

/** What changes when codex is updated: the standalone install's bin is a link to the current release
 *  folder, so the real path moves; an npm install rewrites the shim in place, so the time and size do. */
function fileIdentity(file: string): string {
  try {
    const real = realpathSync(file)
    const st = statSync(real)
    return `${real}|${st.mtimeMs}|${st.size}`
  } catch {
    return file
  }
}

/** The sync answer a command builder reads, and `warm`, which a spawn's prepare awaits first so that answer is ready. */
export type CodexNoDaemonProbe = (() => boolean) & { warm(): Promise<void> }

export function makeCodexNoDaemonProbe(o: {
  platform: NodeJS.Platform
  resolve?: ResolveExecutable
  run?: (cmd: SpawnCommand) => string | null
  identity?: (file: string) => string
  resolveAsync?: (name: string) => Promise<string | null>
  runAsync?: (cmd: SpawnCommand) => Promise<string | null>
  identityAsync?: (file: string) => Promise<string>
  now?: () => number
}): CodexNoDaemonProbe {
  const resolve = o.resolve ?? resolveWindowsExecutable
  const run = o.run ?? runHelp
  const identity = o.identity ?? fileIdentity
  const resolveAsync = o.resolveAsync ?? warmWindowsExecutable
  const runAsync = o.runAsync ?? runHelpAsync
  const identityAsync = o.identityAsync ?? fileIdentityAsync
  const now = o.now ?? Date.now
  let known: { key: string; at: number; supported: boolean } | null = null
  const fresh = (key: string): boolean => known !== null && known.key === key && now() - known.at < TTL_MS
  const learn = (key: string, help: string | null): boolean => {
    const supported = help !== null && /(^|\s)--no-daemon\b/.test(help)
    known = { key, at: now(), supported }
    return supported
  }
  const probe = (): boolean => {
    let cmd: SpawnCommand
    let key: string
    if (o.platform === 'win32') {
      const found = resolve('codex')
      // Not on PATH: the session's own spawn fails the same way, and there is nothing to ask.
      if (found === null) return false
      cmd = windowsSpawn('codex', ['--help'], () => found)
      key = identity(found)
    } else {
      cmd = { file: 'codex', args: ['--help'] }
      key = 'codex'
    }
    if (fresh(key)) return (known as { supported: boolean }).supported
    // A spawn nobody prepared: asked here, synchronously, as before.
    return learn(key, run(cmd))
  }
  const warm = async (): Promise<void> => {
    try {
      let cmd: SpawnCommand
      let key: string
      if (o.platform === 'win32') {
        const found = await resolveAsync('codex')
        if (found === null) return
        cmd = windowsSpawn('codex', ['--help'], () => found)
        key = await identityAsync(found)
      } else {
        cmd = { file: 'codex', args: ['--help'] }
        key = 'codex'
      }
      if (fresh(key)) return
      learn(key, await runAsync(cmd))
    } catch {
      /* the spawn's own sync answer stands */
    }
  }
  return Object.assign(probe, { warm })
}

const shared = new Map<NodeJS.Platform, CodexNoDaemonProbe>()

/** One probe per platform for the whole process: every SessionManager, the Host's spawner and its
 *  checks build descriptors of their own, and asking the binary once is enough for all of them. */
export function codexNoDaemonProbe(platform: NodeJS.Platform): CodexNoDaemonProbe {
  let probe = shared.get(platform)
  if (!probe) {
    probe = makeCodexNoDaemonProbe({ platform })
    shared.set(platform, probe)
  }
  return probe
}
