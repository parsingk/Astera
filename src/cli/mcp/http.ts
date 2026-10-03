// `astera mcp http` (MCP HTTP design §1): the same MCP server as `astera mcp serve`, over the SDK's
// Streamable HTTP transport at http://<bind>:<port>/mcp, behind a bearer token and an allowed-hosts check.
// One MCP session (the transport's session id) gets its own server and its own Host link, as one stdio
// process does. The Host starts this process and reads its stdout: one JSON line when it listens, or
// one when it could not, and nothing else. Every diagnostic goes to stderr; the token never does.
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import os from 'node:os'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { McpClient } from '../../core/continuity/actor'
import { createTokenReader, tokenMatches } from '../../core/mcp/httpToken'
import type { HostLink } from './hostLink'
import { createMcpServer, openMcpHostLink } from './server'

/** Body cap (MCP HTTP design §1). */
const BODY_CAP = 4 * 1024 * 1024
/** A session unseen this long is closed (MCP HTTP design §1). */
const IDLE_MS = 30 * 60_000
/** Open sessions one process keeps; an initialize past it is answered 503. Each holds a server and a Host link. */
const MAX_SESSIONS = 64

type Session = { transport: StreamableHTTPServerTransport; server: McpServer; lastSeen: number }

/** The Host header values this process answers to: `127.0.0.1:<port>`, `localhost:<port>`, the hosts it
 *  was given (with `:<port>` added when they name none), and, when bound beyond loopback, this machine's
 *  own addresses as they are at start. Lower case. */
export function allowedHosts(
  port: number,
  bind: string,
  hosts: string[],
  interfaces: Record<string, Array<{ address: string }> | undefined> = os.networkInterfaces()
): Set<string> {
  const withPort = (h: string): string => {
    const v = h.trim().toLowerCase()
    if (/^\[.*\]:\d+$/.test(v) || /^[^:]+:\d+$/.test(v)) return v
    return v.includes(':') && !v.startsWith('[') ? `[${v}]:${port}` : `${v}:${port}`
  }
  const out = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  for (const h of hosts) if (h.trim()) out.add(withPort(h))
  if (bind !== '127.0.0.1' && bind !== 'localhost')
    for (const list of Object.values(interfaces))
      for (const n of list ?? []) out.add(withPort(n.address.split('%')[0]))
  return out
}

/** allowedHosts without `:<port>` (IPv6 unbracketed): the hosts the ready line names. A port that differs is
 *  one a person typed, and stays. */
export function hostsWithoutPort(allowed: Iterable<string>, port: number): string[] {
  const suffix = `:${port}`
  return [...allowed].map((h) => (h.endsWith(suffix) ? h.slice(0, -suffix.length).replace(/^\[(.*)\]$/, '$1') : h))
}

/** `host:port` of an Origin header, with the scheme's default port spelled out; null when it is not a URL
 *  (`null` included). */
function originHost(origin: string): string | null {
  try {
    const u = new URL(origin)
    return `${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return null
  }
}

const bearerOf = (h: string | undefined): string | null => /^Bearer\s+(\S+)\s*$/i.exec(h ?? '')?.[1] ?? null

const sendJson = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

/** How long a refused connection stays open after its answer is written, for the answer to leave. */
const REFUSE_GRACE_MS = 100

/** A refusal (401, 403, 413) that does not wait for the body: `connection: close`, and the socket destroyed
 *  shortly after the answer is written, so a peer without the token cannot hold a connection open by
 *  streaming bytes. */
const refuse = (req: http.IncomingMessage, res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  res.on('finish', () => setTimeout(() => req.socket.destroy(), REFUSE_GRACE_MS).unref())
  sendJson(res, status, body, { connection: 'close', ...headers })
}

const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', error: { code, message }, id: null })

/** The whole body, or 'tooLarge' as soon as it is declared or read past the cap; the rest is not read
 *  (the 413 closes the connection). */
function readBody(req: http.IncomingMessage): Promise<string | 'tooLarge'> {
  if (Number(req.headers['content-length'] ?? 0) > BODY_CAP) return Promise.resolve('tooLarge')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const onData = (c: Buffer): void => {
      size += c.length
      if (size <= BODY_CAP) return void chunks.push(c)
      req.off('data', onData)
      req.pause()
      resolve('tooLarge')
    }
    req.on('data', onData)
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function serveMcpHttp(a: {
  port: number
  bind: string
  hosts: string[]
  tokenFile: string
  version: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  log(m: string): void
  /** Test injection; without it each session opens the real link to this profile's Host. `client` is
   *  read when the link opens, after initialize, like stdio's. */
  link?: (s: { client(): McpClient | undefined; remote: string | undefined }) => HostLink
  /** Test injection for the idle close. */
  idleMs?: number
}): Promise<{ close(): Promise<void>; address(): { port: number }; addresses(): string[] }> {
  const { log } = a
  const idleMs = a.idleMs ?? IDLE_MS
  const reader = createTokenReader(a.tokenFile)
  const sessions = new Map<string, Session>()
  const debug = a.env.ASTERA_MCP_LOG_LEVEL === 'debug'
  const makeLink =
    a.link ??
    ((s: { client(): McpClient | undefined; remote: string | undefined }) =>
      openMcpHostLink({
        env: a.env,
        platform: a.platform,
        home: a.home,
        version: a.version,
        log,
        client: s.client,
        ...(s.remote !== undefined ? { remote: s.remote } : {}),
        startsHost: false
      }))
  let allowed = new Set<string>()
  /** Initializes past the cap check whose session is not in `sessions` yet, so concurrent ones count. */
  let opening = 0
  /** The token the open sessions were opened under. */
  let sessionsToken: string | null = null

  const openSession = async (req: http.IncomingMessage, res: http.ServerResponse, body: unknown, remote: string | undefined): Promise<void> => {
    let counted = true
    opening++
    const settle = (): void => {
      if (counted) opening--
      counted = false
    }
    const link = makeLink({ client: () => server.server.getClientVersion(), remote })
    const server = createMcpServer({ link, version: a.version, log, debug })
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        settle()
        sessions.set(id, { transport, server, lastSeen: Date.now() })
      }
    })
    // The server's hook fires on every close: DELETE, the idle sweep, shutdown, a broken transport.
    server.server.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId)
      try {
        link.close()
      } catch (err) {
        log(`closing a session's Host link failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } finally {
      settle()
    }
    // An initialize the transport refused (a bad Accept header, say) made no session: nothing keeps it.
    if (transport.sessionId === undefined || !sessions.has(transport.sessionId)) await server.close()
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '')
    // **The token comes before anything else**, the path included. Only the address is logged.
    let token: string | null = null
    try {
      token = await reader.current()
    } catch (err) {
      log(`the token file cannot be read: ${(err as NodeJS.ErrnoException).code ?? 'error'}`)
    }
    // A new token (or none: a missing or unreadable file) ends every session opened under the old one, an
    // open GET stream included, since such a stream sends no request that would be refused.
    if (token !== sessionsToken) {
      if (sessions.size > 0) log(`the token changed: closing ${sessions.size} open session(s)`)
      for (const s of [...sessions.values()])
        s.server.close().catch((err: unknown) => log(`closing a session failed: ${err instanceof Error ? err.message : String(err)}`))
      sessionsToken = token
    }
    const given = bearerOf(req.headers.authorization)
    if (token === null || given === null || !tokenMatches(given, token)) {
      log(`401: refused a request from ${remote ?? 'an unknown address'} without a valid token`)
      return refuse(req, res, 401, {}, { 'www-authenticate': 'Bearer' })
    }
    // Checked here rather than by the transport's DNS-rebinding options: those run only once a session's
    // transport exists, and an initialize would build its server and link before being refused.
    const host = (req.headers.host ?? '').toLowerCase()
    const origin = req.headers.origin
    if (!allowed.has(host) || (origin !== undefined && !allowed.has(originHost(origin) ?? ''))) {
      log(`403: refused a request from ${remote ?? 'an unknown address'} for host ${JSON.stringify(req.headers.host ?? '')}${origin !== undefined ? ` and origin ${JSON.stringify(origin)}` : ''}`)
      return refuse(req, res, 403, rpcError(-32000, 'Forbidden: host or origin not allowed'))
    }
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/mcp') {
      req.resume()
      return sendJson(res, 404, {})
    }
    let body: unknown
    if (req.method === 'POST') {
      const text = await readBody(req)
      if (text === 'tooLarge') return refuse(req, res, 413, rpcError(-32000, 'Request body over 4 MB'))
      try {
        body = JSON.parse(text)
      } catch {
        return sendJson(res, 400, rpcError(-32700, 'Parse error: Invalid JSON'))
      }
    }
    const sid = req.headers['mcp-session-id']
    if (typeof sid === 'string') {
      const s = sessions.get(sid)
      if (!s) return sendJson(res, 404, rpcError(-32001, 'Session not found'))
      s.lastSeen = Date.now()
      return s.transport.handleRequest(req, res, body)
    }
    if (req.method === 'POST' && isInitializeRequest(body)) {
      if (sessions.size + opening >= MAX_SESSIONS) {
        log(`503: refused a new session from ${remote ?? 'an unknown address'}, ${MAX_SESSIONS} are open`)
        return sendJson(res, 503, rpcError(-32000, `Too many open sessions (${MAX_SESSIONS}); close one first`))
      }
      return openSession(req, res, body, remote)
    }
    return sendJson(res, 400, rpcError(-32000, 'Bad Request: no session; send initialize first'))
  }

  const httpServer = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`a request failed: ${err instanceof Error ? err.message : String(err)}`)
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, 'Internal error'))
      else res.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(a.port, a.bind, () => {
      httpServer.off('error', reject)
      resolve()
    })
  })
  const port = (httpServer.address() as { port: number }).port
  allowed = allowedHosts(port, a.bind, a.hosts)

  const sweep = setInterval(() => {
    const now = Date.now()
    for (const [id, s] of sessions)
      if (now - s.lastSeen > idleMs) {
        log(`closing session ${id.slice(0, 8)}, idle for ${Math.round((now - s.lastSeen) / 60_000)} min`)
        s.server.close().catch((err: unknown) => log(`closing an idle session failed: ${err instanceof Error ? err.message : String(err)}`))
      }
  }, Math.min(60_000, idleMs))
  sweep.unref()

  return {
    address: () => ({ port }),
    addresses: () => hostsWithoutPort(allowed, port),
    async close() {
      clearInterval(sweep)
      await Promise.allSettled([...sessions.values()].map((s) => s.server.close()))
      // An open SSE stream would hold the server open; nothing is left to answer on it.
      httpServer.closeAllConnections()
      await new Promise<void>((resolve) => httpServer.close(() => resolve()))
    }
  }
}

/** The ready line: the port it listens on and the hosts it answers to (the Host makes the settings screen's
 *  URLs from them, core/mcp/httpUrls.ts). */
export function readyLineOf(served: { address(): { port: number }; addresses(): string[] }): { ready: true; port: number; addresses: string[] } {
  return { ready: true, port: served.address().port, addresses: served.addresses() }
}

export type McpHttpArgs = { port: number; bind: string; tokenFile: string; hosts: string[] }

/** `--port <n> --bind <addr> --token-file <path> [--hosts a,b]`. Port 0 asks for any free port; the
 *  ready line says which. */
export function parseMcpHttpArgs(argv: readonly string[]): McpHttpArgs | { error: string } {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (!['--port', '--bind', '--token-file', '--hosts'].includes(flag)) return { error: `unknown argument: ${flag}` }
    const v = argv[i + 1]
    if (v === undefined) return { error: `${flag} needs a value` }
    values[flag] = v
  }
  const port = Number(values['--port'])
  if (values['--port'] === undefined || !Number.isInteger(port) || port < 0 || port > 65535)
    return { error: '--port must be an integer from 0 to 65535' }
  if (!values['--bind']) return { error: '--bind is required' }
  if (!values['--token-file']) return { error: '--token-file is required' }
  const hosts = (values['--hosts'] ?? '').split(',').map((h) => h.trim()).filter(Boolean)
  return { port, bind: values['--bind'], tokenFile: values['--token-file'], hosts }
}

/** The CLI side: the stdout protocol the Host reads (one JSON line: `{"ready":true,"port":n,"addresses":[...]}` once
 *  listening, or `{"error":code,"message":text}` before a failing exit), and the ends that close it:
 *  SIGTERM, SIGINT, or the end of stdin (the Host that started it went). Resolves the exit code. */
export async function runMcpHttp(a: {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  version: string
}): Promise<number> {
  const line = (v: unknown): void => void process.stdout.write(`${JSON.stringify(v)}\n`)
  const log = (m: string): void => void process.stderr.write(`astera mcp http: ${m}\n`)
  const args = parseMcpHttpArgs(a.argv)
  if ('error' in args) {
    line({ error: 'INVALID_ARGUMENTS', message: args.error })
    return 2
  }
  let served: Awaited<ReturnType<typeof serveMcpHttp>>
  try {
    served = await serveMcpHttp({ ...args, version: a.version, env: a.env, platform: a.platform, home: a.home, log })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    // The Host copies this line into host.log and the app's state (host/mcpHttp.ts): never put a secret in it.
    line({ error: e.code ?? 'LISTEN_FAILED', message: e.message })
    return 1
  }
  line(readyLineOf(served))
  log(`listening on ${args.bind}:${served.address().port}`)
  await new Promise<void>((resolve) => {
    process.once('SIGTERM', resolve)
    process.once('SIGINT', resolve)
    process.stdin.once('end', resolve)
    process.stdin.once('close', resolve)
    process.stdin.resume()
  })
  await served.close()
  return 0
}
