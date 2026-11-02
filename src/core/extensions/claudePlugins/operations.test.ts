// Sharing, checking, updating and removing Claude Code plugins as jobs on one serial queue, in Astera's own config folder
// (the "home"). `claude plugin …` is a fake that answers per argument list; what Claude Code would leave in the home (the
// marketplace record and clone, the version folders) is written by hand, so the fingerprint and the manifests are real
// files. The sweep runs on hand-made version folders whose marker and use stamp are aged with utimes.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { removeFixture } from '../../testFixtures'
import { extensionPaths } from '../../profile/paths'
import { catalogFingerprint } from './catalog'
import { PLUGIN_INSTALL_TIMEOUT_MS, type PluginCliResult, type PluginCliRun } from './cli'
import { readClaudePlugins, updateClaudePlugins } from './store'
import type { ClaudePluginDependency, MarketplaceSource, SharedClaudePlugin } from './types'
import {
  createClaudePluginOps,
  stampClaudePluginUse,
  sweepOrphanedClaudePlugins,
  type ClaudePluginJob,
  type ClaudePluginOps
} from './operations'

const NOW = new Date('2026-11-02T09:00:00.000Z')
const EARLIER = '2026-10-01T00:00:00.000Z'
const DAY = 24 * 60 * 60 * 1000
const SOURCE: MarketplaceSource = { source: 'github', repo: 'acme/market' }
const OTHER: MarketplaceSource = { source: 'github', repo: 'acme/other' }

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeFixture(d)
})
const profile = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-claudeplugin-ops-'))
  dirs.push(d)
  return d
}
const homeOf = (p: string): string => extensionPaths(p).claudePluginHome
const write = async (file: string, text: string): Promise<void> => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
}
const exists = (p: string): Promise<boolean> => fs.lstat(p).then(() => true, () => false)

type CatalogEntry = { name: string; version?: string; [field: string]: unknown }

/** The clone's catalog; each entry gets an object source, so its fingerprint is the entry alone. */
const writeCatalog = (home: string, marketplace: string, entries: CatalogEntry[]): Promise<void> =>
  write(
    path.join(home, 'plugins', 'marketplaces', marketplace, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({ name: marketplace, owner: { name: 'acme' }, plugins: entries.map((e) => ({ source: { source: 'github', repo: `acme/${e.name}` }, ...e })) })
  )

/** What `claude plugin marketplace add` leaves in the home: the record in known_marketplaces.json and the clone. */
async function addMarketplace(home: string, marketplace: string, source: MarketplaceSource, entries: CatalogEntry[]): Promise<void> {
  const file = path.join(home, 'plugins', 'known_marketplaces.json')
  const known = JSON.parse(await fs.readFile(file, 'utf8').catch(() => '{}')) as Record<string, unknown>
  known[marketplace] = { source, installLocation: path.join(home, 'plugins', 'marketplaces', marketplace), lastUpdated: EARLIER }
  await write(file, JSON.stringify(known))
  await writeCatalog(home, marketplace, entries)
}

/** A version folder as `claude plugin install` leaves it, its manifest naming `dependencies`. */
async function installFolder(home: string, id: string, version: string, dependencies: unknown[] = []): Promise<string> {
  const [name, marketplace] = id.split('@')
  const dir = path.join(home, 'plugins', 'cache', marketplace, name, version)
  await write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version, dependencies }))
  return dir
}

/** A row of `claude plugin list --json` (M1). */
const row = (id: string, version: string, installPath: string) => ({
  id,
  version,
  scope: 'user',
  enabled: true,
  installPath,
  installedAt: EARLIER,
  lastUpdated: EARLIER,
  projectEnabled: false
})

/** The home's installs as `claude plugin list --json` reports them: `put` installs a version (replacing the plugin's
 *  row), and `list` answers what is installed at that moment. */
function installs(home: string) {
  const rows: ReturnType<typeof row>[] = []
  const put = async (id: string, version: string, deps: unknown[] = []): Promise<ClaudePluginDependency> => {
    const installPath = await installFolder(home, id, version, deps)
    const at = rows.findIndex((r) => r.id === id)
    if (at >= 0) rows.splice(at, 1)
    rows.push(row(id, version, installPath))
    return { id, version, installPath }
  }
  return { put, list: () => ok([...rows]) }
}

const fingerprintOf = async (home: string, marketplace: string, name: string): Promise<string> => {
  const fp = await catalogFingerprint({ home, marketplace, name })
  if (fp === null) throw new Error(`no catalog entry for ${name}@${marketplace}`)
  return fp.fingerprint
}

const shared = (home: string, name: string, over: Partial<SharedClaudePlugin> = {}): SharedClaudePlugin => ({
  id: `${name}@market`,
  name,
  marketplace: 'market',
  source: SOURCE,
  version: '1.0.0',
  installPath: path.join(home, 'plugins', 'cache', 'market', name, '1.0.0'),
  dependencies: [],
  importedFrom: 'acc_1',
  enabled: true,
  addedAt: EARLIER,
  lastUpdated: EARLIER,
  fingerprint: 'sha256:recorded',
  ...over
})
const seed = (p: string, plugins: SharedClaudePlugin[]) => updateClaudePlugins(p, (s) => ({ ...s, plugins }))

type Reply = Partial<PluginCliResult>
type Script = Record<string, Reply | ((args: string[]) => Reply | Promise<Reply>)>

/** A `claude plugin` runner that answers each argument list (without the --json the real one adds) from `script`; one it
 *  was not given fails, so a stray command shows. */
function fakeRun(script: Script) {
  const calls: { args: string[]; timeoutMs?: number }[] = []
  const run: PluginCliRun = async (args, o) => {
    calls.push({ args, timeoutMs: o?.timeoutMs })
    const key = args.join(' ')
    const answer = script[key]
    const r = answer === undefined ? { code: 1, stderr: `not scripted: ${key}` } : typeof answer === 'function' ? await answer(args) : answer
    return { code: 0, json: null, stdout: '', stderr: '', timedOut: false, ...r }
  }
  return { run, calls, lines: () => calls.map((c) => c.args.join(' ')) }
}
const ok = (json: Record<string, unknown> | unknown[]): Reply => ({ code: 0, json })
const failure = (json: Record<string, unknown>): Reply => ({ code: 1, json, stderr: String(json.message ?? '') })
const installed = ok({ command: 'install', outcome: 'ok' })
const uninstalled = ok({ command: 'uninstall', outcome: 'ok', keptData: false })
/** M12: what `uninstall --json` answers for a plugin the home does not have. */
const notInstalled = (id: string): Reply =>
  failure({ command: 'uninstall', outcome: 'failed', plugin: id, message: `Plugin "${id}" is not installed`, failureCode: 'not_installed' })

const opsFor = (p: string, run: PluginCliRun, now: () => Date = () => NOW): ClaudePluginOps => createClaudePluginOps({ profileDir: p, run, now })

/** The job once it has ended. */
const ended = (ops: ClaudePluginOps, id: string): Promise<ClaudePluginJob> =>
  vi.waitFor(
    () => {
      const j = ops.jobs().find((x) => x.id === id)
      if (!j || j.state === 'queued' || j.state === 'running') throw new Error(`job ${id} is ${j?.state ?? 'not listed'}`)
      return j
    },
    { timeout: 5_000, interval: 5 }
  )

/** M8: what `install --json` answers for a marketplace command nobody accepted yet. */
const SHOWN = {
  kind: 'command_source',
  pluginId: 'cmdprobe@market',
  command: 'node -e "console.log(require(\'path\').resolve(\'out\'))"',
  mode: 'copy',
  catalogRevision: 'sha256:692a',
  sha256: 'e552'
}
const refusedInstall = (shownCommand: Record<string, unknown>, extra: Record<string, unknown> = {}): Reply =>
  failure({
    command: 'install',
    outcome: 'failed',
    plugin: shownCommand.pluginId,
    scope: 'user',
    message: `${String(shownCommand.pluginId)} is installed by running a command on this machine that has not been reviewed yet, so it was not run.`,
    failureCode: 'command_source_refused',
    shownCommand,
    ...extra
  })

describe('share', () => {
  it('share records version, installPath, dependencies and fingerprint', async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'review', version: '1.0.0' }, { name: 'base', version: '2.0.0' }])
    const h = installs(home)
    let review = ''
    let base: ClaudePluginDependency | undefined
    const f = fakeRun({
      'plugin install review@market': async () => {
        review = (await h.put('review@market', '1.0.0', ['base'])).installPath
        base = await h.put('base@market', '2.0.0')
        return ok({ command: 'install', outcome: 'ok', pluginId: 'review@market', message: 'Successfully installed plugin: review@market (scope: user) (+ 1 dependency: base)' })
      },
      'plugin list': h.list
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.share({ id: 'review@market', source: SOURCE, importedFrom: 'acc_1' }))

    expect(job).toMatchObject({ kind: 'share', target: 'review@market', state: 'done', startedAt: NOW.toISOString(), endedAt: NOW.toISOString() })
    expect(job.code).toBeUndefined()
    expect((await readClaudePlugins(p)).plugins).toEqual([
      {
        id: 'review@market',
        name: 'review',
        marketplace: 'market',
        source: SOURCE,
        version: '1.0.0',
        installPath: review,
        dependencies: [base],
        importedFrom: 'acc_1',
        enabled: true,
        addedAt: NOW.toISOString(),
        lastUpdated: NOW.toISOString(),
        fingerprint: await fingerprintOf(home, 'market', 'review')
      }
    ])
    // the list before the install tells a later failure what this share installed
    expect(f.calls).toEqual([
      { args: ['plugin', 'list'], timeoutMs: undefined },
      { args: ['plugin', 'install', 'review@market'], timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS },
      { args: ['plugin', 'list'], timeoutMs: undefined }
    ])
  })

  it('share adds the marketplace only when the home lacks it', async () => {
    const pinned: MarketplaceSource = { source: 'github', repo: 'acme/market', ref: 'main' }
    const shareInto = async (prepare: (home: string) => Promise<void>) => {
      const p = await profile()
      const home = homeOf(p)
      await prepare(home)
      const h = installs(home)
      const f = fakeRun({
        'plugin marketplace add acme/market#main': async () => {
          await addMarketplace(home, 'market', pinned, [{ name: 'review', version: '1.0.0' }])
          return ok({ command: 'marketplace-add', outcome: 'ok', marketplace: 'market' })
        },
        'plugin install review@market': async () => {
          await h.put('review@market', '1.0.0')
          return installed
        },
        'plugin list': h.list
      })
      const ops = opsFor(p, f.run)
      const job = await ended(ops, ops.share({ id: 'review@market', source: pinned, importedFrom: 'acc_1' }))
      return { job, lines: f.lines(), plugins: (await readClaudePlugins(p)).plugins }
    }

    const lacking = await shareInto(async () => {})
    expect(lacking.job.state).toBe('done')
    expect(lacking.lines).toEqual(['plugin marketplace add acme/market#main', 'plugin list', 'plugin install review@market', 'plugin list'])
    expect(lacking.plugins.map((e) => e.id)).toEqual(['review@market'])

    const knowing = await shareInto((home) => addMarketplace(home, 'market', pinned, [{ name: 'review', version: '1.0.0' }]))
    expect(knowing.job.state).toBe('done')
    expect(knowing.lines).toEqual(['plugin list', 'plugin install review@market', 'plugin list'])
  })

  it('share stops at needs-confirmation and records nothing', async () => {
    const p = await profile()
    await addMarketplace(homeOf(p), 'market', SOURCE, [{ name: 'cmdprobe', version: '1.0.0' }])
    const f = fakeRun({ 'plugin list': ok([]), 'plugin install cmdprobe@market': refusedInstall(SHOWN) })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.share({ id: 'cmdprobe@market', source: SOURCE, importedFrom: 'acc_1' }))

    expect(job).toMatchObject({ state: 'needs-confirmation', step: 'install', command: { text: SHOWN.command, sha256: 'e552' } })
    // nothing was installed, so there is nothing to uninstall
    expect(f.lines()).toEqual(['plugin list', 'plugin install cmdprobe@market'])
    expect((await readClaudePlugins(p)).plugins).toEqual([])
  })

  it('share with acceptCommand passes --accept-command <sha>', async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'cmdprobe', version: '1.0.0' }])
    const h = installs(home)
    let dir = ''
    const f = fakeRun({
      'plugin install cmdprobe@market --accept-command e552': async () => {
        dir = (await h.put('cmdprobe@market', '1.0.0-d5e3941fb248')).installPath
        return installed
      },
      'plugin list': h.list
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.share({ id: 'cmdprobe@market', source: SOURCE, importedFrom: 'acc_1', acceptCommand: 'e552' }))

    expect(job.state).toBe('done')
    expect(f.calls[1]).toEqual({ args: ['plugin', 'install', 'cmdprobe@market', '--accept-command', 'e552'], timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS })
    expect((await readClaudePlugins(p)).plugins).toMatchObject([{ id: 'cmdprobe@market', version: '1.0.0-d5e3941fb248', installPath: dir }])
  })

  it('a confirmed install that returns a new shownCommand asks again', async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'hh', version: '1.0.0' }, { name: 'a', version: '1.1.0' }])
    // M8: editing any catalog entry voids every pending sha, and the answer shows the command again with a new one
    const helper = {
      kind: 'entry_helper',
      pluginId: 'hh@market',
      command: 'node -e "console.log(JSON.stringify({}))"',
      archiveUrl: 'https://plugins.example/hh-1.0.0.zip',
      catalogRevision: 'sha256:b',
      sha256: 'new'
    }
    const a = shared(home, 'a')
    await seed(p, [a])
    const f = fakeRun({
      'plugin list': ok([]),
      'plugin install hh@market --accept-command old': refusedInstall(helper, { failureCode: 'entry_helper_unconfirmed', acceptCommandMatched: false }),
      'plugin update a@market --accept-command old': failure({
        command: 'update',
        outcome: 'failed',
        message: 'the marketplace changed the command that installs it since it was accepted, so it was not run',
        failureCode: 'command_source_refused',
        shownCommand: { ...SHOWN, pluginId: 'a@market', previousAcceptance: 'changed', sha256: 'newer' },
        acceptCommandMatched: false
      })
    })
    const ops = opsFor(p, f.run)

    const install = await ended(ops, ops.share({ id: 'hh@market', source: SOURCE, importedFrom: 'acc_1', acceptCommand: 'old' }))
    expect(install).toMatchObject({ state: 'needs-confirmation', command: { text: `${helper.command}\n${helper.archiveUrl}`, sha256: 'new' } })

    const update = await ended(ops, ops.update('a@market', 'old'))
    expect(update).toMatchObject({ state: 'needs-confirmation', command: { text: SHOWN.command, sha256: 'newer' } })

    expect((await readClaudePlugins(p)).plugins).toEqual([a])
    expect(f.lines()).toEqual(['plugin list', 'plugin install hh@market --accept-command old', 'plugin update a@market --accept-command old'])
  })

  it('share fails on a marketplace name the home knows from another source and runs nothing', async () => {
    const p = await profile()
    // M10: the same name from a LAN address in one account and an https one in another; a second add re-points it
    await addMarketplace(homeOf(p), 'market', { source: 'git', url: 'http://192.168.0.10/market.git' }, [{ name: 'review', version: '1.0.0' }])
    const f = fakeRun({})
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.share({ id: 'review@market', source: { source: 'git', url: 'https://git.example/market.git' }, importedFrom: 'acc_1' }))

    expect(job).toMatchObject({ state: 'failed', step: 'marketplace', code: 'marketplace-mismatch' })
    expect(job.message).toContain('market')
    expect(f.calls).toEqual([])
    expect((await readClaudePlugins(p)).plugins).toEqual([])
  })

  it("share records dependencies from the owner's manifest, recursively", async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'owner', version: '1.0.0' }])
    const h = installs(home)
    const expected: ClaudePluginDependency[] = []
    const f = fakeRun({
      'plugin install owner@market': async () => {
        // plugin-dependencies docs: a bare name is in the declaring plugin's own marketplace, `name@m` and
        // `{ name, marketplace }` in another, `{ name, version }` a range
        await h.put('owner@market', '1.0.0', ['mid', 'w@other', { name: 'pinned', version: '^1.0' }, { name: 'x', marketplace: 'other' }])
        expected.push(
          await h.put('mid@market', '1.0.0', ['leaf']),
          await h.put('leaf@market', '1.0.0', ['mid', 'owner']),
          await h.put('w@other', '3.0.0'),
          await h.put('pinned@market', '1.4.0'),
          await h.put('x@other', '2.0.0', ['y']),
          await h.put('y@other', '0.1.0', ['x@other'])
        )
        await h.put('unrelated@market', '5.0.0')
        return installed
      },
      'plugin list': h.list
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.share({ id: 'owner@market', source: SOURCE, importedFrom: 'acc_1' }))

    expect(job.state).toBe('done')
    expect((await readClaudePlugins(p)).plugins[0].dependencies).toEqual(expected)
  })

  it('share fails on a dependency Claude Code did not install, naming it', async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'owner', version: '1.0.0' }])
    const h = installs(home)
    const f = fakeRun({
      'plugin install owner@market': async () => {
        await h.put('owner@market', '1.0.0', ['ghost'])
        return installed
      },
      'plugin list': h.list,
      'plugin uninstall owner@market': uninstalled
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.share({ id: 'owner@market', source: SOURCE, importedFrom: 'acc_1' }))

    expect(job).toMatchObject({ state: 'failed', step: 'record', code: 'dependency-missing' })
    expect(job.message).toContain('ghost@market')
    expect((await readClaudePlugins(p)).plugins).toEqual([])
  })

  it('share of an id already shared fails and runs nothing', async () => {
    const p = await profile()
    const a = shared(homeOf(p), 'a')
    await seed(p, [a])
    const f = fakeRun({})
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.share({ id: 'a@market', source: SOURCE, importedFrom: 'acc_2' }))

    expect(job).toMatchObject({ state: 'failed', code: 'already-shared' })
    expect(job.message).toContain('a@market')
    expect(f.calls).toEqual([])
    expect((await readClaudePlugins(p)).plugins).toEqual([a])
  })

  it("share fails when the plugin's catalog entry cannot be read", async () => {
    const p = await profile()
    const home = homeOf(p)
    // the catalog does not list the plugin, so there is no fingerprint to find its updates by
    await addMarketplace(home, 'market', SOURCE, [{ name: 'someone-else', version: '1.0.0' }])
    const h = installs(home)
    const f = fakeRun({
      'plugin install review@market': async () => {
        await h.put('review@market', '1.0.0')
        return installed
      },
      'plugin list': h.list,
      'plugin uninstall review@market': uninstalled
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.share({ id: 'review@market', source: SOURCE, importedFrom: 'acc_1' }))

    expect(job).toMatchObject({ state: 'failed', step: 'record', code: 'catalog-unreadable' })
    expect(job.message).toMatch(/catalog/)
    expect((await readClaudePlugins(p)).plugins).toEqual([])
  })

  it('a share that fails after install uninstalls what it installed, and leaves a plugin that was already there', async () => {
    // new to the home: the catalog cannot be read, so the install is taken back
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'someone-else', version: '1.0.0' }])
    const h = installs(home)
    const f = fakeRun({
      'plugin install review@market': async () => {
        await h.put('review@market', '1.0.0')
        return installed
      },
      'plugin list': h.list,
      'plugin uninstall review@market': uninstalled
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.share({ id: 'review@market', source: SOURCE, importedFrom: 'acc_1' }))
    expect(job).toMatchObject({ state: 'failed', code: 'catalog-unreadable' })
    expect(f.lines()).toEqual(['plugin list', 'plugin install review@market', 'plugin list', 'plugin uninstall review@market'])

    // already in the home (another shared plugin's dependency): the install answers "already installed", the share
    // fails on a missing dependency, and the plugin stays
    const p2 = await profile()
    const home2 = homeOf(p2)
    await addMarketplace(home2, 'market', SOURCE, [{ name: 'review', version: '1.0.0' }])
    const h2 = installs(home2)
    await h2.put('review@market', '1.0.0', ['ghost'])
    const f2 = fakeRun({
      'plugin install review@market': ok({ command: 'install', outcome: 'ok', message: 'Plugin "review@market" is already installed (scope: user)' }),
      'plugin list': h2.list
    })
    const ops2 = opsFor(p2, f2.run)
    const job2 = await ended(ops2, ops2.share({ id: 'review@market', source: SOURCE, importedFrom: 'acc_1' }))
    expect(job2).toMatchObject({ state: 'failed', code: 'dependency-missing' })
    expect(f2.lines()).toEqual(['plugin list', 'plugin install review@market', 'plugin list'])
    expect((await readClaudePlugins(p2)).plugins).toEqual([])
  })

  it('share refuses what it cannot share, with a code', async () => {
    const p = await profile()
    const home = homeOf(p)
    const f = fakeRun({ 'plugin list': ok([]), 'plugin install review@market': installed, 'plugin uninstall review@market': notInstalled('review@market') })
    const ops = opsFor(p, f.run)

    // not a plugin id
    const notId = await ended(ops, ops.share({ id: 'review', source: SOURCE, importedFrom: 'acc_1' }))
    expect(notId).toMatchObject({ state: 'failed', code: 'not-shareable' })
    expect(f.calls).toEqual([])

    // the home's list of marketplaces is damaged, so a mismatch cannot be ruled out
    await write(path.join(home, 'plugins', 'known_marketplaces.json'), '{ broken')
    const damaged = await ended(ops, ops.share({ id: 'review@market', source: SOURCE, importedFrom: 'acc_1' }))
    expect(damaged).toMatchObject({ state: 'failed', step: 'marketplace', code: 'home-unreadable' })
    expect(f.calls).toEqual([])

    // the install answered ok, but Claude Code does not list the plugin
    await fs.rm(path.join(home, 'plugins', 'known_marketplaces.json'))
    await addMarketplace(home, 'market', SOURCE, [{ name: 'review', version: '1.0.0' }])
    const unlisted = await ended(ops, ops.share({ id: 'review@market', source: SOURCE, importedFrom: 'acc_1' }))
    expect(unlisted).toMatchObject({ state: 'failed', step: 'record', code: 'not-listed' })
    expect((await readClaudePlugins(p)).plugins).toEqual([])
  })

  it('a refused or timed-out run fails the job with its code', async () => {
    const p = await profile()
    const refused = 'the arguments hold cmd.exe syntax and claude is a .cmd that only cmd.exe can run; nothing was run'
    const a = shared(homeOf(p), 'a')
    await seed(p, [a])
    const f = fakeRun({
      'plugin marketplace add https://git.example/a&b.git': { code: null, refused },
      'plugin update a@market': { code: null, timedOut: true, stderr: 'claude did not finish within 600 s' }
    })
    const ops = opsFor(p, f.run)

    const share = await ended(ops, ops.share({ id: 'review@market', source: { source: 'git', url: 'https://git.example/a&b.git' }, importedFrom: 'acc_1' }))
    expect(share).toMatchObject({ state: 'failed', step: 'marketplace', code: 'refused', message: refused })

    const update = await ended(ops, ops.update('a@market'))
    expect(update).toMatchObject({ state: 'failed', step: 'install', code: 'timed-out', message: 'claude did not finish within 600 s' })
    expect((await readClaudePlugins(p)).plugins).toEqual([a])
  })
})

describe('check', () => {
  it('check marks an entry whose fingerprint changed and installs nothing', async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }])
    await addMarketplace(home, 'other', OTHER, [{ name: 'c', version: '3.0.0' }])
    const a = shared(home, 'a', { fingerprint: await fingerprintOf(home, 'market', 'a') })
    const b = shared(home, 'b', {
      fingerprint: await fingerprintOf(home, 'market', 'b'),
      update: { version: '9.9.9', fingerprint: 'sha256:stale', checkedAt: EARLIER }
    })
    const c = shared(home, 'c', { id: 'c@other', marketplace: 'other', source: OTHER, version: '3.0.0', fingerprint: await fingerprintOf(home, 'other', 'c') })
    await seed(p, [a, b, c])
    const f = fakeRun({
      'plugin marketplace update market': async () => {
        await writeCatalog(home, 'market', [{ name: 'a', version: '1.1.0' }, { name: 'b', version: '1.0.0' }])
        return ok({ command: 'marketplace-update', outcome: 'ok', marketplace: 'market' })
      },
      'plugin marketplace update other': ok({ command: 'marketplace-update', outcome: 'ok', marketplace: 'other' })
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.check())

    expect(job).toMatchObject({ kind: 'check', state: 'done' })
    expect(job.target).toBeUndefined()
    const { update: _stale, ...bCleared } = b
    const after = await readClaudePlugins(p)
    expect(after.plugins).toEqual([
      { ...a, update: { version: '1.1.0', fingerprint: await fingerprintOf(home, 'market', 'a'), checkedAt: NOW.toISOString() } },
      bCleared,
      c
    ])
    expect(after.lastCheck).toEqual({ at: NOW.toISOString() })
    // once per marketplace, and never an install or an update of a plugin (P5)
    expect(f.lines()).toEqual(['plugin marketplace update market', 'plugin marketplace update other'])
    expect(f.calls.some((x) => x.args[1] === 'install' || x.args[1] === 'update')).toBe(false)
  })

  it('check keeps the entry when the marketplace update fails', async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'a', version: '1.0.0' }])
    const a = shared(home, 'a', { fingerprint: await fingerprintOf(home, 'market', 'a') })
    await seed(p, [a])
    // the clone differs on disk, so a recompute would mark the entry: a failed update must leave it alone
    await writeCatalog(home, 'market', [{ name: 'a', version: '2.0.0' }])
    const message = 'Failed to clone marketplace repository: Failed to connect to 192.168.0.10 port 80 after 21063 ms'
    const f = fakeRun({ 'plugin marketplace update market': failure({ command: 'marketplace-update', outcome: 'failed', marketplace: 'market', message }) })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.check())

    expect(job.state).toBe('failed')
    expect(job.message).toContain(message)
    // Claude Code's failure, not one Astera decided
    expect(job.code).toBeUndefined()
    const after = await readClaudePlugins(p)
    expect(after.plugins).toEqual([a])
    expect(after.lastCheck?.at).toBe(NOW.toISOString())
    expect(after.lastCheck?.error).toContain(message)
  })

  it('check with nothing shared runs nothing and writes nothing', async () => {
    const p = await profile()
    const f = fakeRun({})
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.check())

    expect(job.state).toBe('done')
    expect(f.calls).toEqual([])
    expect(await exists(extensionPaths(p).claudePlugins)).toBe(false)
  })
})

describe('update', () => {
  it('update re-records and clears the mark', async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'a', version: '1.0.0' }])
    const h = installs(home)
    const old = await h.put('a@market', '1.0.0')
    const a = shared(home, 'a', {
      installPath: old.installPath,
      enabled: false,
      fingerprint: await fingerprintOf(home, 'market', 'a'),
      update: { version: '1.1.0', fingerprint: 'sha256:seen', checkedAt: EARLIER }
    })
    await seed(p, [a])
    // what the check saw: the catalog offers 1.1.0, which now needs base
    await writeCatalog(home, 'market', [{ name: 'a', version: '1.1.0' }, { name: 'base', version: '2.0.0' }])
    let next = ''
    let base: ClaudePluginDependency | undefined
    const f = fakeRun({
      'plugin update a@market': async () => {
        next = (await h.put('a@market', '1.1.0', ['base'])).installPath
        base = await h.put('base@market', '2.0.0')
        return ok({ command: 'update', outcome: 'ok', updateOutcome: 'updated', oldVersion: '1.0.0', newVersion: '1.1.0' })
      },
      'plugin list': h.list
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.update('a@market'))

    expect(job).toMatchObject({ kind: 'update', target: 'a@market', state: 'done' })
    const { update: _seen, ...kept } = a
    expect((await readClaudePlugins(p)).plugins).toEqual([
      {
        ...kept,
        version: '1.1.0',
        installPath: next,
        dependencies: [base],
        fingerprint: await fingerprintOf(home, 'market', 'a'),
        lastUpdated: NOW.toISOString()
      }
    ])
    expect(f.calls[0]).toEqual({ args: ['plugin', 'update', 'a@market'], timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS })
  })

  it('update with no change clears the mark', async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'a', version: '1.0.0' }])
    const h = installs(home)
    const dir = (await h.put('a@market', '1.0.0')).installPath
    const a = shared(home, 'a', {
      installPath: dir,
      fingerprint: await fingerprintOf(home, 'market', 'a'),
      update: { version: '1.0.0', fingerprint: 'sha256:seen', checkedAt: EARLIER }
    })
    await seed(p, [a])
    // R3: a catalog edit that changes nothing loadable
    await writeCatalog(home, 'market', [{ name: 'a', version: '1.0.0', keywords: ['new'] }])
    const f = fakeRun({
      'plugin update a@market': ok({ command: 'update', outcome: 'ok', updateOutcome: 'up_to_date', oldVersion: '1.0.0', newVersion: '1.0.0' }),
      'plugin list': h.list
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.update('a@market'))

    expect(job.state).toBe('done')
    const { update: _seen, ...kept } = a
    const fingerprint = await fingerprintOf(home, 'market', 'a')
    expect(fingerprint).not.toBe(a.fingerprint)
    expect((await readClaudePlugins(p)).plugins).toEqual([{ ...kept, fingerprint }])
  })

  it('update keeps the entry when Claude Code cannot reach the marketplace', async () => {
    const p = await profile()
    const a = shared(homeOf(p), 'a', { update: { version: '1.1.0', fingerprint: 'sha256:seen', checkedAt: EARLIER } })
    await seed(p, [a])
    const message = 'Failed to clone marketplace repository: Could not resolve host: git.example'
    const f = fakeRun({ 'plugin update a@market': failure({ command: 'update', outcome: 'failed', message }) })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.update('a@market'))

    expect(job).toMatchObject({ state: 'failed', step: 'install', message })
    expect(job.code).toBeUndefined()
    expect((await readClaudePlugins(p)).plugins).toEqual([a])
    expect(f.lines()).toEqual(['plugin update a@market'])
  })

  it("updating a shared plugin that is another's dependency moves that dependency path too", async () => {
    const p = await profile()
    const home = homeOf(p)
    await addMarketplace(home, 'market', SOURCE, [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.0.0' }])
    const h = installs(home)
    const a = await h.put('a@market', '1.0.0', ['b'])
    const b1 = await h.put('b@market', '1.0.0')
    // c's folder is gone (Review Focus 2), so its manifest cannot be walked: it keeps what it records, moved the same way
    const c = path.join(home, 'plugins', 'cache', 'market', 'c', '1.0.0')
    await seed(p, [
      shared(home, 'a', { installPath: a.installPath, dependencies: [b1] }),
      shared(home, 'b', { installPath: b1.installPath, fingerprint: await fingerprintOf(home, 'market', 'b') }),
      shared(home, 'c', { installPath: c, dependencies: [b1] })
    ])
    await writeCatalog(home, 'market', [{ name: 'a', version: '1.0.0' }, { name: 'b', version: '1.1.0' }])
    let b2: ClaudePluginDependency | undefined
    let e: ClaudePluginDependency | undefined
    const f = fakeRun({
      'plugin update b@market': async () => {
        // the new b needs e: a now needs e too, or b does not load in a's sessions (M9)
        b2 = await h.put('b@market', '1.1.0', ['e'])
        e = await h.put('e@market', '0.1.0')
        return ok({ command: 'update', outcome: 'ok', updateOutcome: 'updated', oldVersion: '1.0.0', newVersion: '1.1.0' })
      },
      'plugin list': h.list
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.update('b@market'))

    expect(job.state).toBe('done')
    const plugins = (await readClaudePlugins(p)).plugins
    expect(plugins.map((x) => [x.id, x.version, x.installPath, x.dependencies])).toEqual([
      ['a@market', '1.0.0', a.installPath, [b2, e]],
      ['b@market', '1.1.0', b2?.installPath, [e]],
      ['c@market', '1.0.0', c, [b2]]
    ])
  })
})

describe('remove', () => {
  it('remove drops the entry before uninstall', async () => {
    const p = await profile()
    const home = homeOf(p)
    await seed(p, [shared(home, 'a'), shared(home, 'b')])
    let during: string[] = []
    const f = fakeRun({
      'plugin uninstall a@market': async () => {
        during = (await readClaudePlugins(p)).plugins.map((e) => e.id)
        return uninstalled
      }
    })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.remove('a@market'))

    expect(job).toMatchObject({ kind: 'remove', target: 'a@market', state: 'done' })
    expect(during).toEqual(['b@market'])
    expect(f.lines()).toEqual(['plugin uninstall a@market'])
  })

  it('remove keeps a dependency another entry still records', async () => {
    const p = await profile()
    const home = homeOf(p)
    const dep = (name: string) => ({ id: `${name}@market`, version: '1.0.0', installPath: path.join(home, 'plugins', 'cache', 'market', name, '1.0.0') })
    await seed(p, [
      shared(home, 'a', { dependencies: [dep('base'), dep('util'), dep('c')] }),
      shared(home, 'b', { dependencies: [dep('base')] }),
      shared(home, 'c')
    ])
    const f = fakeRun({ 'plugin uninstall a@market': uninstalled, 'plugin uninstall util@market': uninstalled })
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.remove('a@market'))

    expect(job.state).toBe('done')
    // base is b's dependency and c is shared itself
    expect(f.lines()).toEqual(['plugin uninstall a@market', 'plugin uninstall util@market'])
    expect((await readClaudePlugins(p)).plugins.map((e) => e.id)).toEqual(['b@market', 'c@market'])
  })

  it('remove leaves installed a plugin another entry records as its dependency', async () => {
    const p = await profile()
    const home = homeOf(p)
    const c = shared(home, 'c')
    await seed(p, [shared(home, 'a', { dependencies: [{ id: c.id, version: c.version, installPath: c.installPath }] }), c])
    const f = fakeRun({})
    const ops = opsFor(p, f.run)
    const job = await ended(ops, ops.remove('c@market'))

    expect(job.state).toBe('done')
    expect(f.calls).toEqual([])
    expect((await readClaudePlugins(p)).plugins.map((e) => e.id)).toEqual(['a@market'])
  })

  it('remove succeeds when the plugin or a dependency is already gone', async () => {
    const p = await profile()
    const home = homeOf(p)
    const dep = (name: string) => ({ id: `${name}@market`, version: '1.0.0', installPath: path.join(home, 'plugins', 'cache', 'market', name, '1.0.0') })
    await seed(p, [shared(home, 'a', { dependencies: [dep('x'), dep('y')] }), shared(home, 'b')])
    const f = fakeRun({
      'plugin uninstall a@market': notInstalled('a@market'),
      'plugin uninstall x@market': uninstalled,
      'plugin uninstall y@market': notInstalled('y@market'),
      'plugin uninstall b@market': failure({ command: 'uninstall', outcome: 'failed', message: 'EBUSY: resource busy or locked' })
    })
    const ops = opsFor(p, f.run)

    const gone = await ended(ops, ops.remove('a@market'))
    expect(gone.state).toBe('done')
    expect(f.lines()).toEqual(['plugin uninstall a@market', 'plugin uninstall x@market', 'plugin uninstall y@market'])

    // any other failure still fails, with Claude Code's message and no code
    const busy = await ended(ops, ops.remove('b@market'))
    expect(busy).toMatchObject({ state: 'failed', step: 'install', message: 'EBUSY: resource busy or locked' })
    expect(busy.code).toBeUndefined()
    expect((await readClaudePlugins(p)).plugins).toEqual([])
  })
})

describe('the queue', () => {
  it('jobs run one at a time', async () => {
    const p = await profile()
    const home = homeOf(p)
    await seed(p, [shared(home, 'a'), shared(home, 'b')])
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const f = fakeRun({
      'plugin uninstall a@market': async () => {
        await gate
        return uninstalled
      },
      'plugin uninstall b@market': uninstalled
    })
    const ops = opsFor(p, f.run)
    const first = ops.remove('a@market')
    const second = ops.remove('b@market')
    expect(first).not.toBe(second)

    await vi.waitFor(() => expect(f.calls.length).toBe(1), { timeout: 5_000, interval: 5 })
    expect(ops.jobs().map((j) => [j.id, j.state])).toEqual([
      [first, 'running'],
      [second, 'queued']
    ])
    // the second job has not touched the store while the first waits on Claude Code
    expect((await readClaudePlugins(p)).plugins.map((e) => e.id)).toEqual(['b@market'])

    release()
    await ended(ops, second)
    expect(f.lines()).toEqual(['plugin uninstall a@market', 'plugin uninstall b@market'])
    expect(ops.jobs().map((j) => j.state)).toEqual(['done', 'done'])
  })

  it('jobs() keeps the live ones and the last 20 ended, newest last', async () => {
    const p = await profile()
    const ops = opsFor(p, fakeRun({}).run)
    const ids: string[] = []
    for (let i = 0; i < 25; i++) ids.push(ops.check())
    expect(new Set(ids).size).toBe(25)
    await ended(ops, ids[24])
    expect(ops.jobs().map((j) => j.id)).toEqual(ids.slice(5))
  })

  it('jobs() hands out copies', async () => {
    const p = await profile()
    const ops = opsFor(p, fakeRun({}).run)
    const id = ops.check()
    const job = await ended(ops, id)
    job.state = 'failed'
    expect(ops.jobs()[0].state).toBe('done')
  })

  it('update or remove of an id not shared fails with not-shared and runs nothing', async () => {
    const p = await profile()
    const f = fakeRun({})
    const ops = opsFor(p, f.run)
    expect(await ended(ops, ops.update('a@market'))).toMatchObject({ state: 'failed', code: 'not-shared' })
    expect(await ended(ops, ops.remove('a@market'))).toMatchObject({ state: 'failed', code: 'not-shared' })
    expect(f.calls).toEqual([])
  })

  it('a job on a damaged store fails with store-unreadable and runs nothing', async () => {
    const p = await profile()
    await write(extensionPaths(p).claudePlugins, '{ broken')
    const f = fakeRun({})
    const ops = opsFor(p, f.run)
    expect(await ended(ops, ops.share({ id: 'a@market', source: SOURCE, importedFrom: 'acc_1' }))).toMatchObject({ state: 'failed', code: 'store-unreadable' })
    expect(await ended(ops, ops.check())).toMatchObject({ state: 'failed', code: 'store-unreadable' })
    expect(f.calls).toEqual([])
  })
})

describe('setEnabled', () => {
  it('setEnabled stamps enabledAt when switching on', async () => {
    const p = await profile()
    await seed(p, [shared(homeOf(p), 'a', { enabled: false }), shared(homeOf(p), 'b')])
    let clock = new Date('2026-11-02T10:00:00.000Z')
    const f = fakeRun({})
    const ops = opsFor(p, f.run, () => clock)
    const a = async () => (await readClaudePlugins(p)).plugins[0]

    await ops.setEnabled('a@market', true)
    expect(await a()).toMatchObject({ enabled: true, enabledAt: '2026-11-02T10:00:00.000Z' })

    clock = new Date('2026-11-02T11:00:00.000Z')
    await ops.setEnabled('a@market', true)
    expect((await a()).enabledAt).toBe('2026-11-02T10:00:00.000Z')

    await ops.setEnabled('a@market', false)
    expect(await a()).toMatchObject({ enabled: false, enabledAt: '2026-11-02T10:00:00.000Z' })

    clock = new Date('2026-11-02T12:00:00.000Z')
    await ops.setEnabled('a@market', true)
    expect(await a()).toMatchObject({ enabled: true, enabledAt: '2026-11-02T12:00:00.000Z' })

    expect((await readClaudePlugins(p)).plugins[1]).toEqual(shared(homeOf(p), 'b'))
    expect(f.calls).toEqual([])
    expect(ops.jobs()).toEqual([])
  })
})

/** A version folder in the home's cache. `orphanedDaysAgo` gives it Claude Code's marker, its mtime that many days ago
 *  and its content far older: Claude Code reads the mtime (M6). */
async function versionFolder(home: string, name: string, version: string, orphanedDaysAgo?: number): Promise<string> {
  const dir = path.join(home, 'plugins', 'cache', 'market', name, version)
  await write(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }))
  if (orphanedDaysAgo !== undefined) await marker(dir, orphanedDaysAgo)
  return dir
}
async function marker(dir: string, daysAgo: number): Promise<void> {
  const file = path.join(dir, '.orphaned_at')
  await write(file, String(NOW.getTime() - 99 * DAY))
  await age(file, daysAgo)
}
const age = (file: string, daysAgo: number): Promise<void> => {
  const t = new Date(NOW.getTime() - daysAgo * DAY)
  return fs.utimes(file, t, t)
}
const stampFile = (p: string, installPath: string): string =>
  path.join(extensionPaths(p).claudePluginUse, createHash('sha256').update(installPath).digest('hex').slice(0, 16))

describe('use stamps and the sweep', () => {
  it('stampClaudePluginUse touches one file per path, holding the path', async () => {
    const p = await profile()
    const a = path.join(p, 'extensions', 'claude-plugins', 'plugins', 'cache', 'market', 'a 한글', '1.0.0')
    const b = path.join(p, 'extensions', 'claude-plugins', 'plugins', 'cache', 'market', 'b', '2.0.0')
    await stampClaudePluginUse(p, [a, b, a])

    const names = await fs.readdir(extensionPaths(p).claudePluginUse)
    expect(names.sort()).toEqual([path.basename(stampFile(p, a)), path.basename(stampFile(p, b))].sort())
    for (const n of names) expect(n).toMatch(/^[0-9a-f]{16}$/)
    expect(await fs.readFile(stampFile(p, a), 'utf8')).toBe(a)

    await age(stampFile(p, a), 40)
    await stampClaudePluginUse(p, [a])
    expect(Date.now() - (await fs.stat(stampFile(p, a))).mtimeMs).toBeLessThan(60_000)
    expect(await fs.readFile(stampFile(p, a), 'utf8')).toBe(a)
  })

  it('sweep deletes only an old, unused, unrecorded orphan', async () => {
    const p = await profile()
    const home = homeOf(p)
    const old = await versionFolder(home, 'a', '1.0.0', 20)
    const freshMarker = await versionFolder(home, 'a', '1.1.0', 3)
    const recorded = await versionFolder(home, 'a', '1.2.0', 20)
    const recordedDependency = await versionFolder(home, 'base', '2.0.0', 20)
    const usedLately = await versionFolder(home, 'b', '1.0.0', 20)
    const usedLongAgo = await versionFolder(home, 'b', '0.9.0', 20)
    const noMarker = await versionFolder(home, 'c', '1.0.0')
    // the marketplace clone is never looked at, whatever it holds
    const clone = path.join(home, 'plugins', 'marketplaces', 'market', 'a', '1.0.0')
    await write(path.join(clone, 'plugin.json'), '{}')
    await marker(clone, 20)
    await seed(p, [
      shared(home, 'a', { version: '1.2.0', installPath: recorded, dependencies: [{ id: 'base@market', version: '2.0.0', installPath: recordedDependency }] })
    ])
    await stampClaudePluginUse(p, [usedLately, usedLongAgo])
    await age(stampFile(p, usedLately), 10)
    await age(stampFile(p, usedLongAgo), 40)

    const deleted = await sweepOrphanedClaudePlugins(p, NOW)

    expect([...deleted].sort()).toEqual([old, usedLongAgo].sort())
    for (const gone of [old, usedLongAgo]) expect(await exists(gone)).toBe(false)
    for (const kept of [freshMarker, recorded, recordedDependency, usedLately, noMarker, clone]) expect(await exists(kept)).toBe(true)
    // the stamp of a deleted folder goes with it
    expect(await exists(stampFile(p, usedLongAgo))).toBe(false)
    expect(await exists(stampFile(p, usedLately))).toBe(true)
  })

  it('sweep never follows a link out of the cache', async () => {
    const p = await profile()
    const home = homeOf(p)
    const outside = path.join(p, 'outside')
    await write(path.join(outside, 'keep.txt'), 'x')
    await marker(outside, 20)
    // a version that is a link to a folder elsewhere, marked an old orphan
    const linked = path.join(home, 'plugins', 'cache', 'market', 'a', '9.9.9')
    await fs.mkdir(path.dirname(linked), { recursive: true })
    await fs.symlink(outside, linked, 'junction')
    // an old orphan holding a link: the link goes with it, what it points at stays
    const orphan = await versionFolder(home, 'a', '1.0.0', 20)
    await fs.symlink(outside, path.join(orphan, 'escape'), 'junction')

    expect(await sweepOrphanedClaudePlugins(p, NOW)).toEqual([orphan])
    expect(await exists(linked)).toBe(true)
    expect(await exists(path.join(outside, 'keep.txt'))).toBe(true)
    expect(await exists(path.join(outside, '.orphaned_at'))).toBe(true)

    // a cache that is itself a link: nothing under it is looked at
    const p2 = await profile()
    const elsewhere = path.join(p2, 'elsewhere')
    const target = path.join(elsewhere, 'market', 'a', '1.0.0')
    await write(path.join(target, 'plugin.json'), '{}')
    await marker(target, 20)
    await fs.mkdir(path.join(homeOf(p2), 'plugins'), { recursive: true })
    await fs.symlink(elsewhere, path.join(homeOf(p2), 'plugins', 'cache'), 'junction')

    expect(await sweepOrphanedClaudePlugins(p2, NOW)).toEqual([])
    expect(await exists(target)).toBe(true)
  })

  it('sweep deletes nothing while the store cannot be read', async () => {
    const p = await profile()
    const old = await versionFolder(homeOf(p), 'a', '1.0.0', 20)
    await write(extensionPaths(p).claudePlugins, '{ broken')

    expect(await sweepOrphanedClaudePlugins(p, NOW)).toEqual([])
    expect(await exists(old)).toBe(true)
    // and keeps no copy of the damage: the Host's own reading of the store does that
    expect((await fs.readdir(path.dirname(extensionPaths(p).claudePlugins))).sort()).toEqual(['claude-plugins', 'claude-plugins.json'])
  })
})
