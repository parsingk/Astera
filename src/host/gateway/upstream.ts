// The MCP Gateway's upstream servers (Agent Control Plane release 2, Gateway design §4.4, G3, G8). Each shared stdio
// server runs once per (server, folder, definition), or once per session when it is switched to that, as a child of
// the Host: an MCP SDK client over stdio, started on the first session that asks for it, given its secrets from the
// extension secret store and none of Astera's own variables, stopped once no session has used it for a while, and
// started again after a backoff when it dies. A server that cannot start fails with its reason; nothing here hangs a
// session or throws into the Host.
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { comparablePath } from '../../core/files/tree'
import { extensionSecrets } from '../../core/extensions/secrets'
import type { McpExtension } from '../../core/extensions/types'

export type UpstreamKey = string
export type UpstreamClient = Client

export interface UpstreamState {
  serverId: string
  processes: number
  state: 'running' | 'stopped' | 'restarting' | 'failed'
  lastError?: string
}

export interface UpstreamPool {
  /** The running client for this server in this folder (or for this session, when the server is switched to one
   *  process per session), started if needed. `release` when the session is done with it. */
  acquire(server: McpExtension, folder: string, sessionToken: string): Promise<{ key: UpstreamKey; client: UpstreamClient; release(): void }>
  stopServer(serverId: string): Promise<void>
  states(): UpstreamState[]
  close(): Promise<void>
  /** Every notification the upstream of `key` sends, for the Gateway to pass on to its sessions; kept for the key, so a
   *  process started again for it keeps them. */
  onNotification(key: UpstreamKey, cb: (n: { method: string; params?: unknown }) => void): () => void
  /** A call to the upstream of `key` timed out: shown as failed with `why` while it runs, until a call answers. */
  markStalled(key: UpstreamKey, why: string): void
  clearStalled(key: UpstreamKey): void
}

export const UPSTREAM_IDLE_MS = 300_000
export const UPSTREAM_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 30_000]
export const UPSTREAM_START_TIMEOUT_MS = 30_000
/** A process that ran this long before it died starts the backoff over. */
const STABLE_MS = 30_000

export function upstreamKey(server: McpExtension, folder: string, sessionToken: string): UpstreamKey {
  const definition = { command: server.command, args: server.args, cwd: server.cwd, env: server.env, options: server.options }
  return createHash('sha256')
    .update(JSON.stringify([server.id, comparablePath(folder), definition, server.isolation === 'session' ? sessionToken : '']))
    .digest('hex')
}

/** Astera's own variables and the CLIs' stay out of a server's process. */
const OWN = /^(ASTERA_|CLAUDE_|CLAUDECODE$|CODEX_|ELECTRON_RUN_AS_NODE$)/i

interface Entry {
  key: UpstreamKey
  serverId: string
  name: string
  client: UpstreamClient | null
  starting: Promise<UpstreamClient> | null
  refs: number
  idle: NodeJS.Timeout | null
  failures: number
  nextTryAt: number
  startedAt: number
  state: UpstreamState['state']
  lastError?: string
  /** Why its calls time out while the process still runs. */
  stalled?: string
  /** The process the stdio transport started (cmd.exe for a .cmd shim on Windows). */
  pid?: number
  closing: boolean
}

/** Ends a process and everything it started. On Windows a server started through a .cmd shim (npx) is cmd.exe's child,
 *  which the SDK's close leaves running, so the tree goes first. */
function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve()
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export function createUpstreamPool(d: {
  profileDir: string
  baseEnv: NodeJS.ProcessEnv
  log: (line: string) => void
  idleMs?: number
  backoffMs?: readonly number[]
  startTimeoutMs?: number
  now?: () => number
}): UpstreamPool {
  const idleMs = d.idleMs ?? UPSTREAM_IDLE_MS
  const backoff = d.backoffMs ?? UPSTREAM_BACKOFF_MS
  const startTimeoutMs = d.startTimeoutMs ?? UPSTREAM_START_TIMEOUT_MS
  const now = d.now ?? Date.now
  const entries = new Map<UpstreamKey, Entry>()
  const listeners = new Map<UpstreamKey, Set<(n: { method: string; params?: unknown }) => void>>()

  const envFor = async (server: McpExtension): Promise<Record<string, string>> => {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(d.baseEnv)) if (v !== undefined && !OWN.test(k)) env[k] = v
    const secrets = extensionSecrets(d.profileDir)
    for (const [n, v] of Object.entries(server.env)) {
      if ('value' in v) env[n] = v.value
      else if ('secret' in v) {
        const value = await secrets.get(v.secret).catch(() => null)
        if (value === null) throw new Error(`the secret ${n} of ${server.name} could not be read`)
        env[n] = value
      } else if (d.baseEnv[n] !== undefined) env[n] = d.baseEnv[n] as string
    }
    return env
  }

  const closeClient = async (c: UpstreamClient, pid: number | undefined): Promise<void> => {
    if (pid !== undefined) await killTree(pid)
    await c.close().catch(() => {})
  }

  const closeEntry = async (e: Entry): Promise<void> => {
    e.closing = true
    if (e.idle) clearTimeout(e.idle)
    if (entries.get(e.key) === e) entries.delete(e.key)
    const c = e.client
    e.client = null
    if (c) await closeClient(c, e.pid)
  }

  /** An entry no session holds and that is not running is forgotten after the idle time, so a failed or crashed key
   *  (one per session for an isolated server) does not stay listed for the Host's life. */
  const forgetLater = (e: Entry): void => {
    if (e.refs > 0 || e.closing) return
    if (e.idle) clearTimeout(e.idle)
    e.idle = setTimeout(() => {
      if (e.refs === 0 && e.client === null && entries.get(e.key) === e) entries.delete(e.key)
    }, idleMs)
    e.idle.unref?.()
  }

  const failed = (e: Entry, why: string, state: 'failed' | 'restarting'): void => {
    if (now() - e.startedAt > STABLE_MS) e.failures = 0
    e.failures += 1
    e.nextTryAt = now() + backoff[Math.min(e.failures - 1, backoff.length - 1)]
    e.state = state
    e.lastError = why
    forgetLater(e)
  }

  const start = async (e: Entry, server: McpExtension, folder: string): Promise<UpstreamClient> => {
    const env = await envFor(server)
    const transport = new StdioClientTransport({
      command: server.command ?? '',
      args: server.args ?? [],
      env,
      cwd: server.cwd ?? folder,
      stderr: 'pipe'
    })
    // Whole lines only, so a value the server writes in two pieces is still one line for the redaction
    let partial = ''
    transport.stderr?.on('data', (chunk: Buffer) => {
      const lines = (partial + chunk.toString('utf8')).split(/\r?\n/)
      partial = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') d.log(`gateway: ${server.name}: ${line}`)
    })
    const client = new Client({ name: 'astera-gateway', version: '1' }, { capabilities: { roots: { listChanged: false } } })
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(folder).href, name: path.basename(folder) }] }))
    client.fallbackNotificationHandler = async (n) => {
      for (const cb of [...(listeners.get(e.key) ?? [])]) cb(n)
    }
    client.onclose = () => {
      if (e.closing || e.client !== client) return
      e.client = null
      failed(e, `${server.name} stopped`, 'restarting')
      d.log(`gateway: ${server.name} stopped; it starts again on the next request`)
    }
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${server.name} did not start within ${Math.round(startTimeoutMs / 1000)} s`)), startTimeoutMs)
    })
    try {
      await Promise.race([client.connect(transport), timeout])
    } catch (err) {
      await closeClient(client, transport.pid ?? undefined)
      throw err
    } finally {
      clearTimeout(timer)
    }
    e.pid = transport.pid ?? undefined
    return client
  }

  const acquire: UpstreamPool['acquire'] = async (server, folder, sessionToken) => {
    const key = upstreamKey(server, folder, sessionToken)
    let e = entries.get(key)
    if (!e) {
      e = { key, serverId: server.id, name: server.name, client: null, starting: null, refs: 0, idle: null, failures: 0, nextTryAt: 0, startedAt: 0, state: 'stopped', closing: false }
      entries.set(key, e)
    }
    const entry = e
    if (!entry.client) {
      if (!entry.starting) {
        if (now() < entry.nextTryAt) throw new Error(`${server.name} is ${entry.state === 'failed' ? 'failing' : 'restarting'}: ${entry.lastError ?? 'try again shortly'}`)
        entry.startedAt = now()
        entry.starting = start(entry, server, folder).then(
          async (client) => {
            // Stopped while it was starting (the server was disabled or removed): it is not handed out or kept
            if (entry.closing) {
              await closeClient(client, entry.pid)
              throw new Error(`${server.name} was stopped`)
            }
            entry.client = client
            entry.state = 'running'
            entry.lastError = undefined
            d.log(`gateway: ${server.name} started`)
            return client
          },
          (err: unknown) => {
            if (entry.closing) throw err
            failed(entry, message(err), 'failed')
            d.log(`gateway: ${server.name} could not start (${message(err)})`)
            throw err
          }
        )
        void entry.starting.catch(() => {}).finally(() => {
          entry.starting = null
        })
      }
      await entry.starting
    }
    entry.refs += 1
    if (entry.idle) {
      clearTimeout(entry.idle)
      entry.idle = null
    }
    let released = false
    return {
      key,
      client: entry.client as UpstreamClient,
      release: () => {
        if (released) return
        released = true
        entry.refs -= 1
        if (entry.refs > 0 || entry.closing) return
        entry.idle = setTimeout(() => {
          d.log(`gateway: ${entry.name} stopped after ${Math.round(idleMs / 1000)} s unused`)
          void closeEntry(entry)
        }, idleMs)
        entry.idle.unref?.()
      }
    }
  }

  return {
    acquire,
    stopServer: async (serverId) => {
      await Promise.all([...entries.values()].filter((e) => e.serverId === serverId).map(closeEntry))
    },
    states: () => {
      const byServer = new Map<string, Entry[]>()
      const stalled = (list: Entry[]) => list.find((e) => e.stalled !== undefined)
      for (const e of entries.values()) byServer.set(e.serverId, [...(byServer.get(e.serverId) ?? []), e])
      return [...byServer].map(([serverId, list]) => {
        const running = list.filter((e) => e.client !== null).length
        const worst = list.find((e) => e.state === 'failed') ?? list.find((e) => e.state === 'restarting')
        const hung = stalled(list)
        if (hung) return { serverId, processes: running, state: 'failed' as const, lastError: hung.stalled as string }
        const state: UpstreamState['state'] = running > 0 ? 'running' : (worst?.state ?? 'stopped')
        return { serverId, processes: running, state, ...(state !== 'running' && worst?.lastError ? { lastError: worst.lastError } : {}) }
      })
    },
    close: async () => {
      await Promise.all([...entries.values()].map(closeEntry))
    },
    onNotification: (key, cb) => {
      const set = listeners.get(key) ?? new Set()
      listeners.set(key, set)
      set.add(cb)
      return () => {
        set.delete(cb)
        if (set.size === 0) listeners.delete(key)
      }
    },
    markStalled: (key, why) => {
      const e = entries.get(key)
      if (e) e.stalled = why
    },
    clearStalled: (key) => {
      const e = entries.get(key)
      if (e) e.stalled = undefined
    }
  }
}
