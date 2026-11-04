// The one sync the Host runs for Codex (Codex plugin sharing design §5.1, §5.3, §5.10): the desired list built from the
// store, the Codex copies and the marketplace written before any account is touched, every Codex account brought in
// line one after the other, the outcome kept, and the copies no account uses swept. No test runs a real codex: a fake
// keeps each account's installed plugins where codex keeps them (config.toml tables and the account's plugin cache) and
// answers `plugin list` (only what the marketplace file lists, C27), `plugin marketplace add`, `plugin add` and `plugin
// remove` from them, reading the marketplace file and the copy it names the way Codex would, so reconcile runs for real
// against temp account folders and temp Claude copies, and every call is recorded.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { patchTomlFile, readTomlObject } from '../../providers/configWrite'
import { extensionPaths } from '../../profile/paths'
import { hasKeptCopy } from '../../storeFile'
import type { Account } from '../../types'
import type { PluginCliResult } from '../claudePlugins/cli'
import { updateClaudePlugins } from '../claudePlugins/store'
import type { SharedClaudePlugin } from '../claudePlugins/types'
import type { CodexPluginCliRun } from './cli'
import { codexCopyFolder } from './copy'
import type { CodexHooksList } from './hooks'
import { readCodexPluginAccounts, writeCodexPluginAccounts, type CodexPluginAccountState } from './state'
import { sweepCodexCopies, syncCodexPlugins } from './sync'

// Every file lock the sync takes, with the folder and the limits it was given
const locks = vi.hoisted(() => ({ taken: [] as { dir: string; opts: unknown }[] }))
vi.mock('../../fileLock', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../fileLock')>()
  return {
    ...real,
    withFileLock: (...args: Parameters<typeof real.withFileLock>) => {
      locks.taken.push({ dir: args[0], opts: args[2] })
      return real.withFileLock(...args)
    }
  }
})

// Every rename the code under test asks for, and the one folder whose rename is made to fail as a busy folder does on Windows
const renames = vi.hoisted(() => ({ seen: [] as { from: string; to: string }[], busy: null as string | null }))
vi.mock('../../renameRetry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../renameRetry')>()
  return {
    ...real,
    renameRetrying: (from: string, to: string) => {
      renames.seen.push({ from, to })
      if (from === renames.busy) return Promise.reject(Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' }))
      return real.renameRetrying(from, to)
    }
  }
})

const M = 'astera-shared'
const NOW = new Date('2026-11-04T01:02:03.000Z')
const AT = NOW.toISOString()

const dirs: string[] = []
let unscripted: string[] = []
beforeEach(() => {
  locks.taken = []
  renames.seen = []
  renames.busy = null
  unscripted = []
})
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
  expect(unscripted, 'codex commands the fake does not know').toEqual([])
})

const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, 'utf8')) as T
interface Marketplace {
  plugins: { name: string; source: { path: string } }[]
}
const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)

interface World {
  base: string
  /** The profile folder; its name holds a space and Korean, and still gives the marketplace `astera-shared`. */
  profile: string
  home: string
  /** The folder every Codex account adds as a marketplace. */
  root: string
  accounts: Account[]
}

async function world(): Promise<World> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codexsync-'))
  dirs.push(base)
  const profile = path.join(base, '에이 스테라', 'astera')
  const home = path.join(base, 'home')
  await fs.mkdir(profile, { recursive: true })
  await fs.mkdir(home, { recursive: true })
  return { base, profile, home, root: extensionPaths(profile).codexPluginHome, accounts: [] }
}

async function addAccount(w: World, id: string, o: { provider?: 'claude' | 'codex'; ambient?: boolean } = {}): Promise<Account> {
  const provider = o.provider ?? 'codex'
  const configDir = o.ambient ? path.join(w.home, '.codex') : path.join(w.home, provider === 'codex' ? '.codex-accounts' : '.claude-accounts', id)
  await fs.mkdir(configDir, { recursive: true })
  const account: Account = { id, label: id, configDir, color: '#888888', createdAt: '2026-11-01T00:00:00.000Z', provider }
  w.accounts.push(account)
  return account
}

/** What `codex` is given as CODEX_HOME for the account: the ambient `~/.codex` is none. */
const homeOf = (w: World, account: Account): string | null => (account.configDir === path.join(w.home, '.codex') ? null : account.configDir)

interface DepSpec {
  name: string
  version: string
  /** The Claude copy's folder is not there. */
  gone?: boolean
}
interface Spec {
  name: string
  version: string
  market?: string
  enabled?: boolean
  deps?: DepSpec[]
  gone?: boolean
  /** Extra files of the Claude copy. */
  files?: Record<string, string>
}

const claudeCopyOf = (w: World, name: string, version: string, market = 'market'): string =>
  path.join(w.base, 'claude-home', 'plugins', 'cache', market, name, version)

/** Makes the Claude copies and writes the store, the way the Host's share leaves them. */
async function share(w: World, specs: Spec[]): Promise<void> {
  const plugins: SharedClaudePlugin[] = []
  for (const s of specs) {
    const market = s.market ?? 'market'
    const installPath = claudeCopyOf(w, s.name, s.version, market)
    if (s.gone !== true) {
      await write(path.join(installPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: s.name }))
      for (const [rel, text] of Object.entries(s.files ?? {})) await write(path.join(installPath, rel), text)
    }
    const dependencies = []
    for (const d of s.deps ?? []) {
      const depPath = claudeCopyOf(w, d.name, d.version)
      if (d.gone !== true) await write(path.join(depPath, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: d.name }))
      dependencies.push({ id: `${d.name}@market`, version: d.version, installPath: depPath })
    }
    plugins.push({
      id: `${s.name}@${market}`,
      name: s.name,
      marketplace: market,
      source: { source: 'github', repo: 'acme/market' },
      version: s.version,
      installPath,
      dependencies,
      importedFrom: 'acc_claude',
      enabled: s.enabled ?? true,
      addedAt: '2026-11-02T00:00:00.000Z',
      lastUpdated: '2026-11-02T00:00:00.000Z',
      fingerprint: 'sha256:aa'
    })
  }
  await updateClaudePlugins(w.profile, (s) => ({ ...s, plugins }))
}

const ok = (json: Record<string, unknown>): PluginCliResult => ({ code: 0, json, stdout: `${JSON.stringify(json)}\n`, stderr: '', timedOut: false })
const exited = (code: number, stderr: string): PluginCliResult => ({ code, json: null, stdout: '', stderr, timedOut: false })

interface Call {
  codexHome: string | null
  line: string
}

/** What the marketplace and the copies hold at the moment an account adds the marketplace. */
interface AtAdd {
  codexHome: string | null
  marketplace: string[] | null
  copies: string[]
}

type Tables = Record<string, unknown>
const tableIn = (current: Tables, key: string): Tables => {
  const t = current[key]
  return typeof t === 'object' && t !== null ? { ...(t as Tables) } : {}
}

/** A `codex` for every account, keeping what it installs the way codex does (C3, C27, C28): an account has a plugin of
 *  this profile when its config.toml has the `[plugins."<name>@astera-shared"]` table and its cache folder
 *  `plugins/cache/astera-shared/<name>/<version>` is there. `plugin list` reports only the ones the marketplace file lists
 *  (C27), each with the flag config.toml gives it. `plugin marketplace add`, `plugin add`, `plugin remove` (which works on
 *  a plugin the list does not report, C28) and `plugin marketplace remove` change the tables and the cache as codex does.
 *  `fail` answers a command in place of the fake, and `own` gives the rows of plugins an account has from other
 *  marketplaces, listed after this profile's with the flag config.toml gives them. */
function fakeCodex(
  w: World,
  o: { fail?: (codexHome: string | null, line: string) => PluginCliResult | undefined; own?: (codexHome: string | null) => Record<string, unknown>[] } = {}
): { run: CodexPluginCliRun; calls: Call[]; atAdd: AtAdd[]; seed: (account: Account, name: string, version: string) => Promise<void>; of: (account: Account) => Call[] } {
  const calls: Call[] = []
  const atAdd: AtAdd[] = []
  const marketplaceFile = path.join(w.root, '.agents', 'plugins', 'marketplace.json')
  const dirOf = (codexHome: string | null): string => codexHome ?? path.join(w.home, '.codex')
  const configOf = (codexHome: string | null): string => path.join(dirOf(codexHome), 'config.toml')
  const cacheOf = (codexHome: string | null, name: string): string => path.join(dirOf(codexHome), 'plugins', 'cache', M, name)
  const tablesOf = async (codexHome: string | null): Promise<Tables> => readTomlObject(await fs.readFile(configOf(codexHome), 'utf8').catch(() => ''))
  /** Sets or, with undefined, removes `[<key>."<id>"]`; a table left empty goes. */
  const setTable = (codexHome: string | null, key: string, id: string, value: Tables | undefined): Promise<unknown> =>
    patchTomlFile(configOf(codexHome), (current) => {
      const t = tableIn(current, key)
      if (value === undefined) delete t[id]
      else t[id] = value
      const next = { ...current, [key]: t }
      if (Object.keys(t).length === 0) delete next[key]
      return next
    })
  const install = async (codexHome: string | null, name: string, version: string): Promise<void> => {
    await fs.rm(cacheOf(codexHome, name), { recursive: true, force: true })
    await fs.mkdir(path.join(cacheOf(codexHome, name), version), { recursive: true })
    await setTable(codexHome, 'plugins', `${name}@${M}`, { enabled: true })
  }
  const addMarketplace = async (codexHome: string | null): Promise<void> => {
    if (tableIn(await tablesOf(codexHome), 'marketplaces')[M] === undefined) await setTable(codexHome, 'marketplaces', M, { source_type: 'local', source: w.root })
  }
  const flagOf = (plugins: Tables, id: string): boolean => (plugins[id] as { enabled?: unknown } | undefined)?.enabled !== false

  const run: CodexPluginCliRun = async (codexHome, args) => {
    const line = args.join(' ')
    calls.push({ codexHome, line })
    const failed = o.fail?.(codexHome, line)
    if (failed !== undefined) return failed
    if (line === 'plugin list') {
      const listedNames = (await exists(marketplaceFile)) ? (await readJson<Marketplace>(marketplaceFile)).plugins.map((p) => p.name) : []
      const plugins = tableIn(await tablesOf(codexHome), 'plugins')
      const rows: Record<string, unknown>[] = []
      for (const id of Object.keys(plugins)) {
        if (!id.endsWith(`@${M}`)) continue
        const name = id.slice(0, -(M.length + 1))
        const [version] = await fs.readdir(cacheOf(codexHome, name)).catch(() => [] as string[])
        if (version === undefined || !listedNames.includes(name)) continue
        rows.push({ pluginId: id, name, marketplaceName: M, version, installed: true, enabled: flagOf(plugins, id), marketplaceSource: { sourceType: 'local', source: w.root } })
      }
      const own = (o.own?.(codexHome) ?? []).map((r) => ({ ...r, enabled: flagOf(plugins, r.pluginId as string) }))
      return ok({ installed: [...rows, ...own], available: [] })
    }
    if (line === `plugin marketplace remove ${M}`) {
      await setTable(codexHome, 'marketplaces', M, undefined)
      return ok({ marketplaceName: M })
    }
    if (line === `plugin marketplace add ${w.root}`) {
      const market = (await exists(marketplaceFile)) ? (await readJson<Marketplace>(marketplaceFile)).plugins.map((p) => p.name) : null
      const copies: string[] = []
      for (const name of await fs.readdir(path.join(w.root, 'plugins')).catch(() => [] as string[])) {
        for (const version of await fs.readdir(path.join(w.root, 'plugins', name)).catch(() => [] as string[])) copies.push(`${name}/${version}`)
      }
      atAdd.push({ codexHome, marketplace: market, copies: copies.sort() })
      await addMarketplace(codexHome)
      return ok({ marketplaceName: M, installedRoot: w.root, alreadyAdded: true })
    }
    const add = /^plugin add (.+)@astera-shared$/.exec(line)
    if (add !== null) {
      const name = add[1]
      const entry = (await readJson<Marketplace>(marketplaceFile)).plugins.find((p) => p.name === name)
      if (entry === undefined) return exited(1, `plugin ${name} is not in the marketplace`)
      const manifest = await readJson<{ version: string }>(path.join(w.root, entry.source.path, '.claude-plugin', 'plugin.json'))
      await install(codexHome, name, manifest.version)
      return ok({ pluginId: `${name}@${M}`, name, marketplaceName: M, version: manifest.version, installedPath: `/cache/${M}/${name}/${manifest.version}`, authPolicy: 'ON_INSTALL' })
    }
    const remove = /^plugin remove (.+)@astera-shared$/.exec(line)
    if (remove !== null) {
      await fs.rm(cacheOf(codexHome, remove[1]), { recursive: true, force: true })
      await setTable(codexHome, 'plugins', `${remove[1]}@${M}`, undefined)
      return ok({ pluginId: `${remove[1]}@${M}` })
    }
    unscripted.push(line)
    throw new Error(`unknown: codex ${line}`)
  }
  return {
    run,
    calls,
    atAdd,
    // As an earlier sync's add would leave it: the marketplace added, the plugin's table and its cache folder
    seed: async (account, name, version) => {
      await addMarketplace(homeOf(w, account))
      await install(homeOf(w, account), name, version)
    },
    of: (account) => calls.filter((c) => c.codexHome === homeOf(w, account))
  }
}

/** The hooks Codex lists: none, and every ask recorded. */
function noHooks(): { list: CodexHooksList; calls: { codexHome: string | null; cwd: string }[] } {
  const calls: { codexHome: string | null; cwd: string }[] = []
  return {
    list: async (codexHome, cwd) => {
      calls.push({ codexHome, cwd })
      return []
    },
    calls
  }
}

function sync(
  w: World,
  cli: { run: CodexPluginCliRun },
  o: { live?: string[]; logs?: string[]; hooks?: { list: CodexHooksList } } = {}
): Promise<CodexPluginAccountState[]> {
  return syncCodexPlugins({
    profileDir: w.profile,
    homeDir: w.home,
    accounts: w.accounts,
    run: cli.run,
    hooks: (o.hooks ?? noHooks()).list,
    liveAccountIds: new Set(o.live ?? []),
    log: (line) => (o.logs ?? []).push(line),
    now: () => NOW
  })
}

const row = (accountId: string, o: Partial<CodexPluginAccountState> = {}): CodexPluginAccountState => ({
  accountId,
  installed: {},
  waiting: false,
  turnedOff: [],
  at: '2026-11-03T00:00:00.000Z',
  ...o
})

const outcomeFile = (w: World): string => extensionPaths(w.profile).codexPluginAccounts
const marketplaceOf = async (w: World): Promise<{ name: string; path: string }[]> =>
  (await readJson<Marketplace>(path.join(w.root, '.agents', 'plugins', 'marketplace.json'))).plugins.map((p) => ({ name: p.name, path: p.source.path }))
const pluginsOf = async (account: Account): Promise<Record<string, { enabled?: boolean }>> =>
  readTomlObject(await fs.readFile(path.join(account.configDir, 'config.toml'), 'utf8')).plugins as Record<string, { enabled?: boolean }>

describe('syncCodexPlugins', () => {
  it('nothing shared and no rows runs nothing', async () => {
    const w = await world()
    await addAccount(w, 'acc_codex')
    const cli = fakeCodex(w)
    const hooks = noHooks()
    const logs: string[] = []

    expect(await sync(w, cli, { hooks, logs })).toEqual([])

    expect(cli.calls).toEqual([])
    expect(hooks.calls).toEqual([])
    expect(logs).toEqual([])
    // No `codex-plugins` folder, no outcome file, not even a folder to hold them
    expect(await fs.readdir(w.profile)).toEqual([])
  })

  it('an empty store and no rows runs nothing either', async () => {
    const w = await world()
    await addAccount(w, 'acc_codex')
    await share(w, [])
    const cli = fakeCodex(w)

    expect(await sync(w, cli)).toEqual([])

    expect(cli.calls).toEqual([])
    expect(await exists(w.root)).toBe(false)
    expect(await exists(outcomeFile(w))).toBe(false)
  })

  it('wants each store entry, then each dependency by its id name, on when any plugin that is on records it', async () => {
    const w = await world()
    const codex = await addAccount(w, 'acc_codex')
    await share(w, [
      { name: 'p', version: '1.0.0', deps: [{ name: 'base', version: '2.0.0' }, { name: 'shared-dep', version: '3.0.0' }] },
      { name: 'q', version: '1.1.0', enabled: false, deps: [{ name: 'shared-dep', version: '3.0.0' }, { name: 'only-q', version: '0.5.0' }] }
    ])
    const cli = fakeCodex(w)

    const rows = await sync(w, cli)

    expect(await marketplaceOf(w)).toEqual([
      { name: 'p', path: './plugins/p/1.0.0' },
      { name: 'q', path: './plugins/q/1.1.0' },
      { name: 'base', path: './plugins/base/2.0.0' },
      { name: 'shared-dep', path: './plugins/shared-dep/3.0.0' },
      { name: 'only-q', path: './plugins/only-q/0.5.0' }
    ])
    expect(cli.calls.filter((c) => c.line.startsWith('plugin add ')).map((c) => c.line)).toEqual(
      ['p', 'q', 'base', 'shared-dep', 'only-q'].map((n) => `plugin add ${n}@${M}`)
    )
    expect(rows).toEqual([
      { accountId: 'acc_codex', installed: { p: '1.0.0', q: '1.1.0', base: '2.0.0', 'shared-dep': '3.0.0', 'only-q': '0.5.0' }, waiting: false, turnedOff: [], at: AT }
    ])
    // Off for the plugin that is off and the dependency only it needs; the shared dependency stays on
    expect(await pluginsOf(codex)).toEqual({
      [`p@${M}`]: { enabled: true },
      [`q@${M}`]: { enabled: false },
      [`base@${M}`]: { enabled: true },
      [`shared-dep@${M}`]: { enabled: true },
      [`only-q@${M}`]: { enabled: false }
    })
  })

  it('one entry per name: a store entry beats a dependency, and an earlier one beats a later one', async () => {
    const w = await world()
    await addAccount(w, 'acc_codex')
    await share(w, [
      { name: 'p', version: '1.0.0', deps: [{ name: 'q', version: '9.0.0' }, { name: 'd', version: '1.0.0' }] },
      { name: 'q', version: '2.0.0', deps: [{ name: 'd', version: '1.5.0' }] },
      { name: 's', version: '1.0.0' },
      { name: 's', version: '2.0.0', market: 'other' }
    ])
    const cli = fakeCodex(w)
    const logs: string[] = []

    const rows = await sync(w, cli, { logs })

    expect(await marketplaceOf(w)).toEqual([
      { name: 'p', path: './plugins/p/1.0.0' },
      { name: 'q', path: './plugins/q/2.0.0' },
      { name: 's', path: './plugins/s/1.0.0' },
      { name: 'd', path: './plugins/d/1.0.0' }
    ])
    expect(rows[0].installed).toEqual({ p: '1.0.0', q: '2.0.0', s: '1.0.0', d: '1.0.0' })
    expect(logs).toEqual([expect.stringContaining('s@other'), expect.stringContaining('q@market'), expect.stringContaining('d@market')])
  })

  describe('a plugin that is a store entry and also a dependency of another entry', () => {
    // The plugins this account has turned off, whatever else its config.toml holds (no file when nothing was written)
    const disabledIn = async (account: Account): Promise<string[]> => {
      const text = await fs.readFile(path.join(account.configDir, 'config.toml'), 'utf8').catch(() => '')
      const plugins = (readTomlObject(text).plugins ?? {}) as Record<string, { enabled?: boolean }>
      return Object.entries(plugins).filter(([, v]) => v.enabled === false).map(([id]) => id).sort()
    }

    it('is on when a plugin that is on needs it, though it is off as an entry, and is not logged as left out', async () => {
      const w = await world()
      const codex = await addAccount(w, 'acc_codex')
      await share(w, [{ name: 'q', version: '1.0.0', enabled: false }, { name: 'p', version: '1.0.0', deps: [{ name: 'q', version: '1.0.0' }] }])
      const cli = fakeCodex(w)
      const logs: string[] = []
      // Codex lists q's hook, which is untrusted: it is trusted only when q is wanted on
      const qHook = `q@${M}:hooks/hooks.json:pre_tool_use:0:0`
      const hooks = { list: (async () => [{ key: qHook, pluginId: `q@${M}`, currentHash: 'sha256:q', trustStatus: 'untrusted' }]) as CodexHooksList }

      const rows = await sync(w, cli, { logs, hooks })

      expect(logs).toEqual([])
      expect(await marketplaceOf(w)).toEqual([
        { name: 'q', path: './plugins/q/1.0.0' },
        { name: 'p', path: './plugins/p/1.0.0' }
      ])
      expect(rows[0].installed).toEqual({ q: '1.0.0', p: '1.0.0' })
      expect(await disabledIn(codex)).toEqual([])
      const state = readTomlObject(await fs.readFile(path.join(codex.configDir, 'config.toml'), 'utf8')).hooks as { state: Record<string, { trusted_hash: string }> }
      expect(state.state[qHook].trusted_hash).toBe('sha256:q')
    })

    it('is on when it is on as an entry, and is not logged as left out', async () => {
      const w = await world()
      const codex = await addAccount(w, 'acc_codex')
      await share(w, [{ name: 'p', version: '1.0.0', deps: [{ name: 'q', version: '1.0.0' }] }, { name: 'q', version: '1.0.0' }])
      const cli = fakeCodex(w)
      const logs: string[] = []

      const rows = await sync(w, cli, { logs })

      expect(logs).toEqual([])
      expect(await marketplaceOf(w)).toEqual([
        { name: 'p', path: './plugins/p/1.0.0' },
        { name: 'q', path: './plugins/q/1.0.0' }
      ])
      expect(rows[0].installed).toEqual({ p: '1.0.0', q: '1.0.0' })
      expect(await disabledIn(codex)).toEqual([])
    })

    it('stays on when it is on as an entry and the plugin that needs it is off', async () => {
      const w = await world()
      const codex = await addAccount(w, 'acc_codex')
      await share(w, [{ name: 'q', version: '1.0.0' }, { name: 'p', version: '1.0.0', enabled: false, deps: [{ name: 'q', version: '1.0.0' }] }])
      const logs: string[] = []

      await sync(w, fakeCodex(w), { logs })

      expect(logs).toEqual([])
      expect(await disabledIn(codex)).toEqual([`p@${M}`])
    })

    it('is off when it is off as an entry and nothing that is on needs it', async () => {
      const w = await world()
      const codex = await addAccount(w, 'acc_codex')
      await share(w, [
        { name: 'q', version: '1.0.0', enabled: false },
        { name: 'p', version: '1.0.0', enabled: false, deps: [{ name: 'q', version: '1.0.0' }] }
      ])
      const logs: string[] = []

      await sync(w, fakeCodex(w), { logs })

      expect(logs).toEqual([])
      expect(await disabledIn(codex)).toEqual([`p@${M}`, `q@${M}`])
    })

    // `q` is off as an entry and carries `r`; `p` is on and records `q` only. What `q` carries is wanted once `q` is, in
    // whatever order the store lists them (the store's own lists are transitive, so this pins the rule, not the usual shape)
    const orders: [string, ('p' | 'q')[]][] = [
      ['q before p', ['q', 'p']],
      ['p before q', ['p', 'q']]
    ]
    it.each(orders)('settles which entries are on before it reads what they record: what an off entry carries is on once an on plugin needs it (%s)', async (_label, order) => {
      const w = await world()
      const codex = await addAccount(w, 'acc_codex')
      const specs: Record<'p' | 'q', Spec> = {
        q: { name: 'q', version: '1.0.0', enabled: false, deps: [{ name: 'r', version: '1.0.0' }] },
        p: { name: 'p', version: '1.0.0', deps: [{ name: 'q', version: '1.0.0' }] }
      }
      await share(w, order.map((n) => specs[n]))
      const cli = fakeCodex(w)
      const logs: string[] = []

      const rows = await sync(w, cli, { logs })

      expect(rows[0].installed).toEqual({ q: '1.0.0', p: '1.0.0', r: '1.0.0' })
      expect(await disabledIn(codex)).toEqual([])
      expect(logs).toEqual([])
    })

    it.each([
      ['s, q, p', ['s', 'q', 'p']],
      ['p, q, s', ['p', 'q', 's']]
    ] as [string, ('p' | 'q' | 's')[]][])('reaches through a chain of entries that each record the next (%s)', async (_label, order) => {
      const w = await world()
      const codex = await addAccount(w, 'acc_codex')
      const specs: Record<'p' | 'q' | 's', Spec> = {
        s: { name: 's', version: '1.0.0', enabled: false, deps: [{ name: 'r', version: '1.0.0' }] },
        q: { name: 'q', version: '1.0.0', enabled: false, deps: [{ name: 's', version: '1.0.0' }] },
        p: { name: 'p', version: '1.0.0', deps: [{ name: 'q', version: '1.0.0' }] }
      }
      await share(w, order.map((n) => specs[n]))

      const rows = await sync(w, fakeCodex(w))

      expect(rows[0].installed).toEqual({ p: '1.0.0', q: '1.0.0', s: '1.0.0', r: '1.0.0' })
      expect(await disabledIn(codex)).toEqual([])
    })

    it('is the entry as it stands when the dependency is another plugin of the same name and version, and that is logged', async () => {
      const w = await world()
      const codex = await addAccount(w, 'acc_codex')
      await share(w, [{ name: 'q', version: '1.0.0', market: 'other', enabled: false }, { name: 'p', version: '1.0.0', deps: [{ name: 'q', version: '1.0.0' }] }])
      const logs: string[] = []

      await sync(w, fakeCodex(w), { logs })

      // `q@other` and `q@market` are two plugins that claim one name (PF2): the entry wins, with its own flag
      expect(await disabledIn(codex)).toEqual([`q@${M}`])
      expect(logs).toEqual([expect.stringContaining('q@market')])
    })

    it('is the entry as it stands when another version of it is what the plugin records, and that is logged', async () => {
      const w = await world()
      const codex = await addAccount(w, 'acc_codex')
      await share(w, [{ name: 'q', version: '2.0.0', enabled: false }, { name: 'p', version: '1.0.0', deps: [{ name: 'q', version: '1.0.0' }] }])
      const cli = fakeCodex(w)
      const logs: string[] = []

      const rows = await sync(w, cli, { logs })

      // PF2: the entry wins, at its own version and its own flag, and the dependency left out is said once
      expect(await marketplaceOf(w)).toEqual([
        { name: 'q', path: './plugins/q/2.0.0' },
        { name: 'p', path: './plugins/p/1.0.0' }
      ])
      expect(rows[0].installed).toEqual({ q: '2.0.0', p: '1.0.0' })
      expect(await disabledIn(codex)).toEqual([`q@${M}`])
      expect(logs).toEqual([expect.stringContaining('q@market')])
    })
  })

  it('writes the copies and the marketplace before reconciling any account, and reconciles only Codex accounts, one by one', async () => {
    const w = await world()
    const a = await addAccount(w, 'acc_a')
    await addAccount(w, 'acc_claude', { provider: 'claude' })
    const b = await addAccount(w, 'acc_b', { ambient: true })
    await share(w, [{ name: 'p', version: '1.0.0', deps: [{ name: 'base', version: '2.0.0' }] }])
    const cli = fakeCodex(w)

    const rows = await sync(w, cli)

    // Every account's marketplace add found the marketplace file and both copies already there
    expect(cli.atAdd).toEqual([
      { codexHome: a.configDir, marketplace: ['p', 'base'], copies: ['base/2.0.0', 'p/1.0.0'] },
      { codexHome: null, marketplace: ['p', 'base'], copies: ['base/2.0.0', 'p/1.0.0'] }
    ])
    // The ambient account runs with no CODEX_HOME; the Claude account is never visited; one account is finished first
    expect(cli.calls.map((c) => c.codexHome)).not.toContain(w.accounts[1].configDir)
    const order = cli.calls.map((c) => c.codexHome).filter((h, i, all) => i === 0 || h !== all[i - 1])
    expect(order).toEqual([a.configDir, null])
    expect(cli.of(a).map((c) => c.line)).toEqual(['plugin list', `plugin marketplace add ${w.root}`, `plugin add p@${M}`, `plugin add base@${M}`, 'plugin list'])
    expect(cli.of(b).length).toBe(5)
    // The outcome file holds one row per Codex account, and the call answers the same rows
    const installed = { p: '1.0.0', base: '2.0.0' }
    const expected = [
      { accountId: 'acc_a', installed, waiting: false, turnedOff: [], at: AT },
      { accountId: 'acc_b', installed, waiting: false, turnedOff: [], at: AT }
    ]
    expect(rows).toEqual(expected)
    expect(await readJson<unknown>(outcomeFile(w))).toEqual({ version: 1, accounts: expected })
    expect(await readCodexPluginAccounts(w.profile)).toEqual(expected)
  })

  it('missing Claude copy skips that plugin', async () => {
    const w = await world()
    await addAccount(w, 'acc_codex')
    const lost = claudeCopyOf(w, 'p', '1.0.0')
    await share(w, [
      { name: 'p', version: '1.0.0', gone: true },
      { name: 'r', version: '1.0.0', deps: [{ name: 'base', version: '2.0.0' }, { name: 'lost', version: '1.0.0', gone: true }] }
    ])
    const cli = fakeCodex(w)
    const logs: string[] = []

    const rows = await sync(w, cli, { logs })

    expect(await marketplaceOf(w)).toEqual([
      { name: 'r', path: './plugins/r/1.0.0' },
      { name: 'base', path: './plugins/base/2.0.0' }
    ])
    expect(cli.calls.filter((c) => c.line.startsWith('plugin add ')).map((c) => c.line)).toEqual([`plugin add r@${M}`, `plugin add base@${M}`])
    expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.0'))).toBe(false)
    expect(await exists(codexCopyFolder(w.profile, 'lost', '1.0.0'))).toBe(false)
    expect(rows[0].installed).toEqual({ r: '1.0.0', base: '2.0.0' })
    expect(logs).toHaveLength(2)
    expect(logs[0]).toContain('p@market')
    expect(logs[0]).toContain(lost)
    expect(logs[1]).toContain('lost@market')
  })

  it('a plugin whose Claude copy is gone stays shared while its Codex copy is there, and keeps the version each account has when neither is', async () => {
    const w = await world()
    await addAccount(w, 'acc_codex')
    await share(w, [{ name: 'p', version: '1.0.0', deps: [{ name: 'base', version: '2.0.0' }] }])
    const cli = fakeCodex(w)
    await sync(w, cli)
    await fs.rm(claudeCopyOf(w, 'p', '1.0.0'), { recursive: true })
    await fs.rm(claudeCopyOf(w, 'base', '2.0.0'), { recursive: true })
    const logs: string[] = []

    const rows = await sync(w, cli, { logs })

    // Codex copies are never rewritten, so one that is there is complete: it is still listed, and nothing is removed
    expect(await marketplaceOf(w)).toEqual([
      { name: 'p', path: './plugins/p/1.0.0' },
      { name: 'base', path: './plugins/base/2.0.0' }
    ])
    expect(cli.calls.filter((c) => c.line.startsWith('plugin remove'))).toEqual([])
    expect(rows[0].installed).toEqual({ p: '1.0.0', base: '2.0.0' })
    expect(logs).toEqual([])

    // The version that has neither a Claude copy nor a Codex copy has nothing to install from, but p is still shared: it is
    // held at the version the account has (final review I2), and only the dependency the new version no longer records goes
    await share(w, [{ name: 'p', version: '1.0.1', gone: true }])
    const next = await sync(w, cli, { logs })

    expect(cli.calls.filter((c) => c.line.startsWith('plugin remove')).map((c) => c.line)).toEqual([`plugin remove base@${M}`])
    expect(next).toEqual([{ accountId: 'acc_codex', installed: { p: '1.0.0' }, held: ['p'], waiting: false, turnedOff: [], at: AT }])
    expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.0'))).toBe(true)
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('p@market')
  })

  it('an update whose new Codex copy cannot be made keeps the old version: nothing removed, its trust and old copy kept, and the row says it is held', async () => {
    const w = await world()
    const a = await addAccount(w, 'acc_a')
    await share(w, [{ name: 'p', version: '1.0.0' }])
    const KEY = `p@${M}:hooks/hooks.json:stop:0:0`
    const hooks = { list: (async () => [{ key: KEY, pluginId: `p@${M}`, currentHash: 'sha256:p', trustStatus: 'untrusted' }]) as CodexHooksList }
    const cli = fakeCodex(w)
    await sync(w, cli, { hooks })

    // The new version's .mcp.json cannot be read, so its Codex copy cannot be made
    await share(w, [{ name: 'p', version: '1.1.0', files: { '.mcp.json': '{ not json' } }])
    const logs: string[] = []
    const rows = await sync(w, cli, { hooks, logs })

    expect(cli.of(a).filter((c) => /^plugin (add|remove) /.test(c.line)).map((c) => c.line)).toEqual([`plugin add p@${M}`])
    const held = { accountId: 'acc_a', installed: { p: '1.0.0' }, held: ['p'], waiting: false, turnedOff: [], at: AT }
    expect(rows).toEqual([held])
    expect(await readCodexPluginAccounts(w.profile)).toEqual([held])
    expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.0'))).toBe(true)
    const state = readTomlObject(await fs.readFile(path.join(a.configDir, 'config.toml'), 'utf8')).hooks as { state: Record<string, { trusted_hash: string }> }
    expect(state.state[KEY]).toEqual({ trusted_hash: 'sha256:p' })
    expect(logs).toEqual([expect.stringContaining('p@market')])
  })

  // R1 (C27, C28): codex lists only what the marketplace file lists, and the sync writes that file without a plugin no
  // longer shared and without a held one, though both are still installed and still load
  describe('a plugin the marketplace file no longer lists', () => {
    it('a partial unshare removes it, drops its trust keys and turns the own copy back on', async () => {
      const w = await world()
      const a = await addAccount(w, 'acc_a')
      const OWN = 'p@claude-plugins-official'
      await write(path.join(a.configDir, 'config.toml'), `[plugins."${OWN}"]\nenabled = true\n`)
      const own = { pluginId: OWN, name: 'p', marketplaceName: 'claude-plugins-official', version: '2.0.0', installed: true, marketplaceSource: { sourceType: 'git', source: 'https://github.com/anthropics/claude-plugins-official.git' } }
      const KEY = `p@${M}:hooks/hooks.json:stop:0:0`
      const hooks = { list: (async () => [{ key: KEY, pluginId: `p@${M}`, currentHash: 'sha256:p', trustStatus: 'untrusted' }]) as CodexHooksList }
      const cli = fakeCodex(w, { own: (home) => (home === a.configDir ? [own] : []) })
      await share(w, [{ name: 'p', version: '1.0.0' }, { name: 'q', version: '1.0.0' }])
      await sync(w, cli, { hooks })
      const config = async (): Promise<Record<string, unknown>> => readTomlObject(await fs.readFile(path.join(a.configDir, 'config.toml'), 'utf8'))
      expect(((await config()).hooks as { state: Record<string, unknown> }).state[KEY]).toEqual({ trusted_hash: 'sha256:p' })
      expect((await pluginsOf(a))[OWN]).toEqual({ enabled: false })

      await share(w, [{ name: 'q', version: '1.0.0' }])
      const rows = await sync(w, cli, { hooks })

      expect(cli.of(a).filter((c) => c.line.startsWith('plugin remove')).map((c) => c.line)).toEqual([`plugin remove p@${M}`])
      expect(rows).toEqual([{ accountId: 'acc_a', installed: { q: '1.0.0' }, waiting: false, turnedOff: [], at: AT }])
      expect((await config()).hooks).toBeUndefined()
      expect(await pluginsOf(a)).toEqual({ [OWN]: { enabled: true }, [`q@${M}`]: { enabled: true } })
      expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.0'))).toBe(false)
    })

    it('a held plugin is recorded at its cache version, its flag follows the store, and the sweep keeps its copy', async () => {
      const w = await world()
      const a = await addAccount(w, 'acc_a')
      const cli = fakeCodex(w)
      await share(w, [{ name: 'p', version: '1.0.0' }])
      await sync(w, cli)

      // p's new version cannot be converted; q is new, so the marketplace file is written again, without p
      await share(w, [
        { name: 'p', version: '1.1.0', enabled: false, files: { '.mcp.json': '{ not json' } },
        { name: 'q', version: '1.0.0' }
      ])
      const rows = await sync(w, cli)

      expect(await marketplaceOf(w)).toEqual([{ name: 'q', path: './plugins/q/1.0.0' }])
      expect(cli.of(a).filter((c) => /^plugin (add|remove) p@/.test(c.line)).map((c) => c.line)).toEqual([`plugin add p@${M}`])
      expect(rows).toEqual([{ accountId: 'acc_a', installed: { p: '1.0.0', q: '1.0.0' }, held: ['p'], waiting: false, turnedOff: [], at: AT }])
      expect((await pluginsOf(a))[`p@${M}`]).toEqual({ enabled: false })
      expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.0'))).toBe(true)
    })
  })

  // Final review I3: which own plugins Astera turned off is its only record of them, so it is on disk before the write
  // that turns one off and after every account, not only once the whole sync is done
  it('records an own plugin before it is turned off and each account once done, so a sync cut off after it keeps the record', async () => {
    const w = await world()
    const a = await addAccount(w, 'acc_a')
    const b = await addAccount(w, 'acc_b')
    const OWN = 'p@claude-plugins-official'
    await write(path.join(a.configDir, 'config.toml'), `[plugins."${OWN}"]\nenabled = true\n`)
    await share(w, [{ name: 'p', version: '1.0.0' }])
    const bRow = row('acc_b', { installed: { p: '1.0.0' } })
    await writeCodexPluginAccounts(w.profile, [bRow])
    const own = {
      pluginId: OWN,
      name: 'p',
      marketplaceName: 'claude-plugins-official',
      version: '2.0.0',
      installed: true,
      enabled: true,
      marketplaceSource: { sourceType: 'git', source: 'https://github.com/anthropics/claude-plugins-official.git' }
    }
    const cli = fakeCodex(w, { own: (home) => (home === a.configDir ? [own] : []) })
    await cli.seed(b, 'p', '1.0.0')
    // Read while a's hooks are asked for (after its flags are written, before its pass ends), and when b's first command
    // runs, which is made to fail the way a Host that stops would leave it
    let whileA: CodexPluginAccountState[] | undefined
    let atB: CodexPluginAccountState[] | undefined
    const hooks = {
      list: (async (home) => {
        if (home === a.configDir) whileA ??= await readCodexPluginAccounts(w.profile)
        return []
      }) as CodexHooksList
    }
    const run: CodexPluginCliRun = async (home, args, o) => {
      if (home === b.configDir) {
        atB ??= await readCodexPluginAccounts(w.profile)
        throw new Error('the Host stopped')
      }
      return cli.run(home, args, o)
    }

    await sync(w, { run }, { hooks })

    const aRow = { accountId: 'acc_a', installed: { p: '1.0.0' }, waiting: false, turnedOff: [OWN], at: AT }
    expect(whileA).toEqual([aRow, bRow])
    expect(atB).toEqual([aRow, bRow])
    expect((await pluginsOf(a))[OWN]).toEqual({ enabled: false })
  })

  // Final review I4: a damaged outcome file is not a missing one, and an account whose row is gone can still hold what
  // this profile installed
  describe('a row that was lost', () => {
    const named = (w: World): string => `[plugins."p@${M}"]\nenabled = true\n\n[marketplaces.${M}]\nsource_type = "local"\nsource = '${w.root}'\n`

    it('a damaged outcome file is kept beside it, nothing is swept, and an account whose config.toml names the marketplace is still cleaned', async () => {
      const w = await world()
      const a = await addAccount(w, 'acc_a')
      const c = await addAccount(w, 'acc_c')
      await write(path.join(a.configDir, 'config.toml'), named(w))
      const copy = codexCopyFolder(w.profile, 'p', '1.0.0')
      await write(path.join(copy, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
      await write(outcomeFile(w), '{ damaged')
      const cli = fakeCodex(w)
      await cli.seed(a, 'p', '1.0.0')
      const logs: string[] = []

      const rows = await sync(w, cli, { logs })

      expect(cli.of(a).map((x) => x.line)).toEqual(['plugin list', `plugin remove p@${M}`, `plugin marketplace remove ${M}`])
      expect(cli.of(c)).toEqual([])
      expect(rows).toEqual([])
      expect(await hasKeptCopy(outcomeFile(w), '{ damaged')).toBe(true)
      // Another account could still have a version the lost rows named
      expect(await exists(copy)).toBe(true)
      expect(logs).toEqual([expect.stringContaining('damaged')])
    })

    it('an account with no row whose config.toml names the marketplace is visited though nothing is shared, and then swept', async () => {
      const w = await world()
      const a = await addAccount(w, 'acc_a')
      await write(path.join(a.configDir, 'config.toml'), named(w))
      const copy = codexCopyFolder(w.profile, 'p', '1.0.0')
      await write(path.join(copy, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
      const cli = fakeCodex(w)
      await cli.seed(a, 'p', '1.0.0')

      expect(await sync(w, cli)).toEqual([])

      expect(cli.of(a).map((x) => x.line)).toEqual(['plugin list', `plugin remove p@${M}`, `plugin marketplace remove ${M}`])
      expect(await exists(copy)).toBe(false)
    })
  })

  it('a plugin whose copy cannot be made is left out and logged, and the others install', async () => {
    const w = await world()
    await addAccount(w, 'acc_codex')
    await share(w, [
      { name: 'broken', version: '1.0.0', files: { '.mcp.json': '{ not json' } },
      { name: 'fine', version: '1.0.0' }
    ])
    const cli = fakeCodex(w)
    const logs: string[] = []

    const rows = await sync(w, cli, { logs })

    expect(await marketplaceOf(w)).toEqual([{ name: 'fine', path: './plugins/fine/1.0.0' }])
    expect(rows[0].installed).toEqual({ fine: '1.0.0' })
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('broken@market')
    expect(logs[0]).toContain('.mcp.json')
    // Nothing of the failed copy is left, not even the empty folder that would have held it
    expect(await fs.readdir(path.join(w.root, 'plugins'))).toEqual(['fine'])
  })

  it('never rewrites a Codex copy whose version folder is there, since servers run from it', async () => {
    const w = await world()
    await addAccount(w, 'acc_codex')
    await share(w, [{ name: 'p', version: '1.0.0' }, { name: 'q', version: '1.0.0' }])
    const kept = codexCopyFolder(w.profile, 'p', '1.0.0')
    await write(path.join(kept, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    await write(path.join(kept, 'marker.txt'), 'in use')
    const cli = fakeCodex(w)

    const rows = await sync(w, cli)

    expect(await fs.readFile(path.join(kept, 'marker.txt'), 'utf8')).toBe('in use')
    expect(await exists(path.join(codexCopyFolder(w.profile, 'q', '1.0.0'), '.claude-plugin', 'plugin.json'))).toBe(true)
    expect(rows[0].installed).toEqual({ p: '1.0.0', q: '1.0.0' })
  })

  it('a failing account does not stop the next one', async () => {
    const w = await world()
    const a = await addAccount(w, 'acc_a')
    const b = await addAccount(w, 'acc_b')
    await share(w, [{ name: 'p', version: '1.0.0' }])
    const cli = fakeCodex(w, { fail: (home, line) => (home === a.configDir && line === 'plugin list' ? exited(1, 'codex exploded') : undefined) })

    const rows = await sync(w, cli)

    expect(cli.of(a).map((c) => c.line)).toEqual(['plugin list'])
    expect(cli.of(b).map((c) => c.line)).toContain(`plugin add p@${M}`)
    expect(rows).toEqual([
      { accountId: 'acc_a', installed: {}, waiting: false, failure: { message: 'codex exploded' }, turnedOff: [], at: AT },
      { accountId: 'acc_b', installed: { p: '1.0.0' }, waiting: false, turnedOff: [], at: AT }
    ])
    expect(await readCodexPluginAccounts(w.profile)).toEqual(rows)
  })

  it('outcome rows of removed accounts are dropped', async () => {
    const w = await world()
    const a = await addAccount(w, 'acc_a')
    await addAccount(w, 'acc_claude', { provider: 'claude' })
    const gone = path.join(w.home, '.codex-accounts', 'acc_gone')
    await fs.mkdir(gone, { recursive: true })
    await share(w, [{ name: 'p', version: '1.0.0' }])
    await writeCodexPluginAccounts(w.profile, [
      row('acc_gone', { installed: { p: '1.0.0' } }),
      row('acc_claude', { installed: { p: '1.0.0' } }),
      row('acc_a', { installed: { p: '1.0.0' } })
    ])
    const cli = fakeCodex(w)
    await cli.seed(a, 'p', '1.0.0')

    const rows = await sync(w, cli)

    expect(rows.map((r) => r.accountId)).toEqual(['acc_a'])
    expect((await readCodexPluginAccounts(w.profile)).map((r) => r.accountId)).toEqual(['acc_a'])
    // Nothing ran against the folder of the account that is gone
    expect(cli.calls.some((c) => c.codexHome === gone)).toBe(false)
  })

  it('liveAccountIds holding an account makes its reconcile busy', async () => {
    const w = await world()
    const a = await addAccount(w, 'acc_a')
    const b = await addAccount(w, 'acc_b')
    await share(w, [{ name: 'p', version: '1.0.0' }])
    const cli = fakeCodex(w)

    const rows = await sync(w, cli, { live: ['acc_a'] })

    // A waits: it only looked, and its row says so; B was brought in line
    expect(cli.of(a).map((c) => c.line)).toEqual(['plugin list'])
    expect(cli.of(b).map((c) => c.line)).toContain(`plugin add p@${M}`)
    expect(rows).toEqual([
      { accountId: 'acc_a', installed: {}, waiting: true, turnedOff: [], at: AT },
      { accountId: 'acc_b', installed: { p: '1.0.0' }, waiting: false, turnedOff: [], at: AT }
    ])
  })

  it('takes the profile lock around config.toml writes, with the limits of the brief', async () => {
    const w = await world()
    await addAccount(w, 'acc_codex')
    await share(w, [{ name: 'p', version: '1.0.0', enabled: false }])
    const cli = fakeCodex(w)

    await sync(w, cli)

    // The plugin is off, so the account's config.toml is written: that write is under the lock
    expect(locks.taken.length).toBeGreaterThan(0)
    for (const l of locks.taken) {
      expect(l.dir).toBe(extensionPaths(w.profile).codexConfigLock)
      expect(l.opts).toEqual({ waitMs: 60_000, staleMs: 600_000 })
    }
  })

  describe('what is left of an unshare', () => {
    it('with nothing desired and rows left, reconciles with nothing desired and writes no copy and no marketplace', async () => {
      const w = await world()
      const a = await addAccount(w, 'acc_a')
      await share(w, [])
      await writeCodexPluginAccounts(w.profile, [row('acc_a', { installed: { p: '1.0.0' } })])
      const cli = fakeCodex(w)
      await cli.seed(a, 'p', '1.0.0')

      const rows = await sync(w, cli)

      expect(cli.of(a).map((c) => c.line)).toEqual(['plugin list', `plugin remove p@${M}`, `plugin marketplace remove ${M}`])
      expect(await exists(w.root)).toBe(false)
      // It is clean now, so the row goes, and with no row left the file goes
      expect(rows).toEqual([])
      expect(await exists(outcomeFile(w))).toBe(false)
    })

    it('keeps the row of an account that failed, drops the clean one', async () => {
      const w = await world()
      const a = await addAccount(w, 'acc_a')
      const b = await addAccount(w, 'acc_b')
      await writeCodexPluginAccounts(w.profile, [row('acc_a', { installed: { p: '1.0.0' } }), row('acc_b', { installed: { p: '1.0.0' } })])
      const cli = fakeCodex(w, { fail: (home, line) => (home === b.configDir && line === 'plugin list' ? exited(1, 'no network') : undefined) })
      await cli.seed(a, 'p', '1.0.0')

      const rows = await sync(w, cli)

      expect(rows).toEqual([{ accountId: 'acc_b', installed: { p: '1.0.0' }, waiting: false, failure: { message: 'no network' }, turnedOff: [], at: AT }])
      expect(await readCodexPluginAccounts(w.profile)).toEqual(rows)
    })

    it('makes no copy and no marketplace when no Codex account exists', async () => {
      const w = await world()
      await addAccount(w, 'acc_claude', { provider: 'claude' })
      await share(w, [{ name: 'p', version: '1.0.0' }])
      await writeCodexPluginAccounts(w.profile, [row('acc_gone', { installed: { p: '1.0.0' } })])
      const cli = fakeCodex(w)

      expect(await sync(w, cli)).toEqual([])

      expect(cli.calls).toEqual([])
      expect(await exists(w.root)).toBe(false)
      expect(await exists(outcomeFile(w))).toBe(false)
    })

    it('sweeps the copies after the accounts let go of them, and leaves the marketplace file', async () => {
      const w = await world()
      const a = await addAccount(w, 'acc_a')
      await share(w, [{ name: 'p', version: '1.0.0', deps: [{ name: 'base', version: '2.0.0' }] }])
      const cli = fakeCodex(w)
      await sync(w, cli)
      expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.0'))).toBe(true)

      await share(w, [])
      const rows = await sync(w, cli)

      expect(cli.of(a).filter((c) => c.line.startsWith('plugin remove')).map((c) => c.line)).toEqual([`plugin remove p@${M}`, `plugin remove base@${M}`])
      expect(rows).toEqual([])
      expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.0'))).toBe(false)
      expect(await exists(codexCopyFolder(w.profile, 'base', '2.0.0'))).toBe(false)
      expect(await exists(path.join(w.root, '.agents', 'plugins', 'marketplace.json'))).toBe(true)
    })
  })

  describe('after an update', () => {
    it('moves the account to the new version and sweeps the old copy', async () => {
      const w = await world()
      const a = await addAccount(w, 'acc_a')
      await share(w, [{ name: 'p', version: '1.0.0' }])
      const cli = fakeCodex(w)
      await sync(w, cli)

      await share(w, [{ name: 'p', version: '1.0.1' }])
      const rows = await sync(w, cli)

      expect(rows[0].installed).toEqual({ p: '1.0.1' })
      expect(cli.of(a).filter((c) => c.line === `plugin add p@${M}`)).toHaveLength(2)
      expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.0'))).toBe(false)
      expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.1'))).toBe(true)
    })

    it('keeps the old copy while an account that waits still has that version', async () => {
      const w = await world()
      await addAccount(w, 'acc_a')
      await share(w, [{ name: 'p', version: '1.0.0' }])
      const cli = fakeCodex(w)
      await sync(w, cli)

      await share(w, [{ name: 'p', version: '1.0.1' }])
      const rows = await sync(w, cli, { live: ['acc_a'] })

      expect(rows).toEqual([{ accountId: 'acc_a', installed: { p: '1.0.0' }, waiting: true, turnedOff: [], at: AT }])
      expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.0'))).toBe(true)
      expect(await exists(codexCopyFolder(w.profile, 'p', '1.0.1'))).toBe(true)
    })
  })

  describe('what it will not guess', () => {
    it('an outcome file that could not be read runs nothing, writes nothing, says so once and answers none', async () => {
      const w = await world()
      await addAccount(w, 'acc_codex')
      await share(w, [{ name: 'p', version: '1.0.0' }])
      await fs.mkdir(outcomeFile(w), { recursive: true }) // a folder where the file belongs: reading it is EISDIR
      const cli = fakeCodex(w)
      const logs: string[] = []

      expect(await sync(w, cli, { logs })).toEqual([])

      expect(cli.calls).toEqual([])
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('outcome')
      expect(await exists(w.root)).toBe(false)
      expect((await fs.lstat(outcomeFile(w))).isDirectory()).toBe(true)
    })

    it('a store that could not be read runs nothing, as it would not know what is shared, and answers the rows it had', async () => {
      const w = await world()
      await addAccount(w, 'acc_codex')
      const rows = [row('acc_codex', { installed: { p: '1.0.0' } })]
      await writeCodexPluginAccounts(w.profile, rows)
      await write(extensionPaths(w.profile).claudePlugins, '{ broken')
      const cli = fakeCodex(w)
      const logs: string[] = []

      expect(await sync(w, cli, { logs })).toEqual(rows)

      expect(cli.calls).toEqual([])
      expect(logs).toHaveLength(1)
      expect(await readCodexPluginAccounts(w.profile)).toEqual(rows)
      // Reading only asks: the damaged file is left to the Host's own reading to keep aside
      expect(await fs.readdir(path.dirname(extensionPaths(w.profile).claudePlugins))).toEqual(['claude-plugins.json'])
    })

    it('a marketplace file that cannot be written runs nothing and does not reject', async () => {
      const w = await world()
      await addAccount(w, 'acc_codex')
      await share(w, [{ name: 'p', version: '1.0.0' }])
      await fs.mkdir(path.join(w.root, '.agents', 'plugins', 'marketplace.json'), { recursive: true })
      const cli = fakeCodex(w)
      const logs: string[] = []

      expect(await sync(w, cli, { logs })).toEqual([])

      expect(cli.calls).toEqual([])
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('marketplace')
    })
  })
})

describe('sweepCodexCopies', () => {
  const folder = async (w: World, name: string, version: string): Promise<string> => {
    const dir = codexCopyFolder(w.profile, name, version)
    await write(path.join(dir, 'keep.txt'), 'x')
    return dir
  }

  it('deletes a version nothing uses any more', async () => {
    const w = await world()
    const old = await folder(w, 'p', '1.0.0')
    const current = await folder(w, 'p', '1.0.1')

    expect(await sweepCodexCopies(w.profile, [row('acc_a', { installed: { p: '1.0.1' } })], [{ name: 'p', version: '1.0.1' }])).toEqual([old])

    expect(await exists(old)).toBe(false)
    expect(await exists(current)).toBe(true)
  })

  it('keeps a version while any account has it, whatever else it records', async () => {
    const w = await world()
    const old = await folder(w, 'p', '1.0.0')
    await folder(w, 'p', '1.0.1')

    const outcome = [row('acc_a', { installed: { p: '1.0.1' } }), row('acc_b', { installed: { p: '1.0.0' }, waiting: true })]
    expect(await sweepCodexCopies(w.profile, outcome, [{ name: 'p', version: '1.0.1' }])).toEqual([])

    expect(await exists(old)).toBe(true)
  })

  it('keeps the current version of a plugin no account has yet', async () => {
    const w = await world()
    const current = await folder(w, 'p', '1.0.1')

    expect(await sweepCodexCopies(w.profile, [], [{ name: 'p', version: '1.0.1' }])).toEqual([])

    expect(await exists(current)).toBe(true)
  })

  it('finds a version by the folder name it is given', async () => {
    const w = await world()
    const dir = await folder(w, 'p', '1.0.0+build 5')
    expect(path.basename(dir)).toBe('1.0.0_build_5')

    expect(await sweepCodexCopies(w.profile, [], [{ name: 'p', version: '1.0.0+build 5' }])).toEqual([])

    expect(await exists(dir)).toBe(true)
  })

  it('removes the temporary folders a crashed copy left, and never the marketplace file', async () => {
    const w = await world()
    const crashed = path.join(w.root, 'plugins', 'p', `1.0.1.${process.pid}.tmp`)
    await write(path.join(crashed, 'half.txt'), 'x')
    const current = await folder(w, 'p', '1.0.1')
    const marketplace = path.join(w.root, '.agents', 'plugins', 'marketplace.json')
    await write(marketplace, '{}')

    expect(await sweepCodexCopies(w.profile, [], [{ name: 'p', version: '1.0.1' }])).toEqual([crashed])

    expect(await exists(crashed)).toBe(false)
    expect(await exists(current)).toBe(true)
    expect(await exists(marketplace)).toBe(true)
  })

  it('renames a version folder to a temporary sibling before it removes it', async () => {
    const w = await world()
    const old = await folder(w, 'p', '1.0.0')

    expect(await sweepCodexCopies(w.profile, [], [])).toEqual([old])

    expect(renames.seen).toHaveLength(1)
    expect(renames.seen[0].from).toBe(old)
    expect(path.dirname(renames.seen[0].to)).toBe(path.dirname(old))
    expect(path.basename(renames.seen[0].to)).toMatch(new RegExp(String.raw`^1\.0\.0\.${process.pid}\.\d+\.tmp$`))
    expect(await exists(renames.seen[0].to)).toBe(false)
  })

  it('leaves a version folder as it is when it cannot be renamed, and removes it at the next sweep', async () => {
    const w = await world()
    const old = await folder(w, 'p', '1.0.0')
    renames.busy = old

    expect(await sweepCodexCopies(w.profile, [], [])).toEqual([])

    // Not half removed, and nothing beside it
    expect(await fs.readFile(path.join(old, 'keep.txt'), 'utf8')).toBe('x')
    expect(await fs.readdir(path.dirname(old))).toEqual(['1.0.0'])

    renames.busy = null
    expect(await sweepCodexCopies(w.profile, [], [])).toEqual([old])
    expect(await exists(old)).toBe(false)
  })

  it('clears a folder an earlier sweep renamed but could not finish removing, without renaming it again', async () => {
    const w = await world()
    const half = path.join(w.root, 'plugins', 'p', `1.0.0.${process.pid}.7.tmp`)
    await write(path.join(half, 'left.txt'), 'x')

    expect(await sweepCodexCopies(w.profile, [], [])).toEqual([half])

    expect(await exists(half)).toBe(false)
    expect(renames.seen).toEqual([])
  })

  it('removes a plugin folder left empty, and keeps one that still holds a version', async () => {
    const w = await world()
    await folder(w, 'p', '1.0.0')
    await folder(w, 'q', '1.0.0')
    await folder(w, 'q', '1.0.1')
    const empty = path.join(w.root, 'plugins', 'broken')
    await fs.mkdir(empty, { recursive: true })

    await sweepCodexCopies(w.profile, [], [{ name: 'q', version: '1.0.1' }])

    expect(await fs.readdir(path.join(w.root, 'plugins'))).toEqual(['q'])
    expect(await fs.readdir(path.join(w.root, 'plugins', 'q'))).toEqual(['1.0.1'])
  })

  it('never deletes through a symlinked version folder', async (ctx) => {
    const w = await world()
    const outside = path.join(w.base, 'outside')
    await write(path.join(outside, 'precious.txt'), 'x')
    const link = codexCopyFolder(w.profile, 'p', '1.0.0')
    await fs.mkdir(path.dirname(link), { recursive: true })
    try {
      await fs.symlink(outside, link, 'junction')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw e
    }

    expect(await sweepCodexCopies(w.profile, [], [{ name: 'p', version: '1.0.1' }])).toEqual([])

    expect((await fs.lstat(link)).isSymbolicLink()).toBe(true)
    expect(await fs.readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('x')
  })

  it('never follows a link inside a folder it deletes', async (ctx) => {
    const w = await world()
    const outside = path.join(w.base, 'outside')
    await write(path.join(outside, 'precious.txt'), 'x')
    const old = await folder(w, 'p', '1.0.0')
    try {
      await fs.symlink(outside, path.join(old, 'inner'), 'junction')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
      throw e
    }

    expect(await sweepCodexCopies(w.profile, [], [])).toEqual([old])

    expect(await exists(old)).toBe(false)
    expect(await fs.readFile(path.join(outside, 'precious.txt'), 'utf8')).toBe('x')
  })

  it('does nothing, and makes nothing, when there are no copies', async () => {
    const w = await world()

    expect(await sweepCodexCopies(w.profile, [], [])).toEqual([])

    expect(await exists(w.root)).toBe(false)
  })
})
