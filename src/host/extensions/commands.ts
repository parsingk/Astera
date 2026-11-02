// The Host's `extensions-*` commands (Agent Control Plane release 1 design §4.3, §4.6): the Host owns the shared
// extension registry, so the app's Settings › Extensions and this machine's CLI change it through here. Like the
// `plugins-*` commands, they are for the app and the CLI only: MCP, a remote controller and a plugin never get here,
// since no gate lists them, and an agent's shell may read but not change. Every change syncs the managed copies
// afterwards, and the answer never carries an environment value, only names (D5).
//
// The shared Claude Code plugins' `extensions-plugin-*` commands are here too, beside the other kinds but not on their
// queue (R4): each change is a job on the plugins' own queue (claudePlugins/operations.ts) that answers its id at once,
// since an install can take minutes, and the settings tab reads the jobs' state in the list.
import { promises as fs } from 'node:fs'
import { RepairNeeded } from '../../core/settings/repairNeeded'
import { publicEntry, readExtensionRegistry } from '../../core/extensions/registry'
import { hideExtensionSecrets, hidingLog } from '../../core/extensions/secrets'
import { redactSecrets } from '../../core/remote/redact'
import { discoverIn } from '../../core/extensions/discover'
import { importItems, removeEntry, setEnabled, setIsolation, type ImportPick } from '../../core/extensions/importItems'
import type { GatewayHub } from '../gateway/hub'
import { replaceConflict, syncMaterialized, type SyncItem } from '../../core/extensions/materialize'
import type { OrchCaller } from '../../core/host/orchProtocol'
import type { ExtensionEntry, ExtensionKind } from '../../core/extensions/types'
import { resolveSessionCapabilities, type SkipReason } from '../../core/extensions/resolve'
import { readClaudePlugins } from '../../core/extensions/claudePlugins/store'
import { discoverClaudePlugins } from '../../core/extensions/claudePlugins/discover'
import { createClaudePluginOps, sweepOrphanedClaudePlugins, type ClaudePluginOps } from '../../core/extensions/claudePlugins/operations'
import type { PluginCliRun } from '../../core/extensions/claudePlugins/cli'
import type { ClaudePluginRefusal } from '../../core/extensions/claudePlugins/types'
import type { Account } from '../../core/types'

export const EXTENSION_COMMANDS: ReadonlySet<string> = new Set([
  'extensions-list',
  'extensions-discover',
  'extensions-import',
  'extensions-enable',
  'extensions-disable',
  'extensions-remove',
  'extensions-sync',
  'extensions-replace',
  'extensions-gateway',
  'extensions-isolation',
  'extensions-plugin-list',
  'extensions-plugin-discover',
  'extensions-plugin-share',
  'extensions-plugin-update',
  'extensions-plugin-check',
  'extensions-plugin-remove',
  'extensions-plugin-set-enabled'
])

/** The ones that change the registry, the accounts' copies, or the shared Claude plugins. */
export const EXTENSION_CHANGES: ReadonlySet<string> = new Set([
  'extensions-import',
  'extensions-enable',
  'extensions-disable',
  'extensions-remove',
  'extensions-sync',
  'extensions-replace',
  'extensions-isolation',
  'extensions-plugin-share',
  'extensions-plugin-update',
  'extensions-plugin-check',
  'extensions-plugin-remove',
  'extensions-plugin-set-enabled'
])

export interface ExtensionsAnswer {
  status: number
  body: unknown
}

export interface HostExtensions {
  command(a: {
    cmd: string
    args: Record<string, unknown>
    role: OrchCaller['role'] | undefined
    /** The sentence an agent's shell is refused with, present exactly when the caller is one. */
    agentRefusal?: string
    marks: { effects: number }
  }): Promise<ExtensionsAnswer>
  /** Syncs the managed copies into every account now; never rejects. */
  sync(): Promise<SyncItem[]>
  /** The Host's start for the shared Claude plugins: sweeps their folder once, before any plugin job runs, then checks
   *  them for updates now and every CLAUDE_PLUGIN_CHECK_EVERY_MS. Returns the stop; the timer never keeps the process
   *  alive. */
  keepCheckingClaudePlugins(o?: {
    /** Test injection: how the check is repeated; returns the stop. */
    every?: (ms: number, fn: () => void) => () => void
  }): () => void
}

const KINDS: readonly ExtensionKind[] = ['mcp', 'skill', 'command', 'agent']

/** How often the Host checks the shared Claude plugins' marketplaces for updates. */
const CLAUDE_PLUGIN_CHECK_EVERY_MS = 24 * 60 * 60 * 1000

const bad = (error: string): ExtensionsAnswer => ({ status: 400, body: { error } })
/** A share the accounts do not offer, with why in a word the settings tab can say. */
const refusedShare = (error: string, reason: ClaudePluginRefusal | 'not-offered'): ExtensionsAnswer => ({ status: 400, body: { error, reason } })
const NO_CLAUDE_PLUGINS: ExtensionsAnswer = { status: 501, body: { error: 'this Host does not share Claude plugins' } }
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const isFolder = (p: string): Promise<boolean> => fs.stat(p).then((s) => s.isDirectory(), () => false)

function picksOf(v: unknown): ImportPick[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const out: ImportPick[] = []
  for (const p of v) {
    if (typeof p !== 'object' || p === null) return null
    const { kind, name, secretNames } = p as Record<string, unknown>
    if (!KINDS.includes(kind as ExtensionKind) || typeof name !== 'string' || name === '') return null
    if (secretNames !== undefined && !(Array.isArray(secretNames) && secretNames.every((s) => typeof s === 'string'))) return null
    out.push({ kind: kind as ExtensionKind, name, ...(secretNames !== undefined ? { secretNames: secretNames as string[] } : {}) })
  }
  return out
}

export function createHostExtensions(d: {
  profileDir: string
  homeDir: string
  readAccounts: () => Promise<Account[]>
  log: (line: string) => void
  platform?: NodeJS.Platform
  /** The Host's MCP Gateway (Gateway design §4.1): synced after every change, its port for the per-account status and
   *  the app, its processes' state for the list. Absent: this Host runs none, and stdio servers are not given. */
  gateway?: Pick<GatewayHub, 'sync' | 'port' | 'states' | 'stopServer'>
  /** How `claude plugin …` runs in Astera's own plugin folder (claudePlugins/cli.ts). Absent: this Host shares no Claude
   *  plugins, and the plugin changes answer 501. */
  claudePluginRun?: PluginCliRun
}): HostExtensions {
  // Every line written about shared extensions, and every error answered, has the stored secret values taken out
  // (design §4.9): an error's own words may quote a file that holds one
  const log = hidingLog(d.profileDir, d.log)
  const hide = (line: string): Promise<string> => hideExtensionSecrets(d.profileDir, line).catch(() => redactSecrets(line))
  // The last sync's outcome per item and account: what `extensions-list` reports as status
  let last: SyncItem[] = []
  // One change at a time: an import and a sync must not both rewrite the registry or the state file
  let chain: Promise<unknown> = Promise.resolve()
  const queued = <T>(f: () => Promise<T>): Promise<T> => {
    const run = chain.then(f, f)
    chain = run.catch(() => {})
    return run
  }

  // The shared Claude plugins' jobs, on their own queue. They are made once the plugin folder has been swept, so no job
  // runs beside the sweep: the Host's start or the first plugin command, whichever comes first, starts it, and both wait
  // for it. `pluginJobs` is what the list reads meanwhile, and it never waits. A start-up step that failed fails the
  // callers waiting for it and is tried again by the next one, rather than kept as every later answer until a restart.
  let pluginJobs: ClaudePluginOps | null = null
  let pluginsReady: Promise<ClaudePluginOps> | null = null
  const claudePlugins = (): Promise<ClaudePluginOps> | null => {
    const run = d.claudePluginRun
    if (run === undefined) return null
    if (pluginsReady === null) {
      const ready = sweepOrphanedClaudePlugins(d.profileDir)
        .then((gone) => {
          if (gone.length > 0) log(`claude plugins: removed ${gone.length} version folder(s) no session used: ${gone.join(', ')}`)
          pluginJobs = createClaudePluginOps({ profileDir: d.profileDir, run, log })
          return pluginJobs
        })
        .catch((e: unknown) => {
          pluginsReady = null
          throw new Error(`the shared Claude plugins could not be started (${message(e)})`)
        })
      // A caller that answers before it waits (a share no account offers) must not leave the failure unhandled
      ready.catch(() => {})
      pluginsReady = ready
    }
    return pluginsReady
  }
  // Read only: a damaged store's copy is kept by the jobs' own reading, never by a question
  const readPlugins = () => readClaudePlugins(d.profileDir, { keepDamaged: false })
  const pluginShared = async (id: string): Promise<boolean> => (await readPlugins()).plugins.some((e) => e.id === id)
  const notShared = (id: string): ExtensionsAnswer => ({ status: 404, body: { error: `no shared Claude plugin ${id}` } })

  const syncNow = async (): Promise<SyncItem[]> => {
    const r = await syncMaterialized({ profileDir: d.profileDir, accounts: await d.readAccounts() })
    last = r.items
    for (const i of r.items) if (i.outcome === 'failed') log(`extensions: ${i.id} could not be synced into account ${i.accountId} (${i.detail ?? 'unknown'})`)
    return r.items
  }

  /** For each enabled MCP server, per account, whether that account's sessions get it or why not (final review I1),
   *  worked out the way a spawn does, without writing anything. */
  const mcpStatus = async (entries: ExtensionEntry[]): Promise<{ id: string; accountId: string; state: 'given' | SkipReason }[]> => {
    const servers = entries.filter((e) => e.kind === 'mcp' && e.enabled)
    if (servers.length === 0) return []
    const out: { id: string; accountId: string; state: 'given' | SkipReason }[] = []
    for (const account of await d.readAccounts()) {
      const r = await resolveSessionCapabilities({ profileDir: d.profileDir, homeDir: d.homeDir, account, platform: d.platform ?? process.platform, gatewayPort: d.gateway?.port() ?? null, dryRun: true })
      const skipped = new Map(r.skipped.map((s) => [s.name, s.reason]))
      for (const e of servers) out.push({ id: e.id, accountId: account.id, state: r.given.includes(e.name) ? 'given' : (skipped.get(e.name) ?? 'provider') })
    }
    return out
  }

  /** The Gateway's processes, their last error with the stored secret values taken out (final review M2). */
  const hiddenStates = async () =>
    Promise.all((d.gateway?.states() ?? []).map(async (s) => (s.lastError === undefined ? s : { ...s, lastError: await hide(s.lastError) })))

  const answer = async (cmd: string, args: Record<string, unknown>): Promise<ExtensionsAnswer> => {
    switch (cmd) {
      case 'extensions-list': {
        const registry = await readExtensionRegistry(d.profileDir)
        await d.gateway?.sync()
        return {
          status: 200,
          body: { entries: registry.entries.map(publicEntry), status: last, mcpStatus: await mcpStatus(registry.entries), gateway: await hiddenStates() }
        }
      }
      case 'extensions-gateway':
        // Synced first, so a spawn that asks right after an import finds the listener open
        return { status: 200, body: { port: d.gateway ? await d.gateway.sync() : null } }
      case 'extensions-isolation': {
        if (typeof args.id !== 'string' || (args.isolation !== 'folder' && args.isolation !== 'session')) return bad('extensions-isolation needs id and isolation (folder or session)')
        const { id, isolation } = args as { id: string; isolation: 'folder' | 'session' }
        return queued(async () => {
          if (!(await readExtensionRegistry(d.profileDir)).entries.some((e) => e.id === id && e.kind === 'mcp')) return { status: 404, body: { error: `no shared server ${id}` } }
          await setIsolation(d.profileDir, id, isolation)
          return { status: 200, body: { isolation } }
        })
      }
      case 'extensions-discover': {
        if (typeof args.accountId !== 'string') return bad('extensions-discover needs accountId')
        const account = (await d.readAccounts()).find((a) => a.id === args.accountId)
        if (!account) return { status: 404, body: { error: `no account ${args.accountId}` } }
        const registry = await readExtensionRegistry(d.profileDir)
        return { status: 200, body: { items: await discoverIn({ account, homeDir: d.homeDir, registry }) } }
      }
      case 'extensions-import': {
        const picks = picksOf(args.picks)
        if (typeof args.accountId !== 'string' || picks === null) return bad('extensions-import needs accountId and picks')
        const account = (await d.readAccounts()).find((a) => a.id === args.accountId)
        if (!account) return { status: 404, body: { error: `no account ${args.accountId}` } }
        return queued(async () => {
          const result = await importItems({ profileDir: d.profileDir, homeDir: d.homeDir, account, picks })
          await d.gateway?.sync()
          return { status: 200, body: { ...result, sync: await syncNow() } }
        })
      }
      case 'extensions-enable':
      case 'extensions-disable':
      case 'extensions-remove': {
        if (typeof args.id !== 'string') return bad(`${cmd} needs id`)
        const id = args.id
        return queued(async () => {
          if (!(await readExtensionRegistry(d.profileDir)).entries.some((e) => e.id === id)) return { status: 404, body: { error: `no shared item ${id}` } }
          if (cmd === 'extensions-remove') await removeEntry(d.profileDir, id)
          else await setEnabled(d.profileDir, id, cmd === 'extensions-enable')
          // A server no longer shared stops at once; the listener closes when nothing is shared over stdio
          if (cmd !== 'extensions-enable') await d.gateway?.stopServer(id)
          await d.gateway?.sync()
          return { status: 200, body: { sync: await syncNow() } }
        })
      }
      case 'extensions-plugin-list': {
        // Not queued and no Gateway sync: the settings tab polls it while a job runs
        const store = await readPlugins()
        // Each account's own copy of a shared id: discovery leaves out what it is told is shared, so it is told nothing
        const copies = store.plugins.length === 0 ? [] : (await discoverClaudePlugins({ accounts: await d.readAccounts(), shared: [] })).plugins
        const plugins = await Promise.all(
          store.plugins.map(async (e) => ({
            ...e,
            // As a spawn finds it (spawnArgs.ts): with its own folder or a dependency's gone, no session is handed it
            missing: (await Promise.all([e.installPath, ...e.dependencies.map((x) => x.installPath)].map(isFolder))).includes(false),
            accountCopies: copies.find((c) => c.id === e.id)?.holders ?? [],
            // An entry that is off still loads for each of these, which need it (spawnArgs.ts)
            requiredBy: store.plugins.filter((o) => o.enabled && o.dependencies.some((x) => x.id === e.id)).map((o) => o.id)
          }))
        )
        return { status: 200, body: { plugins, jobs: pluginJobs?.jobs() ?? [], ...(store.lastCheck ? { lastCheck: store.lastCheck } : {}) } }
      }
      case 'extensions-plugin-discover': {
        const store = await readPlugins()
        return { status: 200, body: await discoverClaudePlugins({ accounts: await d.readAccounts(), shared: store.plugins }) }
      }
      case 'extensions-plugin-share': {
        const { id, acceptCommand } = args
        if (typeof id !== 'string' || (acceptCommand !== undefined && typeof acceptCommand !== 'string'))
          return bad('extensions-plugin-share needs id, and acceptCommand as a string when given')
        const ready = claudePlugins()
        if (ready === null) return NO_CLAUDE_PLUGINS
        // Asked again now rather than taken from the tab: the source and the account it comes from are the Host's to find
        const store = await readPlugins()
        const found = (await discoverClaudePlugins({ accounts: await d.readAccounts(), shared: store.plugins })).plugins.find((p) => p.id === id)
        if (!found) return refusedShare(`no Claude account offers ${id} to share`, 'not-offered')
        if (!found.shareable) return refusedShare(`${id} cannot be shared (${found.reason})`, found.reason)
        // Discovery refuses a plugin it has no source for, so this is only a guard
        if (found.source === null) return refusedShare(`${id} has no marketplace source Astera can add`, 'source-unsupported')
        const jobId = (await ready).share({ id, source: found.source, importedFrom: found.sourceAccountId, ...(acceptCommand === undefined ? {} : { acceptCommand }) })
        return { status: 200, body: { jobId } }
      }
      case 'extensions-plugin-update':
      case 'extensions-plugin-remove': {
        const { id, acceptCommand } = args
        if (typeof id !== 'string' || (cmd === 'extensions-plugin-update' && acceptCommand !== undefined && typeof acceptCommand !== 'string'))
          return bad(`${cmd} needs id${cmd === 'extensions-plugin-update' ? ', and acceptCommand as a string when given' : ''}`)
        const ready = claudePlugins()
        if (ready === null) return NO_CLAUDE_PLUGINS
        if (!(await pluginShared(id))) return notShared(id)
        const ops = await ready
        const jobId = cmd === 'extensions-plugin-update' ? ops.update(id, acceptCommand as string | undefined) : ops.remove(id)
        return { status: 200, body: { jobId } }
      }
      case 'extensions-plugin-check': {
        const ready = claudePlugins()
        if (ready === null) return NO_CLAUDE_PLUGINS
        return { status: 200, body: { jobId: (await ready).check() } }
      }
      case 'extensions-plugin-set-enabled': {
        const { id, enabled } = args
        if (typeof id !== 'string' || typeof enabled !== 'boolean') return bad('extensions-plugin-set-enabled needs id and enabled (true or false)')
        const ready = claudePlugins()
        if (ready === null) return NO_CLAUDE_PLUGINS
        if (!(await pluginShared(id))) return notShared(id)
        // A store write, not a job: it changes what the next session is handed and runs nothing
        await (await ready).setEnabled(id, enabled)
        return { status: 200, body: { enabled } }
      }
      case 'extensions-sync':
        return queued(async () => ({ status: 200, body: { sync: await syncNow() } }))
      case 'extensions-replace': {
        if (typeof args.accountId !== 'string' || typeof args.id !== 'string') return bad('extensions-replace needs accountId and id')
        const { accountId, id } = args as { accountId: string; id: string }
        return queued(async () => {
          await replaceConflict({ profileDir: d.profileDir, accountId, id, accounts: await d.readAccounts() })
          return { status: 200, body: { sync: await syncNow() } }
        })
      }
      default:
        return { status: 501, body: { error: `${cmd} is not answered by this Host` } }
    }
  }

  return {
    command: async (a) => {
      if (a.role !== 'app' && a.role !== 'cli') return { status: 403, body: { error: `${a.cmd} is for this machine's app and CLI only` } }
      if (EXTENSION_CHANGES.has(a.cmd) && a.agentRefusal !== undefined) return { status: 403, body: { error: a.agentRefusal } }
      let r: ExtensionsAnswer
      try {
        r = await answer(a.cmd, a.args)
      } catch (e) {
        // A damaged registry or accounts file is the person's to repair in the app (RepairNeeded), anything else failed
        r = { status: e instanceof RepairNeeded ? 409 : 500, body: { error: await hide(message(e)) } }
      }
      if (r.status === 200 && EXTENSION_CHANGES.has(a.cmd)) a.marks.effects += 1
      return r
    },
    sync: () =>
      queued(syncNow).catch((e: unknown) => {
        log(`extensions: the shared copies could not be synced (${message(e)})`)
        return []
      }),
    keepCheckingClaudePlugins: (o = {}) => {
      if (d.claudePluginRun === undefined) return () => {}
      const every =
        o.every ??
        ((ms: number, fn: () => void) => {
          const t = setInterval(fn, ms)
          t.unref?.()
          return () => clearInterval(t)
        })
      // While nothing is shared a check would run nothing, so it is not even a job: a person who shares no plugin sees no
      // job and gets no store. A store that cannot be read is checked, so the job fails and says why. Each tick asks for
      // the jobs again, so a start-up step that failed is tried again by the next one.
      const check = (): void => {
        void claudePlugins()
          ?.then(async (ops) => {
            const nothingShared = await readPlugins().then((s) => s.plugins.length === 0, () => false)
            if (!nothingShared) ops.check()
          })
          .catch((e: unknown) => log(`claude plugins: the update check did not start (${message(e)})`))
      }
      check()
      return every(CLAUDE_PLUGIN_CHECK_EVERY_MS, check)
    }
  }
}
