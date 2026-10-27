// The Claude side of a sandboxed session (sandbox design §6): the `sandbox` and `permissions` parts of the settings handed to
// the session. Claude's own sandbox runs on macOS and Linux only; on Windows the deny rules are all it can enforce.
export interface ClaudeSandboxSettings {
  sandbox?: {
    enabled: boolean
    allowUnsandboxedCommands: boolean
    failIfUnavailable: boolean
    excludedCommands: string[]
    filesystem: { allowWrite: string[]; denyRead: string[] }
  }
  permissions: { deny: string[] }
}

/** Claude's permission paths: `//` marks an absolute path, and on Windows `C:/x` is matched in its POSIX form `/c/x`. */
function readRule(p: string): string {
  const f = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(f)
  const posix = drive ? `/${drive[1].toLowerCase()}${drive[2] ?? ''}` : f
  return `Read(/${posix}/**)`
}

export function claudeSandboxSettings(o: { platform: NodeJS.Platform; denied: string[]; npmCache: string }): ClaudeSandboxSettings {
  const permissions = { deny: o.denied.map(readRule) }
  if (o.platform === 'win32') return { permissions }
  return {
    sandbox: {
      enabled: true,
      // A command that cannot run inside the sandbox fails instead of being retried outside it, and a missing sandbox stops the session.
      allowUnsandboxedCommands: false,
      failIfUnavailable: true,
      // The astera command talks to the Host over a socket the sandbox would block.
      excludedCommands: ['astera *'],
      filesystem: { allowWrite: [o.npmCache], denyRead: o.denied }
    },
    permissions
  }
}
