// `astera ext list` and `astera ext sync` (Agent Control Plane release 1 design §4.6, AC-14, D5): no Host, names only,
// and a second sync changes nothing.
import { describe, it, expect, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../core/testFixtures'
import { extensionPaths } from '../core/profile/paths'
import { writeExtensionRegistry } from '../core/extensions/registry'
import { extensionSecrets } from '../core/extensions/secrets'
import { hashFile } from '../core/extensions/hash'
import { updateClaudePlugins } from '../core/extensions/claudePlugins/store'
import type { SharedClaudePlugin } from '../core/extensions/claudePlugins/types'
import { extensionsCommand } from './extensions'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const SECRET = 'lin_api_cli_list_must_not_leak_000'

async function profile() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-cli-ext-'))
  dirs.push(root)
  const profileDir = path.join(root, 'profile')
  const configDir = path.join(root, 'claude-a')
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(profileDir, { recursive: true })
  await fs.writeFile(path.join(profileDir, 'accounts.json'), JSON.stringify({ accounts: [
    { id: 'acc_1', label: 'a', configDir, color: '#888', createdAt: '2026-10-21T00:00:00.000Z', provider: 'claude' }
  ] }))
  const paths = extensionPaths(profileDir)
  await fs.mkdir(paths.commands, { recursive: true })
  await fs.writeFile(path.join(paths.commands, 'ship.md'), 'ship it\n')
  await writeExtensionRegistry(profileDir, { version: 1, entries: [
    { id: 'command-ship', kind: 'command', name: 'ship', hash: await hashFile(path.join(paths.commands, 'ship.md')), providers: ['claude'], importedFrom: 'acc_0', enabled: true },
    { id: 'mcp-linear', kind: 'mcp', name: 'linear', transport: 'stdio', command: 'npx', providers: ['claude'], importedFrom: 'acc_0', enabled: true,
      env: { LINEAR_API_KEY: { secret: 'mcp.mcp-linear.LINEAR_API_KEY' }, LOG_LEVEL: { value: 'info' } } }
  ] })
  await extensionSecrets(profileDir).put('mcp.mcp-linear.LINEAR_API_KEY', SECRET)
  return { profileDir, configDir, paths }
}

describe('extensionsCommand', () => {
  it('sync writes the copies, and a second sync prints the same items as unchanged and writes nothing', async () => {
    const p = await profile()
    expect(await extensionsCommand({ cmd: 'ext-sync', profileDir: p.profileDir })).toEqual({
      ok: true, body: { items: [{ id: 'command-ship', accountId: 'acc_1', outcome: 'written' }] }
    })
    const state = await fs.stat(p.paths.materializedState)
    const again = await extensionsCommand({ cmd: 'ext-sync', profileDir: p.profileDir })
    expect(again).toEqual({ ok: true, body: { items: [{ id: 'command-ship', accountId: 'acc_1', outcome: 'unchanged' }] } })
    expect((await fs.stat(p.paths.materializedState)).mtimeMs).toBe(state.mtimeMs)
  })

  it('list names what is shared and where its copies are, with no environment value', async () => {
    const p = await profile()
    await extensionsCommand({ cmd: 'ext-sync', profileDir: p.profileDir })
    const r = await extensionsCommand({ cmd: 'ext-list', profileDir: p.profileDir })
    expect(JSON.stringify(r)).not.toContain(SECRET)
    expect(JSON.stringify(r)).not.toContain('"info"')
    expect(r).toMatchObject({ ok: true, body: {
      entries: [{ id: 'command-ship' }, { id: 'mcp-linear', env: { LINEAR_API_KEY: 'secret', LOG_LEVEL: 'value' } }],
      copies: [{ id: 'command-ship', accountId: 'acc_1', destination: path.join(p.configDir, 'commands', 'ship.md'), adopted: false }]
    } })
  })

  const sharedPlugin: SharedClaudePlugin = {
    id: 'review@market',
    name: 'review',
    marketplace: 'market',
    source: { source: 'github', repo: 'acme/market' },
    version: '1.0.0',
    installPath: '/astera/extensions/claude-plugins/plugins/cache/market/review/1.0.0',
    dependencies: [],
    importedFrom: 'acc_1',
    enabled: true,
    addedAt: '2026-11-02T00:00:00.000Z',
    lastUpdated: '2026-11-02T00:00:00.000Z',
    fingerprint: 'sha256:aa',
    update: { version: '1.1.0', fingerprint: 'sha256:bb', checkedAt: '2026-11-02T02:00:00.000Z' }
  }

  it('list includes shared plugins, and an empty list when none is shared', async () => {
    const p = await profile()
    const none = await extensionsCommand({ cmd: 'ext-list', profileDir: p.profileDir })
    expect(none).toMatchObject({ ok: true, body: { claudePlugins: [] } })
    expect(JSON.stringify(none)).not.toContain('claudePluginsError')
    await updateClaudePlugins(p.profileDir, (s) => ({ ...s, plugins: [sharedPlugin] }))
    const r = await extensionsCommand({ cmd: 'ext-list', profileDir: p.profileDir })
    expect(r).toMatchObject({ ok: true, body: { entries: [{ id: 'command-ship' }, { id: 'mcp-linear' }], claudePlugins: [sharedPlugin] } })
    expect(JSON.stringify(r)).not.toContain('claudePluginsError')
  })

  it('list answers the registry when the plugin store is damaged, and writes nothing beside it', async () => {
    const p = await profile()
    await fs.writeFile(p.paths.claudePlugins, '{ damaged')
    const extDir = path.dirname(p.paths.claudePlugins)
    const before = await fs.readdir(extDir)
    const r = await extensionsCommand({ cmd: 'ext-list', profileDir: p.profileDir })
    expect(r).toMatchObject({ ok: true, body: { entries: [{ id: 'command-ship' }, { id: 'mcp-linear' }], copies: [] } })
    if (!r.ok) throw new Error('unreachable')
    expect(r.body.claudePluginsError).toEqual(expect.stringContaining('claude-plugins.json'))
    // a damaged store is not "nothing shared": no list is given, and the file and its folder are as they were
    expect(r.body).not.toHaveProperty('claudePlugins')
    expect(await fs.readFile(p.paths.claudePlugins, 'utf8')).toBe('{ damaged')
    expect(await fs.readdir(extDir)).toEqual(before)
  })

  it('refuses a damaged registry with the file to repair, and a failed copy exits as a failure', async () => {
    const p = await profile()
    await fs.rm(p.configDir, { recursive: true })
    expect(await extensionsCommand({ cmd: 'ext-sync', profileDir: p.profileDir })).toMatchObject({ ok: false, error: { code: 'FAILED' } })
    await fs.writeFile(p.paths.registry, '{ damaged')
    expect(await extensionsCommand({ cmd: 'ext-list', profileDir: p.profileDir })).toMatchObject({
      ok: false, error: { code: 'CONFLICT', details: { repair: 'extensions/registry.json' } }
    })
  })
})
