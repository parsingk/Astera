// The Host's `plugins-*` commands (plugin runtime design P5): for this machine's app and CLI, the changes refused to an
// agent's shell, answered by the plugin manager. MCP, a remote controller and a plugin never get here: no plugins
// command is on their gates' lists. orch.ts calls this below the receipt line, so a change marks the one effect that
// keeps its receipt.
import type { OrchCaller } from '../../core/host/orchProtocol'
import type { PluginManager, PluginsAnswer } from './manager'

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
  'plugins-configure'
])

/** The ones that change what is installed or whether it runs. */
export const PLUGIN_CHANGES: ReadonlySet<string> = new Set(['plugins-install', 'plugins-enable', 'plugins-disable', 'plugins-remove', 'plugins-configure'])

export async function pluginsCommand(a: {
  manager: PluginManager | undefined
  cmd: string
  args: Record<string, unknown>
  role: OrchCaller['role'] | undefined
  /** The sentence an agent's shell is refused with, present exactly when the caller is one. */
  agentRefusal?: string
  marks: { effects: number }
}): Promise<PluginsAnswer> {
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
