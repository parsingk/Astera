// A Claude Job's checks on macOS and Linux, inside the sandbox its workers ran in (Task K, the person's Q2). Claude Code
// builds that sandbox on @anthropic-ai/sandbox-runtime ("Claude Code builds the sandbox on the open source
// @anthropic-ai/sandbox-runtime package", code.claude.com/docs/en/sandboxing), whose `srt` "works for sandboxing standalone
// MCP servers or other helper processes" (code.claude.com/docs/en/sandbox-environments). Claude Code ships no way to run
// one command in its sandbox without a session, so a check runs under the package itself, 0.0.79 as measured, with the
// settings a session's twin holds (claudeSettings.ts), through Astera's own runner (src/sandboxCheck/index.ts).
//
// **Library mode, not the `srt` CLI.** A session's network is allowed (sandbox design E3), and Claude Code in
// bypassPermissions lets a host outside the allowed list through "without a prompt" (sandboxing, "Hosts outside your
// allowed domains"). srt's CLI cannot say that: `allowedDomains` refuses a bare `*` (dist/sandbox/sandbox-config.js:20-53)
// and the CLI initializes with no ask callback (dist/cli.js:359), so a host not listed is denied
// (dist/sandbox/sandbox-manager.js:247-250). The library takes the callback (SandboxManager's
// `initialize(runtimeConfig, sandboxAskCallback)`), so the runner allows every host through srt's proxy, which still
// refuses loopback and this host's own addresses for a name (README "Resolved-address check"), as a session's commands
// meet it.
//
// One process per check: SandboxManager keeps one configuration per process, and checks of two Tasks run at once.
import type { ClaudeSandboxSettings } from './claudeSettings'
import type { GitLayout } from './gitLayout'

/** The part of srt's runtime configuration a check gives it. */
export interface SrtConfig {
  network: { allowedDomains: string[]; deniedDomains: string[] }
  filesystem: { denyRead: string[]; allowRead: string[]; allowWrite: string[]; denyWrite: string[] }
}

/** What the runner is handed for one check. */
export interface SrtCheckPayload {
  config: SrtConfig
  cwd: string
  command: string
}

/** The few calls of @anthropic-ai/sandbox-runtime 0.0.79 the runner makes (dist/sandbox/sandbox-manager.d.ts). */
export interface SrtModule {
  SandboxManager: {
    initialize(config: SrtConfig, ask?: (p: { host: string; port: number }) => Promise<boolean>): Promise<void>
    wrapWithSandbox(command: string): Promise<string>
    cleanupAfterCommand?(): void
    reset(): Promise<void>
    checkDependencies(): { errors: string[]; warnings: string[] }
  }
}

/** The package, loaded where it is installed with this Astera (a dependency, kept outside the bundle). The name is a
 *  variable so the bundler leaves it to the runtime. */
export const loadSrt = async (): Promise<SrtModule> => {
  const name = '@anthropic-ai/sandbox-runtime'
  return (await import(name)) as SrtModule
}

/**
 * A session's sandbox (claudeSandboxSettings' `sandbox` part, for the check's folder) as srt's configuration, the way
 * Claude Code hands its settings to the runtime: the folder writable with npm's cache, and a worktree's common directory,
 * which Claude Code makes writable itself ("Filesystem isolation", code.claude.com/docs/en/sandboxing), with its hooks and
 * config kept read-only; the twin's denied reads and read-only folders as they are. The S2 measurement translates the
 * same part the same way (scripts/measure/s2.mjs srtSettingsOf). No host is listed: the runner's callback allows them.
 */
export function srtConfigOf(sandbox: NonNullable<ClaudeSandboxSettings['sandbox']>, o: { cwd: string; layout: GitLayout | null }): SrtConfig {
  const commonDir = o.layout?.worktree ? o.layout.commonDir : null
  return {
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: {
      denyRead: [...sandbox.filesystem.denyRead],
      allowRead: [],
      allowWrite: [o.cwd, ...sandbox.filesystem.allowWrite, ...(commonDir ? [commonDir] : [])],
      denyWrite: [...new Set([...sandbox.filesystem.denyWrite, ...(commonDir ? [`${commonDir}/hooks`, `${commonDir}/config`] : [])])]
    }
  }
}

/** A child process as the runner waits on it. */
export interface CheckChild {
  on(event: 'exit', fn: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

/** Signal numbers for an exit code a shell would give (128 + n); a signal not listed reads 128. */
const SIGNALS: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }

/**
 * Runs one check under srt and resolves with its exit code: srt's temp folder made (srt hands the command `TMPDIR` and
 * leaves making it to Claude Code, dist/sandbox/sandbox-utils.js:643-654), the configuration installed with every host
 * allowed, the command wrapped and run in the check's folder through the shell srt wraps it for, as srt's CLI does
 * (dist/cli.js:430-486), and srt's leftovers cleared. A command ended by a signal is never a pass. Astera's node flag is
 * left out of the command's environment. Rejects when srt itself fails, which the runner says.
 */
export async function runInSrt(o: {
  payload: SrtCheckPayload
  load: () => Promise<SrtModule>
  spawn: (command: string, opts: { cwd: string; env: NodeJS.ProcessEnv }) => CheckChild
  mkdir: (dir: string) => void
  env: NodeJS.ProcessEnv
}): Promise<number> {
  o.mkdir(o.env.CLAUDE_CODE_TMPDIR || o.env.CLAUDE_TMPDIR || '/tmp/claude')
  const { SandboxManager } = await o.load()
  await SandboxManager.initialize(o.payload.config, async () => true)
  try {
    const wrapped = await SandboxManager.wrapWithSandbox(o.payload.command)
    const { ELECTRON_RUN_AS_NODE: _flag, ...env } = o.env
    const child = o.spawn(wrapped, { cwd: o.payload.cwd, env })
    return await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (code, signal) => resolve(signal ? 128 + (SIGNALS[signal] ?? 0) : (code ?? 1)))
    })
  } finally {
    SandboxManager.cleanupAfterCommand?.()
    await SandboxManager.reset()
  }
}

/** How a session manager starts a Claude check under srt: what srt lacks here, and the runner's launch. */
export interface SrtCheckRunner {
  /** Why srt cannot run a command here (its dependency check's errors: bubblewrap, socat and ripgrep on Linux), or null. */
  missing(): Promise<string | null>
  /** The runner for one check: Astera's own executable as node on `runnerPath`, the check in its one argument. */
  launch(p: SrtCheckPayload): { file: string; args: string[]; env: Record<string, string> }
}

export function srtCheckRunner(o: { execPath: string; runnerPath: string; load?: () => Promise<SrtModule> }): SrtCheckRunner {
  const load = o.load ?? loadSrt
  return {
    missing: async () => {
      let srt: SrtModule
      try {
        srt = await load()
      } catch (e) {
        return `the sandbox runtime could not be loaded: ${e instanceof Error ? e.message : String(e)}`
      }
      const { errors } = srt.SandboxManager.checkDependencies()
      return errors.length > 0 ? errors.join('; ') : null
    },
    launch: (p) => ({ file: o.execPath, args: [o.runnerPath, JSON.stringify(p)], env: { ELECTRON_RUN_AS_NODE: '1' } })
  }
}
