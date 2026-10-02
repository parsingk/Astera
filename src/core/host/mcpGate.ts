// Which Host commands an MCP client may send (MCP design §2). An allowlist, so a command added to the
// Host later is closed to MCP until it is listed here.
import type { McpAccess } from '../types'

export const MCP_READ_COMMANDS = [
  'projects-list',
  'projects-get',
  'accounts-list',
  'jobs-list',
  'jobs-get',
  'runs-list',
  'runs-get',
  'tasks-list',
  'tasks-get',
  'questions-list',
  'questions-get',
  'runs-completion',
  'run-configs-list',
  'tasks-check-output',
  'tasks-output'
] as const

export const MCP_CONTROL_COMMANDS = [
  'jobs-create',
  'jobs-run',
  'runs-stop',
  'runs-resume',
  'questions-answer',
  'tasks-add'
] as const

/** Session commands are a second gate on top of the access level: they need `mcpSessions` too (P1 design §1). */
export const MCP_SESSION_READ_COMMANDS = ['sessions-list', 'sessions-read'] as const
export const MCP_SESSION_WRITE_COMMANDS = ['sessions-send', 'sessions-create'] as const

const READ: ReadonlySet<string> = new Set(MCP_READ_COMMANDS)
const CONTROL: ReadonlySet<string> = new Set(MCP_CONTROL_COMMANDS)
const SESSION_READ: ReadonlySet<string> = new Set(MCP_SESSION_READ_COMMANDS)
const SESSION_WRITE: ReadonlySet<string> = new Set(MCP_SESSION_WRITE_COMMANDS)

export function mcpRefusal(cmd: string, access: McpAccess, sessions: boolean): { status: 403; body: { error: string } } | null {
  if (access === 'off')
    return { status: 403, body: { error: 'MCP access is off in Astera Settings (CLI tab). Turn it on to use Astera from an MCP client.' } }
  if (SESSION_READ.has(cmd) || SESSION_WRITE.has(cmd)) {
    if (!sessions)
      return { status: 403, body: { error: `${cmd} is off: turn on "Let MCP clients see and use sessions" in Astera Settings (CLI tab).` } }
    if (SESSION_READ.has(cmd) || access === 'control') return null
    return { status: 403, body: { error: `${cmd} needs MCP access "Read and control" in Astera Settings (CLI tab); it is "Read only".` } }
  }
  if (READ.has(cmd)) return null
  if (CONTROL.has(cmd))
    return access === 'control'
      ? null
      : { status: 403, body: { error: `${cmd} needs MCP access "Read and control" in Astera Settings (CLI tab); it is "Read only".` } }
  return { status: 403, body: { error: `${cmd} is not available to MCP clients` } }
}
