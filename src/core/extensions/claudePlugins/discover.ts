// The Claude Code plugins installed in the Claude accounts, so the person can pick which to share across them. It reads
// account files only (plugins/installed_plugins.json, plugins/known_marketplaces.json, settings.json and a plugin's
// own manifest) and writes none: nothing here installs, enables or edits anything in an account's config folder.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { providerOf } from '../../providers/meta'
import { credentialInLaunch } from '../discover'
import type { Account } from '../../types'
import type { ClaudePluginRefusal, MarketplaceSource, SharedClaudePlugin } from './types'

export interface ClaudePluginHolder {
  accountId: string
  version: string
  enabled: boolean
}

export type DiscoveredClaudePlugin = {
  id: string
  name: string
  marketplace: string
  /** Every Claude account holding the plugin at user scope, in the order the accounts were given. */
  holders: ClaudePluginHolder[]
  /** From the first account that holds the plugin and knows its marketplace; null when none does or the source is one
   *  Astera cannot hand to `claude plugin marketplace add`. */
  source: MarketplaceSource | null
  /** That account; the first holder when no holder knows the marketplace. */
  sourceAccountId: string
} & ({ shareable: true } | { shareable: false; reason: ClaudePluginRefusal })

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Marketplaces Claude Code reports for a plugin that no marketplace holds: `--plugin-dir`, the ones it ships with, and a
 *  skills folder. There is nothing to add and install them from. */
const NOT_FROM_MARKETPLACE = new Set(['inline', 'builtin', 'skills-dir'])

const text = (r: Obj, key: string): string | null => (typeof r[key] === 'string' && r[key] !== '' ? r[key] : null)

/** What follows `claude plugin marketplace add` for a source (the M10 table), or null when it cannot be said with one
 *  argument. It reads the object it is given, not its type: a github or git source can also carry `path` or
 *  `sparsePaths` in an account's file, which the type has no room for and the argument cannot express. */
export function marketplaceArg(s: MarketplaceSource): string | null {
  const r: Obj = { ...s }
  switch (r.source) {
    case 'github':
    case 'git': {
      if (r.path !== undefined || r.sparsePaths !== undefined) return null
      const base = text(r, r.source === 'github' ? 'repo' : 'url')
      if (base === null) return null
      if (r.ref === undefined) return base
      const ref = text(r, 'ref')
      return ref === null ? null : `${base}#${ref}`
    }
    case 'directory':
    case 'file':
      return text(r, 'path')
    case 'url':
      return text(r, 'url')
    default:
      return null
  }
}

const SOURCE_FIELDS: Record<MarketplaceSource['source'], string[]> = {
  github: ['repo', 'ref'],
  git: ['url', 'ref'],
  url: ['url'],
  directory: ['path'],
  file: ['path']
}

/** An account's recorded source as a MarketplaceSource, or null when `marketplaceArg` cannot say it. Only the fields a
 *  source is made of are carried over: what else a record holds (a url source may hold request headers) goes nowhere. */
function sourceOf(raw: unknown): MarketplaceSource | null {
  if (!isObj(raw) || marketplaceArg(raw as MarketplaceSource) === null) return null
  const clean: Obj = { source: raw.source }
  for (const key of SOURCE_FIELDS[raw.source as MarketplaceSource['source']]) if (raw[key] !== undefined) clean[key] = raw[key]
  return clean as MarketplaceSource
}

/** Undefined when there is no such file; throws when it is there but cannot be read or is not a JSON object (damaged, or
 *  the CLI is writing it). */
async function readObject(file: string): Promise<Obj | undefined> {
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  const v: unknown = JSON.parse(raw)
  if (!isObj(v)) throw new Error(`${path.basename(file)} is not a JSON object`)
  return v
}

interface Held {
  version: string
  installPath: string | null
}
interface AccountFiles {
  accountId: string
  /** Plugin id to its user-scope install. */
  installed: Map<string, Held>
  /** Marketplace name to its record in known_marketplaces.json. */
  marketplaces: Map<string, unknown>
  enabled: Obj
}

async function readAccount(account: Account): Promise<AccountFiles> {
  const plugins = path.join(account.configDir, 'plugins')
  const [installedFile, known, settings] = await Promise.all([
    readObject(path.join(plugins, 'installed_plugins.json')),
    readObject(path.join(plugins, 'known_marketplaces.json')),
    readObject(path.join(account.configDir, 'settings.json'))
  ])
  const installed = new Map<string, Held>()
  if (installedFile !== undefined) {
    if (!isObj(installedFile.plugins)) throw new Error('installed_plugins.json has no plugins')
    for (const [id, entries] of Object.entries(installedFile.plugins)) {
      const user = Array.isArray(entries) ? entries.find((e): e is Obj => isObj(e) && e.scope === 'user') : undefined
      if (user) installed.set(id, { version: typeof user.version === 'string' ? user.version : 'unknown', installPath: typeof user.installPath === 'string' ? user.installPath : null })
    }
  }
  return {
    accountId: account.id,
    installed,
    marketplaces: new Map(Object.entries(known ?? {})),
    enabled: isObj(settings?.enabledPlugins) ? settings.enabledPlugins : {}
  }
}

/** Whether a plugin's manifest asks the person for settings (`userConfig`). Those values live in the account that was
 *  asked, so a copy installed once for every account would never have them. A manifest that is missing or cannot be
 *  parsed declares none. */
async function declaresUserConfig(installPath: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(await fs.readFile(path.join(installPath, '.claude-plugin', 'plugin.json'), 'utf8'))
    const asked = isObj(manifest) ? manifest.userConfig : undefined
    return typeof asked === 'object' && asked !== null && Object.keys(asked).length > 0
  } catch {
    return false
  }
}

interface Group {
  id: string
  name: string
  marketplace: string
  holders: ClaudePluginHolder[]
  installPaths: string[]
  source: MarketplaceSource | null
  sourceAccountId: string | null
}

/** The first reason that applies, in the order the design gives them. userConfig is asked of every holder's copy, since
 *  versions differ between accounts and the one Astera installs may be newer than any of them. */
async function refusalOf(g: Group, shared: SharedClaudePlugin[]): Promise<ClaudePluginRefusal | null> {
  if (NOT_FROM_MARKETPLACE.has(g.marketplace)) return 'not-from-marketplace'
  if (shared.some((s) => s.name === g.name && s.marketplace !== g.marketplace)) return 'name-taken'
  if (g.source === null) return 'source-unsupported'
  if ('url' in g.source && credentialInLaunch(undefined, g.source.url)) return 'source-credential'
  if ((await Promise.all(g.installPaths.map(declaresUserConfig))).some(Boolean)) return 'user-config'
  return null
}

/** The plugins installed in `accounts` (Claude ones only), unioned by id, each with the accounts that hold it. One
 *  already in `shared` is left out. An account without plugin files holds none; one whose files are there but cannot be
 *  read or parsed is named in `unreadable`, and the others are still listed. */
export async function discoverClaudePlugins(a: {
  accounts: Account[]
  shared: SharedClaudePlugin[]
}): Promise<{ plugins: DiscoveredClaudePlugin[]; unreadable: string[] }> {
  const claude = a.accounts.filter((account) => providerOf(account) === 'claude')
  const read = await Promise.all(claude.map((account) => readAccount(account).catch(() => null)))
  const unreadable = claude.filter((_, i) => read[i] === null).map((account) => account.id)

  const sharedIds = new Set(a.shared.map((s) => s.id))
  const groups = new Map<string, Group>()
  for (const files of read) {
    if (files === null) continue
    for (const [id, held] of files.installed) {
      if (sharedIds.has(id)) continue
      const at = id.lastIndexOf('@')
      if (at <= 0 || at === id.length - 1) continue
      const g: Group = groups.get(id) ?? { id, name: id.slice(0, at), marketplace: id.slice(at + 1), holders: [], installPaths: [], source: null, sourceAccountId: null }
      groups.set(id, g)
      g.holders.push({ accountId: files.accountId, version: held.version, enabled: files.enabled[id] === true })
      if (held.installPath !== null) g.installPaths.push(held.installPath)
      if (g.sourceAccountId === null && files.marketplaces.has(g.marketplace)) {
        const record = files.marketplaces.get(g.marketplace)
        g.sourceAccountId = files.accountId
        g.source = sourceOf(isObj(record) ? record.source : undefined)
      }
    }
  }

  const plugins: DiscoveredClaudePlugin[] = []
  for (const g of groups.values()) {
    const found = { id: g.id, name: g.name, marketplace: g.marketplace, holders: g.holders, source: g.source, sourceAccountId: g.sourceAccountId ?? g.holders[0].accountId }
    const reason = await refusalOf(g, a.shared)
    plugins.push(reason ? { ...found, shareable: false, reason } : { ...found, shareable: true })
  }
  return { plugins, unreadable }
}
