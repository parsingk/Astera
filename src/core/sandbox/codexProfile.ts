// The Codex side of a sandboxed session (sandbox design §6): a permission profile passed as `-c` arguments, so nothing is
// written to the user's config.toml, and the few environment variables the sandbox needs to keep git and npm working.
import type { GitLayout } from './gitLayout'

export const NPM_CACHE_DIR = 'astera-npm-cache'
/** The permission profile's name: the `-c` arguments define it and make it the default, and a sandboxed chat's thread
 *  names it (codexProtocol.ts threadStartParams). */
export const CODEX_PROFILE = 'astera'

const slashed = (p: string): string => p.replace(/\\/g, '/')

/** npm's cache lives in TEMP: the default one is under the home folder, which the sandbox does not let a session write. */
export const npmCacheOf = (tmpDir: string): string => `${slashed(tmpDir).replace(/\/+$/, '')}/${NPM_CACHE_DIR}`

// A TOML basic string: JSON's escapes are TOML's, so paths with quotes, backslashes or non-ASCII text stay one key.
const toml = (s: string): string => JSON.stringify(s)

type Access = 'write' | 'read' | 'deny'
const entry = (p: string, access: Access): string => `${toml(p)}=${toml(access)}`

/** The git entries of the filesystem table. Codex makes a pointer file's resolved gitdir read-only unless an entry names
 *  that exact path, so a linked worktree's own git directory is named even though the common directory is too. Hooks and
 *  config stay read-only: a session that could write them could run its code outside the sandbox the next time git runs.
 *  So does every `config.worktree` git may read for the repository (`layout.worktreeConfigs`: the checkout's own, the
 *  main checkout's, the other worktrees'): git reads them under `extensions.worktreeConfig`, and one can set
 *  `core.hooksPath`. And so does everything that decides where git reads those from (`layout.gitFiles`, final fix pass
 *  C1): every `commondir`, which could point a checkout, or all of them, at a git directory of the session's own, and
 *  `modules`, the submodules' git directories; at a linked worktree's top its `.git` pointer file is read-only too, since
 *  it names the worktree's git directory. A read entry holds only for a path that exists (inventory §23.3), so the start
 *  makes them first (`ensureWorktreeConfigFiles`, `ensureGitFiles`). At a repository's top its own are the relative
 *  entries beside `.git/config`. */
function gitEntries(layout: GitLayout | null): string[] {
  if (!layout) return []
  const atTop = layout.top === layout.cwd
  const read = (paths: string[], skip: ReadonlySet<string>): string[] => paths.filter((p) => !skip.has(p)).map((p) => entry(p, 'read'))
  if (atTop && !layout.worktree) {
    const own = (name: string): string => `${layout.gitDir}/${name}`
    const roots = [
      entry('.git', 'write'),
      entry('.git/hooks', 'read'),
      entry('.git/config', 'read'),
      entry('.git/config.worktree', 'read'),
      entry('.git/commondir', 'read'),
      entry('.git/modules', 'read')
    ]
    const relative = new Set([own('config.worktree'), own('commondir'), own('modules')])
    return [`":workspace_roots"={${roots.join(', ')}}`, ...read(layout.worktreeConfigs, relative), ...read(layout.gitFiles, relative)]
  }
  const out: string[] = []
  if (atTop) out.push(`":workspace_roots"={${entry('.git', 'read')}}`)
  if (layout.gitDir !== layout.commonDir) out.push(entry(layout.gitDir, 'write'))
  out.push(entry(layout.commonDir, 'write'), entry(`${layout.commonDir}/hooks`, 'read'), entry(`${layout.commonDir}/config`, 'read'))
  return [...out, ...read(layout.worktreeConfigs, new Set()), ...read(layout.gitFiles, new Set())]
}

/** `readOnly` (the profile folder, locations.ts profileReadOnly) is "read": where the session's folder holds it, Codex
 *  carves it out of that writable root read-only on every OS (protocol/src/permissions.rs
 *  get_writable_roots_with_cwd_impl at rust-v0.160.0: "Narrower explicit non-write entries carve out broader writable
 *  roots"), and a "deny" inside it (the app key) still holds, since the most specific entry decides (resolve_access). */
export function codexSandboxArgs(o: { platform: NodeJS.Platform; layout: GitLayout | null; denied: string[]; readOnly: readonly string[] }): string[] {
  const entries = [...gitEntries(o.layout), ...o.readOnly.map((p) => entry(p, 'read')), ...o.denied.map((p) => entry(p, 'deny'))]
  const profile = `permissions={${CODEX_PROFILE}={extends=":workspace", filesystem={${entries.join(', ')}}, network={enabled=true}}}`
  const args = ['-a', 'never', '-c', profile, '-c', `default_permissions=${toml(CODEX_PROFILE)}`]
  // The unelevated Windows sandbox is not pinned by default, so a session would otherwise run with whichever one Codex picks.
  if (o.platform === 'win32') args.push('-c', 'windows.sandbox="elevated"')
  return args
}

/** What `codex app-server` takes of codexSandboxArgs: the profile's `-c` values without the leading `-a never`, which is
 *  an option of the session command only; a chat's thread carries it as `approvalPolicy: "never"` instead. The shape Task 2
 *  measured the app-server with (inventory §23.1). */
export function appServerSandboxArgs(args: string[]): string[] {
  if (args[0] !== '-a' || args[1] !== 'never') throw new Error(`the sandbox arguments no longer start with -a never: ${args.slice(0, 2).join(' ')}`)
  return args.slice(2)
}

/** `entries` as git's GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n variables, numbered after the ones `env` (the
 *  environment the session inherits) already holds, with the count made the total: the person's own entries are kept. A
 *  count git could not read (not a whole number) is taken as none, which git would otherwise refuse to run with. */
export function appendGitConfig(env: Record<string, string | undefined> | undefined, entries: Array<[key: string, value: string]>): Record<string, string> {
  const inherited = env?.GIT_CONFIG_COUNT ?? ''
  const first = /^\d+$/.test(inherited) ? Number(inherited) : 0
  const out: Record<string, string> = { GIT_CONFIG_COUNT: String(first + entries.length) }
  entries.forEach(([key, value], i) => {
    out[`GIT_CONFIG_KEY_${first + i}`] = key
    out[`GIT_CONFIG_VALUE_${first + i}`] = value
  })
  return out
}

/** On Windows git refuses a repository owned by another account, and the elevated sandbox runs as one, so the checkout and
 *  (for a linked worktree) the main checkout are named safe, after the person's own GIT_CONFIG entries (appendGitConfig).
 *  That account cannot read the person's global excludes either, so after them `core.excludesFile` names the copy the
 *  prepare wrote in TEMP (`excludesFile`, gitExcludes.ts codexExcludesWriter), in a repository or not; null or absent: no
 *  copy, and git keeps looking where it would. macOS and Linux sessions run as the person, and read their own. */
export function codexSandboxEnv(o: {
  platform: NodeJS.Platform
  layout: GitLayout | null
  tmpDir: string
  env?: Record<string, string | undefined>
  excludesFile?: string | null
}): Record<string, string> {
  const env: Record<string, string> = { npm_config_cache: npmCacheOf(o.tmpDir) }
  if (o.platform !== 'win32') return env
  const entries: Array<[key: string, value: string]> = []
  if (o.layout) {
    entries.push(['safe.directory', o.layout.top])
    const main = o.layout.commonDir.replace(/\/[^/]*$/, '')
    if (main && main !== o.layout.top) entries.push(['safe.directory', main])
  }
  if (o.excludesFile) entries.push(['core.excludesFile', o.excludesFile])
  return entries.length === 0 ? env : { ...env, ...appendGitConfig(o.env, entries) }
}
