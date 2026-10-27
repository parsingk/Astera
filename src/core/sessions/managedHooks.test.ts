import { describe, expect, it } from 'vitest'
import { claudeManagedHooksOff, managedSettingsDir } from './managedHooks'

// Final review C2: a policy an organization deploys can turn Claude Code's hooks off where nothing a session passes
// overrides it (Claude Code's managed settings reference); a session started in Enforce then does not start
describe('claudeManagedHooksOff', () => {
  const files = (map: Record<string, string>) => ({
    readText: async (p: string) => map[p.replace(/\\/g, '/')] ?? null,
    listDir: async (p: string) => Object.keys(map).filter((k) => k.startsWith(p.replace(/\\/g, '/') + '/')).map((k) => k.slice(p.length + 1))
  })

  it('reads the managed settings file and its drop-ins where each OS keeps them', async () => {
    expect(managedSettingsDir('win32')).toBe('C:\\Program Files\\ClaudeCode')
    expect(managedSettingsDir('darwin')).toBe('/Library/Application Support/ClaudeCode')
    expect(managedSettingsDir('linux')).toBe('/etc/claude-code')
    const dir = '/etc/claude-code'
    expect(await claudeManagedHooksOff({ platform: 'linux', ...files({ [`${dir}/managed-settings.json`]: '{"allowManagedHooksOnly": true}' }) })).toBe(true)
    expect(await claudeManagedHooksOff({ platform: 'linux', ...files({ [`${dir}/managed-settings.d/20-x.json`]: '{"disableAllHooks": true}' }) })).toBe(true)
    expect(await claudeManagedHooksOff({ platform: 'linux', ...files({ [`${dir}/managed-settings.json`]: '{"disableAllHooks": false, "model": "x"}' }) })).toBe(false)
    // One that cannot be read as JSON keeps Claude Code from starting at all: not this check's to refuse
    expect(await claudeManagedHooksOff({ platform: 'linux', ...files({ [`${dir}/managed-settings.json`]: '{ nope' }) })).toBe(false)
    expect(await claudeManagedHooksOff({ platform: 'linux', ...files({}) })).toBe(false)
  })

  it('reads the Windows registry policy and the macOS managed preferences', async () => {
    const none = files({})
    expect(
      await claudeManagedHooksOff({ platform: 'win32', ...none, registry: async (key) => (key === 'HKLM\\SOFTWARE\\Policies\\ClaudeCode' ? '{"allowManagedHooksOnly":true}' : null) })
    ).toBe(true)
    expect(await claudeManagedHooksOff({ platform: 'win32', ...none, registry: async (key) => (key.startsWith('HKCU') ? '{"disableAllHooks":true}' : null) })).toBe(true)
    expect(await claudeManagedHooksOff({ platform: 'darwin', ...none, plist: async () => '{"disableAllHooks":true}' })).toBe(true)
    expect(await claudeManagedHooksOff({ platform: 'darwin', ...none, plist: async () => null })).toBe(false)
  })
})
