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
  'runs-completion'
] as const

export const MCP_CONTROL_COMMANDS = ['jobs-create', 'jobs-run', 'runs-stop', 'questions-answer'] as const

const READ: ReadonlySet<string> = new Set(MCP_READ_COMMANDS)
const CONTROL: ReadonlySet<string> = new Set(MCP_CONTROL_COMMANDS)

export function mcpRefusal(cmd: string, access: McpAccess): { status: 403; body: { error: string } } | null {
  if (access === 'off')
    return { status: 403, body: { error: 'MCP access is off in Astera Settings (CLI tab). Turn it on to use Astera from an MCP client.' } }
  if (READ.has(cmd)) return null
  if (CONTROL.has(cmd))
    return access === 'control'
      ? null
      : { status: 403, body: { error: `${cmd} needs MCP access "Read and control" in Astera Settings (CLI tab); it is "Read only".` } }
  return { status: 403, body: { error: `${cmd} is not available to MCP clients` } }
}
