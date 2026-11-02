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
import { readClaudePlugins, updateClaudePlugins } from '../../core/extensions/claudePlugins/store'
import type { PluginCliResult, PluginCliRun } from '../../core/extensions/claudePlugins/cli'
import type { ClaudePluginJob } from '../../core/extensions/claudePlugins/operations'
import type { MarketplaceSource, SharedClaudePlugin } from '../../core/extensions/claudePlugins/types'
import type { McpExtension } from '../../core/extensions/types'
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

  // Remote governance design §13: the controller gate refuses these first; the handler refuses a controller as well
  it('a controller role is refused at the handler too', async () => {
    const h = await rig()
    const r = await h.ext.command({ cmd: 'extensions-list', args: {}, role: 'controller', marks: { effects: 0 } })
    expect(r.status).toBe(403)
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

// Final review of release 2 (M2): the Gateway's last error is shown with stored secret values taken out
describe('createHostExtensions, the Gateway’s errors', () => {
  it('redacts a stored secret value from the processes’ last error', async () => {
    const h = await rig()
    await extensionSecrets(h.profileDir).put('mcp.mcp-linear.LINEAR_API_KEY', SECRET)
    h.gateway.states = () => [{ serverId: 'mcp-linear', processes: 0, state: 'failed', lastError: `refused ${SECRET}` }] as never
    const listed = await h.call('extensions-list')
    expect(JSON.stringify(listed.body)).not.toContain(SECRET)
    expect(JSON.stringify(listed.body)).toContain('[redacted]')
  })
})

// Shared Claude Code plugins (R4, R5): each change is a job on the plugins' own queue that answers its id at once, the
// list waits for neither queue and never syncs the Gateway, a share re-runs discovery, and the start sweeps the plugin
// folder, then checks for updates, then checks again every day. `claude plugin …` is a fake that answers per argument
// list; what Claude Code would leave in Astera's plugin folder is written by hand.
const SOURCE: MarketplaceSource = { source: 'github', repo: 'acme/market' }
const EARLIER = '2026-10-01T00:00:00.000Z'
const DAY_MS = 24 * 60 * 60 * 1000

const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)
const deferred = () => {
  let release!: () => void
  const p = new Promise<void>((r) => (release = r))
  return { p, release }
}

type Reply = Partial<PluginCliResult>
type Script = Record<string, (args: string[]) => Reply | Promise<Reply>>
const okOutcome: Reply = { code: 0, json: { outcome: 'ok' } }

/** A `claude plugin` runner that answers each argument list from `script`, read at the call; one it was not given fails,
 *  so a stray command shows. */
function fakeRun(script: Script) {
  const calls: string[] = []
  const run: PluginCliRun = async (args) => {
    const key = args.join(' ')
    calls.push(key)
    const r = script[key] ? await script[key](args) : { code: 1, stderr: `not scripted: ${key}` }
    return { code: 0, json: null, stdout: '', stderr: '', timedOut: false, ...r }
  }
  return { run, calls }
}

/** An account's plugins at user scope, all from marketplace `market` (SOURCE), as Claude Code records them. */
async function holding(configDir: string, plugins: Record<string, { version: string; manifest?: object }>, enabled: Record<string, boolean> = {}): Promise<void> {
  const installed: Record<string, object[]> = {}
  for (const [id, p] of Object.entries(plugins)) {
    const [name, marketplace] = id.split('@')
    const installPath = path.join(configDir, 'plugins', 'cache', marketplace, name, p.version)
    installed[id] = [{ scope: 'user', version: p.version, installPath }]
    await write(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify(p.manifest ?? { name }))
  }
  await write(path.join(configDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: installed }))
  await write(
    path.join(configDir, 'plugins', 'known_marketplaces.json'),
    JSON.stringify({ market: { source: SOURCE, installLocation: path.join(configDir, 'plugins', 'marketplaces', 'market') } })
  )
  await write(path.join(configDir, 'settings.json'), JSON.stringify({ enabledPlugins: enabled }))
}

/** What `claude plugin marketplace add` leaves in Astera's plugin folder: the record and the clone's catalog. */
async function addMarketplace(pluginHome: string): Promise<void> {
  const installLocation = path.join(pluginHome, 'plugins', 'marketplaces', 'market')
  await write(path.join(pluginHome, 'plugins', 'known_marketplaces.json'), JSON.stringify({ market: { source: SOURCE, installLocation } }))
  await write(
    path.join(installLocation, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: 'market', owner: { name: 'acme' }, plugins: [{ name: 'review', source: { source: 'github', repo: 'acme/review' }, version: '1.0.0' }] })
  )
}

const sharedEntry = (pluginHome: string, name: string, over: Partial<SharedClaudePlugin> = {}): SharedClaudePlugin => ({
  id: `${name}@market`,
  name,
  marketplace: 'market',
  source: SOURCE,
  version: '1.0.0',
  installPath: path.join(pluginHome, 'plugins', 'cache', 'market', name, '1.0.0'),
  dependencies: [],
  importedFrom: 'acc_1',
  enabled: true,
  addedAt: EARLIER,
  lastUpdated: EARLIER,
  fingerprint: 'sha256:recorded',
  ...over
})

const LINEAR: McpExtension = { id: 'mcp-linear', kind: 'mcp', name: 'linear', transport: 'stdio', command: 'npx', env: {}, providers: ['claude'], importedFrom: 'acc_1', enabled: true }

/** A version folder an earlier update left behind, marked orphaned 20 days ago: the sweep takes it. */
async function orphanedVersion(pluginHome: string): Promise<string> {
  const dir = path.join(pluginHome, 'plugins', 'cache', 'market', 'review', '0.9.0')
  const marker = path.join(dir, '.orphaned_at')
  await write(marker, '')
  const aged = new Date(Date.now() - 20 * DAY_MS)
  await fs.utimes(marker, aged, aged)
  return dir
}

async function pluginRig() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ext-plugin-'))
  dirs.push(root)
  const profileDir = path.join(root, 'profile')
  const home = path.join(root, 'home')
  const account: Account = { id: 'acc_1', label: 'a', configDir: path.join(home, '.claude'), color: '#888', createdAt: EARLIER, provider: 'claude' }
  await fs.mkdir(account.configDir, { recursive: true })
  const pluginHome = extensionPaths(profileDir).claudePluginHome
  const script: Script = {}
  const fake = fakeRun(script)
  const gateway = {
    port: (): number | null => null,
    sync: vi.fn(async (): Promise<number | null> => null),
    states: () => [],
    stopServer: vi.fn(async (_id: string) => {})
  }
  const ext = createHostExtensions({ profileDir, homeDir: home, readAccounts: async () => [account], log: () => {}, gateway, claudePluginRun: fake.run })
  const call = (cmd: string, args: Record<string, unknown> = {}, extra: { role?: 'app' | 'cli' | 'mcp'; agentRefusal?: string } = {}) => {
    const marks = { effects: 0 }
    return ext.command({ cmd, args, role: extra.role ?? 'app', ...(extra.agentRefusal ? { agentRefusal: extra.agentRefusal } : {}), marks }).then((r) => ({ ...r, marks }))
  }
  const seed = (plugins: SharedClaudePlugin[]) => updateClaudePlugins(profileDir, (s) => ({ ...s, plugins }))
  const listed = async () => (await call('extensions-plugin-list')).body as { plugins: (SharedClaudePlugin & { missing: boolean; requiredBy: string[] })[]; jobs: ClaudePluginJob[] }
  const jobs = async () => (await listed()).jobs
  return { profileDir, account, pluginHome, script, fake, gateway, ext, call, seed, listed, jobs }
}

describe('createHostExtensions, shared Claude plugins', () => {
  it('plugin-list answers jobs and entries without syncing the gateway', async () => {
    const h = await pluginRig()
    const review = sharedEntry(h.pluginHome, 'review')
    await fs.mkdir(review.installPath, { recursive: true })
    await h.seed([review])
    await holding(h.account.configDir, { 'review@market': { version: '0.9.0' } }, { 'review@market': true })
    // A check held in `marketplace update`, and an MCP removal held in the Gateway's stop: the list waits for neither
    const check = deferred()
    h.script['plugin marketplace update market'] = async () => {
      await check.p
      return okOutcome
    }
    await writeExtensionRegistry(h.profileDir, { version: 1, entries: [LINEAR] })
    const stop = deferred()
    h.gateway.stopServer.mockImplementation(async () => {
      await stop.p
    })
    const checked = await h.call('extensions-plugin-check')
    expect(checked).toMatchObject({ status: 200, marks: { effects: 1 } })
    const removing = h.call('extensions-remove', { id: 'mcp-linear' })
    await vi.waitFor(() => expect(h.fake.calls).toEqual(['plugin marketplace update market']))
    await vi.waitFor(() => expect(h.gateway.stopServer).toHaveBeenCalled())

    const listed = await h.call('extensions-plugin-list')
    expect(listed).toMatchObject({ status: 200, marks: { effects: 0 } })
    expect(listed.body).toEqual({
      plugins: [{ ...review, missing: false, accountCopies: [{ accountId: 'acc_1', version: '0.9.0', enabled: true }], requiredBy: [] }],
      jobs: [expect.objectContaining({ id: (checked.body as { jobId: string }).jobId, kind: 'check', state: 'running' })]
    })
    expect(h.gateway.sync).not.toHaveBeenCalled()

    check.release()
    stop.release()
    expect((await removing).status).toBe(200)
    await vi.waitFor(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ state: 'done' })]))
    expect((await h.listed()) as unknown).toMatchObject({ lastCheck: { at: expect.any(String) } })
  })

  // Review Focus 2: deleted by hand, or swept. Missing as a spawn finds it: the entry's folder or a dependency's
  it('list marks a missing installPath', async () => {
    const h = await pluginRig()
    const kept = sharedEntry(h.pluginHome, 'kept')
    const gone = sharedEntry(h.pluginHome, 'gone')
    const owner = sharedEntry(h.pluginHome, 'owner', {
      dependencies: [{ id: 'base@market', version: '1.0.0', installPath: path.join(h.pluginHome, 'plugins', 'cache', 'market', 'base', '1.0.0') }]
    })
    await fs.mkdir(kept.installPath, { recursive: true })
    await fs.mkdir(owner.installPath, { recursive: true })
    await h.seed([kept, gone, owner])
    expect((await h.listed()).plugins.map((p) => [p.id, p.missing])).toEqual([
      ['kept@market', false],
      ['gone@market', true],
      ['owner@market', true]
    ])
  })

  // Task 7: an entry that is off still loads for an enabled entry that needs it, and the row says for which
  it('list names the enabled entries that still load an entry', async () => {
    const h = await pluginRig()
    const base = sharedEntry(h.pluginHome, 'base', { enabled: false })
    const needsBase = { dependencies: [{ id: base.id, version: base.version, installPath: base.installPath }] }
    await h.seed([base, sharedEntry(h.pluginHome, 'review', needsBase), sharedEntry(h.pluginHome, 'lint', { ...needsBase, enabled: false })])
    expect((await h.listed()).plugins.map((p) => [p.id, p.requiredBy])).toEqual([
      ['base@market', ['review@market']],
      ['review@market', []],
      ['lint@market', []]
    ])
  })

  it('plugin-share answers a job id at once and the job records the entry', async () => {
    const h = await pluginRig()
    await holding(h.account.configDir, { 'review@market': { version: '1.0.0' } })
    const rows: object[] = []
    const install = deferred()
    h.script['plugin marketplace add acme/market'] = async () => {
      await addMarketplace(h.pluginHome)
      return okOutcome
    }
    h.script['plugin list'] = () => ({ code: 0, json: [...rows] })
    h.script['plugin install review@market --accept-command sha-shown'] = async () => {
      await install.p
      const installPath = path.join(h.pluginHome, 'plugins', 'cache', 'market', 'review', '1.0.0')
      await write(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'review', version: '1.0.0' }))
      rows.push({ id: 'review@market', version: '1.0.0', scope: 'user', enabled: true, installPath })
      return okOutcome
    }

    const shared = await h.call('extensions-plugin-share', { id: 'review@market', acceptCommand: 'sha-shown' })
    expect(shared).toMatchObject({ status: 200, body: { jobId: expect.any(String) }, marks: { effects: 1 } })
    const jobId = (shared.body as { jobId: string }).jobId
    // Answered while the install is still held
    expect(await h.jobs()).toEqual([expect.objectContaining({ id: jobId, kind: 'share', target: 'review@market', state: expect.stringMatching(/^(queued|running)$/) })])

    install.release()
    await vi.waitFor(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ id: jobId, state: 'done' })]))
    expect((await readClaudePlugins(h.profileDir)).plugins).toEqual([
      expect.objectContaining({ id: 'review@market', source: SOURCE, importedFrom: 'acc_1', version: '1.0.0', enabled: true })
    ])
    expect(h.fake.calls).toEqual(['plugin marketplace add acme/market', 'plugin list', 'plugin install review@market --accept-command sha-shown', 'plugin list'])
  })

  it('plugin-share of a refused id answers 400 with the reason', async () => {
    const h = await pluginRig()
    await holding(h.account.configDir, {
      'form@market': { version: '1.0.0', manifest: { name: 'form', userConfig: { token: { type: 'string' } } } },
      'review@market': { version: '1.0.0' }
    })
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    expect((await h.call('extensions-plugin-discover')).body).toEqual({
      plugins: [expect.objectContaining({ id: 'form@market', shareable: false, reason: 'user-config' })],
      unreadable: []
    })
    expect(await h.call('extensions-plugin-share', { id: 'form@market' })).toMatchObject({ status: 400, body: { reason: 'user-config' }, marks: { effects: 0 } })
    // Held by no account, or shared already: discovery does not offer it
    expect(await h.call('extensions-plugin-share', { id: 'nope@market' })).toMatchObject({ status: 400, body: { reason: 'not-offered' } })
    expect(await h.call('extensions-plugin-share', { id: 'review@market' })).toMatchObject({ status: 400, body: { reason: 'not-offered' } })
    expect(h.fake.calls).toEqual([])
    expect(await h.jobs()).toEqual([])
  })

  it('plugin changes are refused to an agent shell', async () => {
    const h = await pluginRig()
    await holding(h.account.configDir, { 'lint@market': { version: '1.0.0' } })
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    const changes: [string, Record<string, unknown>][] = [
      ['extensions-plugin-share', { id: 'lint@market' }],
      ['extensions-plugin-update', { id: 'review@market' }],
      ['extensions-plugin-check', {}],
      ['extensions-plugin-remove', { id: 'review@market' }],
      ['extensions-plugin-set-enabled', { id: 'review@market', enabled: false }]
    ]
    for (const [cmd, args] of changes) {
      expect(await h.call(cmd, args, { role: 'cli', agentRefusal: 'not from an agent session' })).toMatchObject({
        status: 403,
        body: { error: 'not from an agent session' },
        marks: { effects: 0 }
      })
    }
    // Reads are an agent shell's to make; anyone but the app and the CLI is refused even those
    expect((await h.call('extensions-plugin-list', {}, { role: 'cli', agentRefusal: 'no' })).status).toBe(200)
    expect((await h.call('extensions-plugin-discover', {}, { role: 'cli', agentRefusal: 'no' })).status).toBe(200)
    expect((await h.call('extensions-plugin-list', {}, { role: 'mcp' })).status).toBe(403)
    expect(h.fake.calls).toEqual([])
    expect((await readClaudePlugins(h.profileDir)).plugins).toEqual([sharedEntry(h.pluginHome, 'review')])
    expect(await h.jobs()).toEqual([])
  })

  it('a long plugin job does not block an MCP change', async () => {
    const h = await pluginRig()
    await holding(h.account.configDir, { 'review@market': { version: '1.0.0' } })
    await writeExtensionRegistry(h.profileDir, { version: 1, entries: [LINEAR] })
    const add = deferred()
    h.script['plugin marketplace add acme/market'] = async () => {
      await add.p
      return { code: 1, json: { outcome: 'failed', message: 'the marketplace could not be reached' } }
    }
    const shared = await h.call('extensions-plugin-share', { id: 'review@market' })
    expect(shared.status).toBe(200)
    await vi.waitFor(() => expect(h.fake.calls).toEqual(['plugin marketplace add acme/market']))

    expect((await h.call('extensions-remove', { id: 'mcp-linear' })).status).toBe(200)
    expect((await readExtensionRegistry(h.profileDir)).entries).toEqual([])
    expect(await h.jobs()).toEqual([expect.objectContaining({ id: (shared.body as { jobId: string }).jobId, state: 'running' })])

    add.release()
    await vi.waitFor(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ state: 'failed', message: 'the marketplace could not be reached' })]))
  })

  it('update and remove answer a job id at once, and set-enabled switches the entry', async () => {
    const h = await pluginRig()
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    h.script['plugin update review@market --accept-command sha-shown'] = () => ({ code: 1, json: { outcome: 'failed', message: 'offline' } })
    h.script['plugin uninstall review@market'] = () => ({ code: 0, json: { outcome: 'ok' } })

    expect(await h.call('extensions-plugin-set-enabled', { id: 'review@market', enabled: false })).toMatchObject({ status: 200, marks: { effects: 1 } })
    expect((await readClaudePlugins(h.profileDir)).plugins[0].enabled).toBe(false)
    const updated = await h.call('extensions-plugin-update', { id: 'review@market', acceptCommand: 'sha-shown' })
    const removed = await h.call('extensions-plugin-remove', { id: 'review@market' })
    expect(updated).toMatchObject({ status: 200, body: { jobId: expect.any(String) }, marks: { effects: 1 } })
    expect(removed).toMatchObject({ status: 200, body: { jobId: expect.any(String) }, marks: { effects: 1 } })
    await vi.waitFor(async () =>
      expect((await h.jobs()).map((j) => [j.kind, j.state, j.message])).toEqual([
        ['update', 'failed', 'offline'],
        ['remove', 'done', undefined]
      ])
    )
    expect((await readClaudePlugins(h.profileDir)).plugins).toEqual([])
    expect(h.fake.calls).toEqual(['plugin update review@market --accept-command sha-shown', 'plugin uninstall review@market'])
  })

  it('answers 400 for bad arguments, 404 for an id not shared and 409 for a damaged store, writing nothing', async () => {
    const h = await pluginRig()
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    expect((await h.call('extensions-plugin-share', {})).status).toBe(400)
    expect((await h.call('extensions-plugin-update', { id: 'review@market', acceptCommand: 7 })).status).toBe(400)
    expect((await h.call('extensions-plugin-set-enabled', { id: 'review@market' })).status).toBe(400)
    for (const cmd of ['extensions-plugin-update', 'extensions-plugin-remove', 'extensions-plugin-set-enabled'])
      expect((await h.call(cmd, { id: 'nope@market', enabled: true })).status).toBe(404)
    const file = extensionPaths(h.profileDir).claudePlugins
    await fs.writeFile(file, '{ damaged')
    expect((await h.call('extensions-plugin-list')).status).toBe(409)
    expect((await h.call('extensions-plugin-discover')).status).toBe(409)
    // A read keeps no copy of the damage: that is the Host's own reading's to keep
    expect((await fs.readdir(path.dirname(file))).filter((f) => f.endsWith('.bak'))).toEqual([])
    expect(h.fake.calls).toEqual([])
  })

  it('the check runs at start and then on the timer', async () => {
    const h = await pluginRig()
    const review = sharedEntry(h.pluginHome, 'review')
    await fs.mkdir(review.installPath, { recursive: true })
    await h.seed([review])
    // The start sweeps first: the orphaned version is gone before the check's first command
    const orphan = await orphanedVersion(h.pluginHome)
    const orphanAtCheck: boolean[] = []
    h.script['plugin marketplace update market'] = async () => {
      orphanAtCheck.push(await exists(orphan))
      return okOutcome
    }
    let period = 0
    let tick: (() => void) | null = null
    const stop = h.ext.keepCheckingClaudePlugins({
      every: (ms, fn) => {
        period = ms
        tick = fn
        return () => (tick = null)
      }
    })
    expect(period).toBe(DAY_MS)
    await vi.waitFor(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ kind: 'check', state: 'done' })]))
    expect(orphanAtCheck).toEqual([false])
    expect((await readClaudePlugins(h.profileDir)).lastCheck).toEqual({ at: expect.any(String) })

    tick!()
    await vi.waitFor(async () => expect((await h.jobs()).map((j) => [j.kind, j.state])).toEqual([['check', 'done'], ['check', 'done']]))
    expect(h.fake.calls).toEqual(['plugin marketplace update market', 'plugin marketplace update market'])
    stop()
    expect(tick).toBeNull()
  })

  it('the daily check starts nothing while nothing is shared', async () => {
    const h = await pluginRig()
    const orphan = await orphanedVersion(h.pluginHome)
    const stop = h.ext.keepCheckingClaudePlugins({ every: () => () => {} })
    // The sweep still runs: the last plugin removed leaves its folder for it
    await vi.waitFor(async () => expect(await exists(orphan)).toBe(false))
    await new Promise((r) => setTimeout(r, 100))
    expect(h.fake.calls).toEqual([])
    expect(await h.jobs()).toEqual([])
    expect(await exists(extensionPaths(h.profileDir).claudePlugins)).toBe(false)
    stop()
  })
})
