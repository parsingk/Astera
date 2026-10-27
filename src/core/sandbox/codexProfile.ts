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
 *  `core.hooksPath`. The entry holds only for a file that exists (inventory §23.3), so the start makes them first
 *  (`ensureWorktreeConfigFiles`). At a repository's top its own is the relative entry beside `.git/config`. */
function gitEntries(layout: GitLayout | null): string[] {
  if (!layout) return []
  const atTop = layout.top === layout.cwd
  const configsRead = (skip: string | null): string[] => layout.worktreeConfigs.filter((p) => p !== skip).map((p) => entry(p, 'read'))
  if (atTop && !layout.worktree) {
    const roots = [entry('.git', 'write'), entry('.git/hooks', 'read'), entry('.git/config', 'read'), entry('.git/config.worktree', 'read')]
    return [`":workspace_roots"={${roots.join(', ')}}`, ...configsRead(`${layout.gitDir}/config.worktree`)]
  }
  const out: string[] = []
  if (atTop) out.push(`":workspace_roots"={${entry('.git', 'write')}}`)
  if (layout.gitDir !== layout.commonDir) out.push(entry(layout.gitDir, 'write'))
  out.push(entry(layout.commonDir, 'write'), entry(`${layout.commonDir}/hooks`, 'read'), entry(`${layout.commonDir}/config`, 'read'))
  return [...out, ...configsRead(null)]
}

export function codexSandboxArgs(o: { platform: NodeJS.Platform; layout: GitLayout | null; denied: string[] }): string[] {
  const entries = [...gitEntries(o.layout), ...o.denied.map((p) => entry(p, 'deny'))]
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

/** On Windows git refuses a repository owned by another account, and the elevated sandbox runs as one, so the checkout and
 *  (for a linked worktree) the main checkout are named safe. `env` is the environment the session inherits: entries of
 *  the person's own `GIT_CONFIG_COUNT` are kept, these numbered after them and the count made the total. A count git
 *  could not read (not a whole number) is taken as none, which git would otherwise refuse to run with. */
export function codexSandboxEnv(o: {
  platform: NodeJS.Platform
  layout: GitLayout | null
  tmpDir: string
  env?: Record<string, string | undefined>
}): Record<string, string> {
  const env: Record<string, string> = { npm_config_cache: npmCacheOf(o.tmpDir) }
  if (o.platform !== 'win32' || !o.layout) return env
  const safe = [o.layout.top]
  const main = o.layout.commonDir.replace(/\/[^/]*$/, '')
  if (main && main !== o.layout.top) safe.push(main)
  const inherited = o.env?.GIT_CONFIG_COUNT ?? ''
  const first = /^\d+$/.test(inherited) ? Number(inherited) : 0
  env.GIT_CONFIG_COUNT = String(first + safe.length)
  safe.forEach((p, i) => {
    env[`GIT_CONFIG_KEY_${first + i}`] = 'safe.directory'
    env[`GIT_CONFIG_VALUE_${first + i}`] = p
  })
  return env
}
