// Bringing one Codex account in line with what this profile shares (Codex plugin sharing design §5.3, §5.4): each shared
// plugin and dependency installed from this profile's marketplace at the shared version, its `enabled` flag as the
// person set it (C4), the account's own plugin of the same name off while the shared one is on and back on after (C1),
// the shared plugins' hooks trusted, and what is no longer shared removed. Codex installs and removes (`codex plugin
// …`); Astera writes the flags and the trust itself, since codex-cli 0.160 has no command for either.
//
// A pass never rejects. Whatever stops it is the account's failure, and the row it answers says what is known by then,
// so one account's trouble never stops the others and the Claude side, already done, never fails over it.
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
/** What clap says to a `codex` that has no `plugin` command (assumed, not measured). */
const UNSUPPORTED = 'unrecognized subcommand'

const lineWith = (text: string, needle: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.includes(needle))

/** A run that did not succeed, as the account's failure. A refusal and a time limit are Astera's own. A name taken by
 *  another folder and a codex with no plugin command are told by Codex's line that says so, on whichever stream it
 *  wrote it. Anything else is Codex's own words, else its exit code. */
function cliFailed(r: PluginCliResult, args: string[]): Stop {
  if (r.refused !== undefined) return new Stop(r.refused, 'refused')
  const err = r.stderr.trim()
  if (r.timedOut) return new Stop(err !== '' ? err : `codex ${args.join(' ')} did not finish in time`, 'timed-out')
  const output = `${r.stdout}\n${r.stderr}`
  const taken = lineWith(output, TAKEN)
  if (taken !== undefined) return new Stop(taken, 'marketplace-taken')
  const unsupported = lineWith(output, UNSUPPORTED)
  if (unsupported !== undefined) return new Stop(unsupported, 'codex-unsupported')
  const out = r.stdout.trim()
  return new Stop(err !== '' ? err : out !== '' ? out : `codex ${args.join(' ')} exited with code ${String(r.code)}`)
}

/** `current` with `plugins."<id>".enabled` set as `flags` says; every other key of each entry and of the file kept. */
function flagPatch(current: Table, flags: Map<string, boolean>): Table {
  const plugins: Table = { ...(isTable(current.plugins) ? current.plugins : {}) }
  for (const [id, enabled] of flags) plugins[id] = { ...(isTable(plugins[id]) ? plugins[id] : {}), enabled }
  return { ...current, plugins }
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
  const list = async (): Promise<Listed[]> => installedRows((await run(['plugin', 'list'])).json)
  /** One config.toml write, under the profile lock the settings import also takes (P4), through a link as Codex does. A
   *  file that does not parse is left as it is and fails the account. */
  const write = async (patch: (current: Table) => Table): Promise<void> => {
    try {
      await a.lock(() => patchTomlFile(configFile, patch, { throughLink: true }))
    } catch (e) {
      throw new Stop(messageOf(e), 'config-unreadable')
    }
  }
  const ours = (rows: Listed[]): Listed[] => rows.filter((r) => r.marketplace === m)
  const versions = (rows: Listed[]): Record<string, string> => Object.fromEntries(ours(rows).map((r) => [r.name, r.version]))
  /** The name of this marketplace's plugin a `hooks.state` key or a plugin id belongs to; null for anything else. */
  const pluginOf = (id: string): string | null => (id.endsWith(`@${m}`) ? id.slice(0, -(m.length + 1)) : null)
  const keyPlugin = (key: string): string | null => {
    const colon = key.indexOf(':')
    return colon < 0 ? null : pluginOf(key.slice(0, colon))
  }

  /** Steps 5 and 6: each installed shared copy's flag as the person set it, and each own plugin of the same name off
   *  while the shared copy is on here, back on once it is not, but only one Astera turned off and still finds off (C1).
   *  Another profile's marketplace and its plugins are never an account's own (C12). */
  const writeFlags = async (rows: Listed[]): Promise<void> => {
    const flags = new Map<string, boolean>()
    for (const r of ours(rows)) {
      const d = desired.get(r.name)
      if (d !== undefined && r.enabled !== d.enabled) flags.set(r.id, d.enabled)
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
    // 1. What the account has
    const before = await list()
    installed = versions(before)
    const toAdd = a.desired.filter((d) => ours(before).find((r) => r.name === d.name)?.version !== d.version)

    // 3., decided on the first list and before step 2, so an account left waiting runs nothing more. A reinstall and a
    // removal delete the folder a running session reads its hooks and skills from (C5, C14); a flag does not, so the
    // flags are still written, and the versions recorded stay as they were until the account is brought in line.
    if (a.busy && (toAdd.length > 0 || ours(before).some((r) => !desired.has(r.name)))) {
      await writeFlags(before)
      installed = { ...a.previous?.installed }
      return answer({ waiting: true })
    }

    // 2. Adding a folder already added is a no-op that answers alreadyAdded; under this name from another folder Codex
    // refuses, and the account goes no further
    if (a.desired.length > 0) await run(['plugin', 'marketplace', 'add', a.marketplace.root])

    // 4. Each one missing or at another version; an add at a new version replaces the old version's folder
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
    let marketplaceAdded = false
    await write((current) => {
      marketplaceAdded = isTable(current.marketplaces) && isTable(current.marketplaces[m])
      return trustPatch(current, { trust, drop: stale(new Set([...desired.keys(), ...leaving.map((r) => r.name)])) })
    })

    // 8. What is no longer shared, then its trust keys
    for (const r of leaving) {
      await run(['plugin', 'remove', `${r.name}@${m}`])
      delete installed[r.name]
    }
    if (leaving.length > 0) await write((current) => trustPatch(current, { trust: [], drop: stale(new Set(desired.keys())) }))

    // 9. After the plugins: a marketplace removed first leaves them installed with nothing to remove them by (C13). Only
    // when config.toml names it, as `plugin list` does not say whether it is added
    if (a.desired.length === 0 && marketplaceAdded) await run(['plugin', 'marketplace', 'remove', m])

    // 10. The outcome
    return answer()
  }

  try {
    return await pass()
  } catch (e) {
    return answer({ failure: e instanceof Stop && e.code !== undefined ? { message: e.message, code: e.code } : { message: messageOf(e) } })
  }
}
