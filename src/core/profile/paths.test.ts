// Agent Control Plane release 1 (design §4.1, AC-09.5): every path the extension state uses is under the profile it
// was given, so a dev profile and the installed one never share it.
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { extensionPaths } from './paths'

describe('extensionPaths', () => {
  it('puts every extension path under the profile', () => {
    const p = path.join('C:', 'Users', 'u', 'AppData', 'Roaming', 'astera')
    expect(extensionPaths(p)).toEqual({
      registry: path.join(p, 'extensions', 'registry.json'),
      claudePlugins: path.join(p, 'extensions', 'claude-plugins.json'),
      claudePluginHome: path.join(p, 'extensions', 'claude-plugins'),
      codexPluginHome: path.join(p, 'extensions', 'codex-plugins'),
      codexPluginData: path.join(p, 'extensions', 'codex-plugin-data'),
      skills: path.join(p, 'extensions', 'skills'),
      commands: path.join(p, 'extensions', 'commands'),
      agents: path.join(p, 'extensions', 'agents'),
      secrets: path.join(p, 'extensions', 'secrets'),
      materializedState: path.join(p, 'extension-state', 'materialized.json'),
      claudePluginUse: path.join(p, 'extension-state', 'claude-plugin-use'),
      codexPluginAccounts: path.join(p, 'extension-state', 'codex-plugin-accounts.json'),
      codexConfigLock: path.join(p, 'extension-state', 'codex-config.lock'),
      backups: path.join(p, 'extension-state', 'backups'),
      generatedMcp: path.join(p, 'materialized', 'mcp')
    })
  })

  it('gives a dev profile and the installed profile no path in common', () => {
    const prod = Object.values(extensionPaths(path.join('C:', 'r', 'astera')))
    const dev = Object.values(extensionPaths(path.join('C:', 'r', 'astera-dev')))
    for (const d of dev) for (const p of prod) expect(d.startsWith(p + path.sep) || d === p).toBe(false)
  })
})
