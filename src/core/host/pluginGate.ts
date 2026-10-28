// What a plugin may ask the Host (plugin runtime design P12, §2; spec §11). An allowlist, like the MCP and controller
// gates: a command added to the Host later is closed to plugins until it is listed here with the permission it needs.
// The Host applies it to the plugin's own channel, with the permissions the person granted, before receipts and before
// any command. It is a contract for honest plugins, not a sandbox (design P1).
import type { PluginPermission } from '../plugins/manifest'

/** Every command the SDK sends, and the one permission each needs (design §2). */
export const PLUGIN_COMMAND_PERMISSIONS: Readonly<Record<string, PluginPermission>> = Object.freeze({
  'projects-list': 'projects.read',
  'projects-get': 'projects.read',
  'jobs-list': 'jobs.read',
  'jobs-get': 'jobs.read',
  'jobs-wait': 'jobs.read',
  'jobs-create': 'jobs.create',
  'jobs-run': 'jobs.run',
  'runs-list': 'runs.read',
  'runs-get': 'runs.read',
  'runs-wait': 'runs.read',
  'runs-follow': 'runs.read',
  'runs-stop': 'runs.control',
  'runs-resume': 'runs.control',
  'tasks-list': 'tasks.read',
  'tasks-get': 'tasks.read',
  'tasks-add': 'tasks.write',
  'questions-list': 'questions.read',
  'questions-get': 'questions.read',
  'questions-answer': 'questions.answer',
  'runs-completion': 'completion.read',
  'events-poll': 'events.subscribe'
})

/** Commands the SDK sends that no permission opens to a plugin: the agent profile reads (Agent Profiles design §6) are
 *  for the app, the CLI and MCP, and the plugin permissions have no word for them yet. This set is a list for the tests
 *  and the docs, not a check: a plugin asking is refused by `pluginRefusal` as for any unlisted command, and the role
 *  check in src/host/agentProfiles/commands.ts (the app and the CLI, and MCP only for the list) is what enforces it
 *  behind the gate. */
export const SDK_COMMANDS_CLOSED_TO_PLUGINS: ReadonlySet<string> = new Set(['agent-profiles-list', 'agent-profiles-get'])

/** Needs no permission: it reads only the receipts of the plugin that asks (receipts are kept per plugin). */
const OPEN = new Set(['requests-show'])

export function pluginRefusal(
  cmd: string,
  plugin: { id: string; granted: ReadonlySet<string> } | undefined
): { status: 403; body: { error: string } } | null {
  if (!plugin) return { status: 403, body: { error: 'a plugin call needs its plugin' } }
  if (OPEN.has(cmd)) return null
  const needs = Object.hasOwn(PLUGIN_COMMAND_PERMISSIONS, cmd) ? PLUGIN_COMMAND_PERMISSIONS[cmd] : undefined
  if (needs === undefined) return { status: 403, body: { error: `${cmd} is not available to plugins` } }
  if (!plugin.granted.has(needs))
    return { status: 403, body: { error: `${cmd} needs the ${needs} permission, which plugin ${plugin.id} was not granted` } }
  return null
}
