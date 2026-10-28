// The MCP Gateway's HTTP side (Agent Control Plane release 2, Gateway design §4.1, §4.4). A Streamable HTTP listener
// on 127.0.0.1 inside the Host serves `/mcp/<serverId>` to the sessions that were given that server: each one comes
// with its own bearer token (tokens.ts), opens an MCP session here, and gets a server whose capabilities, version and
// instructions are the shared upstream's (upstream.ts) and whose requests are passed to it. The checks come before
// anything else: no `Origin` (a browser page), a loopback `Host`, a live token, a granted server. Nothing a session
// sends can throw into the Host.
//
// The same listener carries `POST /astera/call` (sandbox design §6): a session inside Codex's sandbox cannot open the
// Host's pipe but can reach 127.0.0.1, and the `astera` CLI sends its command here with the session's workload token.
// The checks are the MCP route's, then the command runs as the session the token stands for.
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
  ErrorCode,
  McpError,
  ResultSchema,
  SetLevelRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  isInitializeRequest
} from '@modelcontextprotocol/sdk/types.js'
import type { ExtensionRegistry, McpExtension } from '../../core/extensions/types'
import { sessionOfPresentedToken, type TokenTable } from './tokens'
import type { OrchCall, OrchCaller } from '../../core/host/orchProtocol'
import type { UpstreamPool } from './upstream'

export interface Gateway {
  /** Starts listening on 127.0.0.1 and an ephemeral port; answers the port. */
  listen(): Promise<number>
  close(): Promise<void>
  port(): number | null
  /** Ends every MCP session opened with these tokens, their calls in flight included. */
  forgetTokens(tokens: string[]): void
}

/** How long a passed-on call may go without an answer or a progress report before it is answered with a timeout, when
 *  the server sets no tool timeout of its own (Codex's `tool_timeout_sec`, which import carries). */
export const GATEWAY_CALL_TIMEOUT_MS = 600_000
const BODY_MAX = 4 * 1024 * 1024
/** How many calls on the command routes may be in flight at once. Only these are capped: the MCP routes hold long-lived
 *  streams per session and server, and a cap on them would refuse a heavy but ordinary setup. */
const MAX_COMMANDS = 64

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
  /** Takes the stored secret values out of what a session is told; absent leaves the text as it is. */
  hide?: (text: string) => Promise<string>
  /** Told when a session's `tools/call` settles, with the pty or proc its token belongs to (credentials design §6). */
  onToolCall?: (c: { ownerId: string; serverId: string; serverName: string; tool: string; ok: boolean }) => void
  /** The Host's commands, for `POST /astera/call`. Absent, that route answers 501. */
  call?: OrchCall['call']
  /** The caller of a `cli` command that came over no socket (host/server.ts `cliCaller`): the same one the pipe builds for
   *  a `cli` socket, whose `toOthers` here reaches every socket the Host holds. */
  cliCaller?: () => OrchCaller
  /** The Host's hello with the proof of a client's nonce (host/server.ts `loopbackHello`), so the client can tell this
   *  Host from something else on the address, as it does on the pipe. */
  hello?: (nonce: string) => { host: string; pid: number; startedAt: string; features: string[]; proof?: string }
}): Gateway {
  const hide = d.hide ?? (async (s: string) => s)
  let server: http.Server | null = null
  let port: number | null = null
  const sessions = new Map<string, DownSession>()
  let commandsInFlight = 0

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
      return send(res, 502, rpcError(-32603, await hide(err instanceof Error ? err.message : String(err))))
    }
    // The session may have ended while the upstream started: nothing could reach or end this one later (final review I1)
    const binding = d.tokens.lookup(token)
    if (binding === null) {
      up.release()
      return send(res, 401, rpcError(-32001, 'Unauthorized'))
    }
    const toolCalled = (tool: unknown, ok: boolean): void => {
      if (typeof tool !== 'string' || !d.onToolCall) return
      try {
        d.onToolCall({ ownerId: binding.ownerId, serverId: entry.id, serverName: entry.name, tool, ok })
      } catch {
        // a record that could not be made never fails the call
      }
    }
    // A client initializes again after a reconnect; the MCP session it left is ended rather than held to its pty's exit
    for (const old of [...sessions.values()]) if (old.token === token && old.serverId === entry.id) endSession(old)
    // The upstream a call goes to: the one acquired, or a new one once that one died (it restarts on the next request),
    // as long as the server is still shared (final review I2)
    let current = up
    const upstream = async (): Promise<Awaited<ReturnType<UpstreamPool['acquire']>>> => {
      if (current.client.transport !== undefined) return current
      const shared = (await d.readRegistry()).entries.some((e) => e.id === entry.id && e.kind === 'mcp' && e.enabled)
      if (!shared) throw new McpError(ErrorCode.InvalidRequest, `${entry.name} is no longer shared`)
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
        const timeout = entry.options?.toolTimeoutSec !== undefined ? entry.options.toolTimeoutSec * 1000 : GATEWAY_CALL_TIMEOUT_MS
        const call = u.client.request({ method, params } as never, ResultSchema, {
          signal: AbortSignal.any([extra.signal, ended.signal]),
          timeout,
          resetTimeoutOnProgress: true,
          ...(meta?.progressToken !== undefined
            ? { onprogress: (p) => void extra.sendNotification({ method: 'notifications/progress', params: { ...p, progressToken: meta.progressToken } } as never).catch(() => {}) }
            : {})
        })
        // A call that times out shows the server as failed until one answers again (final review M4)
        return call.then(
          (r) => {
            d.pool.clearStalled(u.key)
            if (method === 'tools/call') toolCalled(params.name, (r as { isError?: unknown }).isError !== true)
            return r
          },
          (err: unknown) => {
            if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) d.pool.markStalled(u.key, `a call timed out after ${Math.round(timeout / 1000)} s`)
            if (method === 'tools/call') toolCalled(params.name, false)
            throw err
          }
        )
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
    try {
      await down.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (err) {
      endSession(session)
      throw err
    }
    if (transport.sessionId === undefined || !sessions.has(transport.sessionId) || d.tokens.lookup(token) === null) endSession(session)
  }

  /** The answer of a refusal on the command routes: the connection is closed after it, so a refused caller does not keep
   *  one of the few slots the command routes have (`MAX_COMMANDS`). */
  const refuse = (res: http.ServerResponse, status: number, error: string): void => {
    res.setHeader('connection', 'close')
    send(res, status, { error })
  }

  /** What both command routes check first, in the MCP route's order: no `Origin`, a loopback `Host`, a live workload token.
   *  Answers the token's session, or null once the refusal is sent. */
  const authorize = (req: http.IncomingMessage, res: http.ServerResponse): string | null => {
    if (req.headers.origin !== undefined) {
      req.resume()
      refuse(res, 403, 'Forbidden')
      return null
    }
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      req.resume()
      refuse(res, 421, 'Misdirected request')
      return null
    }
    // The token, never the body, names the session
    const bearer = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')
    const sessionId = bearer ? sessionOfPresentedToken((t) => d.tokens.sessionOf(t), bearer[1]) : null
    if (sessionId === null) {
      req.resume()
      refuse(res, 401, 'workload token not recognised')
      return null
    }
    return sessionId
  }

  /** The body of a command route: the object it holds, or null once the refusal is sent. */
  const objectBody = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | null> => {
    if (req.method !== 'POST') {
      req.resume()
      refuse(res, 405, 'POST only')
      return null
    }
    const text = await readBody(req)
    if (text === 'tooLarge') {
      req.resume()
      refuse(res, 413, 'Request body over 4 MB')
      return null
    }
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      refuse(res, 400, 'the body is not JSON')
      return null
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      refuse(res, 400, 'the body must be an object')
      return null
    }
    return body as Record<string, unknown>
  }

  /** `POST /astera/hello`: the Host's hello with the proof of the client's nonce. The client checks the proof against the
   *  Host key of the profile it means to reach before it sends a command (packages/client/src/loopback.ts). */
  const hello = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    if (authorize(req, res) === null) return
    if (!d.hello) {
      req.resume()
      return refuse(res, 501, 'this Host does not answer commands over loopback')
    }
    const m = await objectBody(req, res)
    if (m === null) return
    if (typeof m.nonce !== 'string' || m.nonce === '' || m.nonce.length > 256) return refuse(res, 400, 'the body needs a nonce')
    send(res, 200, d.hello(m.nonce))
  }

  /** `POST /astera/call`: the CLI's command, run as the session the bearer token stands for. */
  const command = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const sessionId = authorize(req, res)
    if (sessionId === null) return
    if (!d.call || !d.cliCaller) {
      req.resume()
      return refuse(res, 501, 'this Host does not answer commands over loopback')
    }
    const m = await objectBody(req, res)
    if (m === null) return
    if (typeof m.cmd !== 'string') return refuse(res, 400, 'the body needs a string cmd')
    if (m.args !== undefined && (typeof m.args !== 'object' || m.args === null || Array.isArray(m.args))) return refuse(res, 400, 'args must be an object')
    if (m.request !== undefined && typeof m.request !== 'string') return refuse(res, 400, 'request must be a string')
    const r = await d.call({
      cmd: m.cmd,
      args: (m.args as Record<string, unknown> | undefined) ?? {},
      sessionId,
      from: d.cliCaller(),
      ...(m.request !== undefined ? { request: m.request as string } : {})
    })
    send(res, 200, {
      status: r.status,
      body: r.body,
      ...(r.replayed === true ? { replayed: true } : {}),
      ...(r.observed === true ? { observed: true } : {})
    })
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path === '/astera/call' || path === '/astera/hello') {
      // The slot is held until the response is done or the connection is gone, whichever the caller does
      if (commandsInFlight >= MAX_COMMANDS) return refuse(res, 503, 'too many calls')
      commandsInFlight++
      res.once('close', () => void commandsInFlight--)
      return path === '/astera/call' ? command(req, res) : hello(req, res)
    }
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
        // A command can legitimately take an hour (`wait`, `ask`, `check`, `follow`; the CLI's own deadline governs), so no
        // socket idle timeout may end one. The trade-off: the listener is open for the Host's whole life and only the
        // command routes' calls are capped (MAX_COMMANDS), so the MCP routes' connections are bounded neither in number
        // nor in how long one may sit idle; a local process may hold as many open, for as long, as the OS lets it.
        s.timeout = 0
        s.once('error', reject)
        s.listen(0, '127.0.0.1', () => {
          // Past the listen, an error (too many open files on accept, say) is logged, never thrown into the Host
          s.off('error', reject)
          s.on('error', (err) => d.log(`gateway: the listener reported an error (${err.message})`))
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
      if (s) {
        // A connection left open (a session's event stream) would hold the close, and every spawn waits on it
        const closed = new Promise<void>((r) => s.close(() => r()))
        s.closeAllConnections()
        await closed
      }
    },
    port: () => port,
    forgetTokens: (tokens) => {
      const gone = new Set(tokens)
      for (const s of [...sessions.values()]) if (gone.has(s.token)) endSession(s)
    }
  }
}
