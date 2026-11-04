// Sharing a Claude Code plugin across accounts: Astera installs it once in its own config folder (the "home") with
// `claude plugin …`, records it in the plugin store, and every Claude session is then handed its folder. Each change is a
// job on one serial queue that answers its id at once, since an install can clone a repository and take minutes; the
// settings tab polls `jobs()`. A marketplace command runs only once the person saw it: a result that shows one ends the
// job asking for confirmation, and the same action comes back with its sha256 (M8). A job that fails leaves the store as
// it was, except a removal, which drops the entry first so new sessions stop loading the plugin at once; a share that
// fails after its install takes that install back.
//
// Claude Code never sweeps the home, because no session starts there (M6), so Astera removes the version folders that
// `update` and `uninstall` leave behind, sparing any a session was handed in the last 30 days.
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { extensionPaths } from '../../profile/paths'
import { writeThroughTmp } from '../../accounts/fileQueue'
import { RepairNeeded } from '../../settings/repairNeeded'
import { catalogFingerprint } from './catalog'
import { PLUGIN_INSTALL_TIMEOUT_MS, type PluginCliResult, type PluginCliRun } from './cli'
import { marketplaceArg } from './discover'
import { readClaudePlugins, updateClaudePlugins } from './store'
import type {
  ClaudePluginDependency,
  ClaudePluginFailureCode,
  ClaudePluginJob,
  ClaudePluginJobKind,
  ClaudePluginStore,
  MarketplaceSource,
  SharedClaudePlugin
} from './types'

export type { ClaudePluginFailureCode, ClaudePluginJob, ClaudePluginJobKind } from './types'

export interface ClaudePluginOps {
  share(p: { id: string; source: MarketplaceSource; importedFrom: string; acceptCommand?: string }): string
  update(id: string, acceptCommand?: string): string
  check(): string
  remove(id: string): string
  /** A store write, not a job: it changes what the next session is handed and runs nothing. */
  setEnabled(id: string, on: boolean): Promise<void>
  /** The queued and running jobs and the last 20 ended, in the order they were asked for. */
  jobs(): ClaudePluginJob[]
  /** Runs `work` on the jobs' queue, after every job queued before it and before any queued after, with no job record. Its
   *  result or rejection is its caller's alone: a rejection does not hold up the jobs behind it. */
  runExclusive<T>(work: () => Promise<T>): Promise<T>
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

type Confirmation = NonNullable<ClaudePluginJob['command']>

/** Ends a job before its last step, failed or asking for confirmation. */
class Stop extends Error {
  constructor(
    message: string,
    readonly code?: ClaudePluginFailureCode,
    readonly confirm: Confirmation | null = null
  ) {
    super(message)
  }
}
const failed = (message: string, code?: ClaudePluginFailureCode): Stop => new Stop(message, code)

/** How many ended jobs `jobs()` still lists. */
const ENDED_KEPT = 20

/** What a confirmation shows (M8): the command, and for an entry's headersHelper the archive its headers go to. Null
 *  when the result shows none. */
function shownCommand(json: PluginCliResult['json']): Confirmation | null {
  if (!isObj(json) || !isObj(json.shownCommand)) return null
  const { command, archiveUrl, sha256 } = json.shownCommand
  if (typeof command !== 'string' || typeof sha256 !== 'string') return null
  return { text: typeof archiveUrl === 'string' ? `${command}\n${archiveUrl}` : command, sha256 }
}

const succeeded = (r: PluginCliResult): boolean => r.refused === undefined && !r.timedOut && r.code === 0 && isObj(r.json) && r.json.outcome === 'ok'

/** A run that did not succeed, as the job's failure. A refusal and a time limit are Astera's; anything else is Claude
 *  Code's own answer: its JSON message, else stderr, else the exit code. */
function cliFailed(r: PluginCliResult, args: string[]): Stop {
  if (r.refused !== undefined) return failed(r.refused, 'refused')
  const err = r.stderr.trim()
  if (r.timedOut) return failed(err !== '' ? err : `claude ${args.join(' ')} did not finish in time`, 'timed-out')
  if (isObj(r.json) && typeof r.json.message === 'string' && r.json.message !== '') return failed(r.json.message)
  return failed(err !== '' ? err : `claude ${args.join(' ')} exited with code ${String(r.code)}`)
}

const marketplaceOf = (id: string): string => id.slice(id.lastIndexOf('@') + 1)

/** A row of `claude plugin list --json` (M1), at user scope: Claude Code's install in the home. */
interface Installed {
  id: string
  version: string
  installPath: string
}

/** The ids a plugin's manifest names in `dependencies` (plugin-dependencies docs): a bare name is in the declaring
 *  plugin's own marketplace; `name@m` and `{ name, marketplace }` are in another; a `version` range says nothing about
 *  which folder Claude Code installed. A plugin folder without a manifest declares none; a folder that is not there says
 *  nothing, so it fails. */
async function declaredDependencies(installPath: string, marketplace: string): Promise<string[]> {
  const file = path.join(installPath, '.claude-plugin', 'plugin.json')
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw failed(`${file} could not be read (${String(e)})`, 'dependency-missing')
    if (await fs.stat(installPath).then((s) => s.isDirectory(), () => false)) return []
    throw failed(`${installPath} is missing`, 'dependency-missing')
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(text)
  } catch {
    throw failed(`${file} is not JSON`, 'dependency-missing')
  }
  const deps: unknown[] = isObj(manifest) && Array.isArray(manifest.dependencies) ? manifest.dependencies : []
  return deps.map((dep) => {
    if (typeof dep === 'string') return dep.includes('@') ? dep : `${dep}@${marketplace}`
    if (isObj(dep) && typeof dep.name === 'string') return `${dep.name}@${typeof dep.marketplace === 'string' ? dep.marketplace : marketplace}`
    throw failed(`${file} names a dependency Astera cannot read: ${JSON.stringify(dep)}`, 'dependency-missing')
  })
}

/** Every plugin `owner` needs, through each one's own manifest in turn, each once, as `known` has it installed: a
 *  session needs each one's folder too, or the owner does not load (M9). */
async function dependenciesOf(owner: Installed, known: Installed[]): Promise<ClaudePluginDependency[]> {
  const out: ClaudePluginDependency[] = []
  const seen = new Set([owner.id])
  const walk = async (plugin: Installed): Promise<void> => {
    for (const id of await declaredDependencies(plugin.installPath, marketplaceOf(plugin.id))) {
      if (seen.has(id)) continue
      seen.add(id)
      const dep = known.find((r) => r.id === id)
      if (!dep) throw failed(`${owner.id} needs ${id}, which Claude Code did not install`, 'dependency-missing')
      out.push({ id, version: dep.version, installPath: dep.installPath })
      await walk(dep)
    }
  }
  await walk(owner)
  return out
}

/** The home's `known_marketplaces.json`; empty before the first `marketplace add`. */
async function knownMarketplaces(home: string): Promise<Obj> {
  const file = path.join(home, 'plugins', 'known_marketplaces.json')
  let text: string
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw failed(`${file} could not be read (${String(e)})`, 'home-unreadable')
  }
  try {
    const known: unknown = JSON.parse(text)
    if (isObj(known)) return known
  } catch {
    // reported below
  }
  throw failed(`${file} is damaged`, 'home-unreadable')
}

export function createClaudePluginOps(d: {
  profileDir: string
  run: PluginCliRun
  now?: () => Date
  log?: (l: string) => void
  /** Called once for each job when its state is final (done, failed or needs confirmation), before the oldest ended jobs
   *  are dropped from `jobs()`. */
  onJobEnd?: (job: ClaudePluginJob) => void
}): ClaudePluginOps {
  const home = extensionPaths(d.profileDir).claudePluginHome
  const now = (): string => (d.now ?? (() => new Date()))().toISOString()

  /** Runs a command that answers `{ outcome }` and returns when the outcome is ok. A result that shows a command ends
   *  the job asking for confirmation, even after one was given (a changed catalog voids the sha, M8); any other ends it
   *  failed. */
  const runOk = async (args: string[], o?: { timeoutMs?: number }): Promise<void> => {
    const r = await d.run(args, o)
    if (succeeded(r)) return
    const shown = r.refused === undefined ? shownCommand(r.json) : null
    throw shown ? new Stop('the marketplace command needs confirmation', undefined, shown) : cliFailed(r, args)
  }

  /** Uninstalls one plugin from the home. One already gone counts as uninstalled (M12: `failureCode: "not_installed"`),
   *  so a removal can be repeated. */
  const uninstall = async (id: string): Promise<void> => {
    const args = ['plugin', 'uninstall', id]
    const r = await d.run(args)
    if (succeeded(r) || (r.refused === undefined && !r.timedOut && isObj(r.json) && r.json.failureCode === 'not_installed')) return
    throw cliFailed(r, args)
  }

  const list = async (): Promise<Installed[]> => {
    const args = ['plugin', 'list']
    const r = await d.run(args)
    if (r.refused !== undefined || r.timedOut || r.code !== 0 || !Array.isArray(r.json)) throw cliFailed(r, args)
    return r.json
      .filter((x): x is Obj => isObj(x) && x.scope === 'user' && typeof x.id === 'string' && typeof x.version === 'string' && typeof x.installPath === 'string')
      .map((x) => ({ id: x.id as string, version: x.version as string, installPath: x.installPath as string }))
  }
  const installedAs = (rows: Installed[], id: string): Installed => {
    const found = rows.find((r) => r.id === id)
    if (!found) throw failed(`Claude Code does not list ${id} as installed`, 'not-listed')
    return found
  }
  const accept = (sha: string | undefined): string[] => (sha === undefined ? [] : ['--accept-command', sha])
  const entryOf = async (id: string): Promise<SharedClaudePlugin> => {
    const entry = (await readClaudePlugins(d.profileDir)).plugins.find((e) => e.id === id)
    if (!entry) throw failed(`${id} is not shared`, 'not-shared')
    return entry
  }

  /** Writes the store as `change` leaves it, with every entry's dependencies walked again against `rows`, the list after
   *  the command. An id then has one folder across the store (a shared plugin's own record, else Claude Code's install),
   *  and what a dependency's new version needs comes along (M9). The walk of `target` must succeed; another entry whose
   *  walk fails (its folder gone, Review Focus 2) keeps what it records, moved to the same folders. */
  const record = (rows: Installed[], target: string, change: (plugins: SharedClaudePlugin[]) => SharedClaudePlugin[]) =>
    updateClaudePlugins(d.profileDir, async (s) => {
      const plugins = change(s.plugins)
      const known: Installed[] = [...plugins, ...rows]
      const moved = (x: ClaudePluginDependency): ClaudePluginDependency => {
        const k = known.find((r) => r.id === x.id)
        return k ? { id: x.id, version: k.version, installPath: k.installPath } : x
      }
      const walked: SharedClaudePlugin[] = []
      for (const e of plugins) {
        let dependencies: ClaudePluginDependency[]
        try {
          dependencies = await dependenciesOf(e, known)
        } catch (err) {
          if (e.id === target || !(err instanceof Stop)) throw err
          d.log?.(`claude plugins: kept the recorded dependencies of ${e.id} (${err.message})`)
          dependencies = e.dependencies.map(moved)
        }
        walked.push({ ...e, dependencies })
      }
      return { ...s, plugins: walked }
    })

  const share = async (job: ClaudePluginJob, p: Parameters<ClaudePluginOps['share']>[0]): Promise<void> => {
    const at = p.id.lastIndexOf('@')
    if (at <= 0 || at === p.id.length - 1) throw failed(`${p.id} is not a plugin id`, 'not-shareable')
    const name = p.id.slice(0, at)
    const marketplace = p.id.slice(at + 1)
    const plugins = (await readClaudePlugins(d.profileDir)).plugins
    if (plugins.some((e) => e.id === p.id)) throw failed(`${p.id} is already shared`, 'already-shared')
    // Asked here, in the queue, and not only when the share was asked for: two same-name shares asked together both pass
    // that check, and both would load as `<name>@inline` (C3)
    const taken = plugins.find((e) => e.name === name)
    if (taken) throw failed(`${taken.id} is already shared under the name ${name}`, 'name-taken')
    const arg = marketplaceArg(p.source)
    if (arg === null) throw failed(`the source of marketplace ${marketplace} cannot be given to claude plugin marketplace add`, 'not-shareable')

    job.step = 'marketplace'
    const known = (await knownMarketplaces(home))[marketplace]
    if (known === undefined) await runOk(['plugin', 'marketplace', 'add', arg])
    // A same-name add would re-point the marketplace, and the plugins already installed from it with it (M10)
    else if (!isObj(known) || !isObj(known.source) || marketplaceArg(known.source as MarketplaceSource) !== arg)
      throw failed(`marketplace ${marketplace} is already in Astera's plugin folder from another source`, 'marketplace-mismatch')

    job.step = 'install'
    // What the home held before, so a failure after the install takes back only what this share installed
    const before = await list()
    await runOk(['plugin', 'install', p.id, ...accept(p.acceptCommand)], { timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS })

    job.step = 'record'
    try {
      const rows = await list()
      const installed = installedAs(rows, p.id)
      const fp = await catalogFingerprint({ home, marketplace, name })
      if (fp === null) throw failed(`the catalog entry of ${p.id} in Astera's plugin folder could not be read, so its updates could not be found`, 'catalog-unreadable')
      const stamp = now()
      const entry: SharedClaudePlugin = {
        id: p.id,
        name,
        marketplace,
        source: p.source,
        version: installed.version,
        installPath: installed.installPath,
        dependencies: [],
        importedFrom: p.importedFrom,
        enabled: true,
        addedAt: stamp,
        lastUpdated: stamp,
        fingerprint: fp.fingerprint
      }
      await record(rows, p.id, (plugins) => [...plugins, entry])
    } catch (e) {
      // Leave the home as it was: an install nobody records is never used and never swept. Its dependencies stay (M12)
      if (!before.some((r) => r.id === p.id)) {
        await uninstall(p.id).catch((u: unknown) => d.log?.(`claude plugins: ${p.id} stays installed after the failed share (${u instanceof Error ? u.message : String(u)})`))
      }
      throw e
    }
  }

  /** Refreshes each marketplace's clone and compares each entry's fingerprint with the recorded one (R3). Never an
   *  install or an update: a version changes only when the person presses update (P5). An entry whose marketplace could
   *  not be refreshed, or whose catalog cannot be read, keeps what it has. */
  const check = async (job: ClaudePluginJob): Promise<void> => {
    const plugins = (await readClaudePlugins(d.profileDir)).plugins
    if (plugins.length === 0) return
    job.step = 'marketplace'
    const errors: string[] = []
    const refreshed = new Set<string>()
    for (const m of new Set(plugins.map((e) => e.marketplace))) {
      const args = ['plugin', 'marketplace', 'update', m]
      const r = await d.run(args)
      if (succeeded(r)) refreshed.add(m)
      else errors.push(`${m}: ${cliFailed(r, args).message}`)
    }
    job.step = 'record'
    const offers = new Map<string, { fingerprint: string; offeredVersion: string | null }>()
    for (const e of plugins) {
      if (!refreshed.has(e.marketplace)) continue
      const fp = await catalogFingerprint({ home, marketplace: e.marketplace, name: e.name })
      if (fp !== null) offers.set(e.id, fp)
    }
    const at = now()
    const error = errors.join('\n')
    await updateClaudePlugins(d.profileDir, (s) => ({
      ...s,
      plugins: s.plugins.map((e) => {
        const offer = offers.get(e.id)
        if (!offer) return e
        if (offer.fingerprint === e.fingerprint) {
          const { update: _cleared, ...same } = e
          return same
        }
        return { ...e, update: { version: offer.offeredVersion, fingerprint: offer.fingerprint, checkedAt: at } }
      }),
      lastCheck: error === '' ? { at } : { at, error }
    }))
    if (error !== '') throw failed(error)
  }

  const update = async (job: ClaudePluginJob, id: string, acceptCommand: string | undefined): Promise<void> => {
    const entry = await entryOf(id)
    job.step = 'install'
    await runOk(['plugin', 'update', id, ...accept(acceptCommand)], { timeoutMs: PLUGIN_INSTALL_TIMEOUT_MS })

    job.step = 'record'
    const rows = await list()
    const installed = installedAs(rows, id)
    const moved = installed.version !== entry.version || installed.installPath !== entry.installPath
    // Null keeps the recorded fingerprint: there is nothing to compare, and the next check that can read it decides
    const fp = await catalogFingerprint({ home, marketplace: entry.marketplace, name: entry.name })
    const at = now()
    await record(rows, id, (plugins) =>
      plugins.map((e) => {
        if (e.id !== id) return e
        const { update: _done, ...rest } = e
        return {
          ...rest,
          ...(fp === null ? {} : { fingerprint: fp.fingerprint }),
          ...(moved ? { version: installed.version, installPath: installed.installPath, lastUpdated: at } : {})
        }
      })
    )
  }

  /** Drops the entry, then uninstalls it and each of its dependencies that no remaining entry records, as its own id or
   *  as a dependency: Claude Code leaves each folder with a `.orphaned_at` marker (M3) for the sweep. */
  const remove = async (job: ClaudePluginJob, id: string): Promise<void> => {
    job.step = 'record'
    const entry = await entryOf(id)
    let still = new Set<string>()
    await updateClaudePlugins(d.profileDir, (s) => {
      const remaining = s.plugins.filter((e) => e.id !== id)
      still = new Set(remaining.flatMap((e) => [e.id, ...e.dependencies.map((x) => x.id)]))
      return { ...s, plugins: remaining }
    })
    job.step = 'install'
    for (const target of [id, ...entry.dependencies.map((x) => x.id)]) {
      if (!still.has(target)) await uninstall(target)
    }
  }

  // One job at a time, in the order asked: two commands in one config folder would race over its files
  const all: ClaudePluginJob[] = []
  let chain: Promise<unknown> = Promise.resolve()
  const live = (j: ClaudePluginJob): boolean => j.state === 'queued' || j.state === 'running'
  const copyOf = (j: ClaudePluginJob): ClaudePluginJob => ({ ...j, ...(j.command === undefined ? {} : { command: { ...j.command } }) })

  const enqueue = (kind: ClaudePluginJobKind, target: string | undefined, work: (job: ClaudePluginJob) => Promise<void>): string => {
    const job: ClaudePluginJob = { id: randomUUID(), kind, ...(target === undefined ? {} : { target }), state: 'queued', startedAt: now() }
    all.push(job)
    const run = async (): Promise<void> => {
      job.state = 'running'
      try {
        await work(job)
        job.state = 'done'
      } catch (e) {
        if (e instanceof Stop && e.confirm !== null) {
          job.state = 'needs-confirmation'
          job.command = e.confirm
        } else {
          job.state = 'failed'
          job.message = e instanceof Error ? e.message : String(e)
          const code = e instanceof Stop ? e.code : e instanceof RepairNeeded ? 'store-unreadable' : undefined
          if (code !== undefined) job.code = code
        }
      }
      job.endedAt = now()
      // A listener's failure is its own: the job has ended, and the queue goes on
      try {
        d.onJobEnd?.(copyOf(job))
      } catch (e) {
        d.log?.(`claude plugins: the listener of an ended ${kind} job failed (${e instanceof Error ? e.message : String(e)})`)
      }
      const ended = all.filter((j) => !live(j))
      for (const j of ended.slice(0, Math.max(0, ended.length - ENDED_KEPT))) all.splice(all.indexOf(j), 1)
      if (job.state !== 'done') {
        const why = `${job.code === undefined ? '' : ` [${job.code}]`}${job.message === undefined ? '' : ` (${job.message})`}`
        d.log?.(`claude plugins: ${kind}${target === undefined ? '' : ` ${target}`} ${job.state}${why}`)
      }
    }
    const next = chain.then(run, run)
    chain = next.catch(() => {})
    return job.id
  }

  return {
    share: (p) => enqueue('share', p.id, (job) => share(job, p)),
    update: (id, acceptCommand) => enqueue('update', id, (job) => update(job, id, acceptCommand)),
    check: () => enqueue('check', undefined, check),
    remove: (id) => enqueue('remove', id, (job) => remove(job, id)),
    // As the other kinds: a switch from off to on is stamped, so the days it was off do not count as unused
    setEnabled: async (id, on) => {
      const at = now()
      await updateClaudePlugins(d.profileDir, (s) => ({
        ...s,
        plugins: s.plugins.map((e) => (e.id !== id ? e : on && !e.enabled ? { ...e, enabled: on, enabledAt: at } : { ...e, enabled: on }))
      }))
    },
    jobs: () => all.map(copyOf),
    runExclusive: <T>(work: () => Promise<T>): Promise<T> => {
      const run = chain.then(work, work)
      chain = run.catch(() => {})
      return run
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Claude Code's own wait after it marks a version folder orphaned (M6: the marker's mtime, 14 days). */
const ORPHAN_GRACE_MS = 14 * DAY_MS
/** A folder a session was handed this recently may still be loaded (sweepGeneratedMcp's window). */
const UNUSED_MS = 30 * DAY_MS

const stampName = (installPath: string): string => createHash('sha256').update(installPath).digest('hex').slice(0, 16)

/** Notes that a session was just handed each folder: one file per path, holding the path, its mtime the last use.
 *  Touched rather than rewritten, so a sweep reading it at that moment never finds it empty. */
export async function stampClaudePluginUse(profileDir: string, installPaths: string[]): Promise<void> {
  const dir = extensionPaths(profileDir).claudePluginUse
  await fs.mkdir(dir, { recursive: true })
  const at = new Date()
  await Promise.all(
    [...new Set(installPaths)].map(async (installPath) => {
      const file = path.join(dir, stampName(installPath))
      try {
        await fs.utimes(file, at, at)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        await writeThroughTmp(file, installPath)
      }
    })
  )
}

/** A folder as the sweep compares it: resolved, and in one case, as Windows and macOS name folders. On Linux two folders
 *  that differ only in case then count as one, which only ever keeps a folder. */
const sameFolder = (p: string): string => path.resolve(p).toLowerCase()

/** The last use of each stamped folder, read from what each stamp holds rather than from its name, so a path spelled
 *  another way (separators, case) still finds its stamp. */
async function lastUses(profileDir: string): Promise<Map<string, { mtimeMs: number; files: string[] }>> {
  const dir = extensionPaths(profileDir).claudePluginUse
  const uses = new Map<string, { mtimeMs: number; files: string[] }>()
  for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
    const file = path.join(dir, name)
    const [text, st] = await Promise.all([fs.readFile(file, 'utf8').catch(() => ''), fs.stat(file).catch(() => null)])
    if (text === '' || st === null) continue
    const key = sameFolder(text)
    const seen = uses.get(key)
    uses.set(key, { mtimeMs: Math.max(seen?.mtimeMs ?? 0, st.mtimeMs), files: [...(seen?.files ?? []), file] })
  }
  return uses
}

/** The real folders in `dir`, never a link to one. */
async function subfolders(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries.filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name))
}

/** Deletes the version folders `<home>/plugins/cache/<marketplace>/<plugin>/<version>` that Claude Code marked orphaned
 *  at least 14 days ago, that no store entry or recorded dependency names, and that no session was handed in the last 30
 *  days, with their use stamps. It walks real folders only, so it never follows a link out of the cache, and it never
 *  looks at the marketplace clones or at any account's folder. A store it cannot read deletes nothing: it would not know
 *  which folders are recorded. Resolves to the folders it deleted; never rejects. */
export async function sweepOrphanedClaudePlugins(profileDir: string, now: Date = new Date()): Promise<string[]> {
  let store: ClaudePluginStore
  try {
    store = await readClaudePlugins(profileDir, { keepDamaged: false })
  } catch {
    return []
  }
  const recorded = new Set(store.plugins.flatMap((e) => [e.installPath, ...e.dependencies.map((x) => x.installPath)]).map(sameFolder))
  const home = extensionPaths(profileDir).claudePluginHome
  const cache = path.join(home, 'plugins', 'cache')
  for (const dir of [home, path.join(home, 'plugins'), cache]) {
    const st = await fs.lstat(dir).catch(() => null)
    if (!st?.isDirectory()) return []
  }
  const uses = await lastUses(profileDir)
  const deleted: string[] = []
  for (const marketplace of await subfolders(cache)) {
    for (const plugin of await subfolders(marketplace)) {
      for (const version of await subfolders(plugin)) {
        if (recorded.has(sameFolder(version))) continue
        const marker = await fs.lstat(path.join(version, '.orphaned_at')).catch(() => null)
        if (!marker?.isFile() || now.getTime() - marker.mtimeMs < ORPHAN_GRACE_MS) continue
        const use = uses.get(sameFolder(version))
        if (use && now.getTime() - use.mtimeMs < UNUSED_MS) continue
        try {
          await fs.rm(version, { recursive: true, force: true })
        } catch {
          continue
        }
        deleted.push(version)
        for (const file of use?.files ?? []) await fs.rm(file, { force: true }).catch(() => {})
      }
    }
  }
  return deleted
}
