// Agent Control Plane release 1 (design §4.3, §4.6, D5): the Host's extensions commands. For the app and the CLI
// only, changes refused to an agent's shell, every change followed by a sync, and no environment value in any answer.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../core/testFixtures'
import { extensionPaths } from '../../core/profile/paths'
import { readExtensionRegistry, writeExtensionRegistry } from '../../core/extensions/registry'
import { extensionSecrets } from '../../core/extensions/secrets'
import { createHostExtensions } from './commands'
import type { Account } from '../../core/types'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const SECRET = 'lin_api_host_list_must_not_leak_000'

async function rig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-ext-'))
  dirs.push(root)
  const profileDir = path.join(root, 'profile')
  const home = path.join(root, 'home')
  const source: Account = { id: 'acc_1', label: 'a', configDir: path.join(home, '.claude'), color: '#888', createdAt: '2026-10-21T00:00:00.000Z', provider: 'claude' }
  const other: Account = { ...source, id: 'acc_2', configDir: path.join(home, '.claude-accounts', 'b') }
  await fs.mkdir(path.join(source.configDir, 'commands'), { recursive: true })
  await fs.mkdir(other.configDir, { recursive: true })
  await fs.writeFile(path.join(source.configDir, 'commands', 'ship.md'), 'ship it\n')
  const logs: string[] = []
  // The Gateway as the Host's hub shows it to the commands: a port while something is shared over stdio
  const gateway = {
    port: (): number | null => 47999,
    sync: vi.fn(async (): Promise<number | null> => 47999),
    states: () => [{ serverId: 'mcp-linear', processes: 1, state: 'running' as const }],
    stopServer: vi.fn(async (_id: string) => {})
  }
  const ext = createHostExtensions({ profileDir, homeDir: home, readAccounts: async () => [source, other], log: (l) => logs.push(l), gateway })
  const call = (cmd: string, args: Record<string, unknown> = {}, extra: { role?: 'app' | 'cli' | 'mcp'; agentRefusal?: string } = {}) => {
    const marks = { effects: 0 }
    return ext.command({ cmd, args, role: extra.role ?? 'app', ...(extra.agentRefusal ? { agentRefusal: extra.agentRefusal } : {}), marks }).then((r) => ({ ...r, marks }))
  }
  return { profileDir, home, source, other, ext, call, logs, gateway }
}

describe('createHostExtensions', () => {
  it('imports from an account, copies it into the others, and lists it with the sync status', async () => {
    const h = await rig()
    const r = await h.call('extensions-import', { accountId: 'acc_1', picks: [{ kind: 'command', name: 'ship' }] })
    expect(r.status).toBe(200)
    expect(r.marks.effects).toBe(1)
    expect(await fs.readFile(path.join(h.other.configDir, 'commands', 'ship.md'), 'utf8')).toBe('ship it\n')
    const listed = await h.call('extensions-list')
    expect(listed.body).toMatchObject({
      entries: [{ id: 'command-ship', kind: 'command', name: 'ship' }],
      status: expect.arrayContaining([
        { id: 'command-ship', accountId: 'acc_1', outcome: 'adopted' },
        { id: 'command-ship', accountId: 'acc_2', outcome: 'written' }
      ])
    })
  })

  it('never answers an environment value, only where each one comes from', async () => {
    const h = await rig()
    await writeExtensionRegistry(h.profileDir, { version: 1, entries: [
      { id: 'mcp-linear', kind: 'mcp', name: 'linear', transport: 'stdio', command: 'npx', providers: ['claude', 'codex'], importedFrom: 'acc_1', enabled: true,
        env: { LINEAR_API_KEY: { secret: 'mcp.mcp-linear.LINEAR_API_KEY' }, LOG_LEVEL: { value: 'info' }, HOME_DIR: { inherit: true } } }
    ] })
    await extensionSecrets(h.profileDir).put('mcp.mcp-linear.LINEAR_API_KEY', SECRET)
    const listed = await h.call('extensions-list', {}, { role: 'cli' })
    expect(JSON.stringify(listed.body)).not.toContain(SECRET)
    expect(listed.body).toMatchObject({ entries: [{ env: { LINEAR_API_KEY: 'secret', LOG_LEVEL: 'value', HOME_DIR: 'inherit' } }] })
  })

  it('refuses a change to an agent’s shell and to anyone but the app and the CLI, and lets the shell read', async () => {
    const h = await rig()
    const refused = await h.call('extensions-import', { accountId: 'acc_1', picks: [{ kind: 'command', name: 'ship' }] }, { role: 'cli', agentRefusal: 'not from an agent session' })
    expect(refused).toMatchObject({ status: 403, body: { error: 'not from an agent session' } })
    expect((await h.call('extensions-list', {}, { role: 'mcp' })).status).toBe(403)
    expect((await h.call('extensions-list', {}, { role: 'cli', agentRefusal: 'no' })).status).toBe(200)
    expect(await fs.stat(extensionPaths(h.profileDir).registry).then(() => true, () => false)).toBe(false)
  })

  it('answers 400 for missing arguments and 404 for an unknown account or item', async () => {
    const h = await rig()
    expect((await h.call('extensions-import', { accountId: 'acc_1' })).status).toBe(400)
    expect((await h.call('extensions-import', { accountId: 'nope', picks: [{ kind: 'skill', name: 'x' }] })).status).toBe(404)
    expect((await h.call('extensions-disable', { id: 'skill-nope' })).status).toBe(404)
    expect((await h.call('extensions-discover', { accountId: 'acc_1' })).body).toMatchObject({ items: [{ kind: 'command', name: 'ship', shareable: true }] })
  })

  // Design §4.9: a stored secret value never reaches the Host's log or an answer, even inside an error's own words
  it('redacts a stored secret value from its log lines and its error answers', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-host-ext-'))
    dirs.push(root)
    const profileDir = path.join(root, 'profile')
    await extensionSecrets(profileDir).put('mcp.mcp-linear.LINEAR_API_KEY', SECRET)
    const logs: string[] = []
    const ext = createHostExtensions({
      profileDir,
      homeDir: root,
      readAccounts: async () => {
        throw new Error(`accounts.json could not be read near "${SECRET}"`)
      },
      log: (l) => logs.push(l)
    })
    const r = await ext.command({ cmd: 'extensions-sync', args: {}, role: 'app', marks: { effects: 0 } })
    expect(r.status).toBe(500)
    expect(JSON.stringify(r.body)).not.toContain(SECRET)
    expect(JSON.stringify(r.body)).toContain('[redacted]')
    await ext.sync()
    await vi.waitFor(() => expect(logs.length).toBeGreaterThan(0))
    expect(logs.join(' ')).not.toContain(SECRET)
    expect(logs.join(' ')).toContain('[redacted]')
  })

  // Final review I1: a server a session cannot get is said, per account, with why
  it('lists for each MCP server, per account, whether its sessions get it and why not', async () => {
    const h = await rig()
    await fs.writeFile(path.join(h.source.configDir, '..', '.claude.json'), JSON.stringify({ mcpServers: { linear: { command: 'npx' } } }))
    await h.call('extensions-import', { accountId: 'acc_1', picks: [{ kind: 'mcp', name: 'linear' }] })
    const listed = await h.call('extensions-list')
    expect((listed.body as { mcpStatus: unknown[] }).mcpStatus).toEqual(
      expect.arrayContaining([
        { id: 'mcp-linear', accountId: 'acc_1', state: 'account-own' },
        { id: 'mcp-linear', accountId: 'acc_2', state: 'given' }
      ])
    )
  })

  it('removes a copy it wrote when the item is disabled, and answers a damaged registry with 409', async () => {
    const h = await rig()
    await h.call('extensions-import', { accountId: 'acc_1', picks: [{ kind: 'command', name: 'ship' }] })
    await h.call('extensions-disable', { id: 'command-ship' })
    expect(await fs.stat(path.join(h.other.configDir, 'commands', 'ship.md')).then(() => true, () => false)).toBe(false)
    expect(await fs.readFile(path.join(h.source.configDir, 'commands', 'ship.md'), 'utf8')).toBe('ship it\n')
    await fs.writeFile(extensionPaths(h.profileDir).registry, '{ damaged')
    expect((await h.call('extensions-list')).status).toBe(409)
    expect(await h.ext.sync()).toEqual([])
  })
})

// Gateway design §4.1, §4.5, G8
describe('createHostExtensions, with the Gateway', () => {
  it('answers the Gateway’s port, syncing it first, and the processes’ state in the list', async () => {
    const h = await rig()
    expect((await h.call('extensions-gateway')).body).toEqual({ port: 47999 })
    expect(h.gateway.sync).toHaveBeenCalled()
    expect((await h.call('extensions-list')).body).toMatchObject({ gateway: [{ serverId: 'mcp-linear', processes: 1, state: 'running' }] })
  })

  it('syncs the Gateway after an import, and stops a server’s processes when it is disabled or removed', async () => {
    const h = await rig()
    await fs.writeFile(path.join(h.home, '.claude.json'), JSON.stringify({ mcpServers: { linear: { command: 'npx' } } }))
    await h.call('extensions-import', { accountId: 'acc_1', picks: [{ kind: 'mcp', name: 'linear' }] })
    expect(h.gateway.sync).toHaveBeenCalled()
    await h.call('extensions-disable', { id: 'mcp-linear' })
    await h.call('extensions-remove', { id: 'mcp-linear' })
    expect(h.gateway.stopServer.mock.calls).toEqual([['mcp-linear'], ['mcp-linear']])
  })

  it('switches a server to one process per session, refused to an agent shell', async () => {
    const h = await rig()
    await fs.writeFile(path.join(h.home, '.claude.json'), JSON.stringify({ mcpServers: { linear: { command: 'npx' } } }))
    await h.call('extensions-import', { accountId: 'acc_1', picks: [{ kind: 'mcp', name: 'linear' }] })
    expect((await h.call('extensions-isolation', { id: 'mcp-linear', isolation: 'session' }, { role: 'cli', agentRefusal: 'no' })).status).toBe(403)
    expect((await h.call('extensions-isolation', { id: 'mcp-linear', isolation: 'nope' })).status).toBe(400)
    const r = await h.call('extensions-isolation', { id: 'mcp-linear', isolation: 'session' })
    expect(r.status).toBe(200)
    expect(r.marks.effects).toBe(1)
    expect((await readExtensionRegistry(h.profileDir)).entries[0]).toMatchObject({ isolation: 'session' })
  })
})
