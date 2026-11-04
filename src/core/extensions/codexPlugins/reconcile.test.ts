// One pass over one Codex account (Codex plugin sharing design §5.3, §5.4): what `codex plugin list` reports against
// what the profile shares, then the commands, the `enabled` flags, the account's own plugin of the same name, and hook
// trust. No test runs a real codex: the runner is a script keyed by the arguments, every call is recorded and one the
// script lacks fails the test, and the hooks list answers what each test gives it. The account is a temp folder whose
// `config.toml` is real text with comments, written through the real patchTomlFile.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { readTomlObject } from '../../providers/configWrite'
import type { Account } from '../../types'
import type { PluginCliResult } from '../claudePlugins/cli'
import { CODEX_PLUGIN_ADD_TIMEOUT_MS, type CodexPluginCliRun } from './cli'
import type { CodexHookRow, CodexHooksList } from './hooks'
import type { CodexPluginAccountState } from './state'
import { marketplaceFolder, reconcileCodexAccount, type DesiredCodexPlugin } from './reconcile'

// Every config.toml write is seen with the path, the options and whether the profile lock was held at that moment
const seen = vi.hoisted(() => ({ lockDepth: 0, locks: 0, writes: [] as { file: string; o: unknown; inLock: boolean }[] }))
vi.mock('../../providers/configWrite', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../providers/configWrite')>()
  return {
    ...real,
    patchTomlFile: (file: string, patch: Parameters<typeof real.patchTomlFile>[1], o?: { throughLink?: boolean }) => {
      seen.writes.push({ file, o, inLock: seen.lockDepth > 0 })
      return real.patchTomlFile(file, patch, o)
    }
  }
})

const lock = async <T>(fn: () => Promise<T>): Promise<T> => {
  seen.locks++
  seen.lockDepth++
  try {
    return await fn()
  } finally {
    seen.lockDepth--
  }
}

const M = 'astera-shared'
/** The profile folder holds a space and Korean, as the review asks of every path given to codex. */
const ROOT = path.join(os.tmpdir(), '에이 스테라', 'extensions', 'codex-plugins')
const DEV_SOURCE = 'C:\\Users\\x\\AppData\\Roaming\\astera-dev\\extensions\\codex-plugins'
const OFFICIAL_SOURCE = 'https://github.com/anthropics/claude-plugins-official.git'
const NOW = new Date('2026-11-04T01:02:03.000Z')
const AT = NOW.toISOString()
const ACCOUNT_ID = 'acc_codex_work'

const dirs: string[] = []
let unscripted: string[] = []
beforeEach(() => {
  seen.lockDepth = 0
  seen.locks = 0
  seen.writes = []
  unscripted = []
})
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
  expect(unscripted, 'codex commands the test did not script').toEqual([])
  // Every config.toml write of every test holds the profile lock and goes through a link
  expect(seen.writes.filter((w) => !w.inLock || (w.o as { throughLink?: boolean } | undefined)?.throughLink !== true)).toEqual([])
})

interface Fixture {
  home: string
  account: Account
  file: string
}

/** A home folder with one Codex account in it, whose config.toml holds `config` (no file when undefined). */
async function fixture(config?: string, o: { ambient?: boolean } = {}): Promise<Fixture> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-reconcile-'))
  dirs.push(home)
  const configDir = o.ambient ? path.join(home, '.codex') : path.join(home, '.codex-accounts', 'work')
  await fs.mkdir(configDir, { recursive: true })
  const file = path.join(configDir, 'config.toml')
  if (config !== undefined) await fs.writeFile(file, config, 'utf8')
  const account: Account = { id: ACCOUNT_ID, label: 'work', configDir, color: '#888888', createdAt: '2026-11-01T00:00:00.000Z', provider: 'codex' }
  return { home, account, file }
}

const ok = (json: Record<string, unknown>): PluginCliResult => ({ code: 0, json, stdout: `${JSON.stringify(json)}\n`, stderr: '', timedOut: false })
const exited = (code: number, o: { stdout?: string; stderr?: string } = {}): PluginCliResult => ({
  code,
  json: null,
  stdout: o.stdout ?? '',
  stderr: o.stderr ?? '',
  timedOut: false
})

/** A row of `codex plugin list --json` as codex-cli 0.160 prints it (C3). */
function row(name: string, marketplaceName: string, version: string, o: { enabled?: boolean; source?: string } = {}): Record<string, unknown> {
  const source = o.source ?? (marketplaceName === M ? ROOT : OFFICIAL_SOURCE)
  return {
    pluginId: `${name}@${marketplaceName}`,
    name,
    marketplaceName,
    version,
    installed: true,
    enabled: o.enabled ?? true,
    source: { source: 'local', path: `./plugins/${name}/${version}` },
    marketplaceSource: { sourceType: source.startsWith('https:') ? 'git' : 'local', source },
    installPolicy: 'AVAILABLE',
    authPolicy: 'ON_INSTALL'
  }
}
const listed = (...rows: Record<string, unknown>[]): PluginCliResult => ok({ installed: rows, available: [] })
const marketplaceAdded = ok({ marketplaceName: M, installedRoot: ROOT, alreadyAdded: true })
const pluginAdded = (name: string, version: string): PluginCliResult =>
  ok({ pluginId: `${name}@${M}`, name, marketplaceName: M, version, installedPath: `/cache/${M}/${name}/${version}`, authPolicy: 'ON_INSTALL' })
const removed = (name: string): PluginCliResult => ok({ pluginId: `${name}@${M}` })

interface Call {
  codexHome: string | null
  args: string[]
  line: string
  timeoutMs?: number
}

/** A runner that answers each command by `args.join(' ')`. A list of answers is used one per call, in order; a single
 *  answer serves every call. A command the script lacks is recorded as unscripted, which fails the test. */
function scripted(script: Record<string, PluginCliResult | PluginCliResult[]>): { run: CodexPluginCliRun; calls: Call[]; lines: () => string[] } {
  const calls: Call[] = []
  const queues = new Map(Object.entries(script).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]))
  const run: CodexPluginCliRun = async (codexHome, args, o) => {
    const line = args.join(' ')
    calls.push({ codexHome, args, line, timeoutMs: o?.timeoutMs })
    const queued = queues.get(line)
    const answer = Array.isArray(queued) ? queued.shift() : queued
    if (answer === undefined) {
      unscripted.push(line)
      throw new Error(`unscripted: codex ${line}`)
    }
    return answer
  }
  return { run, calls, lines: () => calls.map((c) => c.line) }
}

/** The hooks Codex lists, or the reason it could not list them. */
function hooksAnswering(answer: CodexHookRow[] | Error = []): { list: CodexHooksList; calls: { codexHome: string | null; cwd: string }[] } {
  const calls: { codexHome: string | null; cwd: string }[] = []
  const list: CodexHooksList = async (codexHome, cwd) => {
    calls.push({ codexHome, cwd })
    if (answer instanceof Error) throw answer
    return answer
  }
  return { list, calls }
}

const on = (name: string, version: string): DesiredCodexPlugin => ({ name, version, enabled: true })
const off = (name: string, version: string): DesiredCodexPlugin => ({ name, version, enabled: false })
const prev = (o: Partial<CodexPluginAccountState> = {}): CodexPluginAccountState => ({
  accountId: ACCOUNT_ID,
  installed: {},
  waiting: false,
  turnedOff: [],
  at: '2026-11-03T00:00:00.000Z',
  ...o
})

function pass(
  f: Fixture,
  o: {
    desired: DesiredCodexPlugin[]
    previous?: CodexPluginAccountState
    busy?: boolean
    cli: { run: CodexPluginCliRun }
    hooks?: { list: CodexHooksList }
    root?: string
    lock?: <T>(fn: () => Promise<T>) => Promise<T>
    held?: string[]
    record?: (row: CodexPluginAccountState) => Promise<void>
  }
): Promise<CodexPluginAccountState> {
  return reconcileCodexAccount({
    account: f.account,
    homeDir: f.home,
    marketplace: { name: M, root: o.root ?? ROOT },
    desired: o.desired,
    held: o.held ?? [],
    previous: o.previous,
    busy: o.busy ?? false,
    run: o.cli.run,
    hooks: (o.hooks ?? hooksAnswering()).list,
    record: o.record ?? (async () => {}),
    lock: o.lock ?? lock,
    now: () => NOW
  })
}

const pluginsOf = async (file: string): Promise<Record<string, { enabled?: boolean }>> =>
  readTomlObject(await fs.readFile(file, 'utf8')).plugins as Record<string, { enabled?: boolean }>
const hookStateOf = async (file: string): Promise<Record<string, unknown> | undefined> =>
  (readTomlObject(await fs.readFile(file, 'utf8')).hooks as { state?: Record<string, unknown> } | undefined)?.state

const SHARED_ON = ['# the person\'s settings', 'model = "gpt-5" # kept as written', '', `[plugins."p@${M}"]`, '# written by codex plugin add', 'enabled = true', ''].join('\n')

describe('reconcileCodexAccount', () => {
  it('nothing desired and nothing previous runs nothing', async () => {
    const f = await fixture(SHARED_ON)
    const cli = scripted({})
    const hooks = hooksAnswering()
    const state = await pass(f, { desired: [], cli, hooks })
    expect(state).toEqual({ accountId: ACCOUNT_ID, installed: {}, waiting: false, turnedOff: [], at: AT })
    expect(cli.calls).toEqual([])
    expect(hooks.calls).toEqual([])
    expect(seen.writes).toEqual([])
    expect(seen.locks).toBe(0)
    expect(await fs.readFile(f.file, 'utf8')).toBe(SHARED_ON)
    expect(await fs.readdir(f.account.configDir)).toEqual(['config.toml'])
  })

  it('installs what is missing', async () => {
    const f = await fixture()
    const cli = scripted({
      'plugin list': [listed(), listed(row('p', M, '1.0.0'))],
      [`plugin marketplace add ${ROOT}`]: ok({ marketplaceName: M, installedRoot: ROOT, alreadyAdded: false }),
      [`plugin add p@${M}`]: pluginAdded('p', '1.0.0')
    })
    const hooks = hooksAnswering()
    const state = await pass(f, { desired: [on('p', '1.0.0')], cli, hooks })
    expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`, `plugin add p@${M}`, 'plugin list'])
    // The folder is one argument, spaces and Korean and all
    expect(cli.calls[1].args).toEqual(['plugin', 'marketplace', 'add', ROOT])
    expect(cli.calls[2].timeoutMs).toBe(CODEX_PLUGIN_ADD_TIMEOUT_MS)
    expect(cli.calls.map((c) => c.codexHome)).toEqual(cli.calls.map(() => f.account.configDir))
    expect(hooks.calls).toEqual([{ codexHome: f.account.configDir, cwd: ROOT }])
    expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { p: '1.0.0' }, waiting: false, turnedOff: [], at: AT })
  })

  it('reinstalls on another version', async () => {
    const f = await fixture(SHARED_ON)
    const cli = scripted({
      'plugin list': [listed(row('p', M, '1.0.0')), listed(row('p', M, '1.1.0'))],
      [`plugin marketplace add ${ROOT}`]: marketplaceAdded,
      [`plugin add p@${M}`]: pluginAdded('p', '1.1.0')
    })
    const state = await pass(f, { desired: [on('p', '1.1.0')], previous: prev({ installed: { p: '1.0.0' } }), cli })
    expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`, `plugin add p@${M}`, 'plugin list'])
    expect(state.installed).toEqual({ p: '1.1.0' })
    expect(state.failure).toBeUndefined()
  })

  it('does not reinstall the same version', async () => {
    const f = await fixture(SHARED_ON)
    const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
    const state = await pass(f, { desired: [on('p', '1.0.0')], previous: prev({ installed: { p: '1.0.0' } }), cli })
    expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`])
    expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { p: '1.0.0' }, waiting: false, turnedOff: [], at: AT })
    expect(await fs.readFile(f.file, 'utf8')).toBe(SHARED_ON)
  })

  it('runs the ambient ~/.codex account with no CODEX_HOME', async () => {
    const f = await fixture(SHARED_ON, { ambient: true })
    const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
    const hooks = hooksAnswering()
    await pass(f, { desired: [on('p', '1.0.0')], cli, hooks })
    expect(cli.calls.map((c) => c.codexHome)).toEqual([null, null])
    expect(hooks.calls).toEqual([{ codexHome: null, cwd: ROOT }])
  })

  describe('waits while busy', () => {
    const SHARED_Q = [`[plugins."q@${M}"]`, 'enabled = true', ''].join('\n')

    it('with an install due runs only plugin list, still writes the flags it can, and records the versions it lists', async () => {
      const f = await fixture(SHARED_Q)
      const cli = scripted({ 'plugin list': listed(row('q', M, '1.0.0')) })
      const hooks = hooksAnswering()
      const previous = prev({ installed: { q: '1.0.0', gone: '0.1.0' } })
      const state = await pass(f, { desired: [on('p', '1.0.0'), off('q', '1.0.0')], previous, busy: true, cli, hooks })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(hooks.calls).toEqual([])
      // What the first list shows, not what the previous row said
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { q: '1.0.0' }, waiting: true, turnedOff: [], at: AT })
      expect((await pluginsOf(f.file))[`q@${M}`]).toEqual({ enabled: false })
    })

    it('leaves the own plugin of the same name on while the shared copy waits to be installed', async () => {
      const OWN = 'p@claude-plugins-official'
      const config = [`[plugins."${OWN}"]`, 'enabled = true', ''].join('\n')
      const f = await fixture(config)
      const cli = scripted({ 'plugin list': listed(row('p', 'claude-plugins-official', '2.0.0')) })
      const state = await pass(f, { desired: [on('p', '1.0.0')], previous: prev(), busy: true, cli })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(state.waiting).toBe(true)
      expect(state.turnedOff).toEqual([])
      expect(await fs.readFile(f.file, 'utf8')).toBe(config)
    })

    it('with a reinstall due runs only plugin list', async () => {
      const f = await fixture(SHARED_ON)
      const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')) })
      const state = await pass(f, { desired: [on('p', '2.0.0')], previous: prev({ installed: { p: '1.0.0' } }), busy: true, cli })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(state.waiting).toBe(true)
      expect(state.installed).toEqual({ p: '1.0.0' })
      expect(await fs.readFile(f.file, 'utf8')).toBe(SHARED_ON)
    })

    it('with a removal due runs only plugin list (C14)', async () => {
      const config = [`[plugins."old@${M}"]`, 'enabled = true', '', `[hooks.state."old@${M}:hooks/hooks.json:stop:0:0"]`, 'trusted_hash = "sha256:old"', ''].join('\n')
      const f = await fixture(config)
      const cli = scripted({ 'plugin list': listed(row('old', M, '1.0.0')) })
      const state = await pass(f, { desired: [], previous: prev({ installed: { old: '1.0.0' } }), busy: true, cli })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { old: '1.0.0' }, waiting: true, turnedOff: [], at: AT })
      // The copy waiting to be removed is turned off, and keeps its trust while it stays installed
      expect(await fs.readFile(f.file, 'utf8')).toBe(config.replace('enabled = true', 'enabled = false'))
    })

    it('turns a copy no longer shared off while its removal waits, and the own copy back on', async () => {
      const OWN = 'p@claude-plugins-official'
      const config = [`[plugins."p@${M}"]`, 'enabled = true', '', `[plugins."${OWN}"]`, 'enabled = false', ''].join('\n')
      const f = await fixture(config)
      const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0'), row('p', 'claude-plugins-official', '2.0.0', { enabled: false })) })
      const state = await pass(f, { desired: [], previous: prev({ installed: { p: '1.0.0' }, turnedOff: [OWN] }), busy: true, cli })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { p: '1.0.0' }, waiting: true, turnedOff: [], at: AT })
      expect(await pluginsOf(f.file)).toEqual({ [`p@${M}`]: { enabled: false }, [OWN]: { enabled: true } })
    })

    it('with only an enabled change writes the flag and does not wait', async () => {
      const f = await fixture(SHARED_ON)
      const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
      const hooks = hooksAnswering()
      const state = await pass(f, { desired: [off('p', '1.0.0')], previous: prev({ installed: { p: '1.0.0' } }), busy: true, cli, hooks })
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { p: '1.0.0' }, waiting: false, turnedOff: [], at: AT })
      expect((await pluginsOf(f.file))[`p@${M}`]).toEqual({ enabled: false })
      // A plugin that is off has no hooks to trust
      expect(hooks.calls).toEqual([])
    })
  })

  it('off writes enabled = false, comment lines kept', async () => {
    const f = await fixture(SHARED_ON)
    const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
    const state = await pass(f, { desired: [off('p', '1.0.0')], cli })
    expect(state.failure).toBeUndefined()
    expect(await fs.readFile(f.file, 'utf8')).toBe(SHARED_ON.replace('enabled = true', 'enabled = false'))
  })

  it('on writes enabled = true, comment lines kept', async () => {
    const config = SHARED_ON.replace('enabled = true', 'enabled = false')
    const f = await fixture(config)
    const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0', { enabled: false })), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
    const hooks = hooksAnswering()
    const state = await pass(f, { desired: [on('p', '1.0.0')], cli, hooks })
    expect(state.failure).toBeUndefined()
    expect(await fs.readFile(f.file, 'utf8')).toBe(SHARED_ON)
    expect(hooks.calls).toHaveLength(1)
  })

  describe('turns the own same-name plugin off', () => {
    const OWN = 'p@claude-plugins-official'
    const config = (shared: boolean, own: boolean): string =>
      [`[plugins."p@${M}"]`, `enabled = ${shared}`, '', "# the person's own copy", `[plugins."${OWN}"]`, `enabled = ${own} # from the official marketplace`, ''].join('\n')

    it('while the shared one is on, and remembers it turned it off', async () => {
      const f = await fixture(config(true, true))
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0'), row('p', 'claude-plugins-official', '2.0.0')),
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded
      })
      const state = await pass(f, { desired: [on('p', '1.0.0')], cli })
      expect(state.turnedOff).toEqual([OWN])
      expect(state.failure).toBeUndefined()
      expect(await fs.readFile(f.file, 'utf8')).toBe(config(true, false))
      // Every config.toml write takes the profile lock, goes through a link, and names the account's own file
      expect(seen.writes.length).toBeGreaterThan(0)
      expect(seen.writes).toEqual(seen.writes.map(() => ({ file: f.file, o: { throughLink: true }, inLock: true })))
    })

    it('keeps one it turned off earlier in turnedOff while the shared one stays on', async () => {
      const f = await fixture(config(true, false))
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0'), row('p', 'claude-plugins-official', '2.0.0', { enabled: false })),
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded
      })
      const state = await pass(f, { desired: [on('p', '1.0.0')], previous: prev({ installed: { p: '1.0.0' }, turnedOff: [OWN] }), cli })
      expect(state.turnedOff).toEqual([OWN])
      expect(await fs.readFile(f.file, 'utf8')).toBe(config(true, false))
    })

    it('turns it back on when the shared one is turned off', async () => {
      const f = await fixture(config(true, false))
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0'), row('p', 'claude-plugins-official', '2.0.0', { enabled: false })),
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded
      })
      const state = await pass(f, { desired: [off('p', '1.0.0')], previous: prev({ installed: { p: '1.0.0' }, turnedOff: [OWN] }), cli })
      expect(state.turnedOff).toEqual([])
      expect(await fs.readFile(f.file, 'utf8')).toBe(config(false, true))
    })

    it('turns it back on when the shared one is removed', async () => {
      const text = `${config(true, false)}\n[marketplaces.${M}]\nsource_type = "local"\nsource = '${ROOT}'\n`
      const f = await fixture(text)
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0'), row('p', 'claude-plugins-official', '2.0.0', { enabled: false })),
        [`plugin remove p@${M}`]: removed('p'),
        [`plugin marketplace remove ${M}`]: ok({ marketplaceName: M })
      })
      const state = await pass(f, { desired: [], previous: prev({ installed: { p: '1.0.0' }, turnedOff: [OWN] }), cli })
      expect(cli.lines()).toEqual(['plugin list', `plugin remove p@${M}`, `plugin marketplace remove ${M}`])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: {}, waiting: false, turnedOff: [], at: AT })
      expect((await pluginsOf(f.file))[OWN]).toEqual({ enabled: true })
    })

    it('leaves one the person had off before, and does not count it as turned off', async () => {
      const f = await fixture(config(true, false))
      const own = row('p', 'claude-plugins-official', '2.0.0', { enabled: false })
      const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0'), own), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
      const shared = await pass(f, { desired: [on('p', '1.0.0')], cli })
      expect(shared.turnedOff).toEqual([])
      const sharedOff = await pass(f, { desired: [off('p', '1.0.0')], previous: shared, cli })
      expect(sharedOff.turnedOff).toEqual([])
      expect((await pluginsOf(f.file))[OWN]).toEqual({ enabled: false })
    })

    it('forgets one it turned off that is no longer installed, and one the person turned back on', async () => {
      const f = await fixture(config(false, true))
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0', { enabled: false }), row('p', 'claude-plugins-official', '2.0.0')),
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded
      })
      const state = await pass(f, { desired: [off('p', '1.0.0')], previous: prev({ turnedOff: [OWN, 'q@gone-mkt'] }), cli })
      expect(state.turnedOff).toEqual([])
      expect(await fs.readFile(f.file, 'utf8')).toBe(config(false, true))
    })
  })

  describe('leaves another Astera profile alone', () => {
    const DEV = 'astera-dev-shared'
    const config = [`[plugins."p@${M}"]`, 'enabled = true', '', `[plugins."p@${DEV}"]`, 'enabled = true', ''].join('\n')

    it('does not turn its plugin of the same name off', async () => {
      const f = await fixture(config)
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0'), row('p', DEV, '1.0.0', { source: DEV_SOURCE })),
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded
      })
      const state = await pass(f, { desired: [on('p', '1.0.0')], cli })
      expect(state.turnedOff).toEqual([])
      expect(await fs.readFile(f.file, 'utf8')).toBe(config)
    })

    it('does not remove its plugins when this profile stops sharing', async () => {
      const f = await fixture(`${config}\n[marketplaces.${M}]\nsource_type = "local"\nsource = '${ROOT}'\n`)
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0'), row('p', DEV, '1.0.0', { source: DEV_SOURCE })),
        [`plugin remove p@${M}`]: removed('p'),
        [`plugin marketplace remove ${M}`]: ok({ marketplaceName: M })
      })
      const state = await pass(f, { desired: [], previous: prev({ installed: { p: '1.0.0' } }), cli })
      expect(cli.lines()).toEqual(['plugin list', `plugin remove p@${M}`, `plugin marketplace remove ${M}`])
      expect(state.installed).toEqual({})
      expect(state.failure).toBeUndefined()
    })
  })

  describe('this marketplace name added from another folder', () => {
    /** Another profile whose folder has the same base name, so the same marketplace name. Codex records it with `\\?\`. */
    const OTHER_ROOT = path.join(os.tmpdir(), 'elsewhere', 'astera', 'extensions', 'codex-plugins')
    const OTHER_SOURCE = `\\\\?\\${OTHER_ROOT}`
    const config = [
      `[plugins."p@${M}"]`,
      'enabled = true',
      '',
      `[hooks.state."p@${M}:hooks/hooks.json:stop:0:0"]`,
      'trusted_hash = "sha256:theirs"',
      '',
      `[marketplaces.${M}]`,
      'source_type = "local"',
      `source = '${OTHER_SOURCE}'`,
      ''
    ].join('\n')

    it('leaves its plugin alone when this profile shares nothing, and fails the account naming that folder', async () => {
      const f = await fixture(config)
      const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0', { source: OTHER_SOURCE })) })
      const state = await pass(f, { desired: [], previous: prev({ installed: { p: '1.0.0' } }), cli })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(state.failure?.code).toBe('marketplace-taken')
      expect(state.failure?.message).toContain(OTHER_SOURCE)
      expect(state.installed).toEqual({})
      expect(seen.writes).toEqual([])
      expect(await fs.readFile(f.file, 'utf8')).toBe(config)
    })

    it('leaves its plugin alone when this profile shares the same plugin, as Codex refuses the add', async () => {
      const refusal = `Error: marketplace '${M}' is already added from a different source; remove it before adding this source`
      const f = await fixture(config)
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0', { source: OTHER_SOURCE })),
        [`plugin marketplace add ${ROOT}`]: exited(1, { stderr: `${refusal}\n` })
      })
      const state = await pass(f, { desired: [off('p', '1.0.0')], previous: prev({ installed: { p: '1.0.0' } }), cli })
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`])
      expect(state.failure).toEqual({ message: refusal, code: 'marketplace-taken' })
      expect(state.installed).toEqual({})
      expect(seen.writes).toEqual([])
      expect(await fs.readFile(f.file, 'utf8')).toBe(config)
    })

    it('leaves its trust keys and its marketplace alone when none of its plugins is installed', async () => {
      const f = await fixture(config)
      const cli = scripted({ 'plugin list': listed() })
      const state = await pass(f, { desired: [], previous: prev(), cli })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(state.failure?.code).toBe('marketplace-taken')
      expect(state.failure?.message).toContain(OTHER_SOURCE)
      expect(await fs.readFile(f.file, 'utf8')).toBe(config)
    })
  })

  describe('rows under this marketplace name from this folder', () => {
    it('takes every row under the name once the marketplace add succeeded, wherever Codex says it comes from', async () => {
      // Codex records the folder resolved (a junction, a subst drive, a redirected folder); its add succeeding proves the
      // name is this folder's, as it refuses an add from a different source
      const RESOLVED = `\\\\?\\${path.join(os.tmpdir(), 'resolved', 'astera', 'extensions', 'codex-plugins')}`
      const KEY = `p@${M}:hooks/hooks.json:pre_tool_use:0:0`
      const config = `${SHARED_ON}\n[marketplaces.${M}]\nsource_type = "local"\nsource = '${RESOLVED}'\n`
      const f = await fixture(config)
      const cli = scripted({
        'plugin list': [listed(row('p', M, '1.0.0', { source: RESOLVED })), listed(row('p', M, '1.1.0', { source: RESOLVED }))],
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded,
        [`plugin add p@${M}`]: pluginAdded('p', '1.1.0')
      })
      const hooks = hooksAnswering([{ key: KEY, pluginId: `p@${M}`, currentHash: 'sha256:pre', trustStatus: 'untrusted' }])
      const state = await pass(f, { desired: [on('p', '1.1.0')], previous: prev({ installed: { p: '1.0.0' } }), cli, hooks })
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`, `plugin add p@${M}`, 'plugin list'])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { p: '1.1.0' }, waiting: false, turnedOff: [], at: AT })
      expect(await hookStateOf(f.file)).toEqual({ [KEY]: { trusted_hash: 'sha256:pre' } })
    })

    it('takes a source Codex records with \\\\?\\ for this folder as this folder when nothing is added', async () => {
      const source = `\\\\?\\${ROOT}`
      const f = await fixture(`${SHARED_ON}\n[marketplaces.${M}]\nsource_type = "local"\nsource = '${source}'\n`)
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0', { source })),
        [`plugin remove p@${M}`]: removed('p'),
        [`plugin marketplace remove ${M}`]: ok({ marketplaceName: M })
      })
      const state = await pass(f, { desired: [], previous: prev({ installed: { p: '1.0.0' } }), cli })
      expect(cli.lines()).toEqual(['plugin list', `plugin remove p@${M}`, `plugin marketplace remove ${M}`])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: {}, waiting: false, turnedOff: [], at: AT })
    })

    it('takes the folder a junction resolves to as this folder when nothing is added', async (ctx) => {
      const base = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-codex-junction-'))
      dirs.push(base)
      await fs.mkdir(path.join(base, 'real', 'extensions', 'codex-plugins'), { recursive: true })
      try {
        await fs.symlink(path.join(base, 'real'), path.join(base, 'link'), 'junction')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip()
        throw e
      }
      const root = path.join(base, 'link', 'extensions', 'codex-plugins')
      // What Codex records: the resolved folder, with `\\?\` on Windows
      const source = `\\\\?\\${await fs.realpath(root)}`
      expect(marketplaceFolder(source)).not.toBe(root)
      const f = await fixture(`${SHARED_ON}\n[marketplaces.${M}]\nsource_type = "local"\nsource = '${source}'\n`)
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0', { source })),
        [`plugin remove p@${M}`]: removed('p'),
        [`plugin marketplace remove ${M}`]: ok({ marketplaceName: M })
      })
      const state = await pass(f, { desired: [], previous: prev({ installed: { p: '1.0.0' } }), cli, root })
      expect(cli.lines()).toEqual(['plugin list', `plugin remove p@${M}`, `plugin marketplace remove ${M}`])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: {}, waiting: false, turnedOff: [], at: AT })
    })

    it('reads a marketplace source as a plain folder', () => {
      expect(marketplaceFolder('\\\\?\\F:\\x\\extensions\\codex-plugins')).toBe('F:\\x\\extensions\\codex-plugins')
      expect(marketplaceFolder('\\\\?\\UNC\\server\\share\\x\\extensions\\codex-plugins')).toBe('\\\\server\\share\\x\\extensions\\codex-plugins')
      expect(marketplaceFolder('/home/x/.config/astera/extensions/codex-plugins')).toBe('/home/x/.config/astera/extensions/codex-plugins')
    })
  })

  it("trusts this marketplace's plugin hooks", async () => {
    const KEY_P = `p@${M}:hooks/hooks.json:pre_tool_use:0:0`
    const KEY_P_TRUSTED = `p@${M}:hooks/hooks.json:session_start:0:0`
    const KEY_OFF = `r@${M}:hooks/hooks.json:stop:0:0`
    const KEY_OLD = `old@${M}:hooks/hooks.json:stop:0:0`
    const KEY_MINE = 'mine:hooks.json:stop:0:0'
    const config = [
      '# hooks the person trusted',
      `[hooks.state."${KEY_MINE}"]`,
      'trusted_hash = "sha256:mine"',
      '',
      `[hooks.state."${KEY_P_TRUSTED}"]`,
      'trusted_hash = "sha256:start"',
      '',
      `[hooks.state."${KEY_OLD}"]`,
      'trusted_hash = "sha256:old"',
      '',
      `[plugins."p@${M}"]`,
      'enabled = true',
      '',
      `[plugins."r@${M}"]`,
      'enabled = false',
      ''
    ].join('\n')
    const f = await fixture(config)
    const cli = scripted({
      'plugin list': listed(row('p', M, '1.0.0'), row('r', M, '1.0.0', { enabled: false })),
      [`plugin marketplace add ${ROOT}`]: marketplaceAdded
    })
    const hooks = hooksAnswering([
      { key: KEY_P, pluginId: `p@${M}`, currentHash: 'sha256:pre', trustStatus: 'untrusted' },
      { key: KEY_P_TRUSTED, pluginId: `p@${M}`, currentHash: 'sha256:start', trustStatus: 'trusted' },
      { key: KEY_OFF, pluginId: `r@${M}`, currentHash: 'sha256:r', trustStatus: 'untrusted' },
      { key: 'q@other:hooks/hooks.json:stop:0:0', pluginId: 'q@other', currentHash: 'sha256:q', trustStatus: 'untrusted' },
      // The person's own copy of the same name is not this marketplace's, so its hooks are not Astera's to trust
      { key: 'p@claude-plugins-official:hooks/hooks.json:stop:0:0', pluginId: 'p@claude-plugins-official', currentHash: 'sha256:own-p', trustStatus: 'untrusted' },
      { key: 'own:hooks.json:stop:0:0', pluginId: null, currentHash: 'sha256:own', trustStatus: 'untrusted' }
    ])
    const state = await pass(f, { desired: [on('p', '1.0.0'), off('r', '1.0.0')], cli, hooks })
    expect(state.failure).toBeUndefined()
    expect(hooks.calls).toEqual([{ codexHome: f.account.configDir, cwd: ROOT }])
    expect(await hookStateOf(f.file)).toEqual({
      [KEY_MINE]: { trusted_hash: 'sha256:mine' },
      [KEY_P_TRUSTED]: { trusted_hash: 'sha256:start' },
      [KEY_P]: { trusted_hash: 'sha256:pre' }
    })
    const text = await fs.readFile(f.file, 'utf8')
    expect(text).toContain('# hooks the person trusted')
    expect(await pluginsOf(f.file)).toEqual({ [`p@${M}`]: { enabled: true }, [`r@${M}`]: { enabled: false } })
  })

  it('removes what is no longer shared, then the marketplace', async () => {
    const KEY_OLD = `old@${M}:hooks/hooks.json:stop:0:0`
    const config = [
      '# kept',
      `[plugins."old@${M}"]`,
      'enabled = true',
      '',
      `[hooks.state."${KEY_OLD}"]`,
      'trusted_hash = "sha256:old"',
      '',
      `[marketplaces.${M}]`,
      'source_type = "local"',
      `source = '${ROOT}'`,
      ''
    ].join('\n')
    const f = await fixture(config)
    const cli = scripted({
      'plugin list': listed(row('old', M, '1.0.0')),
      [`plugin remove old@${M}`]: removed('old'),
      [`plugin marketplace remove ${M}`]: ok({ marketplaceName: M })
    })
    const hooks = hooksAnswering()
    const state = await pass(f, { desired: [], previous: prev({ installed: { old: '1.0.0' } }), cli, hooks })
    expect(cli.lines()).toEqual(['plugin list', `plugin remove old@${M}`, `plugin marketplace remove ${M}`])
    expect(hooks.calls).toEqual([])
    expect(state).toEqual({ accountId: ACCOUNT_ID, installed: {}, waiting: false, turnedOff: [], at: AT })
    expect(await hookStateOf(f.file)).toBeUndefined()
    expect(await fs.readFile(f.file, 'utf8')).toContain('# kept')
  })

  it('keeps the trust of a plugin whose removal fails, and the marketplace', async () => {
    const KEY_OLD = `old@${M}:hooks/hooks.json:stop:0:0`
    const config = [
      `[plugins."old@${M}"]`,
      'enabled = true',
      '',
      `[hooks.state."${KEY_OLD}"]`,
      'trusted_hash = "sha256:old"',
      '',
      `[marketplaces.${M}]`,
      'source_type = "local"',
      `source = '${ROOT}'`,
      ''
    ].join('\n')
    const f = await fixture(config)
    const cli = scripted({ 'plugin list': listed(row('old', M, '1.0.0')), [`plugin remove old@${M}`]: exited(1, { stderr: 'Error: access denied\n' }) })
    const state = await pass(f, { desired: [], previous: prev({ installed: { old: '1.0.0' } }), cli })
    expect(cli.lines()).toEqual(['plugin list', `plugin remove old@${M}`])
    expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { old: '1.0.0' }, waiting: false, failure: { message: 'Error: access denied' }, turnedOff: [], at: AT })
    // Turned off before its removal was tried, so it never loads beside an own copy turned back on (final review I1)
    expect(await fs.readFile(f.file, 'utf8')).toBe(config.replace('enabled = true', 'enabled = false'))
  })

  it('does not remove a marketplace the account has not added', async () => {
    const f = await fixture('# nothing of Astera here\nmodel = "gpt-5"\n')
    const cli = scripted({ 'plugin list': listed(row('p', 'claude-plugins-official', '2.0.0')) })
    const state = await pass(f, { desired: [], previous: prev(), cli })
    expect(cli.lines()).toEqual(['plugin list'])
    expect(state).toEqual({ accountId: ACCOUNT_ID, installed: {}, waiting: false, turnedOff: [], at: AT })
    expect(await fs.readFile(f.file, 'utf8')).toBe('# nothing of Astera here\nmodel = "gpt-5"\n')
  })

  describe('marketplace taken', () => {
    const TAKEN = `Error: marketplace '${M}' is already added from a different source; remove it before adding this source`

    it.each([
      ['stderr', exited(1, { stderr: `${TAKEN}\n` })],
      ['stdout', exited(1, { stdout: `${TAKEN}\n`, stderr: 'warning: something else\n' })]
    ])('fails the account with the reason Codex gives on %s, and adds no plugin', async (_stream, answer) => {
      const f = await fixture(SHARED_ON)
      const cli = scripted({ 'plugin list': listed(), [`plugin marketplace add ${ROOT}`]: answer })
      const state = await pass(f, { desired: [on('p', '1.0.0')], previous: prev({ turnedOff: ['x@own'] }), cli })
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`])
      expect(state).toEqual({
        accountId: ACCOUNT_ID,
        installed: {},
        waiting: false,
        failure: { message: TAKEN, code: 'marketplace-taken' },
        turnedOff: ['x@own'],
        at: AT
      })
      expect(seen.writes).toEqual([])
      expect(await fs.readFile(f.file, 'utf8')).toBe(SHARED_ON)
    })
  })

  it.each([
    // Measured on codex-cli 0.160 with an unknown first word: clap takes it for the PROMPT and refuses the next one
    ["error: unexpected argument 'list' found\n\nUsage: codex [OPTIONS] [PROMPT]\n       codex [OPTIONS] <COMMAND> [ARGS]\n\nFor more information, try '--help'.\n", "error: unexpected argument 'list' found"],
    ["error: unrecognized subcommand 'plugin'\n\nUsage: codex [OPTIONS] <COMMAND>\n", "error: unrecognized subcommand 'plugin'"]
  ])('codex without plugin (%#)', async (stderr, message) => {
    const f = await fixture(SHARED_ON)
    const cli = scripted({ 'plugin list': exited(2, { stderr }) })
    const state = await pass(f, { desired: [on('p', '1.0.0')], previous: prev({ installed: { p: '0.9.0' } }), cli })
    expect(cli.lines()).toEqual(['plugin list'])
    expect(state.failure).toEqual({ message, code: 'codex-unsupported' })
    expect(state.installed).toEqual({ p: '0.9.0' })
    expect(state.waiting).toBe(false)
  })

  it('damaged config fails only that account', async () => {
    // What codex-cli 0.160 answers for a config.toml it cannot parse (measured)
    const loadFailure = [
      'Error: failed to load configuration: TOML parse error at line 1, column 4',
      '  |',
      '1 | [[[',
      '  |    ^',
      'invalid table header',
      ''
    ].join('\n')
    const damaged = await fixture('[[[')
    const cli = scripted({ 'plugin list': exited(1, { stderr: loadFailure }) })
    const failed = await pass(damaged, { desired: [off('p', '1.0.0')], previous: prev({ installed: { p: '1.0.0' }, turnedOff: ['x@own'] }), cli })
    expect(cli.lines()).toEqual(['plugin list'])
    expect(failed).toEqual({
      accountId: ACCOUNT_ID,
      installed: { p: '1.0.0' },
      waiting: false,
      failure: { message: loadFailure.trim(), code: 'config-unreadable' },
      turnedOff: ['x@own'],
      at: AT
    })
    expect(await fs.readFile(damaged.file, 'utf8')).toBe('[[[')
    expect(await fs.readdir(damaged.account.configDir)).toEqual(['config.toml'])
    // Another account of the same pass goes on
    const fine = await fixture(SHARED_ON)
    const other = await pass(fine, {
      desired: [off('p', '1.0.0')],
      cli: scripted({ 'plugin list': listed(row('p', M, '1.0.0')), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
    })
    expect(other.failure).toBeUndefined()
    expect((await pluginsOf(fine.file))[`p@${M}`]).toEqual({ enabled: false })
  })

  it('a config.toml write that cannot be made fails the account as config-unreadable', async () => {
    const f = await fixture(SHARED_ON)
    const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
    const held = async (): Promise<never> => {
      throw new Error('extension-state/codex-config.lock could not be taken')
    }
    const state = await pass(f, { desired: [off('p', '1.0.0')], previous: prev({ turnedOff: ['x@own'] }), cli, lock: held })
    expect(state.failure).toEqual({ message: `Astera could not update ${f.file}: extension-state/codex-config.lock could not be taken`, code: 'config-unreadable' })
    expect(state.turnedOff).toEqual(['x@own'])
    expect(await fs.readFile(f.file, 'utf8')).toBe(SHARED_ON)
  })

  it('trust failure keeps installs and fails the account', async () => {
    const OWN = 'p@claude-plugins-official'
    const f = await fixture([`[plugins."${OWN}"]`, 'enabled = true', ''].join('\n'))
    const cli = scripted({
      'plugin list': [listed(row('p', 'claude-plugins-official', '2.0.0')), listed(row('p', M, '1.0.0'), row('p', 'claude-plugins-official', '2.0.0'))],
      [`plugin marketplace add ${ROOT}`]: marketplaceAdded,
      [`plugin add p@${M}`]: pluginAdded('p', '1.0.0')
    })
    const hooks = hooksAnswering(new Error('codex app-server did not answer hooks/list within 30 s'))
    const state = await pass(f, { desired: [on('p', '1.0.0')], cli, hooks })
    expect(state).toEqual({
      accountId: ACCOUNT_ID,
      installed: { p: '1.0.0' },
      waiting: false,
      failure: { message: 'codex app-server did not answer hooks/list within 30 s', code: 'hooks-unreadable' },
      // The own copy was turned off before the hooks were asked for, and that write is remembered
      turnedOff: [OWN],
      at: AT
    })
    expect((await pluginsOf(f.file))[OWN]).toEqual({ enabled: false })
  })

  describe('a command that fails answers what is known', () => {
    it.each([
      ['with Codex\'s words and no code', exited(1, { stderr: 'Error: plugin p not found in marketplace\n' }), { message: 'Error: plugin p not found in marketplace' }],
      ['with its exit code when Codex said nothing', exited(3), { message: `codex plugin add p@${M} exited with code 3` }],
      // Only the first plugin list can tell a codex with no plugin command
      ['with no code for an unexpected argument after the first list', exited(2, { stderr: "error: unexpected argument '--json' found\n" }), { message: "error: unexpected argument '--json' found" }],
      [
        'as timed out',
        { ...exited(1, { stderr: 'codex did not finish within 600 s' }), timedOut: true },
        { message: 'codex did not finish within 600 s', code: 'timed-out' }
      ],
      [
        'as refused',
        { code: null, json: null, stdout: '', stderr: '', timedOut: false, refused: 'codex.cmd runs through cmd; nothing was run' },
        { message: 'codex.cmd runs through cmd; nothing was run', code: 'refused' }
      ]
    ])('%s', async (_name, answer, failure) => {
      const f = await fixture(SHARED_ON)
      const cli = scripted({
        'plugin list': listed(row('q', M, '1.0.0')),
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded,
        [`plugin add p@${M}`]: answer as PluginCliResult
      })
      const state = await pass(f, { desired: [on('p', '1.0.0'), on('q', '1.0.0')], previous: prev({ turnedOff: ['x@own'] }), cli })
      // The pass goes on after the add that failed (final review I1), so it ends knowing x@own is no longer installed
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`, `plugin add p@${M}`, 'plugin list'])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { q: '1.0.0' }, waiting: false, failure, turnedOff: [], at: AT })
    })

    it('does not take an unexpected argument from the plugin list after an add for a codex without plugin', async () => {
      const f = await fixture(SHARED_ON)
      const cli = scripted({
        'plugin list': [listed(), exited(2, { stderr: "error: unexpected argument '--json' found\n" })],
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded,
        [`plugin add p@${M}`]: pluginAdded('p', '1.0.0')
      })
      const state = await pass(f, { desired: [on('p', '1.0.0')], cli })
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`, `plugin add p@${M}`, 'plugin list'])
      expect(state.failure).toEqual({ message: "error: unexpected argument '--json' found" })
    })

    it('reads a plugin list with no installed list as a failure, not as nothing installed', async () => {
      const f = await fixture(SHARED_ON)
      const cli = scripted({ 'plugin list': ok({ available: [] }) })
      const state = await pass(f, { desired: [on('p', '1.0.0')], previous: prev({ installed: { p: '1.0.0' } }), cli })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(state.failure?.code).toBeUndefined()
      expect(state.failure?.message).toMatch(/installed/)
      expect(state.installed).toEqual({ p: '1.0.0' })
    })
  })

  // Final review I1: a step that fails for one plugin no longer skips the later steps for every plugin of the account, and
  // a copy no longer shared is turned off in the same write that turns the person's own copy back on
  describe('a step that fails does not stop the steps after it', () => {
    const OWN_X = 'x@claude-plugins-official'
    const HOOKS_DOWN = 'codex app-server did not answer hooks/list within 30 s'

    it('a removal while the hooks cannot be listed: the shared copy goes off as the own copy comes back, and the removal still runs', async () => {
      const KEY_X = `x@${M}:hooks/hooks.json:stop:0:0`
      const config = [
        `[plugins."x@${M}"]`,
        'enabled = true',
        '',
        `[plugins."${OWN_X}"]`,
        'enabled = false',
        '',
        `[plugins."y@${M}"]`,
        'enabled = true',
        '',
        `[hooks.state."${KEY_X}"]`,
        'trusted_hash = "sha256:x"',
        ''
      ].join('\n')
      const f = await fixture(config)
      const cli = scripted({
        'plugin list': listed(row('x', M, '1.0.0'), row('y', M, '1.0.0'), row('x', 'claude-plugins-official', '2.0.0', { enabled: false })),
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded,
        [`plugin remove x@${M}`]: removed('x')
      })
      const state = await pass(f, {
        desired: [on('y', '1.0.0')],
        previous: prev({ installed: { x: '1.0.0', y: '1.0.0' }, turnedOff: [OWN_X] }),
        cli,
        hooks: hooksAnswering(new Error(HOOKS_DOWN))
      })
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`, `plugin remove x@${M}`])
      expect(state).toEqual({
        accountId: ACCOUNT_ID,
        installed: { y: '1.0.0' },
        waiting: false,
        failure: { message: HOOKS_DOWN, code: 'hooks-unreadable' },
        turnedOff: [],
        at: AT
      })
      // Never both copies of x on, at any write
      const plugins = await pluginsOf(f.file)
      expect(plugins[`x@${M}`]).toEqual({ enabled: false })
      expect(plugins[OWN_X]).toEqual({ enabled: true })
      expect(plugins[`y@${M}`]).toEqual({ enabled: true })
      // The removed plugin's trust goes after its removal
      expect(await hookStateOf(f.file)).toBeUndefined()
    })

    it('a removal that fails: the shared copy is off, the own copy back on, the next removal still runs, and the failure is said', async () => {
      const KEY_X = `x@${M}:hooks/hooks.json:stop:0:0`
      const KEY_Z = `z@${M}:hooks/hooks.json:stop:0:0`
      const config = [
        `[plugins."x@${M}"]`,
        'enabled = true',
        '',
        `[plugins."${OWN_X}"]`,
        'enabled = false',
        '',
        `[plugins."z@${M}"]`,
        'enabled = true',
        '',
        `[hooks.state."${KEY_X}"]`,
        'trusted_hash = "sha256:x"',
        '',
        `[hooks.state."${KEY_Z}"]`,
        'trusted_hash = "sha256:z"',
        '',
        `[marketplaces.${M}]`,
        'source_type = "local"',
        `source = '${ROOT}'`,
        ''
      ].join('\n')
      const f = await fixture(config)
      const cli = scripted({
        'plugin list': listed(row('x', M, '1.0.0'), row('z', M, '1.0.0'), row('x', 'claude-plugins-official', '2.0.0', { enabled: false })),
        [`plugin remove x@${M}`]: exited(1, { stderr: 'Error: access denied\n' }),
        [`plugin remove z@${M}`]: removed('z')
      })
      const state = await pass(f, { desired: [], previous: prev({ installed: { x: '1.0.0', z: '1.0.0' }, turnedOff: [OWN_X] }), cli })
      // The marketplace stays while x is still installed from it
      expect(cli.lines()).toEqual(['plugin list', `plugin remove x@${M}`, `plugin remove z@${M}`])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { x: '1.0.0' }, waiting: false, failure: { message: 'Error: access denied' }, turnedOff: [], at: AT })
      const plugins = await pluginsOf(f.file)
      expect(plugins[`x@${M}`]).toEqual({ enabled: false })
      expect(plugins[OWN_X]).toEqual({ enabled: true })
      // x is still installed, so its hooks stay trusted; z's trust goes with it
      expect(await hookStateOf(f.file)).toEqual({ [KEY_X]: { trusted_hash: 'sha256:x' } })
    })

    it('one plugin whose add fails: every other add runs, the others get their flags and trust, the own copy goes off, and the failure is said', async () => {
      const OWN_A = 'a@claude-plugins-official'
      const KEY_A = `a@${M}:hooks/hooks.json:pre_tool_use:0:0`
      const f = await fixture([`[plugins."a@${M}"]`, 'enabled = true', '', `[plugins."${OWN_A}"]`, 'enabled = true', ''].join('\n'))
      const cli = scripted({
        'plugin list': [
          listed(row('a', M, '1.0.0'), row('a', 'claude-plugins-official', '2.0.0')),
          listed(row('a', M, '1.0.0'), row('c', M, '1.0.0', { enabled: true }), row('a', 'claude-plugins-official', '2.0.0'))
        ],
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded,
        [`plugin add b@${M}`]: exited(1, { stderr: 'Error: invalid plugin manifest\n' }),
        [`plugin add c@${M}`]: pluginAdded('c', '1.0.0')
      })
      const hooks = hooksAnswering([{ key: KEY_A, pluginId: `a@${M}`, currentHash: 'sha256:a', trustStatus: 'untrusted' }])
      const state = await pass(f, {
        desired: [on('a', '1.0.0'), on('b', '1.0.0'), off('c', '1.0.0')],
        previous: prev({ installed: { a: '1.0.0' }, failure: { message: 'Error: invalid plugin manifest' } }),
        cli,
        hooks
      })
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`, `plugin add b@${M}`, `plugin add c@${M}`, 'plugin list'])
      expect(state).toEqual({
        accountId: ACCOUNT_ID,
        installed: { a: '1.0.0', c: '1.0.0' },
        waiting: false,
        failure: { message: 'Error: invalid plugin manifest' },
        turnedOff: [OWN_A],
        at: AT
      })
      expect(await pluginsOf(f.file)).toEqual({ [`a@${M}`]: { enabled: true }, [OWN_A]: { enabled: false }, [`c@${M}`]: { enabled: false } })
      expect(hooks.calls).toHaveLength(1)
      expect(await hookStateOf(f.file)).toEqual({ [KEY_A]: { trusted_hash: 'sha256:a' } })
    })

    it('still stops at once when an add finds config.toml unreadable, writing nothing', async () => {
      const f = await fixture(SHARED_ON)
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0', { enabled: false })),
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded,
        [`plugin add q@${M}`]: exited(1, { stderr: 'Error: failed to load configuration: TOML parse error at line 1, column 4\n' })
      })
      const state = await pass(f, { desired: [on('p', '1.0.0'), on('q', '1.0.0')], cli })
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`, `plugin add q@${M}`])
      expect(state.failure?.code).toBe('config-unreadable')
      expect(seen.writes).toEqual([])
    })
  })

  // Final review I3: which own plugins Astera turned off is its only record of them, so it is kept before the write that
  // turns one off, not only once the whole sync is done
  describe('records an own plugin before turning it off', () => {
    const OWN = 'p@claude-plugins-official'
    const config = [`[plugins."p@${M}"]`, 'enabled = true', '', `[plugins."${OWN}"]`, 'enabled = true', ''].join('\n')
    const listing = (): PluginCliResult => listed(row('p', M, '1.0.0'), row('p', 'claude-plugins-official', '2.0.0'))

    it('hands the row with the id to record while the own plugin is still on, then turns it off', async () => {
      const f = await fixture(config)
      const cli = scripted({ 'plugin list': listing(), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
      const recorded: { row: CodexPluginAccountState; ownOn: boolean | undefined }[] = []
      const record = async (r: CodexPluginAccountState): Promise<void> => {
        recorded.push({ row: r, ownOn: (await pluginsOf(f.file))[OWN].enabled })
      }
      const state = await pass(f, { desired: [on('p', '1.0.0')], previous: prev({ installed: { p: '1.0.0' } }), cli, record })
      expect(recorded).toEqual([{ row: { accountId: ACCOUNT_ID, installed: { p: '1.0.0' }, waiting: false, turnedOff: [OWN], at: AT }, ownOn: true }])
      expect(state.turnedOff).toEqual([OWN])
      expect((await pluginsOf(f.file))[OWN]).toEqual({ enabled: false })
    })

    it('a record that fails leaves the own plugin on and fails the account with no code', async () => {
      const f = await fixture(config)
      const cli = scripted({ 'plugin list': listing(), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
      const record = async (): Promise<void> => {
        throw new Error('ENOSPC: no space left on device')
      }
      const state = await pass(f, { desired: [on('p', '1.0.0')], previous: prev({ installed: { p: '1.0.0' } }), cli, record })
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { p: '1.0.0' }, waiting: false, failure: { message: 'ENOSPC: no space left on device' }, turnedOff: [], at: AT })
      expect(await fs.readFile(f.file, 'utf8')).toBe(config)
    })

    it('keeps an id it is about to turn back on in what it records until that write is made', async () => {
      const f = await fixture(
        [`[plugins."p@${M}"]`, 'enabled = true', '', `[plugins."${OWN}"]`, 'enabled = false', '', `[plugins."q@${M}"]`, 'enabled = true', '', '[plugins."q@other"]', 'enabled = true', ''].join('\n')
      )
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0'), row('p', 'claude-plugins-official', '2.0.0', { enabled: false }), row('q', 'other', '1.0.0'), row('q', M, '1.0.0')),
        [`plugin marketplace add ${ROOT}`]: marketplaceAdded
      })
      const recorded: CodexPluginAccountState[] = []
      // p is turned off, so its own copy comes back; q is turned on, so its own copy goes off
      await pass(f, {
        desired: [off('p', '1.0.0'), on('q', '1.0.0')],
        previous: prev({ installed: { p: '1.0.0', q: '1.0.0' }, turnedOff: [OWN] }),
        cli,
        record: async (r) => void recorded.push(r)
      })
      expect(recorded.map((r) => r.turnedOff)).toEqual([[OWN, 'q@other']])
    })

    it('records nothing when nothing is turned off', async () => {
      const f = await fixture(SHARED_ON)
      const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
      const recorded: CodexPluginAccountState[] = []
      await pass(f, { desired: [off('p', '1.0.0')], cli, record: async (r) => void recorded.push(r) })
      expect(recorded).toEqual([])
    })
  })

  // Final review I2: a plugin still shared whose current Codex copy cannot be made keeps the version each account has
  describe('a held plugin', () => {
    const KEY_P = `p@${M}:hooks/hooks.json:stop:0:0`
    const config = [
      `[plugins."p@${M}"]`,
      'enabled = true',
      '',
      `[hooks.state."${KEY_P}"]`,
      'trusted_hash = "sha256:p"',
      '',
      `[marketplaces.${M}]`,
      'source_type = "local"',
      `source = '${ROOT}'`,
      ''
    ].join('\n')

    it('is never reinstalled or removed, keeps its trust and its marketplace, its flag follows the store, and the row lists it', async () => {
      const f = await fixture(config)
      const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')) })
      const state = await pass(f, { desired: [off('p', '1.1.0')], held: ['p'], previous: prev({ installed: { p: '1.0.0' } }), cli })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { p: '1.0.0' }, held: ['p'], waiting: false, turnedOff: [], at: AT })
      expect((await pluginsOf(f.file))[`p@${M}`]).toEqual({ enabled: false })
      expect(await hookStateOf(f.file)).toEqual({ [KEY_P]: { trusted_hash: 'sha256:p' } })
    })

    it('is no reason to wait, and is not listed as held where it is not installed', async () => {
      const f = await fixture(SHARED_ON)
      const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
      const state = await pass(f, { desired: [on('p', '1.0.0'), on('h', '2.0.0')], held: ['h'], previous: prev({ installed: { p: '1.0.0' } }), busy: true, cli })
      expect(cli.lines()).toEqual(['plugin list', `plugin marketplace add ${ROOT}`])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: { p: '1.0.0' }, waiting: false, turnedOff: [], at: AT })
    })

    it('leaves the own plugin it turned off as recorded where the held plugin is not installed', async () => {
      const OWN = 'h@claude-plugins-official'
      const own = [`[plugins."${OWN}"]`, 'enabled = false', ''].join('\n')
      const f = await fixture(own)
      const cli = scripted({ 'plugin list': listed(row('h', 'claude-plugins-official', '2.0.0', { enabled: false })) })
      const state = await pass(f, { desired: [on('h', '1.1.0')], held: ['h'], previous: prev({ turnedOff: [OWN] }), cli })
      expect(cli.lines()).toEqual(['plugin list'])
      expect(state.turnedOff).toEqual([OWN])
      expect(state.failure).toBeUndefined()
      expect(await fs.readFile(f.file, 'utf8')).toBe(own)
    })
  })

  // Final review I4: a row can be lost (a damaged outcome file, an account removed and added again), and what this profile
  // installed is still there; its config.toml says so without running codex
  describe('an account with no row', () => {
    it('is visited when its config.toml names this marketplace from this folder, though nothing is shared', async () => {
      const f = await fixture(`${SHARED_ON}\n[marketplaces.${M}]\nsource_type = "local"\nsource = '${ROOT}'\n`)
      const cli = scripted({
        'plugin list': listed(row('p', M, '1.0.0')),
        [`plugin remove p@${M}`]: removed('p'),
        [`plugin marketplace remove ${M}`]: ok({ marketplaceName: M })
      })
      const state = await pass(f, { desired: [], cli })
      expect(cli.lines()).toEqual(['plugin list', `plugin remove p@${M}`, `plugin marketplace remove ${M}`])
      expect(state).toEqual({ accountId: ACCOUNT_ID, installed: {}, waiting: false, turnedOff: [], at: AT })
    })

    it('is left alone when its config.toml names this marketplace from another folder, or cannot be read as TOML', async () => {
      const other = `${SHARED_ON}\n[marketplaces.${M}]\nsource_type = "local"\nsource = '${path.join(os.tmpdir(), 'elsewhere', 'extensions', 'codex-plugins')}'\n`
      for (const text of [other, `[[[\n[marketplaces.${M}]\nsource = '${ROOT}'\n`]) {
        const f = await fixture(text)
        const cli = scripted({})
        expect(await pass(f, { desired: [], cli })).toEqual({ accountId: ACCOUNT_ID, installed: {}, waiting: false, turnedOff: [], at: AT })
        expect(cli.calls).toEqual([])
        expect(await fs.readFile(f.file, 'utf8')).toBe(text)
      }
    })
  })

  // Final review D4: Codex's parse error is drawn under its first line, so the message keeps the block, bounded
  describe('the message of a config.toml Codex cannot load', () => {
    it('keeps what Codex wrote up to the first blank line', async () => {
      const f = await fixture('[[[')
      const stderr = ['Error: failed to load configuration: TOML parse error at line 1, column 4', '  |', '1 | [[[', '  |    ^', 'invalid table header', '', 'more text', ''].join('\n')
      const cli = scripted({ 'plugin list': exited(1, { stderr }) })
      const state = await pass(f, { desired: [on('p', '1.0.0')], cli })
      expect(state.failure).toEqual({
        message: ['Error: failed to load configuration: TOML parse error at line 1, column 4', '  |', '1 | [[[', '  |    ^', 'invalid table header'].join('\n'),
        code: 'config-unreadable'
      })
    })

    it('keeps at most 500 characters of it', async () => {
      const f = await fixture('[[[')
      const stderr = `Error: failed to load configuration: ${'x'.repeat(1000)}\n`
      const cli = scripted({ 'plugin list': exited(1, { stderr }) })
      const state = await pass(f, { desired: [on('p', '1.0.0')], cli })
      expect(state.failure?.message).toHaveLength(500)
      expect(state.failure?.message.startsWith('Error: failed to load configuration: xxx')).toBe(true)
    })

    it('says it was Astera that could not read config.toml when its own parse fails, not Codex', async () => {
      const f = await fixture('[[[')
      const cli = scripted({ 'plugin list': listed(row('p', M, '1.0.0')), [`plugin marketplace add ${ROOT}`]: marketplaceAdded })
      const state = await pass(f, { desired: [off('p', '1.0.0')], cli })
      expect(state.failure?.code).toBe('config-unreadable')
      expect(state.failure?.message).toMatch(/^Astera could not update /)
      expect(state.failure?.message).toContain(f.file)
      expect(await fs.readFile(f.file, 'utf8')).toBe('[[[')
    })
  })
})
