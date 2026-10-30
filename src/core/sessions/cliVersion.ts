// The CLI version Enforce needs (enforce design §5, E5), asked of the binary itself the way codexNoDaemon.ts asks for
// `--no-daemon`: once per binary (its real path, modification time and size, so an update is asked again) and for
// TTL_MS at most. A CLI older than ENFORCE_MIN, or one whose version cannot be read, does not start in Enforce: a
// session that looks protected and is not is the failure the design rules out.
import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
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

/** The Claude Code the research saw both UserPromptExpansion and SubagentStart in (lifecycle design §4.12, plan ruling 15).
 *  Older, or a version that could not be read, is not given the two hooks (statusline.ts), and its uses read "Claude
 *  cannot tell" (findings/rules/extensionUse.ts): the docs do not say since when UserPromptExpansion exists. */
export const USE_REPORT_MIN_CLAUDE = '2.1.312'

/** Whether the Claude Code at `version` reports every use of a skill, command or agent (USE_REPORT_MIN_CLAUDE). */
export const reportsUses = (version: string | null | undefined): boolean => typeof version === 'string' && atLeast(version, USE_REPORT_MIN_CLAUDE)

/** Why `cli` at `version` cannot be enforced (`ENFORCE_UNAVAILABLE: cli-too-old <cli> <found> <min>`,
 *  `cli-version-unknown <cli>`, or `cli-missing <cli>` when it is not there), or null when it can. */
export function enforceBlocker(cli: Cli, version: string | null | undefined): string | null {
  if (version === undefined) return `ENFORCE_UNAVAILABLE: cli-missing ${cli}`
  if (version === null) return `ENFORCE_UNAVAILABLE: cli-version-unknown ${cli}`
  return atLeast(version, ENFORCE_MIN[cli]) ? null : `ENFORCE_UNAVAILABLE: cli-too-old ${cli} ${version} ${ENFORCE_MIN[cli]}`
}

/** The sync answer a spawn reads (the version, null when it could not be read, undefined when the CLI is not there), and
 *  `warm`, which a prepare (or the capability refresh before a chat) awaits first. `cached` is the version last learnt and
 *  still fresh, or undefined: it never resolves, stats or runs anything, so a spawn that must not wait on the CLI reads it
 *  (an observed Claude session's use hooks, lifecycle design §4.12) and takes a miss for a version not known. */
export type CliVersionProbe = ((cli: Cli) => string | null | undefined) & { warm(cli: Cli): Promise<void>; cached(cli: Cli): string | undefined }

/** The CLI on PATH on macOS and Linux, the first file of that name. */
function whichPosix(name: string): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const file = path.posix.join(dir, name)
    if (existsSync(file)) return file
  }
  return null
}

async function whichPosixAsync(name: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue
    const file = path.posix.join(dir, name)
    if (await fsp.access(file).then(() => true, () => false)) return file
  }
  return null
}

export function makeCliVersionProbe(o: {
  platform: NodeJS.Platform
  resolve?: ResolveExecutable
  run?: (cmd: SpawnCommand) => string | null
  identity?: (file: string) => string
  resolveAsync?: (name: string) => Promise<string | null>
  runAsync?: (cmd: SpawnCommand) => Promise<string | null>
  identityAsync?: (file: string) => Promise<string>
  /** macOS and Linux: the CLI's file on PATH. */
  which?: (name: string) => string | null
  whichAsync?: (name: string) => Promise<string | null>
  now?: () => number
}): CliVersionProbe {
  const resolve = o.resolve ?? resolveWindowsExecutable
  const run = o.run ?? runHelp
  const identity = o.identity ?? fileIdentity
  const resolveAsync = o.resolveAsync ?? warmWindowsExecutable
  const runAsync = o.runAsync ?? runHelpAsync
  const identityAsync = o.identityAsync ?? fileIdentityAsync
  const which = o.which ?? whichPosix
  const whichAsync = o.whichAsync ?? whichPosixAsync
  const now = o.now ?? Date.now
  /** Kept by the binary's identity on every platform, so an update is asked again at once (final review M1). */
  const known = new Map<Cli, { key: string; at: number; version: string }>()
  const fresh = (cli: Cli, key: string): boolean => {
    const k = known.get(cli)
    return k !== undefined && k.key === key && now() - k.at < TTL_MS
  }
  /** A failed answer is not kept: the next spawn asks again (final review M1). */
  const learn = (cli: Cli, key: string, out: string | null): string | null => {
    const version = out === null ? null : parseCliVersion(out)
    if (version === null) known.delete(cli)
    else known.set(cli, { key, at: now(), version })
    return version
  }
  const commandFor = (cli: Cli, found: string): SpawnCommand =>
    o.platform === 'win32' ? windowsSpawn(cli, ['--version'], () => found) : { file: found, args: ['--version'] }
  const probe = (cli: Cli): string | null | undefined => {
    const found = o.platform === 'win32' ? resolve(cli) : which(cli)
    // Not on PATH: there is nothing to ask, and the start says so
    if (found === null) return undefined
    const key = identity(found)
    if (fresh(cli, key)) return known.get(cli)?.version ?? null
    // A spawn nobody warmed: asked here, synchronously, as codexNoDaemon.ts does.
    return learn(cli, key, run(commandFor(cli, found)))
  }
  const warm = async (cli: Cli): Promise<void> => {
    try {
      const found = o.platform === 'win32' ? await resolveAsync(cli) : await whichAsync(cli)
      if (found === null) return
      const cmd = commandFor(cli, found)
      const key = await identityAsync(found)
      if (fresh(cli, key)) return
      learn(cli, key, await runAsync(cmd))
    } catch {
      /* the spawn's own sync answer stands */
    }
  }
  /** What was learnt, within its TTL; the binary is not looked at again (the prepare's warm just did). */
  const cached = (cli: Cli): string | undefined => {
    const k = known.get(cli)
    return k !== undefined && now() - k.at < TTL_MS ? k.version : undefined
  }
  return Object.assign(probe, { warm, cached })
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
