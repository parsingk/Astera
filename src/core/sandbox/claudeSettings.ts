// The Claude side of a sandboxed session (sandbox design §6): the `sandbox` and `permissions` parts of the settings handed to
// the session. Claude's own sandbox runs on macOS and Linux only; on Windows the deny rules are all it can enforce.
import type { GitLayout } from './gitLayout'

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
function readRules(p: string): string[] {
  const f = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(f)
  const posix = drive ? `/${drive[1].toLowerCase()}${drive[2] ?? ''}` : f
  return [`Read(/${posix})`, `Read(/${posix}/**)`]
}

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

export function claudeSandboxSettings(o: { platform: NodeJS.Platform; denied: string[]; npmCache: string; layout: GitLayout | null }): ClaudeSandboxSettings {
  const permissions = { deny: o.denied.flatMap(readRules) }
  if (o.platform === 'win32') return { permissions }
  return {
    sandbox: {
      enabled: true,
      // A command that cannot run inside the sandbox fails instead of being retried outside it, and a missing sandbox stops the session.
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      // The astera command talks to the Host over a socket the sandbox would block.
      excludedCommands: ['astera *'],
      filesystem: { allowWrite: [o.npmCache], denyWrite: [...new Set(gitDenyWrite(o.layout))], denyRead: o.denied }
    },
    permissions
  }
}
