// @astera-app/client: talks to this machine's Astera Host the way the `astera` CLI does (SDK spec §4, local mode).
// One connection, many calls in flight (each `orch-call` carries its own id), the CLI's error codes, request ids for
// safe retries, the CLI's deadlines, and the CLI's public field shaping on every answer.
//
// **The client does not start a Host.** The CLI and its MCP server can, with the installed app's binary; an
// application using this package gets HOST_NOT_RUNNING and decides for itself. **It says `role: 'cli'`**: a Host
// reads an unknown role as `cli` anyway, and an SDK principal of its own comes with the plugin role.
import os from 'node:os'
import { connectHost, type ConnectFailure, type HostConnection } from './connect.js'
import { hostAddress } from './address.js'
import { callDeadlineMs, DEFAULT_CHECK_TIMEOUT_MS, TIMEOUT_HEADROOM_MS } from './deadlines.js'
import { hostTarget, profilePath } from './discovery.js'
import { AsteraError, bodyCodeOf, codeForStatus } from './errors.js'
import { HOST_FEATURE_ORCH, HOST_FEATURE_REQUESTS, HOST_PROTOCOL, type OrchResultMessage } from './protocol.js'
import { publicFor } from './shape.js'
import { createNamespaces, type Namespaces } from './namespaces.js'

/** This package's version, sent in the hello as `sdk-<version>`. Kept equal to package.json by a test. */
export const CLIENT_VERSION = '0.4.0'

/** The handshake's deadline when the options name none. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000
/** An ordinary command's deadline when the options name none: the CLI's (check's long-poll deadline plus headroom). A
 *  command that waits on the Host waits past its own deadline instead (deadlines.ts). */
export const DEFAULT_CALL_TIMEOUT_MS = DEFAULT_CHECK_TIMEOUT_MS + TIMEOUT_HEADROOM_MS
/** The longest delay setTimeout holds; anything longer fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1

export interface AsteraClientOptions {
  /** How to reach the Host. Only `'local'` (this machine's Host, over its pipe or socket) for now. */
  readonly mode?: 'local'
  /** The profile folder whose Host to talk to. Default: `ASTERA_PROFILE_DIR`, else the installed app's, else the
   *  dev app's with `ASTERA_PROFILE=dev`. */
  readonly profileDir?: string
  /** The Host's address. Default: `ASTERA_HOST` for the discovered profile, else the address `profileDir`'s Host
   *  listens on. An explicit `profileDir` without an `address` is always that profile's own Host. */
  readonly address?: string
  /** How long the handshake may take, in ms. Default 5000. */
  readonly connectTimeoutMs?: number
  /** How long an ordinary command may take, in ms. Default 330000 (the CLI's). A command that waits on the Host
   *  (`runs-wait`, `ask`, `check`, a call with `args.timeoutMs`) waits past the Host's deadline instead. */
  readonly callTimeoutMs?: number
  /** The environment discovery reads: `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** Where the handshake's checks report (a malformed line, a Host that could not prove itself, an unsafe socket
   *  folder). Silent by default; the last such line is also in a connect error's `details.reason`. */
  readonly log?: (message: string) => void
}

/** The Host this client is connected to, from its last handshake. Frozen. */
export interface HostInfo {
  readonly version: string
  readonly pid: number
  readonly startedAt: string
  /** What the Host can do beyond the base protocol (`orch`, `requests`, `remote-runtime`, ...). */
  readonly features: readonly string[]
}

export interface CallOptions {
  /** Makes a retry safe while the same Host is up: the Host runs a command once per id and answers a repeat from its
   *  receipt, which it keeps in memory for an hour (a restart forgets it). Refused with
   *  VERSION_MISMATCH by a Host that keeps no receipts. */
  readonly requestId?: string
  /** Ends the wait for the answer, the connect included, rejecting with the signal's reason (an `AbortError`
   *  DOMException by default, not an AsteraError). The Host may still finish the command: cancelling a call is not
   *  cancelling a Run (SDK spec §34). */
  readonly signal?: AbortSignal
  /** How long to wait for this answer, the connect included, in ms. Default: the command's deadline (see
   *  `AsteraClientOptions.callTimeoutMs`). */
  readonly timeoutMs?: number
}

export interface CallResult {
  /** The answer in the public shape the CLI prints (internal fields left out). */
  readonly body: unknown
  /** The answer came from a receipt: the command did not run again. */
  readonly replayed: boolean
  /** The command committed earlier and this is what is true now (a repeated id on a command that waits). */
  readonly observed: boolean
}

/** The client: typed namespaces (`projects`, `jobs`, ...) over `call`, which runs any Host command. */
export interface AsteraClient extends Namespaces {
  readonly host: HostInfo
  readonly profileDir: string
  readonly address: string
  hasFeature(name: string): boolean
  /** Runs one Host command. Rejects with an AsteraError carrying the CLI's code, or with the signal's reason. */
  call(cmd: string, args?: Record<string, unknown>, options?: CallOptions): Promise<CallResult>
  /** Ends the connection: calls in flight (the ones still connecting too) fail, and later calls are refused. An idle
   *  client does not keep Node running, but closing it when done is what frees the Host's side at once. */
  close(): void
}

/** A deadline setTimeout can hold: a positive integer of milliseconds up to about 24.8 days. */
const checkMs = (name: string, ms: number | undefined): void => {
  if (ms === undefined) return
  if (!Number.isInteger(ms) || ms <= 0 || ms > MAX_TIMER_MS)
    throw new AsteraError('INVALID_ARGUMENTS', `${name} must be a whole number of milliseconds from 1 to ${MAX_TIMER_MS}, not ${String(ms)}`)
}

const connectError = (error: ConnectFailure['error'], address: string, profileDir: string, reason: string | null): AsteraError => {
  const why = reason !== null ? { reason } : {}
  if (error === 'unreachable')
    return new AsteraError('HOST_NOT_RUNNING', `no Astera Host is answering at ${address}: open the Astera app, or run \`astera host start\``, { address, profileDir, ...why })
  if (error === 'impostor')
    return new AsteraError('PERMISSION_DENIED', `something at ${address} answered but could not prove it is the Host of ${profileDir}; nothing was sent to it`, { address, profileDir, ...why })
  if (error === 'protocol')
    return new AsteraError('VERSION_MISMATCH', `the Host at ${address} speaks a different protocol version than this client (${HOST_PROTOCOL})`, { address, ...why })
  return new AsteraError('TIMEOUT', `the Host at ${address} accepted the connection but did not say hello`, { address, ...why })
}

/** A refusal as the CLI reads it: the Runtime's own code when its body names one, else the status's, never one
 *  picked from the sentence. */
const callError = (cmd: string, status: number, body: unknown): AsteraError => {
  const said = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  const message = typeof said === 'string' && said.length > 0 ? said : `the Host answered ${status} to ${cmd}`
  return new AsteraError(bodyCodeOf(body) ?? codeForStatus(status), message, body)
}

const CLOSED_IN_FLIGHT = 'the client was closed before the Host answered'
const CLOSED = 'the client is closed'

/** One call in flight: the connection it went out on, and how to settle it. */
interface InFlight {
  conn: HostConnection
  answer(m: OrchResultMessage): void
  fail(e: unknown): void
}

export async function createAsteraClient(options: AsteraClientOptions = {}): Promise<AsteraClient> {
  if (options.mode !== undefined && options.mode !== 'local')
    throw new AsteraError('INVALID_ARGUMENTS', `mode '${String(options.mode)}' is not supported yet; this client speaks 'local'`)
  checkMs('connectTimeoutMs', options.connectTimeoutMs)
  checkMs('callTimeoutMs', options.callTimeoutMs)
  const platform = process.platform
  const target = hostTarget({ env: options.env ?? process.env, platform, home: os.homedir(), tmpDir: os.tmpdir() })
  const profileDir = options.profileDir !== undefined ? profilePath(options.profileDir, platform) : target.profileDir
  // An explicit profile is that profile's Host, whatever ASTERA_HOST says; ASTERA_HOST goes with the discovered one
  const address =
    options.address ??
    (options.profileDir !== undefined ? hostAddress({ profileDir, platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL }).address : target.address)
  return createAsteraClientOver({
    address,
    profileDir,
    options,
    connect: async () => {
      let reason: string | null = null
      const c = await connectHost({
        address,
        profileDir,
        app: `sdk-${CLIENT_VERSION}`,
        role: 'cli',
        timeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        log: (m) => {
          reason = m
          options.log?.(m)
        }
      })
      if ('error' in c) throw connectError(c.error, address, profileDir, reason)
      return c
    }
  })
}

/**
 * A client over a connection its caller makes (plugin runtime design P10): the plugin launcher hands one built on the
 * plugin's stdio, where the Host is on the other end of the process's pipes. Internal: the published package exports
 * `createAsteraClient` only. `connect` resolves an open connection or throws the error a call should fail with;
 * `address` names the connection in messages.
 */
export async function createAsteraClientOver(o: {
  connect: () => Promise<HostConnection>
  address: string
  profileDir: string
  options?: Pick<AsteraClientOptions, 'callTimeoutMs'>
}): Promise<AsteraClient> {
  const { address, profileDir } = o
  const ordinaryMs = o.options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS

  let conn: HostConnection | null = null
  let connecting: Promise<HostConnection> | null = null
  let host: HostInfo | null = null
  let closed = false
  let seq = 0
  const inflight = new Map<string, InFlight>()
  /** Aborted by close(): every call still waiting, for an answer or for the connect, ends on it at once. */
  const lifetime = new AbortController()

  /** Ref'd while one of its calls waits, unref'd while idle, so an idle client lets Node exit. */
  const keepAlive = (c: HostConnection): void => {
    for (const f of inflight.values()) if (f.conn === c) return c.ref()
    c.unref()
  }

  const open = (): Promise<HostConnection> => {
    if (conn !== null) return Promise.resolve(conn)
    connecting ??= (async () => {
      const c = await o.connect()
      // close() came while the handshake was out: this connection is nobody's
      if (closed) {
        c.close()
        throw new AsteraError('FAILED', CLOSED_IN_FLIGHT)
      }
      host = Object.freeze({ version: c.hello.host, pid: c.hello.pid, startedAt: c.hello.startedAt, features: Object.freeze([...c.hello.features]) })
      c.onMessage((m) => {
        if (m.t === 'orch-result') inflight.get(m.call)?.answer(m)
      })
      c.onClose(() => {
        if (conn === c) conn = null
        for (const [, f] of [...inflight].filter(([, f]) => f.conn === c))
          f.fail(closed ? new AsteraError('FAILED', CLOSED_IN_FLIGHT) : null)
      })
      c.unref()
      conn = c
      return c
    })().finally(() => {
      connecting = null
    })
    return connecting
  }

  const call = (cmd: string, args: Record<string, unknown> = {}, o: CallOptions = {}): Promise<CallResult> =>
    new Promise<CallResult>((resolve, reject) => {
      if (closed) return reject(new AsteraError('FAILED', CLOSED))
      try {
        checkMs('timeoutMs', o.timeoutMs)
      } catch (e) {
        return reject(e)
      }
      if (o.signal?.aborted) return reject(o.signal.reason)
      const ms = o.timeoutMs ?? callDeadlineMs({ cmd, args }, ordinaryMs)
      let done = false
      let id: string | null = null
      let sentOn: HostConnection | null = null
      const finish = (settle: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', onAbort)
        lifetime.signal.removeEventListener('abort', onClosed)
        if (id !== null) inflight.delete(id)
        if (sentOn !== null) keepAlive(sentOn)
        settle()
      }
      const onAbort = (): void => finish(() => reject(o.signal?.reason))
      const onClosed = (): void => finish(() => reject(new AsteraError('FAILED', CLOSED_IN_FLIGHT)))
      // One deadline from the start, the connect included
      const timer = setTimeout(() => finish(() => reject(new AsteraError('TIMEOUT', `the Host did not answer ${cmd} within ${ms} ms`, { cmd }))), ms)
      o.signal?.addEventListener('abort', onAbort, { once: true })
      lifetime.signal.addEventListener('abort', onClosed, { once: true })
      open().then(
        (c) => {
          if (done) return
          const h = host as HostInfo
          if (!h.features.includes(HOST_FEATURE_ORCH))
            return finish(() => reject(new AsteraError('VERSION_MISMATCH', `the Host ${h.version} does not run commands (no '${HOST_FEATURE_ORCH}' feature); update the Astera app`)))
          if (o.requestId !== undefined && !h.features.includes(HOST_FEATURE_REQUESTS))
            return finish(() =>
              reject(new AsteraError('VERSION_MISMATCH', `the Host ${h.version} keeps no request receipts, so a requestId cannot make ${cmd} safe to retry`, { requestId: o.requestId }))
            )
          id = `sdk_${++seq}`
          sentOn = c
          inflight.set(id, {
            conn: c,
            answer: (m) =>
              finish(() =>
                m.status >= 200 && m.status < 300
                  ? resolve(Object.freeze({ body: publicFor(cmd, m.body), replayed: m.replayed === true, observed: m.observed === true }))
                  : reject(callError(cmd, m.status, m.body))
              ),
            fail: (e) =>
              finish(() =>
                reject(
                  e ??
                    new AsteraError(
                      'HOST_NOT_RUNNING',
                      `the Host at ${address} closed the connection before answering ${cmd}` +
                        // Receipts live in the Host's memory: the same id is safe only with the Host that took it
                        (o.requestId !== undefined
                          ? `; it may have run it. Sending it again with the same requestId (${o.requestId}) is safe while the same Host is up; ` +
                            'a Host that restarted has forgotten the id, so ask requests-show first'
                          : ''),
                      { address, cmd, ...(o.requestId !== undefined ? { requestId: o.requestId } : {}) }
                    )
                )
              )
          })
          c.ref()
          c.call({ t: 'orch-call', call: id, cmd, args, ...(o.requestId !== undefined ? { request: o.requestId } : {}) })
        },
        (err: unknown) => finish(() => reject(closed ? new AsteraError('FAILED', CLOSED_IN_FLIGHT) : err))
      )
    })

  await open()
  return {
    ...createNamespaces(call, () => (host as HostInfo).features, lifetime.signal),
    get host(): HostInfo {
      return host as HostInfo
    },
    profileDir,
    address,
    hasFeature: (name) => (host as HostInfo).features.includes(name),
    call,
    close: () => {
      if (closed) return
      closed = true
      lifetime.abort()
      conn?.close()
      // A handshake still out is closed when it lands (open() sees `closed`)
    }
  }
}
