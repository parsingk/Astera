// `astera mcp serve` (MCP design §4): the SDK's McpServer over stdio, every tool one Host command
// through the link. stdout is the protocol's; every diagnostic goes to stderr.
import type { Readable, Writable } from 'node:stream'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { connectHost } from '../../core/host/connect'
import { codeForStatus, dataFor, nextStepsFor, type CliErrorCode } from '../../core/orchestration/cliOutput'
import { publicFor } from '../../core/orchestration/cliPublic'
import { sanitize } from '../../core/orchestration/checkpoint'
import { cliHostTarget, runHostCommand } from '../host'
import { openHostLink, type HostLink } from './hostLink'
import { TOOLS, type ToolDef } from './tools'

/** Every string in a result goes through the same secret filter the checkpoint uses. */
const redact = (v: unknown): unknown =>
  typeof v === 'string'
    ? sanitize(v)
    : Array.isArray(v)
      ? v.map(redact)
      : v !== null && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]))
        : v

const errorResult = (code: CliErrorCode, message: string, cmd?: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: `${code}: ${message}` }],
  structuredContent: { code, message, nextSteps: nextStepsFor({ code, cmd }) }
})

const refusalMessage = (status: number, body: unknown): string => {
  const error = (body as { error?: unknown } | null)?.error
  return typeof error === 'string' ? error : `status ${status}`
}

async function runTool(link: HostLink, t: ToolDef, input: Record<string, unknown>): Promise<CallToolResult> {
  let args = input
  // create_job takes a project id; the Host's jobs-create takes the project's folder (`--cwd`).
  if (t.name === 'create_job') {
    const project = await link.call('projects-get', { id: input.projectId })
    if ('code' in project) return errorResult(project.code, project.message, 'projects-get')
    if (project.status !== 200)
      return errorResult(codeForStatus(project.status), refusalMessage(project.status, project.body), 'projects-get')
    args = { ...input, cwd: (project.body as { path: string }).path }
  }
  const r = await link.call(t.cmd, t.args(args), typeof input.requestId === 'string' ? input.requestId : undefined)
  if ('code' in r) return errorResult(r.code, r.message, t.cmd)
  if (r.status < 200 || r.status >= 300) return errorResult(codeForStatus(r.status), refusalMessage(r.status, r.body), t.cmd)
  const shaped = redact(publicFor(t.cmd, r.body))
  const count = Array.isArray(shaped) ? ` (${shaped.length})` : ''
  return {
    content: [
      { type: 'text', text: `${t.title}${count}${r.replayed ? ', replayed from the first call with this requestId' : ''}.` }
    ],
    // MCP structured content is an object: a list goes under its name, as in the CLI's `data`.
    structuredContent: dataFor(t.cmd, shaped)
  }
}

export function createMcpServer(a: { link: HostLink; version: string; log(m: string): void; debug?: boolean }): McpServer {
  const server = new McpServer(
    { name: 'astera', version: a.version },
    {
      instructions:
        'Control Astera projects, Jobs, Runs, Tasks, questions, and completion state through the local Astera Host.'
    }
  )
  for (const t of TOOLS)
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: t.readOnly, destructiveHint: false, idempotentHint: t.readOnly, openWorldHint: false }
      },
      async (input: Record<string, unknown>) => {
        const result = await runTool(a.link, t, input)
        if (a.debug) a.log(`${t.name}: ${result.isError ? String((result.structuredContent as { code?: unknown }).code) : 'ok'}`)
        return result
      }
    )
  return server
}

export async function serveMcp(a: {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  version: string
  stdin?: Readable
  stdout?: Writable
  /** Test injection; without it the real link to this profile's Host is opened. */
  link?: HostLink
}): Promise<void> {
  const log = (m: string): void => void process.stderr.write(`astera mcp: ${m}\n`)
  const stdin = a.stdin ?? process.stdin
  const target = cliHostTarget({ env: a.env, platform: a.platform, home: a.home })
  const inner =
    a.link ??
    openHostLink({
      connect: () => connectHost({ address: target.address, profileDir: target.profileDir, app: a.version, role: 'mcp', log }),
      startHost: async () =>
        (await runHostCommand({ cmd: 'host-start', env: a.env, platform: a.platform, home: a.home, noKeepalive: true })).ok,
      log
    })

  // **Calls in flight are counted so the end of stdin does not cut them off.** A client may write its
  // last request and close stdin at once (a pipe does), and closing the server aborts every handler
  // still running, so their answers would never be written.
  let inFlight = 0
  let idle: () => void = () => {}
  const link: HostLink = {
    async call(cmd, args, request) {
      inFlight++
      try {
        return await inner.call(cmd, args, request)
      } finally {
        inFlight--
        if (inFlight === 0) idle()
      }
    },
    close: () => inner.close()
  }

  const server = createMcpServer({ link, version: a.version, log, debug: a.env.ASTERA_MCP_LOG_LEVEL === 'debug' })
  // The transport's own onclose belongs to the SDK (Protocol.connect chains it); the server's hook
  // fires on every close, ours below or one the transport makes on a broken stream.
  const closed = new Promise<void>((resolve) => (server.server.onclose = resolve))
  await server.connect(new StdioServerTransport(stdin, a.stdout ?? process.stdout))

  const ended = new Promise<void>((resolve) => {
    stdin.once('end', resolve)
    stdin.once('close', resolve)
  })
  await Promise.race([ended, closed])
  // A turn of the event loop lets the last lines read start their handlers; then wait for their Host
  // calls, and one more turn for each answer to be written.
  const turn = (): Promise<void> => new Promise((r) => setImmediate(r))
  await turn()
  while (inFlight > 0) {
    await new Promise<void>((r) => (idle = r))
    await turn()
  }
  await server.close()
  await closed
  link.close()
}
