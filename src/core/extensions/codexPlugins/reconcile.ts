// Bringing one Codex account in line with what this profile shares (Codex plugin sharing design §5.3, §5.4): each shared
// plugin and dependency installed from this profile's marketplace at the shared version, its `enabled` flag as the
// person set it (C4), the account's own plugin of the same name off while the shared one is on and back on after (C1),
// the shared plugins' hooks trusted, and what is no longer shared removed. Codex installs and removes (`codex plugin
// …`); Astera writes the flags and the trust itself, since codex-cli 0.160 has no command for either.
//
// A pass never rejects. Whatever stops it is the account's failure, and the row it answers says what is known by then,
// so one account's trouble never stops the others and the Claude side, already done, never fails over it.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { comparablePath } from '../../files/tree'
import { patchTomlFile } from '../../providers/configWrite'
import type { Account } from '../../types'
import type { PluginCliResult } from '../claudePlugins/cli'
import { CODEX_PLUGIN_ADD_TIMEOUT_MS, type CodexPluginCliRun } from './cli'
import { isAsteraCodexMarketplace } from './copy'
import { trustPatch, type CodexHookRow, type CodexHooksList } from './hooks'
import type { CodexPluginAccountState, CodexPluginFailureCode } from './state'

/** A plugin the account should have from this profile's marketplace: a shared plugin or a dependency of one, at the
 *  shared version, on or off (a dependency is on when any plugin that is on needs it). */
export interface DesiredCodexPlugin {
  name: string
  version: string
  enabled: boolean
}

type Table = Record<string, unknown>
const isTable = (v: unknown): v is Table => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Ends a pass before its last step; it becomes the account's failure. */
class Stop extends Error {
  constructor(
    message: string,
    readonly code?: CodexPluginFailureCode
  ) {
    super(message)
  }
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A plugin `codex plugin list --json` reports installed (C3). */
interface Listed {
  id: string
  name: string
  marketplace: string
  version: string
  enabled: boolean
  /** Where its marketplace comes from; an Astera one, of any profile, ends in `extensions/codex-plugins`. */
  marketplaceSource: string | null
}

/** The installed rows of a `plugin list` answer. An answer with no `installed` list is not read as "nothing installed":
 *  that would reinstall every shared plugin and remove none, so it fails the pass. */
function installedRows(json: PluginCliResult['json']): Listed[] {
  const rows = isTable(json) ? json.installed : undefined
  if (!Array.isArray(rows)) throw new Stop('codex plugin list answered with no installed list')
  const out: Listed[] = []
  for (const x of rows) {
    if (!isTable(x) || x.installed !== true) continue
    if (typeof x.pluginId !== 'string' || typeof x.name !== 'string' || typeof x.marketplaceName !== 'string' || typeof x.version !== 'string') continue
    const source = isTable(x.marketplaceSource) && typeof x.marketplaceSource.source === 'string' ? x.marketplaceSource.source : null
    out.push({ id: x.pluginId, name: x.name, marketplace: x.marketplaceName, version: x.version, enabled: x.enabled === true, marketplaceSource: source })
  }
  return out
}

/** What Codex says when the marketplace name is already added from another folder (C10). */
const TAKEN = 'is already added from a different source'
/** What a codex with no `plugin` command answers, with exit code 2. codex-cli 0.160 takes an unknown first word for its
 *  PROMPT and refuses the word after it (measured); clap says the subcommand is unrecognized when there is no PROMPT. */
const UNSUPPORTED = ['unexpected argument', 'unrecognized subcommand']
/** What codex answers, with exit code 1, when the account's config.toml does not parse (measured), with the parse error
 *  drawn under it. */
const CONFIG_LOAD = 'failed to load configuration'

const lineWith = (text: string, needles: string[]): string | undefined =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => needles.some((n) => l.includes(n)))

/** A run that did not succeed, as the account's failure. A refusal and a time limit are Astera's own. A config.toml
 *  Codex could not load is told by its first line. A name taken by another folder is told by Codex's line that says
 *  so, on whichever stream it wrote it. Anything else is Codex's own words, else its exit code. */
function cliFailed(r: PluginCliResult, args: string[]): Stop {
  if (r.refused !== undefined) return new Stop(r.refused, 'refused')
  const err = r.stderr.trim()
  if (r.timedOut) return new Stop(err !== '' ? err : `codex ${args.join(' ')} did not finish in time`, 'timed-out')
  if (err.includes(CONFIG_LOAD)) return new Stop(err.split(/\r?\n/)[0].trim(), 'config-unreadable')
  const taken = lineWith(`${r.stdout}\n${r.stderr}`, [TAKEN])
  if (taken !== undefined) return new Stop(taken, 'marketplace-taken')
  const out = r.stdout.trim()
  return new Stop(err !== '' ? err : out !== '' ? out : `codex ${args.join(' ')} exited with code ${String(r.code)}`)
}

/** `current` with `plugins."<id>".enabled` set as `flags` says; every other key of each entry and of the file kept. */
function flagPatch(current: Table, flags: Map<string, boolean>): Table {
  const plugins: Table = { ...(isTable(current.plugins) ? current.plugins : {}) }
  for (const [id, enabled] of flags) plugins[id] = { ...(isTable(plugins[id]) ? plugins[id] : {}), enabled }
  return { ...current, plugins }
}

const VERBATIM = '\\\\?\\'
const VERBATIM_UNC = '\\\\?\\UNC\\'

/** A marketplace source as Codex records it, as a plain folder path. On Windows Codex records the folder it resolved
 *  with the `\\?\` prefix (measured on codex-cli 0.160), which Windows writes `\\?\UNC\server\share` for a share. */
export function marketplaceFolder(source: string): string {
  if (source.startsWith(VERBATIM_UNC)) return `\\\\${source.slice(VERBATIM_UNC.length)}`
  return source.startsWith(VERBATIM) ? source.slice(VERBATIM.length) : source
}

export async function reconcileCodexAccount(a: {
  account: Account
  homeDir: string
  marketplace: { name: string; root: string }
  desired: DesiredCodexPlugin[]
  previous: CodexPluginAccountState | undefined
  /** An Astera-started session of this account is alive (C5, C14). */
  busy: boolean
  run: CodexPluginCliRun
  hooks: CodexHooksList
  lock: <T>(fn: () => Promise<T>) => Promise<T>
  now: () => Date
}): Promise<CodexPluginAccountState> {
  const m = a.marketplace.name
  const desired = new Map(a.desired.map((d) => [d.name, d]))
  const previousOff = a.previous?.turnedOff ?? []
  // What is known so far, answered as it stands when a step fails: the versions of the latest list Codex gave, and the
  // own plugins Astera has turned off as far as config.toml has been written
  let installed: Record<string, string> = { ...a.previous?.installed }
  let turnedOff = previousOff
  const answer = (o: { waiting?: boolean; failure?: CodexPluginAccountState['failure'] } = {}): CodexPluginAccountState => ({
    accountId: a.account.id,
    installed,
    waiting: o.waiting ?? false,
    ...(o.failure === undefined ? {} : { failure: o.failure }),
    turnedOff,
    at: a.now().toISOString()
  })

  // A person who shares nothing, in an account this profile never touched: no codex runs and no file changes (§4)
  if (a.desired.length === 0 && a.previous === undefined) return answer()

  // The ambient ~/.codex account is found by codex with no CODEX_HOME (isAmbientDir's rule)
  const codexHome = comparablePath(a.account.configDir) === comparablePath(path.join(a.homeDir, '.codex')) ? null : a.account.configDir
  // Keyed by this path so the writes share oneAtATime with markCodexProjectTrusted
  const configFile = path.join(a.account.configDir, 'config.toml')

  const run = async (args: string[], o?: { timeoutMs?: number }): Promise<PluginCliResult> => {
    const r = await a.run(codexHome, args, o)
    if (r.refused !== undefined || r.timedOut || r.code !== 0) throw cliFailed(r, args)
    return r
  }
  /** `plugin list`. Only the pass's first one can tell a codex that has no plugin command: a later command refused the
   *  same way has some other cause. */
  const list = async (o: { first?: boolean } = {}): Promise<Listed[]> => {
    const args = ['plugin', 'list']
    const r = await a.run(codexHome, args)
    const unsupported = o.first && r.refused === undefined && !r.timedOut && r.code === 2 ? lineWith(r.stderr, UNSUPPORTED) : undefined
    if (unsupported !== undefined) throw new Stop(unsupported, 'codex-unsupported')
    if (r.refused !== undefined || r.timedOut || r.code !== 0) throw cliFailed(r, args)
    return installedRows(r.json)
  }
  /** One config.toml write, under the profile lock the settings import also takes (P4), through a link as Codex does. A
   *  file that does not parse is left as it is and fails the account. */
  const write = async (patch: (current: Table) => Table): Promise<void> => {
    try {
      await a.lock(() => patchTomlFile(configFile, patch, { throughLink: true }))
    } catch (e) {
      throw new Stop(messageOf(e), 'config-unreadable')
    }
  }
  // This profile's marketplace is its name added from its own folder. Another profile whose folder has the same base
  // name has the same marketplace name (C12), so a row or a marketplace table under the name is Astera's to touch only
  // when it comes from this folder. A pass whose `marketplace add` succeeded knows that of every row under the name, as
  // Codex refuses an add from a different source. A pass that adds nothing compares folders, with the root both as given
  // and as the file system resolves it: Codex records the folder resolved (a junction, a symlink, a subst drive).
  let added = false
  const roots = new Set<string>()
  const fromThisFolder = (source: string | null): boolean =>
    added || (source !== null && roots.has(comparablePath(marketplaceFolder(source))))
  const taken = (source: string | null): Stop =>
    new Stop(`marketplace '${m}' is already added from ${source ?? 'a folder codex did not name'}, not from ${a.marketplace.root}`, 'marketplace-taken')
  /** The name taken by another folder fails the account before anything is done in it, as a refused add does (step 2). */
  const refuseTaken = (rows: Listed[]): void => {
    const other = rows.find((r) => r.marketplace === m && !fromThisFolder(r.marketplaceSource))
    if (other !== undefined) throw taken(other.marketplaceSource)
  }
  const ours = (rows: Listed[]): Listed[] => rows.filter((r) => r.marketplace === m && fromThisFolder(r.marketplaceSource))
  const versions = (rows: Listed[]): Record<string, string> => Object.fromEntries(ours(rows).map((r) => [r.name, r.version]))
  /** The name of this marketplace's plugin a `hooks.state` key or a plugin id belongs to; null for anything else. */
  const pluginOf = (id: string): string | null => (id.endsWith(`@${m}`) ? id.slice(0, -(m.length + 1)) : null)
  const keyPlugin = (key: string): string | null => {
    const colon = key.indexOf(':')
    return colon < 0 ? null : pluginOf(key.slice(0, colon))
  }

  /** Steps 5 and 6: each installed shared copy's flag as the person set it, and each own plugin of the same name off
   *  while the shared copy is on here, back on once it is not, but only one Astera turned off and still finds off (C1).
   *  Another profile's marketplace and its plugins are never an account's own (C12). With `waiting`, a copy no longer
   *  shared, whose removal waits for the account's sessions, is turned off first, so the own copy turned back on never
   *  loads beside it. */
  const writeFlags = async (rows: Listed[], o: { waiting?: boolean } = {}): Promise<void> => {
    const flags = new Map<string, boolean>()
    for (const r of ours(rows)) {
      const enabled = desired.get(r.name)?.enabled ?? (o.waiting ? false : undefined)
      if (enabled !== undefined && r.enabled !== enabled) flags.set(r.id, enabled)
    }
    const sharedOn = (name: string): boolean => desired.get(name)?.enabled === true && ours(rows).some((r) => r.name === name)
    const off: string[] = []
    for (const r of rows) {
      if (r.marketplace === m || (r.marketplaceSource !== null && isAsteraCodexMarketplace(r.marketplaceSource))) continue
      const astera = previousOff.includes(r.id)
      if (sharedOn(r.name)) {
        if (r.enabled) flags.set(r.id, false)
        // One the person had off already stays theirs, so it is never turned back on
        if (r.enabled || astera) off.push(r.id)
      } else if (astera && !r.enabled) flags.set(r.id, true)
    }
    if (flags.size > 0) await write((current) => flagPatch(current, flags))
    turnedOff = off
  }

  const pass = async (): Promise<CodexPluginAccountState> => {
    // fs.promises.realpath has fs.realpath.native's semantics: the operating system resolves the whole path
    roots.add(comparablePath(a.marketplace.root))
    const resolved = await fs.realpath(a.marketplace.root).catch(() => null)
    if (resolved !== null) roots.add(comparablePath(resolved))

    // 1. What the account has
    const before = await list({ first: true })
    installed = versions(before)
    // Read on every row under the name: which of them are this profile's is settled by the add, which comes after
    const named = before.filter((r) => r.marketplace === m)
    const due = a.desired.some((d) => named.find((r) => r.name === d.name)?.version !== d.version) || named.some((r) => !desired.has(r.name))
    const waiting = a.busy && due
    // A pass that will add nothing settles by folder which rows are this profile's
    if (a.desired.length === 0 || waiting) refuseTaken(before)

    // 3., decided on the first list and before step 2, so an account left waiting runs nothing more. A reinstall and a
    // removal delete the folder a running session reads its hooks and skills from (C5, C14); a flag does not, so the
    // flags are still written, and the versions recorded are what the first list shows.
    if (waiting) {
      await writeFlags(before, { waiting: true })
      return answer({ waiting: true })
    }

    // 2. Adding a folder already added is a no-op that answers alreadyAdded; under this name from another folder Codex
    // refuses, and the account goes no further. Once it succeeds, every row under the name is this profile's.
    if (a.desired.length > 0) {
      await run(['plugin', 'marketplace', 'add', a.marketplace.root])
      added = true
      installed = versions(before)
    }

    // 4. Each one missing or at another version; an add at a new version replaces the old version's folder
    const toAdd = a.desired.filter((d) => ours(before).find((r) => r.name === d.name)?.version !== d.version)
    for (const d of toAdd) await run(['plugin', 'add', `${d.name}@${m}`], { timeoutMs: CODEX_PLUGIN_ADD_TIMEOUT_MS })
    const rows = toAdd.length > 0 ? await list() : before
    installed = versions(rows)

    // 5., 6. Before the hooks are listed, so a plugin just turned on has its hooks listed
    await writeFlags(rows)

    // 7. Codex gives the keys and hashes (P1). Its app-server is started only when a hook of a shared plugin can load
    const leaving = ours(rows).filter((r) => !desired.has(r.name))
    const trust: { key: string; hash: string }[] = []
    if (ours(rows).some((r) => desired.get(r.name)?.enabled === true)) {
      let hooks: CodexHookRow[]
      try {
        hooks = await a.hooks(codexHome, a.marketplace.root)
      } catch (e) {
        throw new Stop(messageOf(e), 'hooks-unreadable')
      }
      for (const h of hooks) {
        const name = h.pluginId === null ? null : pluginOf(h.pluginId)
        if (name !== null && desired.get(name)?.enabled === true && h.trustStatus !== 'trusted') trust.push({ key: h.key, hash: h.currentHash })
      }
    }
    // Keys of a plugin no longer shared go, except while it is still installed: those go after its removal (step 8), so
    // a removal that fails leaves its hooks trusted. A key that is trusted here is never also dropped.
    const trusted = new Set(trust.map((t) => t.key))
    const stale = (keep: Set<string>) => (key: string): boolean => {
      const name = keyPlugin(key)
      return name !== null && !keep.has(name) && !trusted.has(key)
    }
    // config.toml's table for the name says whose it is when no plugin of it is installed. One from another folder means
    // the `<name>@<m>:` keys are that folder's too, so nothing is written and the account fails as taken.
    const table = { added: false, other: undefined as string | null | undefined }
    await write((current) => {
      const entry = isTable(current.marketplaces) ? current.marketplaces[m] : undefined
      if (isTable(entry)) {
        const source = typeof entry.source === 'string' ? entry.source : null
        if (!fromThisFolder(source)) {
          table.other = source
          return current
        }
        table.added = true
      }
      return trustPatch(current, { trust, drop: stale(new Set([...desired.keys(), ...leaving.map((r) => r.name)])) })
    })
    if (table.other !== undefined) throw taken(table.other)

    // 8. What is no longer shared, then its trust keys
    for (const r of leaving) {
      await run(['plugin', 'remove', `${r.name}@${m}`])
      delete installed[r.name]
    }
    if (leaving.length > 0) await write((current) => trustPatch(current, { trust: [], drop: stale(new Set(desired.keys())) }))

    // 9. After the plugins: a marketplace removed first leaves them installed with nothing to remove them by (C13). Only
    // when config.toml names it, as `plugin list` does not say whether it is added
    if (a.desired.length === 0 && table.added) await run(['plugin', 'marketplace', 'remove', m])

    // 10. The outcome
    return answer()
  }

  try {
    return await pass()
  } catch (e) {
    return answer({ failure: e instanceof Stop && e.code !== undefined ? { message: e.message, code: e.code } : { message: messageOf(e) } })
  }
}
