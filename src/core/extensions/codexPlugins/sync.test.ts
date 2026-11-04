// The one sync the Host runs for Codex (Codex plugin sharing design §5.1, §5.3, §5.10): the desired list built from the
// store, the Codex copies and the marketplace written before any account is touched, every Codex account brought in
// line one after the other, the outcome kept, and the copies no account uses swept. No test runs a real codex: a fake
// keeps each account's installed plugins in memory and answers `plugin list`, `plugin marketplace add`, `plugin add` and
// `plugin remove` from them, reading the marketplace file and the copy it names the way Codex would, so reconcile runs
// for real against temp account folders and temp Claude copies, and every call is recorded.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { readTomlObject } from '../../providers/configWrite'
import { extensionPaths } from '../../profile/paths'
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

const M = 'astera-shared'
const NOW = new Date('2026-11-04T01:02:03.000Z')
const AT = NOW.toISOString()

const dirs: string[] = []
let unscripted: string[] = []
beforeEach(() => {
  locks.taken = []
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

/** A `codex` for every account: `plugin list`, `plugin marketplace add`, `plugin add` and `plugin remove` over what each
 *  account has installed. `fail` answers a command in place of the fake. */
function fakeCodex(
  w: World,
  o: { fail?: (codexHome: string | null, line: string) => PluginCliResult | undefined } = {}
): { run: CodexPluginCliRun; calls: Call[]; atAdd: AtAdd[]; seed: (account: Account, name: string, version: string) => void; of: (account: Account) => Call[] } {
  const installed = new Map<string, Map<string, string>>()
  const mine = (codexHome: string | null): Map<string, string> => {
    const key = codexHome ?? '(ambient)'
    if (!installed.has(key)) installed.set(key, new Map())
    return installed.get(key) as Map<string, string>
  }
  const calls: Call[] = []
  const atAdd: AtAdd[] = []
  const marketplaceFile = path.join(w.root, '.agents', 'plugins', 'marketplace.json')

  const run: CodexPluginCliRun = async (codexHome, args) => {
    const line = args.join(' ')
    calls.push({ codexHome, line })
    const failed = o.fail?.(codexHome, line)
    if (failed !== undefined) return failed
    if (line === 'plugin list') {
      const rows = [...mine(codexHome)].map(([name, version]) => ({
        pluginId: `${name}@${M}`,
        name,
        marketplaceName: M,
        version,
        installed: true,
        enabled: true,
        marketplaceSource: { sourceType: 'local', source: w.root }
      }))
      return ok({ installed: rows, available: [] })
    }
    if (line === `plugin marketplace add ${w.root}`) {
      const market = (await exists(marketplaceFile)) ? (await readJson<Marketplace>(marketplaceFile)).plugins.map((p) => p.name) : null
      const copies: string[] = []
      for (const name of await fs.readdir(path.join(w.root, 'plugins')).catch(() => [] as string[])) {
        for (const version of await fs.readdir(path.join(w.root, 'plugins', name)).catch(() => [] as string[])) copies.push(`${name}/${version}`)
      }
      atAdd.push({ codexHome, marketplace: market, copies: copies.sort() })
      return ok({ marketplaceName: M, installedRoot: w.root, alreadyAdded: true })
    }
    const add = /^plugin add (.+)@astera-shared$/.exec(line)
    if (add !== null) {
      const name = add[1]
      const entry = (await readJson<Marketplace>(marketplaceFile)).plugins.find((p) => p.name === name)
      if (entry === undefined) return exited(1, `plugin ${name} is not in the marketplace`)
      const manifest = await readJson<{ version: string }>(path.join(w.root, entry.source.path, '.claude-plugin', 'plugin.json'))
      mine(codexHome).set(name, manifest.version)
      return ok({ pluginId: `${name}@${M}`, name, marketplaceName: M, version: manifest.version, installedPath: `/cache/${M}/${name}/${manifest.version}`, authPolicy: 'ON_INSTALL' })
    }
    const remove = /^plugin remove (.+)@astera-shared$/.exec(line)
    if (remove !== null) {
      mine(codexHome).delete(remove[1])
      return ok({ pluginId: `${remove[1]}@${M}` })
    }
    unscripted.push(line)
    throw new Error(`unknown: codex ${line}`)
  }
  return {
    run,
    calls,
    atAdd,
    seed: (account, name, version) => mine(homeOf(w, account)).set(name, version),
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
    expect(await pluginsOf(codex)).toEqual({ [`q@${M}`]: { enabled: false }, [`only-q@${M}`]: { enabled: false } })
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
    // No version folder and no temporary one of the failed copy is left
    expect(await fs.readdir(path.join(w.root, 'plugins', 'broken'))).toEqual([])
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
    cli.seed(a, 'p', '1.0.0')

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
      cli.seed(a, 'p', '1.0.0')

      const rows = await sync(w, cli)

      expect(cli.of(a).map((c) => c.line)).toEqual(['plugin list', `plugin remove p@${M}`])
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
      cli.seed(a, 'p', '1.0.0')

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
