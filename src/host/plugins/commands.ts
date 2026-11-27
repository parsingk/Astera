// The Host's `plugins-*` commands (plugin runtime design P5): for this machine's app and CLI, the changes refused to an
// agent's shell, answered by the plugin manager. MCP, a remote controller and a plugin never get here: no plugins
// command is on their gates' lists. orch.ts calls this below the receipt line, so a change marks the one effect that
// keeps its receipt.
import type { OrchCaller } from '../../core/host/orchProtocol'
import type { PluginManager, PluginsAnswer } from './manager'
import type { PluginAudit, PluginAuditRecord } from '../../core/plugins/pluginAudit'

export const PLUGIN_COMMANDS: ReadonlySet<string> = new Set([
  'plugins-inspect',
  'plugins-install',
  'plugins-list',
  'plugins-get',
  'plugins-enable',
  'plugins-disable',
  'plugins-remove',
  'plugins-logs',
  'plugins-doctor',
  'plugins-settings',
  'plugins-configure',
  'plugins-audit',
  // Phase 4: the signed catalog
  'plugins-catalog',
  'plugins-catalog-configure',
  'plugins-catalog-inspect',
  'plugins-catalog-install'
])

/** The ones that change what is installed or whether it runs. */
export const PLUGIN_CHANGES: ReadonlySet<string> = new Set([
  'plugins-install',
  'plugins-enable',
  'plugins-disable',
  'plugins-remove',
  'plugins-configure',
  'plugins-catalog-configure',
  'plugins-catalog-install'
])

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Where an install came from, as the audit says it: a path, an npm spec with the version it was, or a package file with
 *  the start of its sha256. */
const sourceOf = (source: unknown): string => {
  const s = (source ?? {}) as Record<string, unknown>
  if (s.kind === 'npm') return `npm ${str(s.spec) ?? '?'} (${str(s.version) ?? '?'})`
  if (s.kind === 'file') return `${str(s.path) ?? '?'} sha256 ${(str(s.sha256) ?? '').slice(0, 12)}`
  if (s.kind === 'catalog') return `the catalog ${str(s.url) ?? '?'} sha256 ${(str(s.sha256) ?? '').slice(0, 12)}`
  return str(s.path) ?? '?'
}

/** The audit record of a change command's answer (Workspace & Plugin Platform V2 spec E3, "audit"), or null: a change
 *  that was made, or one refused (403). Names only: a setting's key, never its value. */
function changeRecord(cmd: string, args: Record<string, unknown>, by: string, answer: PluginsAnswer): PluginAuditRecord | null {
  // The coalesce key comes with it from pluginsCommand: a refusal repeated in a loop is one line and a count
  const body = (typeof answer.body === 'object' && answer.body !== null ? answer.body : {}) as Record<string, unknown>
  if (answer.status === 403) {
    const plugin = str(args.id) ?? str(args.path) ?? str(args.npm) ?? str(args.file) ?? '?'
    return { plugin, event: 'change-refused', by, detail: `${cmd}: ${str(body.error) ?? 'refused'}` }
  }
  if (answer.status !== 200 || body.changed === false) return null
  const plugin = str(body.id) ?? str(args.id) ?? '?'
  const version = str(body.version)
  const at = { plugin, by, ...(version !== undefined ? { version } : {}) }
  switch (cmd) {
    case 'plugins-install':
    case 'plugins-catalog-install': {
      const granted = list(body.permissions)
      const what = `${str(body.trust) ?? 'trusted'}; granted ${granted.length > 0 ? granted.join(', ') : 'nothing'}; from ${sourceOf(body.source)}`
      const replaced = str(body.replaced)
      return replaced !== undefined ? { ...at, event: 'updated', detail: `was ${replaced}; ${what}` } : { ...at, event: 'installed', detail: what }
    }
    case 'plugins-enable':
      // Enabling a plugin that failed starts it again (design P11): a change though the flag stays (final review M4)
      return { ...at, event: 'enabled', ...(body.restarted === true ? { detail: 'started again' } : {}) }
    case 'plugins-disable':
      return { ...at, event: 'disabled' }
    case 'plugins-remove':
      return { ...at, event: 'removed', ...(str(body.warning) !== undefined ? { detail: str(body.warning) } : {}) }
    case 'plugins-configure': {
      const set = args.set !== null && typeof args.set === 'object' ? Object.keys(args.set) : []
      const unset = list(args.unset)
      const parts = [...(set.length > 0 ? [`set ${set.join(', ')}`] : []), ...(unset.length > 0 ? [`unset ${unset.join(', ')}`] : [])]
      return { plugin: str(args.id) ?? plugin, event: 'configured', by, ...(parts.length > 0 ? { detail: parts.join('; ') } : {}) }
    }
    default:
      return null
  }
}

export async function pluginsCommand(a: {
  manager: PluginManager | undefined
  cmd: string
  args: Record<string, unknown>
  role: OrchCaller['role'] | undefined
  /** The sentence an agent's shell is refused with, present exactly when the caller is one. */
  agentRefusal?: string
  marks: { effects: number }
  /** The Host's plugin audit log: each change made and each change refused is recorded there. */
  audit?: PluginAudit
  /** For tests: the clock a change's record takes its time from. */
  now?: () => number
}): Promise<PluginsAnswer> {
  // A change starts or stops the plugin before it is answered: recorded at the moment it was asked for, what it caused
  // reads after it
  const asked = (a.now ?? Date.now)()
  const answer = await answerOf(a)
  if (a.audit && PLUGIN_CHANGES.has(a.cmd)) {
    const rec = changeRecord(a.cmd, a.args, a.role ?? 'unknown', answer)
    // A change refused again and again (an agent's shell in a loop) is one line and a count (final review M11)
    if (rec) a.audit.record({ ...rec, at: asked }, rec.event === 'change-refused' ? `${rec.plugin} change-refused ${a.cmd}` : undefined)
  }
  // A version a fetched catalog revoked was turned off by the catalog, not by whoever asked to read it (Phase 4)
  if (a.audit && a.cmd === 'plugins-catalog' && answer.status === 200)
    for (const id of list((answer.body as { disabled?: unknown } | undefined)?.disabled)) a.audit.record({ plugin: id, event: 'disabled', by: 'catalog', detail: 'revoked by the catalog', at: asked })
  return answer
}

async function answerOf(a: Omit<Parameters<typeof pluginsCommand>[0], 'audit' | 'now'>): Promise<PluginsAnswer> {
  const { cmd, args, manager } = a
  if (a.role !== 'app' && a.role !== 'cli') return { status: 403, body: { error: `${cmd} is for this machine's app and CLI only` } }
  if (PLUGIN_CHANGES.has(cmd) && a.agentRefusal !== undefined) return { status: 403, body: { error: a.agentRefusal } }
  if (!manager) return { status: 501, body: { error: 'this Host does not run plugins' } }
  let answer: PluginsAnswer
  switch (cmd) {
    case 'plugins-inspect':
      return manager.inspect({ path: args.path, npm: args.npm, ...(args.file !== undefined ? { file: args.file } : {}) })
    case 'plugins-list':
      return manager.list()
    case 'plugins-get':
      return manager.get(args.id)
    case 'plugins-logs':
      return manager.logs(args.id, args.lines)
    case 'plugins-doctor':
      return manager.doctor(args.id)
    case 'plugins-settings':
      return manager.settings(args.id)
    case 'plugins-audit':
      return manager.audit(args.id, args.lines)
    case 'plugins-catalog':
      return manager.catalog({ refresh: args.refresh })
    case 'plugins-catalog-inspect':
      return manager.catalogInspect({ id: args.id, version: args.version })
    case 'plugins-catalog-configure':
      answer = await manager.catalogConfigure({
        ...(args.url !== undefined ? { url: args.url } : {}),
        ...(args.keys !== undefined ? { keys: args.keys } : {}),
        ...(args.clear !== undefined ? { clear: args.clear } : {})
      })
      break
    case 'plugins-catalog-install':
      answer = await manager.catalogInstall({ id: args.id, version: args.version, grant: args.grant, expect: args.expect })
      break
    case 'plugins-configure':
      answer = await manager.configure(args.id, args.set, args.unset)
      break
    case 'plugins-install':
      answer = await manager.install({
        ...(args.path !== undefined ? { path: args.path } : {}),
        ...(args.npm !== undefined ? { npm: args.npm } : {}),
        ...(args.file !== undefined ? { file: args.file } : {}),
        grant: args.grant,
        ...(args.expect !== undefined ? { expect: args.expect } : {})
      })
      break
    case 'plugins-enable':
      answer = await manager.setEnabled(args.id, true)
      break
    case 'plugins-disable':
      answer = await manager.setEnabled(args.id, false)
      break
    case 'plugins-remove':
      answer = await manager.remove(args.id)
      break
    default:
      return { status: 501, body: { error: `${cmd} is not answered by this Host` } }
  }
  const unchanged = typeof answer.body === 'object' && answer.body !== null && (answer.body as { changed?: unknown }).changed === false
  if (answer.status === 200 && !unchanged) a.marks.effects += 1
  return answer
}
