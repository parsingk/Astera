// The Claude side of a sandboxed session (sandbox design §6): the `sandbox` and `permissions` parts of the settings handed to
// the session. Claude's own sandbox runs on macOS and Linux only; on Windows the deny rules are all it can enforce, and a
// session whose shell runs in Codex's sandbox names the wrapper in the settings' `env` (withShellEnv).
import type { GitLayout } from './gitLayout'
import { appKeyDenies, credentialStoreDenies, sensitiveLocations } from './locations'
import { claudeShellEnv } from './claudeShell'

export interface ClaudeSandboxSettings {
  sandbox?: {
    enabled: boolean
    allowUnsandboxedCommands: boolean
    failIfUnavailable: boolean
    excludedCommands: string[]
    filesystem: { allowWrite: string[]; denyWrite: string[]; denyRead: string[] }
  }
  permissions: { deny: string[] }
}

/** Claude's permission paths, as two rules because the gitignore-style match of `p/**` covers a folder's contents but not a
 *  file named `p` (`.npmrc`, `.git-credentials`): `//` marks an absolute path, and on Windows `C:/x` is matched in its
 *  POSIX form `/c/x`. */
function pathRules(tool: 'Read' | 'Edit', p: string): string[] {
  const f = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(f)
  const posix = drive ? `/${drive[1].toLowerCase()}${drive[2] ?? ''}` : f
  return [`${tool}(/${posix})`, `${tool}(/${posix}/**)`]
}

const readRules = (p: string): string[] => pathRules('Read', p)
/** "`Edit` rules apply to all built-in tools that edit files" (code.claude.com/docs/en/permissions, "What `Read` and
 *  `Edit` rules cover"), the creation of a new file included; they do not reach a program the shell runs, which only the
 *  sandbox stops. */
const editRules = (p: string): string[] => pathRules('Edit', p)

/** The git files a sandboxed Claude session may not write (final fix pass, C1), absolute: everything that decides where git
 *  reads its config and hooks from (`layout.gitFiles`: every `commondir`, and `modules`), a linked worktree's `.git`
 *  pointer file, the common directory's hooks and config, and every `config.worktree` (gitLayout.ts). Claude Code makes a
 *  worktree's common directory writable itself; these stay read-only in it. None outside a repository. */
function gitDenyWrite(layout: GitLayout | null): string[] {
  if (!layout) return []
  return [
    ...layout.gitFiles,
    ...(layout.worktree ? [`${layout.top}/.git`] : []),
    `${layout.commonDir}/hooks`,
    `${layout.commonDir}/config`,
    ...layout.worktreeConfigs
  ]
}

/** What a sandboxed Claude session may not read: the E6 list and the OS credential store, from the session's own
 *  environment under the person's home, and the profile's app key (`appKeyFile`, appKeyDenies; sandbox follow-ups, item
 *  1), and the agents' login files (`agentLogins`, sandbox design §6): paths the caller has already chosen (the entries
 *  of locations.ts agentLoginEntries that are there at the start, StatusLineManager.sandboxNamed), appended as given. One
 *  list for a Claude start (StatusLineManager's twins) and the S2 measurement (scripts/measure/s2.mjs claudeDenied), so
 *  what is measured is what a start hands Claude. */
export function claudeSessionDenied(o: {
  platform: NodeJS.Platform
  env: Record<string, string | undefined>
  homeDir: string
  appKeyFile?: string | null
  agentLogins?: readonly string[]
}): string[] {
  return [
    ...sensitiveLocations(o.platform, o.env, o.homeDir),
    ...credentialStoreDenies(o.platform, o.env, o.homeDir),
    ...appKeyDenies(o.appKeyFile ?? null),
    ...(o.agentLogins ?? [])
  ]
}

/** The folders a sandboxed Claude session may write, by which a link on a named path is judged (Task E fix round 5,
 *  namedPathFor): its work folder, npm's cache (the twin's `allowWrite`), its temp folder and `/tmp`, and what srt makes
 *  writable by itself (srt 0.0.79 dist/sandbox/sandbox-utils.js:486 SANDBOX_OWN_WRITE_PATHS, `/tmp/claude`, and :501
 *  HOME_CONVENIENCE_WRITE_DIRS, `~/.npm/_logs` and `~/.claude/debug`). Each as given; namedPathFor adds where each
 *  really is. */
export function claudeWritableFolders(o: { platform: NodeJS.Platform; cwd: string; npmCache: string; tmpDir: string; homeDir: string }): string[] {
  const home = o.homeDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return [o.cwd, o.npmCache, o.tmpDir, ...(o.platform === 'win32' ? [] : ['/tmp']), `${home}/.npm/_logs`, `${home}/.claude/debug`]
}

/** `readOnly` (the profile folder, locations.ts profileReadOnly) is kept from being written on every OS: by Edit rules
 *  for Claude's own file tools (on Windows all there is, as for E6's reads), and on macOS and Linux in the sandbox's
 *  denyWrite, which covers the folder and everything in it on both (srt 0.0.79: Seatbelt's `(deny file-write* (subpath
 *  …))` after the allows, dist/sandbox/macos-sandbox-utils.js generateWriteRules; bubblewrap's `--ro-bind` after the
 *  write binds, with a read-denied file inside put back over it, dist/sandbox/linux-sandbox-utils.js). Reads are not
 *  touched. */
export function claudeSandboxSettings(o: { platform: NodeJS.Platform; denied: string[]; readOnly: readonly string[]; npmCache: string; layout: GitLayout | null }): ClaudeSandboxSettings {
  const permissions = { deny: [...o.denied.flatMap(readRules), ...o.readOnly.flatMap(editRules)] }
  if (o.platform === 'win32') return { permissions }
  return {
    sandbox: {
      enabled: true,
      // A command that cannot run inside the sandbox fails instead of being retried outside it, and a missing sandbox stops the session.
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      // The astera command talks to the Host over a socket the sandbox would block.
      excludedCommands: ['astera *'],
      filesystem: { allowWrite: [o.npmCache], denyWrite: [...new Set([...gitDenyWrite(o.layout), ...o.readOnly])], denyRead: o.denied }
    },
    permissions
  }
}

/** A settings file with Claude's shell routed into Codex's sandbox on Windows (claude shell sandbox design D7): its `env`
 *  gets claudeShellEnv's values for the wrapper `wrapFile`, over any it already holds, its other keys kept. In the file a
 *  session is started with (`--settings`), these win over a project's settings files (spec M10). */
export function withShellEnv<T extends object>(settings: T, wrapFile: string): T & { env: Record<string, string> } {
  const own = (settings as { env?: Record<string, string> }).env
  return { ...settings, env: { ...(own ?? {}), ...claudeShellEnv(wrapFile) } }
}
