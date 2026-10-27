// The Codex side of a sandboxed session (sandbox design §6): a permission profile passed as `-c` arguments, so nothing is
// written to the user's config.toml, and the few environment variables the sandbox needs to keep git and npm working.
import type { GitLayout } from './gitLayout'

export const NPM_CACHE_DIR = 'astera-npm-cache'

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
 *  So does `config.worktree` in the git directory of the checkout, a worktree's own or a repository's `.git`: git reads
 *  it under `extensions.worktreeConfig`, and it can set `core.hooksPath`. The entry holds only for a file that exists
 *  (inventory §23.3), so the start makes it first where git reads it (`ensureWorktreeConfigFile`). */
function gitEntries(layout: GitLayout | null): string[] {
  if (!layout) return []
  const atTop = layout.top === layout.cwd
  if (atTop && !layout.worktree) {
    const roots = [entry('.git', 'write'), entry('.git/hooks', 'read'), entry('.git/config', 'read'), entry('.git/config.worktree', 'read')]
    return [`":workspace_roots"={${roots.join(', ')}}`]
  }
  const out: string[] = []
  if (atTop) out.push(`":workspace_roots"={${entry('.git', 'write')}}`)
  if (layout.gitDir !== layout.commonDir) out.push(entry(layout.gitDir, 'write'))
  out.push(entry(`${layout.gitDir}/config.worktree`, 'read'))
  out.push(entry(layout.commonDir, 'write'), entry(`${layout.commonDir}/hooks`, 'read'), entry(`${layout.commonDir}/config`, 'read'))
  return out
}

export function codexSandboxArgs(o: { platform: NodeJS.Platform; layout: GitLayout | null; denied: string[] }): string[] {
  const entries = [...gitEntries(o.layout), ...o.denied.map((p) => entry(p, 'deny'))]
  const profile = `permissions={astera={extends=":workspace", filesystem={${entries.join(', ')}}, network={enabled=true}}}`
  const args = ['-a', 'never', '-c', profile, '-c', 'default_permissions="astera"']
  // The unelevated Windows sandbox is not pinned by default, so a session would otherwise run with whichever one Codex picks.
  if (o.platform === 'win32') args.push('-c', 'windows.sandbox="elevated"')
  return args
}

/** On Windows git refuses a repository owned by another account, and the elevated sandbox runs as one, so the checkout and
 *  (for a linked worktree) the main checkout are named safe. */
export function codexSandboxEnv(o: { platform: NodeJS.Platform; layout: GitLayout | null; tmpDir: string }): Record<string, string> {
  const env: Record<string, string> = { npm_config_cache: npmCacheOf(o.tmpDir) }
  if (o.platform !== 'win32' || !o.layout) return env
  const safe = [o.layout.top]
  const main = o.layout.commonDir.replace(/\/[^/]*$/, '')
  if (main && main !== o.layout.top) safe.push(main)
  env.GIT_CONFIG_COUNT = String(safe.length)
  safe.forEach((p, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = 'safe.directory'
    env[`GIT_CONFIG_VALUE_${i}`] = p
  })
  return env
}
