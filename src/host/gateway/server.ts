// The MCP Gateway's HTTP side (Agent Control Plane release 2, Gateway design §4.1, §4.4). A Streamable HTTP listener
// on 127.0.0.1 inside the Host serves `/mcp/<serverId>` to the sessions that were given that server: each one comes
// with its own bearer token (tokens.ts), opens an MCP session here, and gets a server whose capabilities, version and
// instructions are the shared upstream's (upstream.ts) and whose requests are passed to it. The checks come before
// anything else: no `Origin` (a browser page), a loopback `Host`, a live token, a granted server. Nothing a session
// sends can throw into the Host.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  CompleteRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ResultSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  isInitializeRequest
} from '@modelcontextprotocol/sdk/types.js'
import type { ExtensionRegistry, McpExtension } from '../../core/extensions/types'
import type { TokenTable } from './tokens'
import type { UpstreamPool } from './upstream'

export interface Gateway {
  /** Starts listening on 127.0.0.1 and an ephemeral port; answers the port. */
  listen(): Promise<number>
  close(): Promise<void>
  port(): number | null
  /** Ends every MCP session opened with these tokens, their calls in flight included. */
  forgetTokens(tokens: string[]): void
}

/** How long a passed-on call may take before the session is answered with a timeout. */
export const GATEWAY_CALL_TIMEOUT_MS = 120_000
const BODY_MAX = 4 * 1024 * 1024

/** The notifications an upstream sends that every session on it should see. */
const PASSED_ON = new Set(['notifications/tools/list_changed', 'notifications/resources/list_changed', 'notifications/prompts/list_changed', 'notifications/resources/updated', 'notifications/message'])

interface DownSession {
  /** Aborted when the session ends, so its calls in flight are cancelled on the shared upstream. */
  ended: AbortController
  token: string
  serverId: string
  transport: StreamableHTTPServerTransport
  server: Server
  release: () => void
  off: () => void
}

const rpcError = (code: number, message: string): unknown => ({ jsonrpc: '2.0', error: { code, message }, id: null })

function send(res: http.ServerResponse, status: number, body: unknown = {}): void {
  if (res.headersSent) return void res.end()
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body))
}

async function readBody(req: http.IncomingMessage): Promise<string | 'tooLarge'> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length
    if (size > BODY_MAX) return 'tooLarge'
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function createGateway(d: {
  tokens: TokenTable
  pool: UpstreamPool
  readRegistry: () => Promise<ExtensionRegistry>
  log: (line: string) => void
}): Gateway {
  let server: http.Server | null = null
  let port: number | null = null
  const sessions = new Map<string, DownSession>()

  const endSession = (s: DownSession): void => {
    s.ended.abort()
    if (s.transport.sessionId !== undefined) sessions.delete(s.transport.sessionId)
    s.off()
    s.release()
    void s.server.close().catch(() => {})
  }

  /** The downstream server for one session, mirroring the upstream it was given. */
  const openSession = async (req: http.IncomingMessage, res: http.ServerResponse, body: unknown, token: string, entry: McpExtension, folder: string): Promise<void> => {
    let up: Awaited<ReturnType<UpstreamPool['acquire']>>
    try {
      up = await d.pool.acquire(entry, folder, token)
    } catch (err) {
      return send(res, 502, rpcError(-32603, err instanceof Error ? err.message : String(err)))
    }
    // The upstream a call goes to: the one acquired, or a new one once that one died (it restarts on the next request)
    let current = up
    const upstream = async (): Promise<Awaited<ReturnType<UpstreamPool['acquire']>>> => {
      if (current.client.transport !== undefined) return current
      const next = await d.pool.acquire(entry, folder, token)
      current.release()
      current = next
      return current
    }
    const ended = new AbortController()
    const caps = up.client.getServerCapabilities() ?? {}
    const version = up.client.getServerVersion() ?? { name: entry.name, version: '0' }
    const instructions = up.client.getInstructions()
    const down = new Server(version, { capabilities: caps, ...(instructions !== undefined ? { instructions } : {}) })
    const pass =
      (method: string) =>
      async (request: { params?: Record<string, unknown> }, extra: { signal: AbortSignal; sendNotification: (n: never) => Promise<void> }) => {
        const params = { ...(request.params ?? {}) }
        const meta = params._meta as { progressToken?: string | number } | undefined
        delete params._meta
        const u = await upstream()
        return u.client.request({ method, params } as never, ResultSchema, {
          signal: AbortSignal.any([extra.signal, ended.signal]),
          timeout: GATEWAY_CALL_TIMEOUT_MS,
          ...(meta?.progressToken !== undefined
            ? { onprogress: (p) => void extra.sendNotification({ method: 'notifications/progress', params: { ...p, progressToken: meta.progressToken } } as never).catch(() => {}) }
            : {})
        })
      }
    if (caps.tools) {
      down.setRequestHandler(ListToolsRequestSchema, pass('tools/list') as never)
      down.setRequestHandler(CallToolRequestSchema, pass('tools/call') as never)
    }
    if (caps.resources) {
      down.setRequestHandler(ListResourcesRequestSchema, pass('resources/list') as never)
      down.setRequestHandler(ListResourceTemplatesRequestSchema, pass('resources/templates/list') as never)
      down.setRequestHandler(ReadResourceRequestSchema, pass('resources/read') as never)
      if (caps.resources.subscribe) {
        down.setRequestHandler(SubscribeRequestSchema, pass('resources/subscribe') as never)
        down.setRequestHandler(UnsubscribeRequestSchema, pass('resources/unsubscribe') as never)
      }
    }
    if (caps.prompts) {
      down.setRequestHandler(ListPromptsRequestSchema, pass('prompts/list') as never)
      down.setRequestHandler(GetPromptRequestSchema, pass('prompts/get') as never)
    }
    if (caps.completions) down.setRequestHandler(CompleteRequestSchema, pass('completion/complete') as never)
    if (caps.logging) down.setRequestHandler(SetLevelRequestSchema, pass('logging/setLevel') as never)

    let s: DownSession | null = null
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        if (s) sessions.set(id, s)
      }
    })
    const off = d.pool.onNotification(up.key, (n) => {
      if (PASSED_ON.has(n.method)) void down.notification(n as never).catch(() => {})
    })
    s = { ended, token, serverId: entry.id, transport, server: down, release: () => current.release(), off }
    const session = s
    down.onclose = () => endSession(session)
    await down.connect(transport)
    await transport.handleRequest(req, res, body)
    if (transport.sessionId === undefined || !sessions.has(transport.sessionId)) endSession(session)
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const match = /^\/mcp\/([^/?#]+)$/.exec(new URL(req.url ?? '/', 'http://x').pathname)
    if (!match) {
      req.resume()
      return send(res, 404)
    }
    if (req.headers.origin !== undefined) {
      req.resume()
      return send(res, 403, rpcError(-32000, 'Forbidden'))
    }
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      req.resume()
      return send(res, 421, rpcError(-32000, 'Misdirected request'))
    }
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
    const binding = bearer ? d.tokens.lookup(bearer[1]) : null
    if (!bearer || !binding) {
      req.resume()
      return send(res, 401, rpcError(-32001, 'Unauthorized'))
    }
    const serverId = decodeURIComponent(match[1])
    if (!binding.grant.has(serverId)) {
      req.resume()
      return send(res, 403, rpcError(-32000, 'Forbidden'))
    }
    const entry = (await d.readRegistry()).entries.find((e): e is McpExtension => e.id === serverId && e.kind === 'mcp' && e.enabled && e.transport === 'stdio')
    if (!entry) {
      req.resume()
      return send(res, 404, rpcError(-32001, 'This shared server is no longer shared'))
    }
    let body: unknown
    if (req.method === 'POST') {
      const text = await readBody(req)
      if (text === 'tooLarge') return send(res, 413, rpcError(-32000, 'Request body over 4 MB'))
      try {
        body = JSON.parse(text)
      } catch {
        return send(res, 400, rpcError(-32700, 'Parse error'))
      }
    }
    const sid = req.headers['mcp-session-id']
    if (typeof sid === 'string') {
      const s = sessions.get(sid)
      // A session id belongs to the token and server it was opened with, and to nothing else
      if (!s || s.token !== bearer[1] || s.serverId !== serverId) return send(res, 404, rpcError(-32001, 'Session not found'))
      return s.transport.handleRequest(req, res, body)
    }
    if (req.method === 'POST' && isInitializeRequest(body)) return openSession(req, res, body, bearer[1], entry, binding.folder)
    return send(res, 400, rpcError(-32000, 'Bad Request: no session; send initialize first'))
  }

  return {
    listen: () =>
      new Promise((resolve, reject) => {
        const s = http.createServer((req, res) => {
          handle(req, res).catch((err: unknown) => {
            d.log(`gateway: a request failed (${err instanceof Error ? err.message : String(err)})`)
            send(res, 500, rpcError(-32603, 'Internal error'))
          })
        })
        s.once('error', reject)
        s.listen(0, '127.0.0.1', () => {
          server = s
          port = (s.address() as { port: number }).port
          resolve(port)
        })
      }),
    close: async () => {
      for (const s of [...sessions.values()]) endSession(s)
      const s = server
      server = null
      port = null
      if (s) await new Promise<void>((r) => s.close(() => r()))
    },
    port: () => port,
    forgetTokens: (tokens) => {
      const gone = new Set(tokens)
      for (const s of [...sessions.values()]) if (gone.has(s.token)) endSession(s)
    }
  }
}
