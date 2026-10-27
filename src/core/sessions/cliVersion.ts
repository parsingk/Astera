// The CLI version Enforce needs (enforce design §5, E5), asked of the binary itself the way codexNoDaemon.ts asks for
// `--no-daemon`: once per binary (its real path, modification time and size, so an update is asked again) and for
// TTL_MS at most. A CLI older than ENFORCE_MIN, or one whose version cannot be read, does not start in Enforce: a
// session that looks protected and is not is the failure the design rules out.
import type { ResolveExecutable, SpawnCommand } from './commands'
import { fileIdentity, fileIdentityAsync, runHelp, runHelpAsync } from './codexNoDaemon'
import { resolveWindowsExecutable, warmWindowsExecutable, windowsSpawn } from './windowsExecutable'

type Cli = 'claude' | 'codex'

/** The oldest CLIs whose PreToolUse deny was measured to hold, bypass modes included (inventory §19). */
export const ENFORCE_MIN: Record<Cli, string> = { claude: '2.1.306', codex: '0.160.0' }

const TTL_MS = 10 * 60 * 1000

/** `2.1.311 (Claude Code)` → `2.1.311`; `codex-cli 0.160.0` → `0.160.0`; a pre-release keeps its numbers. */
export function parseCliVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null
}

/** Whether `found` is `min` or later, part by part as numbers. */
export function atLeast(found: string, min: string): boolean {
  const a = found.split('.').map(Number)
  const b = min.split('.').map(Number)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return true
}

/** Why `cli` at `version` cannot be enforced (`ENFORCE_UNAVAILABLE: cli-too-old <cli> <found> <min>` or
 *  `cli-version-unknown <cli>`), or null when it can. */
export function enforceBlocker(cli: Cli, version: string | null): string | null {
  if (version === null) return `ENFORCE_UNAVAILABLE: cli-version-unknown ${cli}`
  return atLeast(version, ENFORCE_MIN[cli]) ? null : `ENFORCE_UNAVAILABLE: cli-too-old ${cli} ${version} ${ENFORCE_MIN[cli]}`
}

/** The sync answer a spawn reads, and `warm`, which a prepare (or the capability refresh before a chat) awaits first. */
export type CliVersionProbe = ((cli: Cli) => string | null) & { warm(cli: Cli): Promise<void> }

export function makeCliVersionProbe(o: {
  platform: NodeJS.Platform
  resolve?: ResolveExecutable
  run?: (cmd: SpawnCommand) => string | null
  identity?: (file: string) => string
  resolveAsync?: (name: string) => Promise<string | null>
  runAsync?: (cmd: SpawnCommand) => Promise<string | null>
  identityAsync?: (file: string) => Promise<string>
  now?: () => number
}): CliVersionProbe {
  const resolve = o.resolve ?? resolveWindowsExecutable
  const run = o.run ?? runHelp
  const identity = o.identity ?? fileIdentity
  const resolveAsync = o.resolveAsync ?? warmWindowsExecutable
  const runAsync = o.runAsync ?? runHelpAsync
  const identityAsync = o.identityAsync ?? fileIdentityAsync
  const now = o.now ?? Date.now
  const known = new Map<Cli, { key: string; at: number; version: string | null }>()
  const fresh = (cli: Cli, key: string): boolean => {
    const k = known.get(cli)
    return k !== undefined && k.key === key && now() - k.at < TTL_MS
  }
  const learn = (cli: Cli, key: string, out: string | null): string | null => {
    const version = out === null ? null : parseCliVersion(out)
    known.set(cli, { key, at: now(), version })
    return version
  }
  const probe = (cli: Cli): string | null => {
    let cmd: SpawnCommand
    let key: string
    if (o.platform === 'win32') {
      const found = resolve(cli)
      // Not on PATH: the session's own spawn fails the same way, and there is nothing to ask.
      if (found === null) return null
      cmd = windowsSpawn(cli, ['--version'], () => found)
      key = identity(found)
    } else {
      cmd = { file: cli, args: ['--version'] }
      key = cli
    }
    if (fresh(cli, key)) return known.get(cli)?.version ?? null
    // A spawn nobody warmed: asked here, synchronously, as codexNoDaemon.ts does.
    return learn(cli, key, run(cmd))
  }
  const warm = async (cli: Cli): Promise<void> => {
    try {
      let cmd: SpawnCommand
      let key: string
      if (o.platform === 'win32') {
        const found = await resolveAsync(cli)
        if (found === null) return
        cmd = windowsSpawn(cli, ['--version'], () => found)
        key = await identityAsync(found)
      } else {
        cmd = { file: cli, args: ['--version'] }
        key = cli
      }
      if (fresh(cli, key)) return
      learn(cli, key, await runAsync(cmd))
    } catch {
      /* the spawn's own sync answer stands */
    }
  }
  return Object.assign(probe, { warm })
}

const shared = new Map<NodeJS.Platform, CliVersionProbe>()

/** One probe per platform for the whole process, as codexNoDaemonProbe: the app's and the Host's managers share it. */
export function cliVersionProbe(platform: NodeJS.Platform): CliVersionProbe {
  let probe = shared.get(platform)
  if (!probe) {
    probe = makeCliVersionProbe({ platform })
    shared.set(platform, probe)
  }
  return probe
}
