// The Host's plugin manager (SDK + Plugin spec §12, §27; plugin runtime design P4-P8): what is installed in
// `<profile>/plugins`, and the changes a person makes to it. Every change runs after the one before it finished, so two
// installs never write the registry over each other. 2a runs no plugin: an enabled, compatible plugin is `stopped`.
import { promises as fs } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'
import { capabilityPermissionProblem, incompatibility, isSemver, parseManifest, pluginFolderName, type PluginManifest, type PluginPermission, contributionPermissionProblem, type PluginUiPermission, PLUGIN_SERVED_CAPABILITIES } from '../../core/plugins/manifest'
import { PluginCopyRefused, copyPluginFolder, layoutProblem } from './copyFolder'
import { readPackage } from './packageFile'
import { parseNpmSpec } from '../../core/plugins/npmSpec'
import { NpmFailed, NpmMissing, createNpm, installDependencies, packAndExtract, type NpmRun, type NpmRunner } from './npm'
import { NpmUnavailable } from './ownNpm'
import { PackageRefused, extractPackage } from './tarball'
import { RegistryUnreadable, pluginsRoot, readRegistry, writeRegistry, type PluginRecord } from './registry'
import { moveRetrying, type Rename } from './moves'
import { REDACT_MIN, pluginLogFile, type PluginLaunch, type PluginRuntime } from './runtime'
import { coerceSetting, missingRequired, type SettingField, type SettingValue } from '../../core/plugins/settings'
import { PluginSettingsUnreadable, forgetPluginData, pluginSecrets, readSettings, writeSettings } from './pluginData'
import { AUDIT_APP_FILE, AUDIT_FILE, readPluginAudit } from '../../core/plugins/pluginAudit'

/** `ready`: an enabled UI-only plugin (Plugin API 2, ADR-008) with nothing to start and nothing missing. */
export type PluginStatus = 'disabled' | 'incompatible' | 'stopped' | 'starting' | 'running' | 'failed' | 'ready'

/** A Host answer: an HTTP-like status and a body, `{ error }` when it is not 2xx. */
export interface PluginsAnswer {
  status: number
  body: unknown
}

export interface PluginManager {
  /** What a folder (`path`) or an npm package (`npm`, plugins 2e) holds, before it is approved. */
  inspect(a: { path?: unknown; npm?: unknown; file?: unknown }): Promise<PluginsAnswer>
  /** From a folder (`path`) or an npm package (`npm`, plugins 2e); an npm install needs `expect`. */
  install(a: { path?: unknown; npm?: unknown; file?: unknown; grant: unknown; expect?: unknown }): Promise<PluginsAnswer>
  list(): Promise<PluginsAnswer>
  /** What `list` answers, read beside a change in progress rather than after it: a person picking a job source's item
   *  must not wait for an npm install (plugin Phase 4, 4a final review I4). It changes nothing, so it needs no turn. */
  listNow(): Promise<PluginsAnswer>
  get(id: unknown): Promise<PluginsAnswer>
  setEnabled(id: unknown, enabled: boolean): Promise<PluginsAnswer>
  remove(id: unknown): Promise<PluginsAnswer>
  /** The registry as it is, for the plugin runtime (2b). Throws `RegistryUnreadable`. */
  records(): Promise<PluginRecord[]>
  /** Starts every enabled plugin this Astera runs: the Host calls it once it listens. */
  startAll(): Promise<void>
  /** The last lines of a plugin's log (design P13). */
  logs(id: unknown, lines: unknown): Promise<PluginsAnswer>
  /** The last records of the audit log, the Host's and the app's merged by time, of one plugin when `id` names one,
   *  installed or not (Workspace & Plugin Platform V2 spec E3). */
  audit(id: unknown, lines: unknown): Promise<PluginsAnswer>
  /** What could keep a plugin from running, one check at a time (spec §12 `doctor`). */
  doctor(id: unknown): Promise<PluginsAnswer>
  /** A plugin's settings as a person may see them: secret ones say only whether they are set (spec §23-§24). */
  settings(id: unknown): Promise<PluginsAnswer>
  /** Ends the npm still running for an install (2e final review M8): for a Host that leaves. */
  stopNpm(): void
  /** Sets and unsets a plugin's settings, and restarts it if it runs. */
  configure(id: unknown, set: unknown, unset: unknown): Promise<PluginsAnswer>
}

/** A plugin's settings as stored, read against its installed schema (manager's settingsState). */
type SettingsState =
  | { ok: true; plain: Record<string, SettingValue>; secrets: Record<string, string>; redact: string[]; missing: string[]; invalid: string[] }
  | { ok: false; error: string }
type SettingsRead = Extract<SettingsState, { ok: true }>

/** A refusal: a status and the sentence the caller reads. */
class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** A code the caller can say in its own words (2e final review M4: npm missing, in the app). */
    readonly code?: string,
    /** What went wrong in a few words, for a caller that words the rest itself (2e-2 final review M1). */
    readonly reason?: string
  ) {
    super(message)
  }
}

const refused = (status: number, error: string, code?: string, reason?: string): PluginsAnswer => ({
  status,
  body: { error, ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }
})

/** The manifest a folder's package.json holds, or the sentence saying why it holds none. */
async function readManifest(folder: string): Promise<{ ok: true; manifest: PluginManifest } | { ok: false; error: string }> {
  const read = await readPackage(folder)
  if (!read.ok) return read
  const parsed = parseManifest(read.pkg)
  return parsed.ok ? parsed : { ok: false, error: `${path.join(folder, 'package.json')}: ${parsed.problems.join('; ')}` }
}

const isFolder = (p: string): Promise<boolean> => fs.stat(p).then((s) => s.isDirectory(), () => false)

/** The id a command names, or a 400 that says the flag. */
const idOf = (cmd: string, id: unknown): string => {
  if (typeof id !== 'string' || id === '') throw new Refused(400, `${cmd} needs --id`)
  return id
}

/** An absolute path to a folder on this machine, or a 400. */
async function folderOf(cmd: string, p: unknown): Promise<string> {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Refused(400, `${cmd} needs an absolute --path`)
  if (!(await isFolder(p))) throw new Refused(400, `not a folder on this machine: ${p}`)
  return p
}

const hex = (): string => randomBytes(6).toString('hex')

const LOG_LINES_DEFAULT = 100
const LOG_LINES_MAX = 1000

/** The error a failed change answers with when the earlier copy could not be moved back either: the person is told
 *  where it is, since nothing else will find it. */
const stranded = (first: unknown, retired: string): Error =>
  new Error(`${first instanceof Error ? first.message : String(first)}; the earlier copy could not be put back: it is in ${retired}`)

/** Removes a folder the Host no longer needs; a failure leaves it behind rather than failing the change it followed. */
const discard = (p: string): Promise<void> => fs.rm(p, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})

/** The largest package file `install --file` reads: the most a package may unpack to (tarball.ts), as no gzip of it is
 *  larger. */
const PACKAGE_FILE_MAX = 256 * 1024 * 1024

/** The plugin capabilities this Host serves: core/plugins/manifest.ts holds the list, which the CLI's folder check
 *  (`plugins validate`) reads too. */
export { PLUGIN_SERVED_CAPABILITIES }

export function createPluginManager(d: {
  profileDir: string
  hostVersion: string
  /** The plugin capabilities this Host serves (design P8): PLUGIN_SERVED_CAPABILITIES unless a test says otherwise. */
  capabilities?: readonly string[]
  now?: () => number
  /** For tests: one folder move, and the waits between tries of a refused one. */
  rename?: Rename
  renameWaitsMs?: readonly number[]
  /** For tests: the folder copy (`copyPluginFolder`). */
  copy?: (src: string, dest: string) => Promise<void>
  /** The person's own npm, for an install from npm (plugins 2e, design P14); a fake in tests. */
  npm?: NpmRun & Partial<Pick<NpmRunner, 'stopAll'>>
  /** What runs the enabled plugins (2b). Absent: nothing runs, and an enabled, compatible plugin is `stopped`. */
  runtime?: Pick<PluginRuntime, 'start' | 'restart' | 'stop' | 'status' | 'forget'>
  /** The Host's log: what no caller is there to hear, such as plugins that could not be started at the Host's start. */
  log?: (m: string) => void
}): PluginManager {
  const root = pluginsRoot(d.profileDir)
  // The copies live one level down, so no plugin name can be plugins.json or one of the folders the Host keeps for
  // every plugin beside it (design P4). Staging and retired folders sit beside the copies and start with a dot, which
  // no npm name does.
  const installed = path.join(root, 'installed')
  const host = { version: d.hostVersion, capabilities: d.capabilities ?? PLUGIN_SERVED_CAPABILITIES }
  // The person's npm, or where there is none Astera's own, run on the Host's own Node (plugins 2e-2).
  const npm = d.npm ?? createNpm({ profileDir: d.profileDir, env: process.env, node: process.execPath })
  const now = d.now ?? Date.now
  let queue: Promise<unknown> = Promise.resolve()
  /** Moves a folder, trying again while the system refuses for a moment. */
  const move = (from: string, to: string): Promise<void> =>
    moveRetrying(from, to, { ...(d.rename ? { rename: d.rename } : {}), ...(d.renameWaitsMs ? { waitsMs: d.renameWaitsMs } : {}) })

  /** Puts an earlier copy back after a failed change, and fails with both stories when it cannot. */
  async function putBack(first: unknown, retired: string | null, final: string): Promise<never> {
    if (retired) await move(retired, final).catch(() => Promise.reject(stranded(first, retired)))
    throw first
  }

  let swept: Promise<void> | null = null

  /** Clears what a change that never finished left in `installed` (final review m3): a staging folder goes; an earlier
   *  copy that stepped aside comes back when its plugin is still installed and nothing took its place, and goes
   *  otherwise. With a registry that cannot be read nothing retired is touched, since nothing says whose it is. */
  async function sweep(): Promise<void> {
    const names = await fs.readdir(installed).catch(() => [] as string[])
    const records = await readRegistry(root).catch(() => null)
    for (const n of names) {
      if (n.startsWith('.staging-')) {
        await discard(path.join(installed, n))
        continue
      }
      const retired = /^\.retired-(.+)-[0-9a-f]{12}$/.exec(n)
      if (!retired || records === null) continue
      const final = path.join(installed, retired[1])
      if (records.some((r) => r.folder === retired[1]) && !(await isFolder(final))) await move(path.join(installed, n), final).catch(() => {})
      else await discard(path.join(installed, n))
    }
  }

  /** Where an earlier copy waits while a change is made: named for its folder, so a Host that stopped half way can
   *  tell whose it is. */
  const retiredFor = (folder: string): string => path.join(installed, `.retired-${folder}-${hex()}`)

  /** One at a time, each answered with its refusal or the registry's own complaint. The first one clears what a Host
   *  that stopped half way left behind. */
  const serial = (fn: () => Promise<PluginsAnswer>): Promise<PluginsAnswer> => {
    const run = queue.then(async () => {
      try {
        await (swept ??= sweep())
        return await fn()
      } catch (e) {
        if (e instanceof Refused) return refused(e.status, e.message, e.code, e.reason)
        if (e instanceof RegistryUnreadable) return refused(500, e.message)
        // A file the system would not move or write: the change was undone where it could be, and the caller is told.
        return refused(500, e instanceof Error ? e.message : String(e))
      }
    })
    queue = run.catch(() => {})
    return run
  }

  /** A plugin's settings as stored, read against its installed schema (spec §24): the plain values that are valid for
   *  a key it still has, defaults filled; its secret settings (for the plugin alone); every secret value of the plugin,
   *  to redact from its log; the required ones missing; and stored values that no longer fit. */
  async function settingsState(r: PluginRecord, m: PluginManifest): Promise<SettingsState> {
    try {
      const store = pluginSecrets(d.profileDir, r.folder)
      // Every secret value, the ones a plugin with no settings keeps for itself too (2c final review C1).
      const redact = await store.values()
      if (m.settings.length === 0) return { ok: true, plain: {}, secrets: {}, redact, missing: [], invalid: [] }
      const stored = await readSettings(d.profileDir, r.folder)
      const plain: Record<string, SettingValue> = {}
      const secrets: Record<string, string> = {}
      const invalid: string[] = []
      for (const f of m.settings) {
        if (f.secret) {
          const v = await store.setting.get(f.key)
          if (v !== undefined) secrets[f.key] = v
          else if (typeof f.default === 'string') secrets[f.key] = f.default
          continue
        }
        if (Object.hasOwn(stored, f.key)) {
          const c = coerceSetting(f, stored[f.key])
          if (c.ok) plain[f.key] = c.value
          else invalid.push(c.problem)
        }
        if (!Object.hasOwn(plain, f.key) && f.default !== undefined) plain[f.key] = f.default
      }
      const has = (k: string): boolean => Object.hasOwn(plain, k) || Object.hasOwn(secrets, k)
      const valueOf = (k: string): unknown => (Object.hasOwn(secrets, k) ? secrets[k] : plain[k])
      return { ok: true, plain, secrets, redact, missing: missingRequired(m.settings, has, valueOf), invalid }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /** Why an enabled, compatible plugin is held back by its settings, or null. */
  const heldBack = (r: PluginRecord, state: SettingsState): string | null =>
    !state.ok
      ? `the settings cannot be read: ${state.error}`
      : state.missing.length > 0
        ? `needs settings: ${state.missing.join(', ')}; set them with astera plugins configure --id ${r.id}`
        : null

  /** Why the record's grant cannot serve the capabilities its plugin names, or null (final review M7): an Astera that
   *  did not run event plugins (1.4.12, 1.4.13) installed one whatever was granted. It is held back rather than
   *  started into a failure, with what to do. */
  const ungranted = (r: PluginRecord, m: PluginManifest): string | null => {
    const problem = capabilityPermissionProblem(m.capabilities, r.granted) ?? contributionPermissionProblem(m.contributes, r.granted)
    return problem === null ? null : `${problem}, which it was not granted: install it again and grant it`
  }

  /** What the runtime needs to start the plugin a record names, with its installed copy's manifest and settings. */
  const launchOf = (r: PluginRecord, m: PluginManifest, state: SettingsRead): PluginLaunch => {
    const dir = path.join(installed, r.folder)
    return {
      id: r.id,
      version: m.version,
      folder: r.folder,
      dir,
      // runnable hands over only a plugin with a host entry
      entry: path.resolve(dir, m.entry ?? ''),
      granted: r.granted,
      capabilities: m.capabilities,
      // The plugin is trusted (design P1): it gets its secret settings beside the plain ones.
      settings: { ...state.plain, ...state.secrets },
      // A value this short would redact ordinary words from its log.
      redact: state.redact.filter((v) => v.length >= REDACT_MIN)
    }
  }

  /** The record's plugin, when it is enabled, this Astera runs it and its required settings are set; null otherwise. */
  async function runnable(r: PluginRecord): Promise<PluginLaunch | null> {
    if (!r.enabled) return null
    const read = await readManifest(path.join(installed, r.folder))
    // A UI-only plugin has no program to start (ADR-008)
    if (!read.ok || read.manifest.entry === undefined || incompatibility(read.manifest, host) !== null || ungranted(r, read.manifest) !== null) return null
    const state = await settingsState(r, read.manifest)
    if (!state.ok || heldBack(r, state) !== null) return null
    return launchOf(r, read.manifest, state)
  }

  /** Starts the record's plugin when it is enabled and runs here. */
  const startIfRunnable = async (r: PluginRecord): Promise<void> => {
    if (!d.runtime) return
    const launch = await runnable(r)
    if (launch) d.runtime.start(launch)
  }

  /** A record as a person sees it, read with its installed copy's manifest and, while it runs, the runtime's word. */
  async function view(r: PluginRecord): Promise<Record<string, unknown>> {
    const dir = path.join(installed, r.folder)
    const read = await readManifest(dir)
    const m = read.ok ? read.manifest : null
    const incompatible = m ? incompatibility(m, host) : `the installed copy cannot be read: ${read.ok ? '' : read.error}`
    const uiOnly = m !== null && m.entry === undefined
    const run = r.enabled && incompatible === null && !uiOnly ? d.runtime?.status(r.id) : undefined
    let status: PluginStatus = !r.enabled ? 'disabled' : incompatible !== null ? 'incompatible' : (run?.status ?? 'stopped')
    let reason = incompatible ?? run?.reason ?? null
    // A plugin that is not running may be waiting for a grant or for its settings: say which.
    if (m && r.enabled && incompatible === null && status === 'stopped') reason = ungranted(r, m) ?? heldBack(r, await settingsState(r, m)) ?? reason
    // A UI-only plugin with nothing missing is ready: it has nothing to start
    if (uiOnly && status === 'stopped' && reason === null) status = 'ready'
    return {
      id: r.id,
      name: m?.name ?? r.id,
      displayName: m?.displayName ?? r.id,
      version: m?.version ?? r.version,
      ...(m?.description !== undefined ? { description: m.description } : {}),
      enabled: r.enabled,
      status,
      ...(reason !== null ? { reason } : {}),
      ...(run?.pid !== undefined ? { pid: run.pid } : {}),
      trust: m?.trust ?? 'trusted',
      ...(m?.ui !== undefined ? { ui: m.ui } : {}),
      ...(m?.apiVersion === '2' ? { contributes: m.contributes } : {}),
      capabilities: m?.capabilities ?? [],
      permissions: r.granted,
      requested: m?.permissions ?? [],
      installedAt: r.installedAt,
      dir,
      source: r.source
    }
  }

  const find = (records: PluginRecord[], id: string): PluginRecord => {
    const r = records.find((x) => x.id === id)
    if (!r) throw new Refused(404, `no plugin ${id} is installed`)
    return r
  }

  /** Where an install comes from: a folder on this machine, a package on npm (plugins 2e), or a package file on this
   *  machine (`plugins pack`, Phase 2 step 4a). */
  async function sourceOf(
    cmd: string,
    a: { path?: unknown; npm?: unknown; file?: unknown }
  ): Promise<{ kind: 'folder'; folder: string } | { kind: 'npm'; spec: string; name: string } | { kind: 'file'; file: string }> {
    if ([a.path, a.npm, a.file].filter((v) => v !== undefined).length > 1) throw new Refused(400, `${cmd} takes one of --path, --npm and --file`)
    if (a.file !== undefined) {
      if (typeof a.file !== 'string' || !path.isAbsolute(a.file)) throw new Refused(400, `${cmd}: ${String(a.file)} is not an absolute path`)
      const st = await fs.stat(a.file).catch(() => null)
      if (!st?.isFile()) throw new Refused(400, `${cmd}: ${a.file} is not a file`)
      // Refused by its size before it is read into the Host: no package unpacks to more than the npm path's limit
      if (st.size > PACKAGE_FILE_MAX) throw new Refused(400, `${cmd}: ${a.file} is larger than any plugin package (${PACKAGE_FILE_MAX / 1024 / 1024} MiB)`)
      return { kind: 'file', file: a.file }
    }
    if (a.npm !== undefined) {
      // Checked before npm runs: only a registry name and a version ever reach it (design P14).
      const spec = parseNpmSpec(a.npm)
      if (!spec.ok) throw new Refused(400, spec.problem)
      return { kind: 'npm', spec: a.npm as string, name: spec.name }
    }
    if (a.path === undefined) throw new Refused(400, `${cmd} needs --path <folder>, --npm <package> or --file <package.tgz>`)
    return { kind: 'folder', folder: await folderOf(cmd, a.path) }
  }

  /** A refusal for what npm, or the package it fetched, could not do. */
  const npmRefusal = (e: unknown, spec: string): unknown =>
    e instanceof NpmMissing
      ? new Refused(500, e.message, e.code)
      : e instanceof NpmUnavailable
        ? new Refused(500, e.message, e.code, e.reason)
      : e instanceof NpmFailed
        ? new Refused(e.notFound ? 404 : 500, e.message)
        : e instanceof PackageRefused
          ? new Refused(400, `cannot install ${spec} from npm: ${e.message}`)
          : e

  /** Fetches `spec` with npm into a staging folder of its own (cleared at a Host's start like any staging folder) and
   *  hands `use` the extracted package; the folder goes when `use` is done. */
  async function fromNpm<T>(spec: string, use: (folder: string, got: { name: string; version: string }, staging: string) => Promise<T>): Promise<T> {
    await fs.mkdir(installed, { recursive: true })
    const staging = path.join(installed, `.staging-npm-${hex()}`)
    await fs.mkdir(staging)
    try {
      let got: { name: string; version: string; folder: string }
      try {
        got = await packAndExtract(spec, staging, npm)
      } catch (e) {
        throw npmRefusal(e, spec)
      }
      return await use(got.folder, got, staging)
    } finally {
      await discard(staging)
    }
  }

  /** Reads the package file once, into a staging folder of its own: its sha256 is of the bytes that are then extracted,
   *  with the npm path's own extractor and limits, so a file changed meanwhile cannot slip in. `use` gets the extracted
   *  package; the folder goes when `use` is done. */
  async function fromFile<T>(file: string, use: (folder: string, sha256: string) => Promise<T>): Promise<T> {
    await fs.mkdir(installed, { recursive: true })
    const staging = path.join(installed, `.staging-file-${hex()}`)
    await fs.mkdir(staging)
    try {
      const bytes = await fs.readFile(file)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const copy = path.join(staging, 'package.tgz')
      await fs.writeFile(copy, bytes)
      const folder = path.join(staging, 'package')
      try {
        await extractPackage(copy, folder)
      } catch (e) {
        if (e instanceof PackageRefused) throw new Refused(400, `cannot install from ${file}: ${e.message}`)
        throw e
      }
      return await use(folder, sha256)
    } finally {
      await discard(staging)
    }
  }

  async function inspect(a: { path?: unknown; npm?: unknown; file?: unknown }): Promise<PluginsAnswer> {
    const source = await sourceOf('plugins-inspect', a)
    if (source.kind === 'folder') return { status: 200, body: await inspection(source.folder, source.folder) }
    if (source.kind === 'file')
      return fromFile(source.file, async (folder, sha256) => ({ status: 200, body: { ...(await inspection(folder, source.file)), source: { file: source.file, sha256 } } }))
    return fromNpm(source.spec, async (folder, got) => {
      if (got.name !== source.name) throw new Refused(400, `npm answered ${source.spec} with a package that says it is ${got.name}@${got.version}`)
      return { status: 200, body: { ...(await inspection(folder, `${source.spec} from npm`)), source: { npm: source.spec, version: got.version } } }
    })
  }

  /** What `folder` holds, as a person approves it; refusals name `shownAs`, where it came from. */
  async function inspection(folder: string, shownAs: string): Promise<Record<string, unknown>> {
    const layout = await layoutProblem(folder)
    if (layout !== null) throw new Refused(400, `cannot install from ${shownAs}: ${layout}`)
    const read = await readManifest(folder)
    if (!read.ok) throw new Refused(400, read.error.split(folder).join(shownAs))
    const m = read.manifest
    const installed = (await readRegistry(root)).find((r) => r.id === m.id)
    const reason = incompatibility(m, host)
    return {
      id: m.id,
      name: m.name,
      displayName: m.displayName,
      version: m.version,
      ...(m.description !== undefined ? { description: m.description } : {}),
      apiVersion: m.apiVersion,
      trust: m.trust,
      ...(m.entry !== undefined ? { entry: m.entry } : {}),
      ...(m.ui !== undefined ? { ui: m.ui } : {}),
      ...(m.apiVersion === '2' ? { contributes: m.contributes } : {}),
      capabilities: m.capabilities,
      permissions: m.permissions,
      ...(m.minAsteraVersion !== undefined ? { minAsteraVersion: m.minAsteraVersion } : {}),
      ...(m.engines !== undefined ? { engines: m.engines } : {}),
      compatible: reason === null,
      ...(reason !== null ? { reason } : {}),
      ...(installed ? { installed: { version: installed.version, enabled: installed.enabled } } : {})
    }
  }

  /** What `folder` holds, if it can be installed with `grant` as the person saw it; refusals name `shownAs`, the folder
   *  the caller named. */
  async function installable(
    folder: string,
    shownAs: string,
    grant: readonly string[],
    expected: { name: string; version: string; trust?: string } | undefined
  ): Promise<{ manifest: PluginManifest; granted: (PluginPermission | PluginUiPermission)[] }> {
    const read = await readManifest(folder)
    if (!read.ok) throw new Refused(400, read.error.split(folder).join(shownAs))
    const m = read.manifest
    if (expected !== undefined && (expected.name !== m.name || expected.version !== m.version))
      throw new Refused(409, `the folder changed after it was shown: it now holds ${m.name}@${m.version}; run the install again`)
    // A folder that gained a host entry while a restricted UI prompt was open must not install as trusted code (final review
    // M7); an expect without a trust level, from an older caller, is checked as before
    if (expected?.trust !== undefined && expected.trust !== m.trust)
      throw new Refused(409, `the folder changed after it was shown: it now holds ${m.name}@${m.version} as ${m.trust === 'trusted' ? 'trusted code' : 'restricted UI'}; run the install again`)
    const granted: (PluginPermission | PluginUiPermission)[] = []
    for (const g of grant) {
      if (!(m.permissions as string[]).includes(g))
        throw new Refused(400, `${g} is not one the plugin asks for; it asks for: ${m.permissions.length > 0 ? m.permissions.join(', ') : 'nothing'}`)
      if (!granted.includes(g as PluginPermission)) granted.push(g as PluginPermission)
    }
    // Plugin Phase 3 N4: refused before anything is copied, with the reason the manifest's own check gives
    const needs = capabilityPermissionProblem(m.capabilities, granted) ?? contributionPermissionProblem(m.contributes, granted)
    if (needs !== null) throw new Refused(400, needs)
    const isFile = (rel: string): Promise<boolean> => fs.stat(path.join(folder, rel)).then((s) => s.isFile(), () => false)
    if (m.entry !== undefined && !(await isFile(m.entry))) throw new Refused(400, `the entry ${m.entry} is not a file in the plugin`)
    if (m.ui !== undefined && !(await isFile(m.ui))) throw new Refused(400, `the ui ${m.ui} is not a file in the plugin`)
    return { manifest: m, granted }
  }

  async function install(a: { path?: unknown; npm?: unknown; file?: unknown; grant: unknown; expect?: unknown }): Promise<PluginsAnswer> {
    const source = await sourceOf('plugins-install', a)
    const grant = a.grant
    if (!Array.isArray(grant) || !grant.every((g) => typeof g === 'string'))
      throw new Refused(400, 'plugins-install needs a grant: the permissions you approve, from those the plugin asks for')
    const want = a.expect
    if (
      want !== undefined &&
      (typeof want !== 'object' || want === null || typeof (want as Record<string, unknown>).name !== 'string' || typeof (want as Record<string, unknown>).version !== 'string')
    )
      throw new Refused(400, 'expect must be { name, version }')
    const trustShown = want !== undefined ? (want as Record<string, unknown>).trust : undefined
    if (trustShown !== undefined && trustShown !== 'trusted' && trustShown !== 'restricted-ui')
      throw new Refused(400, 'expect.trust must be trusted or restricted-ui')
    const expected = want as { name: string; version: string; trust?: string } | undefined
    if (source.kind === 'folder') {
      // Read before anything is copied: a registry that cannot be read refuses the change with nothing written.
      const records = await readRegistry(root)
      // The folder is checked before it is copied, so a refusal costs no copy (final review m2), and the copy is checked
      // again, because the copy is what will run (design P6).
      await installable(source.folder, source.folder, grant as string[], expected)
      return place(source.folder, source.folder, grant as string[], expected, records, { kind: 'folder', path: source.folder })
    }
    if (source.kind === 'file') {
      // Exactly the bytes that were shown: the sha256 the inspect answered, checked against the copy that is extracted
      const sha256 = (want as Record<string, unknown> | undefined)?.sha256
      if (expected === undefined || typeof sha256 !== 'string')
        throw new Refused(400, 'plugins-install --file needs expect: the { name, version, sha256 } its inspect showed')
      const records = await readRegistry(root)
      return fromFile(source.file, async (folder, got) => {
        if (got !== sha256) throw new Refused(409, `${source.file} changed after it was shown; run the install again`)
        await installable(folder, source.file, grant as string[], expected)
        return place(folder, source.file, grant as string[], expected, records, { kind: 'file', path: source.file, sha256: got })
      })
    }
    // From npm, exactly the version that was shown: an npm version never changes, so the code installed is the code
    // approved (design P14).
    if (expected === undefined) throw new Refused(400, 'plugins-install --npm needs expect: the { name, version } its inspect showed')
    if (expected.name !== source.name) throw new Refused(400, `expect names ${expected.name}, but --npm names ${source.name}`)
    // Checked here, so no other source reaches npm through the version (2e final review I3).
    if (!isSemver(expected.version)) throw new Refused(400, `expect.version ${expected.version} is not a version`)
    const records = await readRegistry(root)
    const shownAs = `${source.spec} from npm`
    const exact = `${expected.name}@${expected.version}`
    return fromNpm(exact, async (folder, got, staging) => {
      // The tarball is what is installed, so it must be what was asked for (2e final review M3).
      if (got.name !== expected.name || got.version !== expected.version)
        throw new Refused(400, `npm answered ${exact} with a package that says it is ${got.name}@${got.version}`)
      // Checked before its dependencies are fetched, so a refusal costs no npm install.
      await installable(folder, shownAs, grant as string[], expected)
      try {
        await installDependencies(folder, staging, npm)
      } catch (e) {
        throw npmRefusal(e, source.spec)
      }
      return place(folder, shownAs, grant as string[], expected, records, { kind: 'npm', spec: source.spec, version: got.version })
    })
  }

  /** Copies `src` into the profile, checks the copy, and puts it in place of any earlier copy of the plugin, which comes
   *  back if the change cannot be finished. */
  async function place(
    src: string,
    shownAs: string,
    grant: string[],
    expected: { name: string; version: string } | undefined,
    records: PluginRecord[],
    source: PluginRecord['source']
  ): Promise<PluginsAnswer> {
    await fs.mkdir(installed, { recursive: true })
    const staging = path.join(installed, `.staging-${hex()}`)
    try {
      try {
        await (d.copy ?? copyPluginFolder)(src, staging)
      } catch (e) {
        if (e instanceof PluginCopyRefused) throw new Refused(400, `cannot install from ${shownAs}: ${e.message}`)
        throw e
      }
      const { manifest: m, granted } = await installable(staging, shownAs, grant, expected)
      const folder = pluginFolderName(m.id)
      const final = path.join(installed, folder)
      const previous = records.find((r) => r.id === m.id)
      // A running copy stops before its folder moves: Windows will not move a folder a process runs from. If the change
      // then fails, the earlier copy is put back and started again.
      if (previous) await d.runtime?.stop(previous.id)
      const startPrevious = async (): Promise<void> => {
        if (previous) await startIfRunnable(previous)
      }
      // An earlier copy steps aside first and comes back if the change cannot be finished.
      const retired = (await isFolder(final)) ? retiredFor(folder) : null
      if (retired) {
        try {
          await move(final, retired)
        } catch (e) {
          await startPrevious()
          throw e
        }
      }
      try {
        await move(staging, final)
      } catch (e) {
        await putBack(e, retired, final).finally(startPrevious)
      }
      const record: PluginRecord = {
        id: m.id,
        version: m.version,
        folder,
        enabled: previous?.enabled ?? true,
        granted,
        installedAt: now(),
        source
      }
      try {
        await writeRegistry(root, [...records.filter((r) => r.id !== m.id), record].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)))
      } catch (e) {
        await discard(final)
        await putBack(e, retired, final).finally(startPrevious)
      }
      if (retired) await discard(retired)
      await startIfRunnable(record)
      return { status: 200, body: { ...(await view(record)), ...(previous ? { replaced: previous.version } : {}) } }
    } finally {
      await discard(staging)
    }
  }

  async function setEnabled(id: unknown, enabled: boolean): Promise<PluginsAnswer> {
    const want = idOf(enabled ? 'plugins-enable' : 'plugins-disable', id)
    const records = await readRegistry(root)
    const r = find(records, want)
    if (r.enabled === enabled) {
      // Enabling a plugin that failed starts it again (design P11): a change, though the flag stays as it was.
      const launch = enabled && d.runtime?.status(r.id)?.status === 'failed' ? await runnable(r) : null
      if (launch && d.runtime) {
        d.runtime.restart(launch)
        return { status: 200, body: { ...(await view(r)), changed: true } }
      }
      return { status: 200, body: { ...(await view(r)), changed: false } }
    }
    const next = { ...r, enabled }
    await writeRegistry(root, records.map((x) => (x.id === want ? next : x)))
    if (enabled) await startIfRunnable(next)
    else await d.runtime?.stop(r.id)
    return { status: 200, body: { ...(await view(next)), changed: true } }
  }

  async function logs(id: unknown, lines: unknown): Promise<PluginsAnswer> {
    const want = idOf('plugins-logs', id)
    const n = linesOf('plugins-logs', lines)
    const r = find(await readRegistry(root), want)
    const file = pluginLogFile(d.profileDir, r.folder)
    const read = (f: string): Promise<string[]> =>
      fs.readFile(f, 'utf8').then(
        (t) => t.split(/\r?\n/).filter((l) => l !== ''),
        () => []
      )
    const all = [...(await read(`${file}.1`)), ...(await read(file))]
    return { status: 200, body: { id: r.id, file, lines: all.slice(-n) } }
  }

  /** A `--lines` value: a whole number from 1 to LOG_LINES_MAX, LOG_LINES_DEFAULT when absent; a 400 otherwise. */
  const linesOf = (cmd: string, lines: unknown): number => {
    const n = lines === undefined ? LOG_LINES_DEFAULT : typeof lines === 'string' && /^\d+$/.test(lines) ? Number(lines) : lines
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > LOG_LINES_MAX) throw new Refused(400, `${cmd} --lines must be a whole number from 1 to ${LOG_LINES_MAX}`)
    return n
  }

  async function audit(id: unknown, lines: unknown): Promise<PluginsAnswer> {
    // Not looked up in the registry: the history of a plugin removed is what the log is for
    if (id !== undefined && (typeof id !== 'string' || id === '')) throw new Refused(400, 'plugins-audit --id must name a plugin')
    const n = linesOf('plugins-audit', lines)
    const entries = await readPluginAudit([path.join(root, AUDIT_FILE), path.join(root, AUDIT_APP_FILE)], { ...(id !== undefined ? { plugin: id } : {}), lines: n })
    return { status: 200, body: { entries } }
  }

  async function doctor(id: unknown): Promise<PluginsAnswer> {
    const r = find(await readRegistry(root), idOf('plugins-doctor', id))
    const dir = path.join(installed, r.folder)
    /** `warn`: worth knowing, and no fault: it leaves `ok` as it is. */
    const checks: { name: string; ok: boolean; warn?: true; detail: string }[] = []
    const answer = (): PluginsAnswer => ({ status: 200, body: { id: r.id, ok: checks.every((c) => c.ok), checks } })
    const read = await readManifest(dir)
    if (!read.ok) {
      checks.push({ name: 'manifest', ok: false, detail: read.error })
      return answer()
    }
    const m = read.manifest
    checks.push({ name: 'manifest', ok: true, detail: `${m.name} ${m.version}, Plugin API ${m.apiVersion}` })
    const incompatible = incompatibility(m, host)
    checks.push({ name: 'compatible', ok: incompatible === null, detail: incompatible ?? 'this Astera runs it' })
    const fileIn = (rel: string): Promise<boolean> => fs.stat(path.resolve(dir, rel)).then((st) => st.isFile(), () => false)
    if (m.entry !== undefined) {
      const entry = await fileIn(m.entry)
      checks.push({ name: 'entry', ok: entry, detail: entry ? m.entry : `${m.entry} is not a file in the installed copy` })
    }
    if (m.ui !== undefined) {
      const ui = await fileIn(m.ui)
      checks.push({ name: 'ui', ok: ui, detail: ui ? m.ui : `${m.ui} is not a file in the installed copy` })
    }
    const grant = ungranted(r, m)
    if (grant !== null) checks.push({ name: 'permissions', ok: false, detail: grant })
    // Design P2: plugins run on the Node inside Astera. An addon loads there only if it was built for it, as N-API addons
    // are, so the doctor warns rather than fails (2b final review M4).
    const addons = (await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]))
      .filter((f) => f.endsWith('.node'))
      .map((f) => f.split(path.sep).join('/'))
      .sort()
    checks.push({
      name: 'native-addons',
      ok: true,
      ...(addons.length > 0 ? { warn: true as const } : {}),
      detail:
        addons.length === 0
          ? 'none'
          : `${addons.length} native addon${addons.length === 1 ? '' : 's'} (${addons[0]}${addons.length > 1 ? `, and ${addons.length - 1} more` : ''}): ` +
            (addons.length === 1 ? 'it loads' : 'each loads') +
            ' only if it was built for the Node inside Astera, as N-API addons are'
    })
    const state = await settingsState(r, m)
    checks.push(
      !state.ok
        ? { name: 'settings', ok: false, detail: `the settings cannot be read: ${state.error}` }
        : state.missing.length > 0
          ? { name: 'settings', ok: false, detail: `needs settings: ${state.missing.join(', ')}` }
          : state.invalid.length > 0
            ? { name: 'settings', ok: false, detail: state.invalid.join('; ') }
            : { name: 'settings', ok: true, detail: m.settings.length === 0 ? 'none' : `${m.settings.length} settings, every required one set` }
    )
    const run = r.enabled && incompatible === null ? d.runtime?.status(r.id) : undefined
    checks.push(
      m.entry === undefined
        ? { name: 'runtime', ok: true, detail: 'none: a UI-only plugin starts no program' }
        : !r.enabled
        ? { name: 'runtime', ok: true, detail: 'disabled' }
        : incompatible !== null
          ? { name: 'runtime', ok: true, detail: 'not started' }
          : run?.status === 'failed'
            ? { name: 'runtime', ok: false, detail: `failed: ${run.reason ?? 'it kept crashing'}` }
            : { name: 'runtime', ok: true, detail: `${run?.status ?? 'stopped'}${run?.pid !== undefined ? ` (pid ${run.pid})` : ''}` }
    )
    return answer()
  }

  /** The installed copy's manifest for a command that needs it, or a 409 saying why there is none. */
  async function manifestOf(r: PluginRecord): Promise<PluginManifest> {
    const read = await readManifest(path.join(installed, r.folder))
    if (!read.ok) throw new Refused(409, `the installed copy of ${r.id} cannot be read: ${read.error}`)
    return read.manifest
  }

  /** Settings as a person sees them: a secret one says only whether it is set. */
  const settingsView = (r: PluginRecord, m: PluginManifest, state: SettingsRead): Record<string, unknown> => ({
    id: r.id,
    fields: m.settings,
    values: state.plain,
    secrets: Object.fromEntries(m.settings.filter((f) => f.secret).map((f) => [f.key, Object.hasOwn(state.secrets, f.key) ? 'set' : 'unset']))
  })

  async function settings(id: unknown): Promise<PluginsAnswer> {
    const r = find(await readRegistry(root), idOf('plugins-settings', id))
    const m = await manifestOf(r)
    const state = await settingsState(r, m)
    if (!state.ok) throw new Refused(500, state.error)
    return { status: 200, body: settingsView(r, m, state) }
  }

  async function configure(id: unknown, set: unknown, unset: unknown): Promise<PluginsAnswer> {
    const r = find(await readRegistry(root), idOf('plugins-configure', id))
    const m = await manifestOf(r)
    if (set !== undefined && (typeof set !== 'object' || set === null || Array.isArray(set)))
      throw new Refused(400, 'plugins-configure --set must be key=value pairs')
    if (unset !== undefined && (!Array.isArray(unset) || !unset.every((k) => typeof k === 'string')))
      throw new Refused(400, 'plugins-configure --unset must be a list of keys')
    const changes = Object.entries((set ?? {}) as Record<string, unknown>)
    const removals = (unset ?? []) as string[]
    if (changes.length === 0 && removals.length === 0) throw new Refused(400, 'plugins-configure needs --set or --unset')
    const fieldOf = (key: string): SettingField => {
      const f = m.settings.find((x) => x.key === key)
      if (!f)
        throw new Refused(
          400,
          `${key} is not a setting of ${r.id}; ${m.settings.length > 0 ? `its settings are: ${m.settings.map((x) => x.key).join(', ')}` : 'it has no settings'}`
        )
      return f
    }
    const both = changes.find(([k]) => removals.includes(k))
    if (both) throw new Refused(400, `${both[0]} is both set and unset`)
    const values = changes.map(([k, v]) => {
      const c = coerceSetting(fieldOf(k), v)
      if (!c.ok) throw new Refused(400, c.problem)
      return [k, c.value] as const
    })
    for (const k of removals) fieldOf(k)
    // A settings file broken by hand is written whole again: setting values is how a person repairs it.
    const stored = await readSettings(d.profileDir, r.folder).catch((e: unknown) => {
      if (e instanceof PluginSettingsUnreadable) return {} as Record<string, unknown>
      throw e
    })
    const secret = (k: string): boolean => fieldOf(k).secret === true
    const next = { ...stored }
    for (const [k, v] of values) if (!secret(k)) next[k] = v
    for (const k of removals) delete next[k]
    // A key an update made secret keeps no plain copy of what it held before (2c final review M8).
    for (const f of m.settings) if (f.secret) delete next[f.key]
    const before = d.runtime?.status(r.id)?.status
    const wasRunning = before === 'running' || before === 'starting'
    try {
      await writeSettings(d.profileDir, r.folder, next)
      const store = pluginSecrets(d.profileDir, r.folder)
      for (const [k, v] of values) if (secret(k)) await store.setting.set(k, String(v))
      for (const k of removals) if (secret(k)) await store.setting.delete(k)
    } finally {
      // A running plugin took its settings at its start: it starts again to take the new ones, and a change that was
      // written only in part still stops it, so it does not run on settings it no longer has (M8). One that was held
      // back for them starts now if it can. A failed one waits for `plugins enable`, as before.
      if (wasRunning) await d.runtime?.stop(r.id)
      if (before !== 'failed') await startIfRunnable(r)
    }
    const state = await settingsState(r, m)
    if (!state.ok) throw new Refused(500, state.error)
    // How it stands now, so a person is not told it restarted when it is held back, or left to guess that a failed one
    // still waits (2c final review M6).
    const now = await view(r)
    const runs = now.status === 'running' || now.status === 'starting'
    return {
      status: 200,
      body: {
        ...settingsView(r, m, state),
        status: now.status,
        ...(now.reason !== null && now.reason !== undefined ? { reason: now.reason } : {}),
        ...(wasRunning && runs ? { restarted: true } : {})
      }
    }
  }

  async function remove(id: unknown): Promise<PluginsAnswer> {
    const want = idOf('plugins-remove', id)
    const records = await readRegistry(root)
    const r = find(records, want)
    const final = path.join(installed, r.folder)
    // Stopped first, then out of the way before the record goes, so a folder Windows will not let go of fails the
    // removal whole; a removal that fails starts the plugin again.
    await d.runtime?.stop(r.id)
    const retired = (await isFolder(final)) ? retiredFor(r.folder) : null
    if (retired) {
      try {
        await move(final, retired)
      } catch (e) {
        await startIfRunnable(r)
        throw e
      }
    }
    try {
      await writeRegistry(root, records.filter((x) => x.id !== want))
    } catch (e) {
      await putBack(e, retired, final).finally(() => startIfRunnable(r))
    }
    if (retired) await discard(retired)
    // Its log goes with it, the rotated generation too: nothing can read it once the plugin is gone. Let go of first, so
    // a line still buffered cannot write it again.
    await d.runtime?.forget(r.folder)
    const log = pluginLogFile(d.profileDir, r.folder)
    await Promise.all([fs.rm(log, { force: true }), fs.rm(`${log}.1`, { force: true })]).catch(() => {})
    // And its settings and secrets (spec §23: a plugin's secrets are its own, and go with it). What cannot be deleted is
    // said, not swallowed (2c final review M12): a plugin installed again under the same id would find it.
    const left = await forgetPluginData(d.profileDir, r.folder).then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e))
    )
    if (left === null) return { status: 200, body: { id: r.id, version: r.version, removed: true } }
    d.log?.(`plugins: ${r.id} was removed, but its settings or secrets could not be deleted: ${left}`)
    return {
      status: 200,
      body: {
        id: r.id,
        version: r.version,
        removed: true,
        warning: `its settings or secrets could not be deleted (${left}); a plugin installed again as ${r.id} would find them`
      }
    }
  }

  return {
    inspect: (p) => serial(() => inspect(p)),
    install: (a) => serial(() => install(a)),
    list: () =>
      serial(async () => ({ status: 200, body: { plugins: await Promise.all((await readRegistry(root)).map(view)) } })),
    listNow: async () => {
      try {
        return { status: 200, body: { plugins: await Promise.all((await readRegistry(root)).map(view)) } }
      } catch (e) {
        return refused(500, e instanceof Error ? e.message : String(e))
      }
    },
    get: (id) =>
      serial(async () => {
        const want = idOf('plugins-get', id)
        return { status: 200, body: await view(find(await readRegistry(root), want)) }
      }),
    setEnabled: (id, enabled) => serial(() => setEnabled(id, enabled)),
    remove: (id) => serial(() => remove(id)),
    logs: (id, lines) => serial(() => logs(id, lines)),
    audit: (id, lines) => serial(() => audit(id, lines)),
    doctor: (id) => serial(() => doctor(id)),
    settings: (id) => serial(() => settings(id)),
    configure: (id, set, unset) => serial(() => configure(id, set, unset)),
    stopNpm: () => npm.stopAll?.(),
    startAll: () =>
      serial(async () => {
        for (const r of await readRegistry(root)) await startIfRunnable(r)
        return { status: 200, body: {} }
      }).then((a) => {
        // Nobody asked, so nobody would hear the refusal: the Host's log says why nothing runs (2b final review M5).
        if (a.status !== 200) d.log?.(`plugins: no plugin was started: ${(a.body as { error?: string }).error ?? a.status}`)
      }),
    records: () => readRegistry(root)
  }
}
