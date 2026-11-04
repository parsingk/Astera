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
import { sweepOrphanedClaudePlugins, type ClaudePluginJob } from '../../core/extensions/claudePlugins/operations'
import type { MarketplaceSource, SharedClaudePlugin } from '../../core/extensions/claudePlugins/types'
import type { CodexPluginCliRun } from '../../core/extensions/codexPlugins/cli'
import type { CodexHooksList } from '../../core/extensions/codexPlugins/hooks'
import { syncCodexPlugins } from '../../core/extensions/codexPlugins/sync'
import { writeCodexPluginAccounts, type CodexPluginAccountState } from '../../core/extensions/codexPlugins/state'
import type { McpExtension } from '../../core/extensions/types'
import { createHostExtensions } from './commands'
import type { Account } from '../../core/types'

// The real sweep, which a test can make fail once: the start-up step the plugin jobs wait for
vi.mock('../../core/extensions/claudePlugins/operations', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/extensions/claudePlugins/operations')>()
  return { ...real, sweepOrphanedClaudePlugins: vi.fn(real.sweepOrphanedClaudePlugins) }
})

// The Codex sync, counted: what it does is the sync's own tests'; here it is when the Host asks for it. It answers no rows
// unless a test says otherwise.
vi.mock('../../core/extensions/codexPlugins/sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/extensions/codexPlugins/sync')>()
  return { ...real, syncCodexPlugins: vi.fn(async () => []) }
})

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
const OTHER: MarketplaceSource = { source: 'github', repo: 'acme/other' }
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
/** A plugin job ends after real file work (the sweep, discovery, store writes), which a loaded machine can stretch well
 *  past vi.waitFor's one-second default. */
const waitLong = <T>(f: () => T | Promise<T>): Promise<T> => vi.waitFor(f, { timeout: 10_000, interval: 20 })

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
async function holding(
  configDir: string,
  plugins: Record<string, { version: string; manifest?: object }>,
  enabled: Record<string, boolean> = {},
  source: MarketplaceSource = SOURCE
): Promise<void> {
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
    JSON.stringify({ market: { source, installLocation: path.join(configDir, 'plugins', 'marketplaces', 'market') } })
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

/** `codex`: the Host is given the three things that make it sync Codex accounts, a runner and a hooks list that are never
 *  called (the sync is mocked), and the accounts whose Codex session is alive (`live`, read at each sync). `second`: the
 *  Host reads a second Claude account too. */
async function pluginRig(o: { codex?: boolean; second?: boolean } = {}) {
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
  const logs: string[] = []
  const second: Account = { ...account, id: 'acc_2', label: 'b', configDir: path.join(home, '.claude-b') }
  if (o.second) await fs.mkdir(second.configDir, { recursive: true })
  const accounts = o.second ? [account, second] : [account]
  const codexRun: CodexPluginCliRun = async () => ({ code: 0, json: null, stdout: '', stderr: '', timedOut: false })
  const codexHooks: CodexHooksList = async () => []
  const live = new Set<string>()
  const syncs = vi.mocked(syncCodexPlugins)
  syncs.mockReset()
  const syncCount = (): number => syncs.mock.calls.length
  const deps = { profileDir, homeDir: home, readAccounts: async () => accounts, log: (l: string) => logs.push(l), gateway, claudePluginRun: fake.run }
  const codexDeps = { codexPluginRun: codexRun, codexHooks, liveAccountIds: async () => new Set(live) }
  const ext = createHostExtensions({ ...deps, ...(o.codex ? codexDeps : {}) })
  const call = (cmd: string, args: Record<string, unknown> = {}, extra: { role?: 'app' | 'cli' | 'mcp'; agentRefusal?: string } = {}) => {
    const marks = { effects: 0 }
    return ext.command({ cmd, args, role: extra.role ?? 'app', ...(extra.agentRefusal ? { agentRefusal: extra.agentRefusal } : {}), marks }).then((r) => ({ ...r, marks }))
  }
  const seed = (plugins: SharedClaudePlugin[]) => updateClaudePlugins(profileDir, (s) => ({ ...s, plugins }))
  const listed = async () =>
    (await call('extensions-plugin-list')).body as {
      plugins: (SharedClaudePlugin & { missing: boolean; requiredBy: string[] })[]
      jobs: ClaudePluginJob[]
      codexAccounts: CodexPluginAccountState[]
    }
  const jobs = async () => (await listed()).jobs
  return { profileDir, homeDir: home, account, second, pluginHome, script, fake, gateway, ext, call, seed, listed, jobs, logs, deps, codexDeps, codexRun, codexHooks, live, syncs, syncCount }
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
    await waitLong(() => expect(h.fake.calls).toEqual(['plugin marketplace update market']))
    await waitLong(() => expect(h.gateway.stopServer).toHaveBeenCalled())

    const listed = await h.call('extensions-plugin-list')
    expect(listed).toMatchObject({ status: 200, marks: { effects: 0 } })
    expect(listed.body).toEqual({
      plugins: [
        {
          ...review,
          missing: false,
          accountCopies: [{ accountId: 'acc_1', version: '0.9.0', enabled: true }],
          requiredBy: [],
          contents: { skills: [], commands: [], agents: [], mcpServers: [], hooks: false }
        }
      ],
      jobs: [expect.objectContaining({ id: (checked.body as { jobId: string }).jobId, kind: 'check', state: 'running' })],
      codexAccounts: []
    })
    expect(h.gateway.sync).not.toHaveBeenCalled()

    check.release()
    stop.release()
    expect((await removing).status).toBe(200)
    await waitLong(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ state: 'done' })]))
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

  // §5.9: the row lists what the plugin brings, read from its folder; a folder that is gone brings nothing
  it('list says what each plugin brings', async () => {
    const h = await pluginRig()
    const review = sharedEntry(h.pluginHome, 'review')
    await write(path.join(review.installPath, 'skills', 'review', 'SKILL.md'), '# review')
    await write(path.join(review.installPath, 'commands', 'ship.md'), 'x')
    await write(path.join(review.installPath, 'agents', 'critic.md'), 'x')
    await write(path.join(review.installPath, '.mcp.json'), JSON.stringify({ mcpServers: { linear: { command: 'npx' } } }))
    await write(path.join(review.installPath, 'hooks', 'hooks.json'), '{}')
    await h.seed([review, sharedEntry(h.pluginHome, 'gone')])
    expect((await h.listed()).plugins.map((p) => [p.id, (p as { contents?: unknown }).contents])).toEqual([
      ['review@market', { skills: ['review'], commands: ['ship'], agents: ['critic'], mcpServers: ['linear'], hooks: true }],
      ['gone@market', { skills: [], commands: [], agents: [], mcpServers: [], hooks: false }]
    ])
  })

  // §5.3: the register dialog says what a share would install, as the source account's marketplace clone offers it
  it('plugin-discover answers the version the source account’s marketplace offers', async () => {
    const h = await pluginRig()
    await holding(h.account.configDir, { 'review@market': { version: '1.0.0' }, 'lint@market': { version: '2.0.0' } })
    await write(
      path.join(h.account.configDir, 'plugins', 'marketplaces', 'market', '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'market', plugins: [{ name: 'review', source: { source: 'github', repo: 'acme/review' }, version: '1.2.0' }] })
    )
    expect((await h.call('extensions-plugin-discover')).body).toEqual({
      plugins: [
        expect.objectContaining({ id: 'review@market', offeredVersion: '1.2.0' }),
        // Not in the catalog: nothing to say
        expect.objectContaining({ id: 'lint@market', offeredVersion: null })
      ],
      unreadable: []
    })
    expect(h.fake.calls).toEqual([])
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
    await waitLong(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ id: jobId, state: 'done' })]))
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
    await waitLong(() => expect(h.fake.calls).toEqual(['plugin marketplace add acme/market']))

    expect((await h.call('extensions-remove', { id: 'mcp-linear' })).status).toBe(200)
    expect((await readExtensionRegistry(h.profileDir)).entries).toEqual([])
    expect(await h.jobs()).toEqual([expect.objectContaining({ id: (shared.body as { jobId: string }).jobId, state: 'running' })])

    add.release()
    await waitLong(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ state: 'failed', message: 'the marketplace could not be reached' })]))
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
    await waitLong(async () =>
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
    await waitLong(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ kind: 'check', state: 'done' })]))
    expect(orphanAtCheck).toEqual([false])
    expect((await readClaudePlugins(h.profileDir)).lastCheck).toEqual({ at: expect.any(String) })

    tick!()
    await waitLong(async () => expect((await h.jobs()).map((j) => [j.kind, j.state])).toEqual([['check', 'done'], ['check', 'done']]))
    expect(h.fake.calls).toEqual(['plugin marketplace update market', 'plugin marketplace update market'])
    stop()
    expect(tick).toBeNull()
  })

  it('the daily check starts nothing while nothing is shared', async () => {
    const h = await pluginRig()
    const orphan = await orphanedVersion(h.pluginHome)
    const stop = h.ext.keepCheckingClaudePlugins({ every: () => () => {} })
    // The sweep still runs: the last plugin removed leaves its folder for it
    await waitLong(async () => expect(await exists(orphan)).toBe(false))
    await new Promise((r) => setTimeout(r, 100))
    expect(h.fake.calls).toEqual([])
    expect(await h.jobs()).toEqual([])
    expect(await exists(extensionPaths(h.profileDir).claudePlugins)).toBe(false)
    stop()
  })

  // The jobs wait for the start's sweep; one that failed is tried again by the next caller rather than kept as the answer
  it('a failing start-up step does not leave plugin commands broken forever', async () => {
    const h = await pluginRig()
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    h.script['plugin marketplace update market'] = () => okOutcome
    const sweep = vi.mocked(sweepOrphanedClaudePlugins)
    sweep.mockClear()
    sweep.mockRejectedValueOnce(new Error('the plugin folder could not be read')).mockRejectedValueOnce(new Error('the plugin folder could not be read'))

    const unhandled = await unhandledDuring(async () => {
      // A share refused before it waits for the step: the step's failure is still handled, and tried again next time
      expect(await h.call('extensions-plugin-share', { id: 'nope@market' })).toMatchObject({ status: 400, body: { reason: 'not-offered' } })

      const failed = await h.call('extensions-plugin-check')
      expect(failed).toMatchObject({ status: 500, marks: { effects: 0 } })
      expect((failed.body as { error: string }).error).toContain('the plugin folder could not be read')
      expect(h.fake.calls).toEqual([])

      const checked = await h.call('extensions-plugin-check')
      expect(checked).toMatchObject({ status: 200, body: { jobId: expect.any(String) }, marks: { effects: 1 } })
      await waitLong(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ kind: 'check', state: 'done' })]))
    })
    expect(sweep).toHaveBeenCalledTimes(3)
    expect(unhandled).toEqual([])
  })

  it('the check tick logs a failure instead of rejecting', async () => {
    const h = await pluginRig()
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    h.script['plugin marketplace update market'] = () => okOutcome
    vi.mocked(sweepOrphanedClaudePlugins).mockRejectedValueOnce(new Error('the plugin folder could not be read'))
    let tick: (() => void) | null = null
    const unhandled = await unhandledDuring(async () => {
      const stop = h.ext.keepCheckingClaudePlugins({
        every: (_ms, fn) => {
          tick = fn
          return () => (tick = null)
        }
      })
      await waitLong(() => expect(h.logs.join('\n')).toContain('the plugin folder could not be read'))
      expect(h.fake.calls).toEqual([])
      // The next tick tries the start-up step again, and checks
      tick!()
      await waitLong(async () => expect(await h.jobs()).toEqual([expect.objectContaining({ kind: 'check', state: 'done' })]))
      expect(h.fake.calls).toEqual(['plugin marketplace update market'])
      stop()
    })
    expect(unhandled).toEqual([])
  })
})

// Codex plugin sharing design §5.3: after every plugin change the Host brings the Codex accounts in line, on the plugin jobs'
// queue so it never runs beside a share, update, remove or the start-up sweep. The sync itself is mocked and counted: what
// matters here is when the Host asks for it, and what it hands over.
const quiet = (): Promise<void> => new Promise((r) => setTimeout(r, 100))
const CODEX_ROW: CodexPluginAccountState = { accountId: 'acc_c', installed: { review: '1.0.0' }, waiting: false, turnedOff: [], at: EARLIER }

/** What `claude plugin` answers for the share of review@market that `holding` made discoverable. */
function scriptShare(h: { pluginHome: string; script: Script }): void {
  const rows: object[] = []
  h.script['plugin marketplace add acme/market'] = async () => {
    await addMarketplace(h.pluginHome)
    return okOutcome
  }
  h.script['plugin list'] = () => ({ code: 0, json: [...rows] })
  h.script['plugin install review@market'] = async () => {
    const installPath = path.join(h.pluginHome, 'plugins', 'cache', 'market', 'review', '1.0.0')
    await write(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'review', version: '1.0.0' }))
    rows.push({ id: 'review@market', version: '1.0.0', scope: 'user', enabled: true, installPath })
    return okOutcome
  }
}

describe('createHostExtensions, Codex accounts', () => {
  it('a share that ends done runs one Codex sync', async () => {
    const h = await pluginRig({ codex: true })
    await holding(h.account.configDir, { 'review@market': { version: '1.0.0' } })
    scriptShare(h)
    expect((await h.call('extensions-plugin-share', { id: 'review@market' })).status).toBe(200)
    await waitLong(() => expect(h.syncCount()).toBe(1))
    await quiet()
    expect(h.syncCount()).toBe(1)
    expect((await h.jobs()).map((j) => [j.kind, j.state])).toEqual([['share', 'done']])
  })

  it('an update that ends done runs one Codex sync', async () => {
    const h = await pluginRig({ codex: true })
    const review = sharedEntry(h.pluginHome, 'review')
    await fs.mkdir(review.installPath, { recursive: true })
    await h.seed([review])
    h.script['plugin update review@market'] = () => okOutcome
    h.script['plugin list'] = () => ({ code: 0, json: [{ id: review.id, version: '1.0.0', scope: 'user', installPath: review.installPath }] })
    expect((await h.call('extensions-plugin-update', { id: review.id })).status).toBe(200)
    await waitLong(() => expect(h.syncCount()).toBe(1))
    await quiet()
    expect(h.syncCount()).toBe(1)
    expect((await h.jobs()).map((j) => [j.kind, j.state])).toEqual([['update', 'done']])
  })

  it('a remove that ends done runs one Codex sync', async () => {
    const h = await pluginRig({ codex: true })
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    h.script['plugin uninstall review@market'] = () => okOutcome
    expect((await h.call('extensions-plugin-remove', { id: 'review@market' })).status).toBe(200)
    await waitLong(() => expect(h.syncCount()).toBe(1))
    await quiet()
    expect(h.syncCount()).toBe(1)
    expect((await h.jobs()).map((j) => [j.kind, j.state])).toEqual([['remove', 'done']])
  })

  // The store entry is dropped before the uninstall can fail, so the Codex accounts still hold what is no longer shared
  it('a remove whose uninstall fails runs one Codex sync', async () => {
    const h = await pluginRig({ codex: true })
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    h.script['plugin uninstall review@market'] = () => ({ code: 1, json: { outcome: 'failed', message: 'offline' } })
    expect((await h.call('extensions-plugin-remove', { id: 'review@market' })).status).toBe(200)
    await waitLong(() => expect(h.syncCount()).toBe(1))
    await quiet()
    expect(h.syncCount()).toBe(1)
    expect((await h.jobs()).map((j) => [j.kind, j.state])).toEqual([['remove', 'failed']])
    expect((await readClaudePlugins(h.profileDir)).plugins).toEqual([])
  })

  it('a failed share and a share asking for confirmation each run one Codex sync', async () => {
    const h = await pluginRig({ codex: true })
    await holding(h.account.configDir, { 'lint@market': { version: '1.0.0' } })
    h.script['plugin marketplace add acme/market'] = () => ({ code: 1, json: { outcome: 'failed', message: 'the marketplace could not be reached' } })
    await h.call('extensions-plugin-share', { id: 'lint@market' })
    await waitLong(() => expect(h.syncCount()).toBe(1))
    await quiet()
    expect(h.syncCount()).toBe(1)

    h.script['plugin marketplace add acme/market'] = async () => {
      await addMarketplace(h.pluginHome)
      return okOutcome
    }
    h.script['plugin list'] = () => ({ code: 0, json: [] })
    h.script['plugin install lint@market'] = () => ({ code: 1, json: { outcome: 'failed', message: 'review it', shownCommand: { command: 'node x', sha256: 'abc' } } })
    await h.call('extensions-plugin-share', { id: 'lint@market' })
    await waitLong(() => expect(h.syncCount()).toBe(2))
    await quiet()
    expect(h.syncCount()).toBe(2)
    expect((await h.jobs()).map((j) => [j.kind, j.state])).toEqual([['share', 'failed'], ['share', 'needs-confirmation']])
  })

  it('a failed update runs one Codex sync, and a check runs none', async () => {
    const h = await pluginRig({ codex: true })
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    h.script['plugin marketplace update market'] = () => okOutcome
    h.script['plugin update review@market'] = () => ({ code: 1, json: { outcome: 'failed', message: 'offline' } })
    await h.call('extensions-plugin-check')
    await waitLong(async () => expect((await h.jobs()).map((j) => [j.kind, j.state])).toEqual([['check', 'done']]))
    await quiet()
    expect(h.syncCount()).toBe(0)

    await h.call('extensions-plugin-update', { id: 'review@market' })
    await waitLong(() => expect(h.syncCount()).toBe(1))
    await quiet()
    expect(h.syncCount()).toBe(1)
    expect((await h.jobs()).map((j) => [j.kind, j.state])).toEqual([['check', 'done'], ['update', 'failed']])
  })

  it('set-enabled runs one Codex sync once the store is written, and extensions-sync runs one', async () => {
    const h = await pluginRig({ codex: true })
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    const enabledAtSync: boolean[] = []
    h.syncs.mockImplementation(async () => {
      enabledAtSync.push((await readClaudePlugins(h.profileDir)).plugins[0].enabled)
      return []
    })
    expect(await h.call('extensions-plugin-set-enabled', { id: 'review@market', enabled: false })).toMatchObject({ status: 200 })
    await waitLong(() => expect(h.syncCount()).toBe(1))
    expect(enabledAtSync).toEqual([false])

    expect((await h.call('extensions-sync')).status).toBe(200)
    await waitLong(() => expect(h.syncCount()).toBe(2))
    await quiet()
    expect(h.syncCount()).toBe(2)

    // An id that is not shared changes nothing, so asks for nothing
    expect((await h.call('extensions-plugin-set-enabled', { id: 'nope@market', enabled: true })).status).toBe(404)
    await quiet()
    expect(h.syncCount()).toBe(2)
  })

  it('extensions-sync runs one Codex sync even when its own copies could not be synced', async () => {
    const h = await pluginRig()
    // The copies' sync reads the accounts first and fails; the Codex sync that follows reads them again and goes through
    let reads = 0
    const ext = createHostExtensions({
      ...h.deps,
      readAccounts: async () => {
        if (reads++ === 0) throw new Error('accounts.json could not be read')
        return [h.account]
      },
      ...h.codexDeps
    })
    const answered = await ext.command({ cmd: 'extensions-sync', args: {}, role: 'app', marks: { effects: 0 } })
    expect(answered.status).toBe(500)
    await waitLong(() => expect(h.syncCount()).toBe(1))
    await quiet()
    expect(h.syncCount()).toBe(1)
  })

  it('hands the sync the profile, the accounts, the runners and the accounts with a live Codex session, and its log', async () => {
    const h = await pluginRig({ codex: true })
    h.live.add('acc_c')
    h.syncs.mockImplementation(async (a) => {
      a.log('codex plugins: a line from the sync')
      return []
    })
    await h.call('extensions-sync')
    await waitLong(() => expect(h.syncCount()).toBe(1))
    expect(h.syncs.mock.calls[0][0]).toEqual({
      profileDir: h.profileDir,
      homeDir: h.homeDir,
      accounts: [h.account],
      run: h.codexRun,
      hooks: h.codexHooks,
      liveAccountIds: new Set(['acc_c']),
      log: expect.any(Function)
    })
    await waitLong(() => expect(h.logs).toContain('codex plugins: a line from the sync'))

    // The live accounts are asked at each sync, not once
    h.live.clear()
    await h.call('extensions-sync')
    await waitLong(() => expect(h.syncCount()).toBe(2))
    expect(h.syncs.mock.calls[1][0].liveAccountIds).toEqual(new Set())
  })

  it('counts no account as busy when the Host is given no way to ask', async () => {
    const h = await pluginRig()
    const { liveAccountIds: _none, ...without } = h.codexDeps
    const ext = createHostExtensions({ ...h.deps, ...without })
    await ext.command({ cmd: 'extensions-sync', args: {}, role: 'app', marks: { effects: 0 } })
    await waitLong(() => expect(h.syncCount()).toBe(1))
    expect(h.syncs.mock.calls[0][0].liveAccountIds).toEqual(new Set())
  })

  it('syncs nothing without a Codex runner, a hooks list or a Claude plugin runner', async () => {
    const h = await pluginRig()
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    h.script['plugin marketplace update market'] = () => okOutcome
    const { codexPluginRun: _run, ...noRun } = h.codexDeps
    const { codexHooks: _hooks, ...noHooks } = h.codexDeps
    const { claudePluginRun: _claude, ...noClaude } = h.deps
    const variants: [string, ReturnType<typeof createHostExtensions>, number[]][] = [
      ['neither', createHostExtensions(h.deps), [DAY_MS]],
      ['no runner', createHostExtensions({ ...h.deps, ...noRun }), [DAY_MS]],
      ['no hooks list', createHostExtensions({ ...h.deps, ...noHooks }), [DAY_MS]],
      ['no Claude runner', createHostExtensions({ ...noClaude, ...h.codexDeps }), []]
    ]
    for (const [name, ext, expectedPeriods] of variants) {
      const call = (cmd: string, args: Record<string, unknown> = {}) => ext.command({ cmd, args, role: 'app', marks: { effects: 0 } })
      expect(await call('extensions-sync'), name).toMatchObject({ status: 200 })
      await call('extensions-plugin-set-enabled', { id: 'review@market', enabled: true })
      const periods: number[] = []
      const stop = ext.keepCheckingClaudePlugins({
        every: (ms) => {
          periods.push(ms)
          return () => {}
        }
      })
      expect(periods, name).toEqual(expectedPeriods)
      stop()
    }
    // The three that start checks each ran theirs
    await waitLong(() => expect(h.fake.calls).toEqual(Array<string>(3).fill('plugin marketplace update market')))
    await quiet()
    expect(h.syncCount()).toBe(0)
  })

  it('requests made while a sync waits run one sync, and one made while it runs queues exactly one more', async () => {
    const h = await pluginRig({ codex: true })
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    // The queue is held by a check, so each request below finds the sync waiting and not yet started
    const check = deferred()
    h.script['plugin marketplace update market'] = async () => {
      await check.p
      return okOutcome
    }
    expect((await h.call('extensions-plugin-check')).status).toBe(200)
    await waitLong(() => expect(h.fake.calls).toEqual(['plugin marketplace update market']))
    const request = (on: boolean) => h.call('extensions-plugin-set-enabled', { id: 'review@market', enabled: on })
    await request(false)
    await request(true)
    await request(false)
    await quiet()
    expect(h.syncCount()).toBe(0)

    const running = deferred()
    h.syncs.mockImplementation(async () => {
      await running.p
      return []
    })
    check.release()
    await waitLong(() => expect(h.syncCount()).toBe(1))
    // Held now that it runs: two more requests make one more sync
    await request(true)
    await request(false)
    await quiet()
    expect(h.syncCount()).toBe(1)
    running.release()
    await waitLong(() => expect(h.syncCount()).toBe(2))
    await quiet()
    expect(h.syncCount()).toBe(2)
  })

  it('a sync waits for the start-up sweep and never runs beside it', async () => {
    const h = await pluginRig({ codex: true })
    const sweep = deferred()
    vi.mocked(sweepOrphanedClaudePlugins).mockImplementationOnce(async () => {
      await sweep.p
      return []
    })
    // The answer does not wait for the sync
    expect((await h.call('extensions-sync')).status).toBe(200)
    await quiet()
    expect(h.syncCount()).toBe(0)
    sweep.release()
    await waitLong(() => expect(h.syncCount()).toBe(1))
  })

  it('a start-up that failed is logged, not thrown, and the next request tries it again', async () => {
    const h = await pluginRig({ codex: true })
    vi.mocked(sweepOrphanedClaudePlugins).mockRejectedValueOnce(new Error('the plugin folder could not be read'))
    const unhandled = await unhandledDuring(async () => {
      expect((await h.call('extensions-sync')).status).toBe(200)
      await waitLong(() => expect(h.logs.join('\n')).toContain('the plugin folder could not be read'))
      expect(h.syncCount()).toBe(0)
      expect((await h.call('extensions-sync')).status).toBe(200)
      await waitLong(() => expect(h.syncCount()).toBe(1))
    })
    expect(unhandled).toEqual([])
  })

  it('accounts or live sessions that cannot be read are logged, not thrown, and the next request syncs', async () => {
    const h = await pluginRig()
    await h.seed([sharedEntry(h.pluginHome, 'review')])
    let accountsError: Error | null = new Error('accounts.json could not be read')
    let liveError: Error | null = null
    const ext = createHostExtensions({
      ...h.deps,
      readAccounts: async () => {
        if (accountsError) throw accountsError
        return [h.account]
      },
      ...h.codexDeps,
      liveAccountIds: async () => {
        if (liveError) throw liveError
        return new Set<string>()
      }
    })
    const enable = () => ext.command({ cmd: 'extensions-plugin-set-enabled', args: { id: 'review@market', enabled: true }, role: 'app', marks: { effects: 0 } })
    const unhandled = await unhandledDuring(async () => {
      expect(await enable()).toMatchObject({ status: 200 })
      await waitLong(() => expect(h.logs.join('\n')).toContain('accounts.json could not be read'))
      accountsError = null
      liveError = new Error('sessions could not be listed')
      await enable()
      await waitLong(() => expect(h.logs.join('\n')).toContain('sessions could not be listed'))
      expect(h.syncCount()).toBe(0)
      liveError = null
      await enable()
      await waitLong(() => expect(h.syncCount()).toBe(1))
    })
    expect(unhandled).toEqual([])
  })

  it('the start runs one Codex sync, after the sweep', async () => {
    const h = await pluginRig({ codex: true })
    const orphan = await orphanedVersion(h.pluginHome)
    const orphanAtSync: boolean[] = []
    h.syncs.mockImplementation(async () => {
      orphanAtSync.push(await exists(orphan))
      return []
    })
    const periods: number[] = []
    const stop = h.ext.keepCheckingClaudePlugins({
      every: (ms) => {
        periods.push(ms)
        return () => {}
      }
    })
    expect(periods).toEqual([DAY_MS, 60_000])
    await waitLong(() => expect(h.syncCount()).toBe(1))
    await quiet()
    expect(h.syncCount()).toBe(1)
    expect(orphanAtSync).toEqual([false])
    stop()
  })

  it('every minute it asks for a sync only for a waiting account none of whose sessions is alive, and the stop stops both timers', async () => {
    const h = await pluginRig({ codex: true })
    const ticks = new Map<number, () => void>()
    const stopped: number[] = []
    const stop = h.ext.keepCheckingClaudePlugins({
      every: (ms, fn) => {
        ticks.set(ms, fn)
        return () => {
          stopped.push(ms)
        }
      }
    })
    await waitLong(() => expect(h.syncCount()).toBe(1))
    const minute = ticks.get(60_000)!
    const tick = async (): Promise<void> => {
      minute()
      await quiet()
    }

    await tick()
    expect(h.syncCount()).toBe(1)
    await writeCodexPluginAccounts(h.profileDir, [CODEX_ROW])
    await tick()
    expect(h.syncCount()).toBe(1)

    // A waiting account whose sessions are still alive would only be left waiting again: nothing is asked
    await writeCodexPluginAccounts(h.profileDir, [CODEX_ROW, { ...CODEX_ROW, accountId: 'acc_d', waiting: true }])
    h.live.add('acc_d')
    await tick()
    expect(h.syncCount()).toBe(1)
    await tick()
    expect(h.syncCount()).toBe(1)

    // Its sessions ended: one sync
    h.live.delete('acc_d')
    await tick()
    expect(h.syncCount()).toBe(2)

    // One waiting account that is free is enough, whatever the others are doing
    h.live.add('acc_c')
    await writeCodexPluginAccounts(h.profileDir, [{ ...CODEX_ROW, waiting: true }, { ...CODEX_ROW, accountId: 'acc_d', waiting: true }])
    await tick()
    expect(h.syncCount()).toBe(3)
    h.live.clear()

    // A file that cannot be read says nothing about waiting: logged, no sync
    const file = extensionPaths(h.profileDir).codexPluginAccounts
    await fs.rm(file)
    await fs.mkdir(file)
    await tick()
    expect(h.syncCount()).toBe(3)
    await waitLong(() => expect(h.logs.join('\n')).toContain('codex plugins: the outcome file could not be read'))

    stop()
    expect(stopped.sort((a, b) => a - b)).toEqual([60_000, DAY_MS])
  })

  it('a minute tick that cannot ask which accounts are busy logs it and syncs nothing', async () => {
    const h = await pluginRig()
    let liveError: Error | null = null
    const ext = createHostExtensions({
      ...h.deps,
      ...h.codexDeps,
      liveAccountIds: async () => {
        if (liveError) throw liveError
        return new Set<string>()
      }
    })
    const ticks = new Map<number, () => void>()
    const stop = ext.keepCheckingClaudePlugins({
      every: (ms, fn) => {
        ticks.set(ms, fn)
        return () => {}
      }
    })
    await waitLong(() => expect(h.syncCount()).toBe(1))
    await writeCodexPluginAccounts(h.profileDir, [{ ...CODEX_ROW, waiting: true }])
    liveError = new Error('sessions could not be listed')
    const unhandled = await unhandledDuring(async () => {
      ticks.get(60_000)!()
      await waitLong(() => expect(h.logs.join('\n')).toContain('the check for an account left waiting did not run (sessions could not be listed)'))
      await quiet()
    })
    expect(unhandled).toEqual([])
    expect(h.syncCount()).toBe(1)
    stop()
  })

  it('the list carries the outcome rows, and none with a log line when the file cannot be read', async () => {
    const h = await pluginRig()
    expect((await h.listed()).codexAccounts).toEqual([])
    await writeCodexPluginAccounts(h.profileDir, [CODEX_ROW])
    expect((await h.listed()).codexAccounts).toEqual([CODEX_ROW])
    const file = extensionPaths(h.profileDir).codexPluginAccounts
    await fs.rm(file)
    await fs.mkdir(file)
    expect((await h.listed()).codexAccounts).toEqual([])
    await waitLong(() => expect(h.logs.join('\n')).toContain('codex plugins: the outcome file could not be read'))
  })

  it('plugin-discover with an accountId reads that account only, and an unknown one answers 404', async () => {
    const h = await pluginRig({ second: true })
    await holding(h.account.configDir, { 'review@market': { version: '1.0.0' } })
    await holding(h.second.configDir, { 'review@market': { version: '1.1.0' }, 'lint@market': { version: '2.0.0' } }, {}, OTHER)
    await write(
      path.join(h.second.configDir, 'plugins', 'marketplaces', 'market', '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ name: 'market', plugins: [{ name: 'review', source: { source: 'github', repo: 'acme/review' }, version: '1.2.0' }] })
    )
    const discover = async (args: Record<string, unknown>) =>
      ((await h.call('extensions-plugin-discover', args)).body as { plugins: { id: string; holders: { accountId: string }[]; sourceAccountId: string; source: unknown; offeredVersion: string | null }[] }).plugins
    const shape = (plugins: Awaited<ReturnType<typeof discover>>) => plugins.map((p) => [p.id, p.holders.map((x) => x.accountId), p.sourceAccountId, p.source])

    expect(shape(await discover({}))).toEqual([['review@market', ['acc_1', 'acc_2'], 'acc_1', SOURCE], ['lint@market', ['acc_2'], 'acc_2', OTHER]])
    expect(shape(await discover({ accountId: 'acc_1' }))).toEqual([['review@market', ['acc_1'], 'acc_1', SOURCE]])
    const second = await discover({ accountId: 'acc_2' })
    expect(shape(second)).toEqual([['review@market', ['acc_2'], 'acc_2', OTHER], ['lint@market', ['acc_2'], 'acc_2', OTHER]])
    // The version a share would install comes from that account's clone
    expect(second.map((p) => p.offeredVersion)).toEqual(['1.2.0', null])

    expect(await h.call('extensions-plugin-discover', { accountId: 'acc_9' })).toMatchObject({ status: 404, body: { error: 'no account acc_9' } })
    expect((await h.call('extensions-plugin-discover', { accountId: 7 })).status).toBe(400)
  })

  it('plugin-share with an accountId finds the plugin and its source in that account only', async () => {
    const h = await pluginRig({ second: true })
    await holding(h.account.configDir, { 'review@market': { version: '1.0.0' } })
    await holding(h.second.configDir, { 'review@market': { version: '1.0.0' } }, {}, OTHER)
    h.script['plugin marketplace add acme/other'] = () => ({ code: 1, json: { outcome: 'failed', message: 'the second account was used' } })
    h.script['plugin marketplace add acme/market'] = () => ({ code: 1, json: { outcome: 'failed', message: 'the first account was used' } })

    expect(await h.call('extensions-plugin-share', { id: 'review@market', accountId: 'acc_2' })).toMatchObject({ status: 200, marks: { effects: 1 } })
    await waitLong(async () => expect((await h.jobs()).map((j) => j.message)).toEqual(['the second account was used']))
    // As today without it: the first account that has a record of the marketplace
    expect((await h.call('extensions-plugin-share', { id: 'review@market' })).status).toBe(200)
    await waitLong(async () => expect((await h.jobs()).map((j) => j.message)).toEqual(['the second account was used', 'the first account was used']))
    expect(h.fake.calls).toEqual(['plugin marketplace add acme/other', 'plugin marketplace add acme/market'])

    expect(await h.call('extensions-plugin-share', { id: 'review@market', accountId: 'acc_9' })).toMatchObject({ status: 404, body: { error: 'no account acc_9' }, marks: { effects: 0 } })
    // An account that does not hold it does not offer it
    await holding(h.second.configDir, { 'lint@market': { version: '1.0.0' } }, {}, OTHER)
    expect(await h.call('extensions-plugin-share', { id: 'review@market', accountId: 'acc_2' })).toMatchObject({ status: 400, body: { reason: 'not-offered' } })
    expect((await h.call('extensions-plugin-share', { id: 'review@market', accountId: 7 })).status).toBe(400)
  })
})

/** The rejections nobody handled while `f` ran. */
async function unhandledDuring(f: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = []
  const on = (e: unknown): void => {
    seen.push(e)
  }
  process.on('unhandledRejection', on)
  try {
    await f()
  } finally {
    process.off('unhandledRejection', on)
  }
  return seen
}
