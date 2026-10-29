// What a sandboxed Claude start does before its spawn (sandbox design §6), for both session managers: the terminal one
// (core/sessions/manager.ts) and the chat one (core/chat/manager.ts). Claude's sandbox is its settings file, written by
// StatusLineManager.ensureSandboxFiles for the start's scope: the folder's git layout, whose git files it keeps from being
// written (final fix pass, C1), and the environment the session is built from. What else is done: the version floor,
// npm's cache folder (macOS and Linux) and, on Linux, the git excludes Task 2 measured (inventory §23.4).
// Both spawns are synchronous, so everything here that touches the disk or runs a process is done in `prepare`, which
// every caller awaits first (a roll before its kill).
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ENFORCE_MIN, atLeast, type CliVersionProbe } from '../sessions/cliVersion'
import { writeScript, type SandboxFilesResult, type SandboxScope } from '../sessions/statusline'
import { appendGitConfig, npmCacheOf } from './codexProfile'
import { globalExcludesText, runGitFile, type RunGit } from './gitExcludes'
import { ensureGitFiles, ensureWorktreeConfigFiles, gitLayoutOf, type GitLayout } from './gitLayout'
import { PreparedLayouts } from './prepared'
import type { LinkLook } from './locations'
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

/** The exclude file, in the profile folder, which the sandbox lets a session read (it denies only the E6 list), named for
 *  the user whose sessions read it. */
export const gitExcludesFileOf = (profileDir: string, uid: number): string => `${slashed(profileDir).replace(/\/+$/, '')}/sandbox/excludes-${uid}`

/** A sandboxed Claude session's environment, on macOS and Linux (on Windows Claude has no shell sandbox, so npm keeps its
 *  own cache and nothing is planted):
 *  - npm's cache in TEMP, since srt leaves out a write path that does not exist and the default cache is under the home
 *    folder;
 *  - on Linux the exclude file, numbered after the GIT_CONFIG_* entries the session inherits (`env`), as codexSandboxEnv
 *    numbers its own; `excludesFile` null: it could not be written, and git keeps the person's own excludes.
 *  No Host address is planted: the sandbox grants no socket, so `astera` reaches the Host through `excludedCommands`,
 *  outside the sandbox, where it derives the address as any session does. */
export function claudeSandboxEnv(o: {
  platform: NodeJS.Platform
  tmpDir: string
  excludesFile: string | null
  env?: Record<string, string | undefined>
}): Record<string, string> {
  if (o.platform === 'win32') return {}
  const env: Record<string, string> = { npm_config_cache: npmCacheOf(o.tmpDir) }
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
  /** The version floor; on macOS and Linux the folder's git layout read and its missing git files made (`git-layout` when
   *  either fails); the settings twins for the scope (`settings-write-failed` when they cannot be written); npm's cache
   *  folder on macOS and Linux, and on Linux the exclude file, in that order: an old Claude is refused before anything is
   *  written. `env` is the environment the session is built from (its account's, before the hiding), the one the spawn
   *  hands scopeOf. Rejects with `SANDBOX_UNAVAILABLE: …`. */
  prepare(o: { accountId: string; cwd: string; env: Record<string, string | undefined> }): Promise<void>
  /** The version floor again, read synchronously at the spawn (the CLI may have changed since the prepare). */
  blocker(): string | null
  /** The scope a prepare wrote twins for, for this account and folder within PREPARED_MS, with `env`, the environment the
   *  session is built from; undefined when no prepare kept one, and the spawn then refuses with `not-prepared`. */
  scopeOf(accountId: string, cwd: string, env: Record<string, string | undefined>): SandboxScope | undefined
  /** A chat's one `--settings`: the sandbox of its scope, with the Enforce hook when `enforce`; null when it was not
   *  written. */
  chatArgs(enforce: boolean, scope: SandboxScope): string[] | null
  /** What the session's environment gets, after everything else Astera adds: `inherited` is that environment. */
  env(inherited: Record<string, string | undefined>): Record<string, string>
}

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
    ensureSandboxFiles(scope: SandboxScope): Promise<SandboxFilesResult>
    sandboxChatArgs(enforce: boolean, scope: SandboxScope): string[] | null
  }
  /** The version check Enforce asks (cliVersion.ts), shared with it. */
  version: Pick<CliVersionProbe, 'warm'> & ((cli: 'claude') => string | null | undefined)
  /** Linux: the user the exclude file is named for. Default: this process's. */
  uid?: number
  /** Test injection; default runs git. */
  runGit?: RunGit
  /** Test injection; default Date.now. */
  now?: () => number
  /** How the disk is read for links on the paths the twins name (Task E fix round 5, core/sandbox/locations.ts
   *  namedPathFor), carried on each scope: the app's and the Host's wiring give nodeLinkLook; null names every path as
   *  given. Required (fix round 6), so a wiring that forgets it does not compile. */
  linkLook: LinkLook | null
  log: (m: string) => void
}): ClaudeSandboxStart {
  const excludesFile = gitExcludesFileOf(o.profileDir, o.uid ?? process.getuid?.() ?? 0)
  const runGit = o.runGit ?? runGitFile
  const now = o.now ?? Date.now
  /** The layouts the prepares read, by account and folder, for the spawn's scope, as a Codex start keeps its own. */
  const layouts = new PreparedLayouts()
  /** Whether the last prepare wrote the exclude file: a spawn after one that could not points git at nothing new. */
  let excludesWritten = false
  const blocker = (): string | null => claudeSandboxBlocker(o.version('claude'))

  const writeExcludes = async (): Promise<boolean> => {
    const text = gitExcludesText(await globalExcludesText({ env: o.env, homeDir: o.homeDir, tmpDir: o.tmpDir, runGit }))
    try {
      await fs.mkdir(path.dirname(excludesFile), { recursive: true })
    } catch (err) {
      o.log(`sandbox: the folder for ${excludesFile} could not be made: ${String(err)}`)
      return false
    }
    // Swapped in whole, as the settings are: a session already running may be reading it
    return writeScript(excludesFile, text)
  }

  /** The folder's git layout, with its missing git files made, on macOS and Linux; null on Windows, where Claude has no
   *  sandbox and its twin holds the deny rules only, whatever the folder. The git files a sandbox keeps from being written
   *  are made first, as a Codex start makes them (gitLayout.ts): srt then denies writing a file that is there rather than
   *  a path that is not. A layout that cannot be read or prepared refuses the start (`git-layout`). */
  const layoutFor = async (cwd: string): Promise<GitLayout | null> => {
    if (o.platform === 'win32') return null
    try {
      const layout = await gitLayoutOf(cwd)
      if (layout) {
        await ensureGitFiles(layout)
        await ensureWorktreeConfigFiles(layout)
      }
      return layout
    } catch (err) {
      o.log(`sandbox: the git layout of ${cwd} could not be read or prepared: ${String(err)}`)
      throw sandboxUnavailable('git-layout')
    }
  }

  return {
    prepare: async (p) => {
      await o.version.warm('claude')
      const blocked = blocker()
      if (blocked !== null) throw new Error(blocked)
      const layout = await layoutFor(p.cwd)
      const written = await o.files.ensureSandboxFiles({ layout, env: p.env, cwd: p.cwd, look: o.linkLook })
      // Task E fix rounds 5 and 6 (rule E5): a named path through a link the session could change, through which srt
      // cannot keep the deny in force (StatusLineManager.refusesLinks says how, per OS; ensureSandboxFiles writes no twin)
      if (typeof written === 'object') {
        o.log(`sandbox: ${written.linked.join(', ')} is a link inside the session's writable folders, which it could repoint, and Claude's sandbox cannot keep the path closed through it, so the sandboxed start is refused`)
        throw sandboxUnavailable('linked-path')
      }
      if (written !== 'ok') {
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
      layouts.keep(p.accountId, p.cwd, layout, now())
    },
    blocker,
    scopeOf: (accountId, cwd, env) => {
      const layout = layouts.layoutOf(accountId, cwd, now())
      return layout === undefined ? undefined : { layout, env, cwd, look: o.linkLook }
    },
    chatArgs: (enforce, scope) => o.files.sandboxChatArgs(enforce, scope),
    env: (inherited) =>
      claudeSandboxEnv({
        platform: o.platform,
        tmpDir: o.tmpDir,
        excludesFile: excludesWritten ? excludesFile : null,
        env: inherited
      })
  }
}
