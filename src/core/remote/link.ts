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
import { GATEWAY_PROTOCOL, type ClientInfo, type HelloFrame, type RemoteCheckpoint, type RemotePtyEvent, type SubscriptionFrame } from './frames'

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
  /** A pty's output (§3.7), kept going across gaps and reconnects. `onReset` gets a checkpoint: the view resets, writes
   *  `state`, then `pending`. `onEvents` gets each event once, in seq order. `onGone` says the Runtime refused it (no such
   *  pty, a missing capability, the subscription budget) or the link ended for good. Returns the unsubscribe. */
  subscribe(pty: string, h: PtyStreamHandlers): () => void
  close(): void
}

export interface PtyStreamHandlers {
  onReset(c: RemoteCheckpoint): void
  onEvents(events: RemotePtyEvent[]): void
  onGone?(code: string, message: string): void
}

/** The waits before each reconnect (N14): 1 s, 2 s, 5 s, 10 s, then 30 s, each with jitter of plus or minus half. */
export const RECONNECT_STEPS_MS = [1000, 2000, 5000, 10_000, 30_000]
const RECONNECT_CAP_MS = 30_000
/** How long a call waits for its reply. Waiting commands pass their own. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000
/** How long a lost call keeps trying to reach the Runtime again before it gives up. */
export const DEFAULT_RECONNECT_FOR_MS = 60_000
/** How long one connect and sign-in may take before the Runtime counts as not answering. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000

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
  /** How long one connect and sign-in may take; DEFAULT_CONNECT_TIMEOUT_MS when left out. */
  connectTimeoutMs?: number
  now?(): number
}): RemoteLink {
  const connect = a.connect ?? connectRuntime
  const sleep = a.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const random = a.random ?? Math.random
  const now = a.now ?? Date.now
  const reconnectForMs = a.reconnectForMs ?? DEFAULT_RECONNECT_FOR_MS
  const connectTimeoutMs = a.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const { target } = a

  let live: Promise<RuntimeLink | RemoteError> | null = null
  let lastHello: HelloFrame | null = null
  let closed = false
  /** Each subscription: its pty, the last seq handed on (null before a checkpoint or a replay), the boot it was on,
   *  and the connection it is subscribed on now. */
  type Stream = { id: string; pty: string; h: PtyStreamHandlers; lastSeq: number | null; bootId: string | null; on: RuntimeLink | null }
  const streams = new Map<string, Stream>()
  let streamN = 0

  const open = async (): Promise<RuntimeLink | RemoteError> => {
    let link: RuntimeLink
    try {
      // Bounded (review I3): a blackholed address would otherwise hold the call for the OS's whole SYN wait.
      const c = connect({ host: target.address, port: target.port, pin: target.fingerprint })
      const got = await new Promise<RuntimeLink | 'timeout'>((resolve, reject) => {
        const t = setTimeout(() => resolve('timeout'), connectTimeoutMs)
        c.then(
          (l) => (clearTimeout(t), resolve(l)),
          (e) => (clearTimeout(t), reject(e))
        )
      })
      if (got === 'timeout') {
        void c.then((l) => l.close(), () => {})
        return new RemoteError('RUNTIME_OFFLINE', `the Runtime at ${target.address}:${target.port} did not answer within ${Math.round(connectTimeoutMs / 1000)} s`)
      }
      link = got
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
      if (current === link) {
        current = null
        live = null
      }
      // Every stream on this connection subscribes again from where it was, on the next one (§3.7, N11).
      for (const s of streams.values()) if (s.on === link) s.on = null
      if (!closed && streams.size > 0) void resubscribeAll(0)
    })
    return link
  }
  const ensure = (): Promise<RuntimeLink | RemoteError> => {
    if (live === null) {
      const p = open()
      live = p
      void p.then((l) => {
        if (live !== p) return
        if (l instanceof RemoteError) live = null
        else current = l
      })
    }
    return live
  }
  /** The connection `live` resolved to, so a drop forgets it in the same turn: the retry right after must not be
   *  handed the dead one again. */
  let current: RuntimeLink | null = null
  const drop = (link: RuntimeLink): void => {
    link.close()
    if (current === link) {
      current = null
      live = null
    }
  }
  const onStreamFrame = (s: Stream, link: RuntimeLink, f: SubscriptionFrame): void => {
    if (streams.get(s.id) !== s || s.on !== link) return
    switch (f.t) {
      case 'subscribed':
        s.bootId = f.bootId
        return
      case 'checkpoint':
        s.lastSeq = f.checkpoint.watermark
        s.h.onReset(f.checkpoint)
        return
      case 'pty-out': {
        // Nothing at or below what was handed on: a replay can overlap what came before it.
        const fresh = s.lastSeq === null ? f.events : f.events.filter((e) => e.seq > (s.lastSeq as number))
        if (fresh.length === 0) return
        s.lastSeq = fresh[fresh.length - 1].seq
        s.h.onEvents(fresh)
        return
      }
      case 'output-gap':
        // The stream ended behind its budget: again from the last seq handed on, on the same connection.
        return start(s, link)
      case 'sub-error':
        streams.delete(s.id)
        s.h.onGone?.(f.code, f.message)
        return
    }
  }
  const start = (s: Stream, link: RuntimeLink): void => {
    if (!link.subscribe) {
      streams.delete(s.id)
      s.h.onGone?.('RUNTIME_CAPABILITY_MISSING', 'this connection does not stream pty output')
      return
    }
    s.on = link
    link.subscribe(s.id, s.pty, { ...(s.lastSeq !== null ? { fromSeq: s.lastSeq + 1 } : {}), ...(s.bootId !== null ? { bootId: s.bootId } : {}) }, (f) =>
      onStreamFrame(s, link, f)
    )
  }
  /** Subscribes every stream that has no connection, waiting out the reconnect backoff; gives up as calls do. */
  let resubscribing = false
  const resubscribeAll = async (i: number): Promise<void> => {
    if (resubscribing) return
    resubscribing = true
    try {
      for (let tries = i; !closed && [...streams.values()].some((s) => s.on === null); tries++) {
        const link = await ensure()
        if (!(link instanceof RemoteError)) {
          for (const s of streams.values()) if (s.on === null) start(s, link)
          return
        }
        if (FINAL.has(link.code)) {
          for (const s of [...streams.values()]) {
            streams.delete(s.id)
            s.h.onGone?.(link.code, link.message)
          }
          return
        }
        await sleep(backoff(tries))
      }
    } finally {
      resubscribing = false
    }
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
    subscribe: (pty, h) => {
      const s: Stream = { id: `s${++streamN}`, pty, h, lastSeq: null, bootId: null, on: null }
      streams.set(s.id, s)
      void resubscribeAll(0)
      return () => {
        if (!streams.delete(s.id)) return
        s.on?.unsubscribe?.(s.id)
        s.on = null
      }
    },
    call: async (cmd, args, o = {}) => {
      const request = o.request
      const timeoutMs = o.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS
      /** Set at each loss (review I1): the window to reach the Runtime again runs from when it was lost. */
      let deadline = 0
      /** Whether this change may have reached the Runtime: then a lost reply is OUTCOME_UNKNOWN, never OFFLINE. */
      let sent = false
      /** Whether this call lost a connection. Until it has, a Runtime that cannot be reached is OFFLINE at once
       *  (review I3): there is nothing in flight to recover, and a person waits on the answer. */
      let losses = 0
      let tries = 0
      const unknown = (why: string): RemoteError =>
        new RemoteError('RUNTIME_OUTCOME_UNKNOWN', `the answer to ${cmd} was lost and the Runtime cannot say whether it ran: ${why}`)
      for (;;) {
        if (closed) return new RemoteError('RUNTIME_OFFLINE', 'the link to the Runtime is closed')
        const link = await ensure()
        if (link instanceof RemoteError) {
          if (FINAL.has(link.code) || losses === 0) return sent && request !== undefined && !FINAL.has(link.code) ? unknown(link.message) : link
          if (now() >= deadline) return sent && request !== undefined ? unknown(link.message) : link
          await sleep(backoff(tries++))
          continue
        }
        const co = request === undefined ? undefined : { request, ...(sent ? { retry: true as const } : {}) }
        let r: CallReply | 'timeout'
        const wasSent: boolean = sent
        try {
          sent = sent || request !== undefined
          r = await withDeadline(co ? link.call(cmd, args, co) : link.call(cmd, args), timeoutMs)
        } catch (e) {
          const err = asRemoteError(e, 'RUNTIME_OFFLINE')
          // The Runtime's own refusal of this call (busy, too large) is its answer (review C1: told apart by `lost`,
          // never by the code, since a connection the Gateway closes carries the code it closed with).
          if (!err.lost) return err
          if (err.unsent) sent = wasSent
          drop(link)
          // A revocation closes the connection: final, and a change sent on it keeps its request id for the person.
          if (err.code === 'RUNTIME_AUTH_FAILED') return err
          if (losses++ === 0) {
            deadline = now() + reconnectForMs
            continue
          }
          if (now() >= deadline)
            return request !== undefined ? unknown('the connection kept closing') : new RemoteError('RUNTIME_OFFLINE', `the connection to the Runtime kept closing during ${cmd}`)
          await sleep(backoff(tries++))
          continue
        }
        if (r === 'timeout') {
          // A link that does not answer may be half-open (review I3): the next call opens a new one.
          drop(link)
          return new RemoteError('REMOTE_TIMEOUT', `the Runtime did not answer ${cmd} within ${Math.round(timeoutMs / 1000)} s; it may still finish`)
        }
        // A retry that finds its own first attempt still running (§3.9: 409, naming this request) asks again until that
        // attempt is done and its receipt can be replayed, within the window the loss opened.
        const b = r.body as { requestId?: unknown; code?: unknown } | null
        // The "may or may not have run" 409 names the request too, with its code: that one is an answer.
        if (co?.retry === true && r.status === 409 && b?.requestId === request && b?.code === undefined && now() < deadline) {
          await sleep(backoff(tries++))
          continue
        }
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
