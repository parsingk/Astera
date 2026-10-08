// Which Host commands a remote controller may send (remote runtime design §3.4, N15). An allowlist like mcpGate's,
// so a command added to the Host later is closed to controllers until it is listed here. Unlike mcpGate, an unknown
// permission level denies: the MCP gate reads an unknown value as control (mcpAccess.ts), which must not be copied.
import type { ControllerPrincipal } from './orchProtocol'

export const CONTROLLER_READ_COMMANDS = [
  'projects-list',
  'projects-get',
  'accounts-list',
  'jobs-list',
  'jobs-get',
  'runs-list',
  'runs-get',
  'tasks-list',
  'tasks-get',
  'dispatch-show',
  'runs-completion',
  'runs-checks',
  'tasks-check-output',
  'tasks-output',
  'runs-follow',
  // Long-poll reads (Phase 4 ruling): §3.1 counts them among a connection's in-flight calls.
  'runs-wait',
  'jobs-wait',
  // Phase 6: a remote Jobs view's own reads, folded and paged on the Runtime (X1-05).
  'jobs-view',
  'runs-timeline',
  // Phase 10: a Run's changed files and one file's diff by id, from the Runtime's git.
  'runs-changed-files',
  'runs-diff',
  // Phase 9a: a remote session's facts (remoteSessions.ts).
  'sessions-facts',
  'sessions-conversation',
  'questions-list',
  'questions-get',
  'run-configs-list',
  'github-pr',
  'github-ci',
  'github-issue',
  // Only the controller's own receipts: they are keyed by its principal (§3.9).
  'requests-show',
  // Sanitized for a controller (§3.6).
  'state-get',
  'sessions-list',
  'sessions-read'
] as const

export const CONTROLLER_CONTROL_COMMANDS = [
  'jobs-create',
  'jobs-run',
  'runs-stop',
  'runs-resume',
  'run-pause',
  'run-resume',
  'run-create',
  'run-start',
  'run-merge',
  'run-delete',
  'task-create',
  'task-update',
  'tasks-add',
  'worker-start',
  'worker-stop',
  'gate-create',
  'gate-resolve',
  'questions-answer',
  'sessions-create',
  'sessions-send',
  // Phase 9a: raw input, a resize that yields to a local viewer, stop, and a chat card's answer (remoteSessions.ts).
  'sessions-input',
  'sessions-resize',
  'sessions-stop',
  'sessions-answer'
] as const

const READ: ReadonlySet<string> = new Set(CONTROLLER_READ_COMMANDS)
const CONTROL: ReadonlySet<string> = new Set(CONTROLLER_CONTROL_COMMANDS)

const denied = (error: string): { status: 403; body: { error: string; code: 'RUNTIME_PERMISSION_DENIED' } } => ({
  status: 403,
  body: { error, code: 'RUNTIME_PERMISSION_DENIED' }
})

export function controllerRefusal(
  cmd: string,
  principal: ControllerPrincipal | undefined
): { status: 401 | 403; body: { error: string; code: 'RUNTIME_AUTH_FAILED' | 'RUNTIME_PERMISSION_DENIED' } } | null {
  if (principal === undefined)
    return { status: 401, body: { error: 'this controller is not paired with this Runtime', code: 'RUNTIME_AUTH_FAILED' } }
  const level = principal.permission
  if (level !== 'read-only' && level !== 'full-control') return denied(`unknown permission level for ${principal.name}`)
  if (READ.has(cmd)) return null
  if (CONTROL.has(cmd)) return level === 'full-control' ? null : denied(`${cmd} needs full control; ${principal.name} is paired read-only`)
  return denied(`${cmd} is not available to a remote controller`)
}
