// What a sandboxed Claude start does before its spawn (sandbox design §6), for both session managers: the terminal one
// (core/sessions/manager.ts) and the chat one (core/chat/manager.ts). Claude's sandbox is its settings file, written by
// StatusLineManager.ensureSandboxFiles, so there is no git layout to read for it as there is for Codex; what is left is the
// version floor, npm's cache folder (macOS and Linux) and, on Linux, the git excludes Task 2 measured (inventory §23.4).
// Both spawns are synchronous, so everything here that touches the disk or runs a process is done in `prepare`, which
// every caller awaits first (a roll before its kill).
import { execFile } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ENFORCE_MIN, atLeast, type CliVersionProbe } from '../sessions/cliVersion'
import { writeScript, type SandboxFilesResult } from '../sessions/statusline'
import { appendGitConfig, npmCacheOf } from './codexProfile'
import { SANDBOX_UNAVAILABLE, sandboxUnavailable } from './unavailable'

const slashed = (p: string): string => p.replace(/\\/g, '/')

/** srt 0.0.79's own lists (`DANGEROUS_FILES` and `getDangerousDirectories()` in dist/sandbox/sandbox-utils.js), the runtime
 *  Claude Code's sandbox uses. On Linux srt mounts `/dev/null` over each of them that is missing in the session folder, and
 *  `git add -A` then fails on the placeholder ("can only add regular files"). */
export const SRT_DANGEROUS_FILES = ['.gitconfig', '.gitmodules', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.ripgreprc', '.mcp.json']
export const SRT_DANGEROUS_DIRECTORIES = ['.vscode', '.idea', '.claude/commands', '.claude/agents']

/** The exclude file's text: the person's own excludes first, since `core.excludesFile` passed through GIT_CONFIG takes the
 *  place of theirs, then srt's names. A name without a slash matches at any depth; the `.claude` folders are spelled for any
 *  depth too, since srt puts them in the session folder, which may be a subfolder of the repository (measured with exactly
 *  these lines, inventory §23.4). */
export function gitExcludesText(globalText: string): string {
  const own = globalText.replace(/\s+$/, '')
  const lines = [...SRT_DANGEROUS_FILES, ...SRT_DANGEROUS_DIRECTORIES.map((d) => (d.includes('/') ? `**/${d}` : d))]
  return `${own ? `${own}\n` : ''}${lines.join('\n')}\n`
}

/** Where git reads the person's excludes: `core.excludesFile` when it is set (`configured`, git's effective value,
 *  GIT_EXCLUDES_ARGS), else `$XDG_CONFIG_HOME/git/ignore`, else `~/.config/git/ignore` (git-config(1)). */
export function globalExcludesPath(configured: string | null, env: Record<string, string | undefined>, home: string): string {
  const h = slashed(home).replace(/\/+$/, '')
  if (configured) return configured.startsWith('~/') ? `${h}/${configured.slice(2)}` : configured
  const xdg = env.XDG_CONFIG_HOME ? slashed(env.XDG_CONFIG_HOME).replace(/\/+$/, '') : ''
  return xdg ? `${xdg}/git/ignore` : `${h}/.config/git/ignore`
}

/** The exclude file, in the profile folder, which the sandbox lets a session read (it denies only the E6 list), named for
 *  the user whose sessions read it. */
export const gitExcludesFileOf = (profileDir: string, uid: number): string => `${slashed(profileDir).replace(/\/+$/, '')}/sandbox/excludes-${uid}`

/** A sandboxed Claude session's environment, on macOS and Linux (on Windows Claude has no shell sandbox, so npm keeps its
 *  own cache and nothing is planted):
 *  - npm's cache in TEMP, since srt leaves out a write path that does not exist and the default cache is under the home
 *    folder;
 *  - on Linux the exclude file, numbered after the GIT_CONFIG_* entries the session inherits (`env`), as codexSandboxEnv
 *    numbers its own; `excludesFile` null: it could not be written, and git keeps the person's own excludes;
 *  - on macOS the Host's address, `hostSocket`, as ASTERA_SANDBOX_HOST: inside Claude's sandbox `$TMPDIR` is not the
 *    app's, so the socket `astera` would derive from it is not the one the sandbox lets it reach
 *    (StatusLineManager.hostSocket); `astera` reads it after a person's ASTERA_HOST (packages/client/src/discovery.ts).
 *    ASTERA_HOST itself is never planted: it is the person's, and every session and Host keeps it, so a planted one
 *    would outlive the session in an app started inside it. ASTERA_SANDBOX_HOST is cleared from every session and Host
 *    Astera starts (MANAGED_ENV_KEYS, core/host/spawn.ts). Linux's sandbox ignores per-path sockets, so `astera`
 *    reaches the Host there through excludedCommands only and nothing is planted. */
export function claudeSandboxEnv(o: {
  platform: NodeJS.Platform
  tmpDir: string
  excludesFile: string | null
  hostSocket: string | null
  env?: Record<string, string | undefined>
}): Record<string, string> {
  if (o.platform === 'win32') return {}
  const env: Record<string, string> = { npm_config_cache: npmCacheOf(o.tmpDir) }
  if (o.platform === 'darwin' && o.hostSocket !== null) env.ASTERA_SANDBOX_HOST = o.hostSocket
  if (o.platform !== 'linux' || o.excludesFile === null) return env
  return { ...env, ...appendGitConfig(o.env, [['core.excludesFile', o.excludesFile]]) }
}

/** Why a sandboxed Claude cannot start, or null: older than the floor Enforce measured (cliVersion.ts ENFORCE_MIN), whose
 *  sandbox keys were measured with it, or a Claude whose version is not known, which could be one that ignores them and
 *  runs its shell unsandboxed (E5). The CLI's own words for each are the version check's codes. */
export function claudeSandboxBlocker(version: string | null | undefined): string | null {
  if (version === undefined) return `${SANDBOX_UNAVAILABLE}: cli-missing claude`
  if (version === null) return `${SANDBOX_UNAVAILABLE}: cli-version-unknown claude`
  return atLeast(version, ENFORCE_MIN.claude) ? null : `${SANDBOX_UNAVAILABLE}: cli-too-old claude ${version} ${ENFORCE_MIN.claude}`
}

/** What both session managers ask of a sandboxed Claude start. */
export interface ClaudeSandboxStart {
  /** The version floor, the settings twins (`settings-write-failed` when they cannot be written), npm's cache folder on
   *  macOS and Linux, and on Linux the exclude file, in that order: an old Claude is refused before anything is written.
   *  Rejects with `SANDBOX_UNAVAILABLE: …`. */
  prepare(): Promise<void>
  /** The version floor again, read synchronously at the spawn (the CLI may have changed since the prepare). */
  blocker(): string | null
  /** A chat's one `--settings`: the sandbox, with the Enforce hook when `enforce`; null when it was not written. */
  chatArgs(enforce: boolean): string[] | null
  /** What the session's environment gets, after everything else Astera adds: `inherited` is that environment. */
  env(inherited: Record<string, string | undefined>): Record<string, string>
}

/** Runs git and answers what it printed, trimmed; null when it failed or printed nothing (`config --get` exits 1 for a key
 *  that is not set). */
export type RunGit = (args: string[], o: { cwd: string; env: Record<string, string | undefined> }) => Promise<string | null>

const runGitFile: RunGit = (args, o) =>
  new Promise((resolve) => {
    execFile('git', args, { env: o.env as NodeJS.ProcessEnv, cwd: o.cwd, timeout: 5_000, windowsHide: true, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? null : stdout.trim() || null)
    )
  })

/** The person's effective `core.excludesFile`, with `~` expanded (`--path`): asked with no scope, so a GIT_CONFIG_GLOBAL or
 *  GIT_CONFIG_* entry of theirs counts as it would for git, but outside any repository (the temp folder), since the file
 *  is shared by every session whatever its folder. */
export const GIT_EXCLUDES_ARGS = ['config', '--path', '--get', 'core.excludesFile']

export function claudeSandboxStart(o: {
  platform: NodeJS.Platform
  /** Astera's profile folder, where the exclude file goes. */
  profileDir: string
  /** The person's home and environment, for where git keeps their global excludes. */
  homeDir: string
  env: Record<string, string | undefined>
  /** os.tmpdir(), where npm's cache goes. */
  tmpDir: string
  files: {
    ensureSandboxFiles(): Promise<SandboxFilesResult>
    sandboxChatArgs(enforce: boolean): string[] | null
    /** macOS: the Host's address the twins grant; null elsewhere. */
    hostSocket(): string | null
  }
  /** The version check Enforce asks (cliVersion.ts), shared with it. */
  version: Pick<CliVersionProbe, 'warm'> & ((cli: 'claude') => string | null | undefined)
  /** Linux: the user the exclude file is named for. Default: this process's. */
  uid?: number
  /** Test injection; default runs git. */
  runGit?: RunGit
  log: (m: string) => void
}): ClaudeSandboxStart {
  const excludesFile = gitExcludesFileOf(o.profileDir, o.uid ?? process.getuid?.() ?? 0)
  const runGit = o.runGit ?? runGitFile
  /** Whether the last prepare wrote the exclude file: a spawn after one that could not points git at nothing new. */
  let excludesWritten = false
  const blocker = (): string | null => claudeSandboxBlocker(o.version('claude'))

  const writeExcludes = async (): Promise<boolean> => {
    const configured = await runGit(GIT_EXCLUDES_ARGS, { cwd: o.tmpDir, env: o.env }).catch(() => null)
    const global = globalExcludesPath(configured, o.env, o.homeDir)
    const text = gitExcludesText(await fs.readFile(global, 'utf8').catch(() => ''))
    try {
      await fs.mkdir(path.dirname(excludesFile), { recursive: true })
    } catch (err) {
      o.log(`sandbox: the folder for ${excludesFile} could not be made: ${String(err)}`)
      return false
    }
    // Swapped in whole, as the settings are: a session already running may be reading it
    return writeScript(excludesFile, text)
  }

  return {
    prepare: async () => {
      await o.version.warm('claude')
      const blocked = blocker()
      if (blocked !== null) throw new Error(blocked)
      if ((await o.files.ensureSandboxFiles()) !== 'ok') {
        o.log("sandbox: Claude's sandbox settings could not be written, so the sandboxed start is refused")
        throw sandboxUnavailable('settings-write-failed')
      }
      // A sandboxed npm cannot install until its cache folder exists (inventory §23.4); a folder that cannot be made costs
      // only the installs, so it is said and not refused. Windows has no shell sandbox for Claude, and npm keeps its own
      if (o.platform !== 'win32')
        await fs.mkdir(npmCacheOf(o.tmpDir), { recursive: true }).catch((err: unknown) => o.log(`sandbox: npm's cache folder could not be made: ${String(err)}`))
      if (o.platform === 'linux') {
        excludesWritten = await writeExcludes()
        if (!excludesWritten) o.log(`sandbox: the git excludes ${excludesFile} could not be written; git add -A may fail in the session`)
      }
    },
    blocker,
    chatArgs: (enforce) => o.files.sandboxChatArgs(enforce),
    env: (inherited) =>
      claudeSandboxEnv({
        platform: o.platform,
        tmpDir: o.tmpDir,
        excludesFile: excludesWritten ? excludesFile : null,
        hostSocket: o.files.hostSocket(),
        env: inherited
      })
  }
}
