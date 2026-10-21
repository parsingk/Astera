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
