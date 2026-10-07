// The controller link (remote runtime design §2.8, §3.2, §3.9, N14): one paired Runtime, as the CLI, MCP and later the
// Desktop reach it. Pinned TLS and the `auth` frame come from client.ts; this adds what a controller needs on top:
// the protocol check on `hello`, a reply deadline, reconnect with backoff, and the one retry rule that keeps a change
// from running twice.
//
// **The retry rule (§3.9).** A call that carries a request id is a change. Sent once with no `retry`; if its
// connection is lost before the reply, it is sent again on a new connection with the same id and `retry: true`. The
// Runtime then replays the receipt of the first attempt, or answers RUNTIME_OUTCOME_UNKNOWN when it has none (the
// first attempt never arrived, or the Runtime restarted): never a second run. A read carries no id and is simply sent
// again. A call that cannot be sent again within `reconnectForMs` answers RUNTIME_OUTCOME_UNKNOWN when a change may
// have arrived, and RUNTIME_OFFLINE otherwise.
//
// Nothing here throws: every failure is a RemoteError value with its §3.10 code.
import { connectRuntime, RemoteError, type CallReply, type RuntimeLink } from './client'
import { GATEWAY_PROTOCOL, type ClientInfo, type HelloFrame } from './frames'

export interface RemoteTarget {
  runtimeId: string
  address: string
  port: number
  fingerprint: string
  token: string
}

export type RemoteAnswer = CallReply

export interface RemoteLink {
  /** The last `hello` this link read, or null before the first connection. */
  hello(): HelloFrame | null
  /** `request` makes the call a change (§3.9). Never rejects. */
  call(cmd: string, args: Record<string, unknown>, o?: { request?: string; timeoutMs?: number }): Promise<RemoteAnswer | RemoteError>
  close(): void
}

/** The waits before each reconnect (N14): 1 s, 2 s, 5 s, 10 s, then 30 s, each with jitter of plus or minus half. */
export const RECONNECT_STEPS_MS = [1000, 2000, 5000, 10_000, 30_000]
const RECONNECT_CAP_MS = 30_000
/** How long a call waits for its reply. Waiting commands pass their own. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000
/** How long a lost call keeps trying to reach the Runtime again before it gives up. */
export const DEFAULT_RECONNECT_FOR_MS = 60_000

/** Codes after which another try cannot help: the Runtime said who it is not, or that it does not know this
 *  controller, or speaks another protocol. */
const FINAL = new Set(['RUNTIME_IDENTITY_CHANGED', 'RUNTIME_AUTH_FAILED', 'RUNTIME_PROTOCOL_MISMATCH'])

const asRemoteError = (e: unknown, fallback: string): RemoteError => {
  if (e instanceof RemoteError) return e
  const code = (e as { code?: unknown } | null)?.code
  const message = e instanceof Error ? e.message : String(e)
  return new RemoteError(code === 'RUNTIME_IDENTITY_CHANGED' ? code : fallback, message)
}

export function openRemoteLink(a: {
  target: RemoteTarget
  client: ClientInfo
  connect?: typeof connectRuntime
  sleep?(ms: number): Promise<void>
  random?(): number
  reconnectForMs?: number
  now?(): number
}): RemoteLink {
  const connect = a.connect ?? connectRuntime
  const sleep = a.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = a.random ?? Math.random
  const now = a.now ?? Date.now
  const reconnectForMs = a.reconnectForMs ?? DEFAULT_RECONNECT_FOR_MS
  const { target } = a

  let live: Promise<RuntimeLink | RemoteError> | null = null
  let lastHello: HelloFrame | null = null
  let closed = false

  const open = async (): Promise<RuntimeLink | RemoteError> => {
    let link: RuntimeLink
    try {
      link = await connect({ host: target.address, port: target.port, pin: target.fingerprint })
    } catch (e) {
      return asRemoteError(e, 'RUNTIME_OFFLINE')
    }
    try {
      const h = await link.auth(target.token, a.client)
      if (h.gatewayProtocol !== GATEWAY_PROTOCOL) {
        link.close()
        return new RemoteError(
          'RUNTIME_PROTOCOL_MISMATCH',
          `the Runtime speaks remote protocol ${h.gatewayProtocol} and this build speaks ${GATEWAY_PROTOCOL}; update the older side`
        )
      }
      lastHello = h
    } catch (e) {
      link.close()
      return asRemoteError(e, 'RUNTIME_OFFLINE')
    }
    void link.closed.then(() => {
      if (live !== null) void live.then((l) => l === link && (live = null))
    })
    return link
  }
  const ensure = (): Promise<RuntimeLink | RemoteError> => {
    if (live === null) {
      const p = open()
      live = p
      void p.then((l) => {
        if (l instanceof RemoteError && live === p) live = null
      })
    }
    return live
  }
  const drop = (link: RuntimeLink): void => {
    link.close()
    if (live !== null) void live.then((l) => l === link && (live = null))
  }
  const backoff = (i: number): number =>
    Math.min(RECONNECT_CAP_MS, Math.round(RECONNECT_STEPS_MS[Math.min(i, RECONNECT_STEPS_MS.length - 1)] * (0.5 + random())))

  const withDeadline = (p: Promise<CallReply>, ms: number): Promise<CallReply | 'timeout'> =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve('timeout'), ms)
      p.then(
        (v) => {
          clearTimeout(t)
          resolve(v)
        },
        (e) => {
          clearTimeout(t)
          reject(e)
        }
      )
    })

  return {
    hello: () => lastHello,
    call: async (cmd, args, o = {}) => {
      const request = o.request
      const timeoutMs = o.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
      const deadline = now() + reconnectForMs
      /** Whether this change may have reached the Runtime: then a lost reply is OUTCOME_UNKNOWN, never OFFLINE. */
      let sent = false
      let tries = 0
      let losses = 0
      for (;;) {
        if (closed) return new RemoteError('RUNTIME_OFFLINE', 'the link to the Runtime is closed')
        const link = await ensure()
        if (link instanceof RemoteError) {
          if (FINAL.has(link.code)) return link
          if (now() >= deadline) {
            return sent && request !== undefined
              ? new RemoteError('RUNTIME_OUTCOME_UNKNOWN', `the answer to ${cmd} was lost and the Runtime could not be reached again: ${link.message}`)
              : link
          }
          await sleep(backoff(tries++))
          continue
        }
        const co = request === undefined ? undefined : { request, ...(sent ? { retry: true as const } : {}) }
        let r: CallReply | 'timeout'
        try {
          sent = sent || request !== undefined
          r = await withDeadline(co ? link.call(cmd, args, co) : link.call(cmd, args), timeoutMs)
        } catch (e) {
          const err = asRemoteError(e, 'RUNTIME_OFFLINE')
          // A refusal of this call by the Runtime (busy, too large) is its answer. A lost connection is not.
          if (err.code !== 'RUNTIME_OFFLINE') {
            if (err.code === 'RUNTIME_AUTH_FAILED') drop(link)
            return err
          }
          drop(link)
          // The first loss reconnects at once; a Runtime that keeps dropping is backed off like one that is down.
          if (losses++ > 0) {
            if (now() >= deadline)
              return request !== undefined
                ? new RemoteError('RUNTIME_OUTCOME_UNKNOWN', `the answer to ${cmd} was lost more than once and the Runtime cannot say whether it ran`)
                : new RemoteError('RUNTIME_OFFLINE', `the connection to the Runtime kept closing during ${cmd}`)
            await sleep(backoff(tries++))
          }
          continue
        }
        if (r === 'timeout')
          return new RemoteError('REMOTE_TIMEOUT', `the Runtime did not answer ${cmd} within ${Math.round(timeoutMs / 1000)} s; it may still finish`)
        return r
      }
    },
    close: () => {
      closed = true
      const l = live
      live = null
      void l?.then((x) => {
        if (!(x instanceof RemoteError)) x.close()
      })
    }
  }
}
