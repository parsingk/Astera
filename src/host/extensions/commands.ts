// The Host's `extensions-*` commands (Agent Control Plane release 1 design §4.3, §4.6): the Host owns the shared
// extension registry, so the app's Settings › Extensions and this machine's CLI change it through here. Like the
// `plugins-*` commands, they are for the app and the CLI only: MCP, a remote controller and a plugin never get here,
// since no gate lists them, and an agent's shell may read but not change. Every change syncs the managed copies
// afterwards, and the answer never carries an environment value, only names (D5).
import { RepairNeeded } from '../../core/settings/repairNeeded'
import { publicEntry, readExtensionRegistry } from '../../core/extensions/registry'
import { hideExtensionSecrets, hidingLog } from '../../core/extensions/secrets'
import { redactSecrets } from '../../core/remote/redact'
import { discoverIn } from '../../core/extensions/discover'
import { importItems, removeEntry, setEnabled, type ImportPick } from '../../core/extensions/importItems'
import { replaceConflict, syncMaterialized, type SyncItem } from '../../core/extensions/materialize'
import type { OrchCaller } from '../../core/host/orchProtocol'
import type { ExtensionKind } from '../../core/extensions/types'
import type { Account } from '../../core/types'

export const EXTENSION_COMMANDS: ReadonlySet<string> = new Set([
  'extensions-list',
  'extensions-discover',
  'extensions-import',
  'extensions-enable',
  'extensions-disable',
  'extensions-remove',
  'extensions-sync',
  'extensions-replace'
])

/** The ones that change the registry or the accounts' copies. */
export const EXTENSION_CHANGES: ReadonlySet<string> = new Set([
  'extensions-import',
  'extensions-enable',
  'extensions-disable',
  'extensions-remove',
  'extensions-sync',
  'extensions-replace'
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
}

const KINDS: readonly ExtensionKind[] = ['mcp', 'skill', 'command', 'agent']

const bad = (error: string): ExtensionsAnswer => ({ status: 400, body: { error } })
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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

  const syncNow = async (): Promise<SyncItem[]> => {
    const r = await syncMaterialized({ profileDir: d.profileDir, accounts: await d.readAccounts() })
    last = r.items
    for (const i of r.items) if (i.outcome === 'failed') log(`extensions: ${i.id} could not be synced into account ${i.accountId} (${i.detail ?? 'unknown'})`)
    return r.items
  }

  const answer = async (cmd: string, args: Record<string, unknown>): Promise<ExtensionsAnswer> => {
    switch (cmd) {
      case 'extensions-list': {
        const registry = await readExtensionRegistry(d.profileDir)
        return { status: 200, body: { entries: registry.entries.map(publicEntry), status: last } }
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
          return { status: 200, body: { sync: await syncNow() } }
        })
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
      })
  }
}
