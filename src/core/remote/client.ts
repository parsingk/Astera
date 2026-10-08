// A controller's end of one connection to a Runtime (remote runtime design §3.2, §4.3, §4.4): pinned TLS, then
// `auth` or `redeem`, then calls. Phase 3 uses it to prove the Gateway end to end; Phase 4 builds the CLI and MCP
// link on it. Every refusal arrives as an Error with a `code` field (§3.10).
import type { TLSSocket } from 'node:tls'
import { createLineReader } from '../../host/framing'
import { connectPinned } from './pin'
import { createReassembler, type ChunkFrame } from './chunks'
import { FRAME_CAP, parseHelloFrame, parsePairedFrame, parseSubscriptionFrame, type ClientInfo, type HelloFrame, type ServerFrame, type SubscriptionFrame } from './frames'

export interface CallReply {
  status: number
  body: unknown
  replayed?: true
  observed?: true
}

export interface RuntimeLink {
  auth(token: string, client: ClientInfo): Promise<HelloFrame>
  redeem(code: string, name: string, client: ClientInfo): Promise<{ clientId: string; token: string }>
  call(cmd: string, args: Record<string, unknown>, o?: { request?: string; retry?: true }): Promise<CallReply>
  /** A pty's output on this connection (§3.7): every frame for `sub` goes to `onFrame`. Optional, so a test double
   *  need not have it; this module's own link always does. */
  subscribe?(sub: string, pty: string, o: { fromSeq?: number; bootId?: string }, onFrame: (f: SubscriptionFrame) => void): void
  unsubscribe?(sub: string): void
  close(): void
  /** Settles when the connection is gone, with the code the Runtime closed it with, if it said one. */
  closed: Promise<{ code?: string }>
}

export class RemoteError extends Error {
  readonly code: string
  /** The connection was lost with this call on it (closed, with or without a code the Runtime named, or silent): the
   *  call may or may not have run, and it is not the Runtime's answer to it (Phase 4 review C1). */
  readonly lost: boolean
  /** The call was never written: its connection was already gone (review M1). A change sent again is a first attempt. */
  readonly unsent: boolean
  constructor(code: string, message: string, o: { lost?: boolean; unsent?: boolean } = {}) {
    super(message)
    this.code = code
    this.lost = o.lost === true
    this.unsent = o.unsent === true
  }
}

/** What a controller holds of replies still arriving in pieces, all together (security audit SEC-5): the largest reply
 *  and a checkpoint or two beside it. */
export const CONTROLLER_REASSEMBLY_MAX = 96 << 20

/** The controller's heartbeat (design §3.1, N14): a ping every 15 s, and a link with nothing heard for 45 s is dropped. */
export const HEARTBEAT = { everyMs: 15_000, silenceMs: 45_000 }

export async function connectRuntime(o: {
  host: string
  port: number
  pin: string
  answerPings?: boolean
  /** Test seam; HEARTBEAT when left out. */
  heartbeat?: { everyMs: number; silenceMs: number }
}): Promise<RuntimeLink> {
  const sock: TLSSocket = await connectPinned({ host: o.host, port: o.port, pin: o.pin })
  sock.setEncoding('utf8')
  const answerPings = o.answerPings ?? true
  const pending = new Map<string, { resolve(r: CallReply): void; reject(e: Error): void }>()
  let handshake: { want: 'hello' | 'paired'; resolve(v: unknown): void; reject(e: Error): void } | null = null
  let closeCode: string | undefined
  let n = 0
  const send = (m: unknown): void => {
    if (!sock.destroyed) sock.write(`${JSON.stringify(m)}\n`)
  }
  // Held to a total across its open replies (security audit SEC-5): a hostile Runtime could open 16 of 64 MiB each.
  const reassemble = createReassembler({ totalCap: CONTROLLER_REASSEMBLY_MAX })
  /** Each subscription's frame handler, by its id. */
  const streams = new Map<string, (f: SubscriptionFrame) => void>()

  const failAll = (e: RemoteError): void => {
    handshake?.reject(e)
    handshake = null
    for (const p of pending.values()) p.reject(e)
    pending.clear()
  }

  const onFrame = (f: ServerFrame): void => {
    switch (f.t) {
      case 'ping':
        if (answerPings) send({ t: 'pong' })
        return
      case 'chunk': {
        const whole = reassemble.add(f as ChunkFrame)
        if (whole === null) return
        if (typeof whole !== 'string') {
          failAll(new RemoteError(whole.error, 'a reply could not be put back together', { lost: true }))
          sock.destroy()
          return
        }
        onFrame(JSON.parse(whole) as ServerFrame)
        return
      }
      case 'hello':
      case 'paired': {
        const want = handshake?.want === f.t ? handshake : null
        handshake = null
        if (!want) return
        // Checked before anything reads it (security audit SEC-4): a Runtime is believed about itself only in shape.
        const ok = f.t === 'hello' ? parseHelloFrame(f) : parsePairedFrame(f)
        if ('error' in ok) {
          want.reject(new RemoteError('REMOTE_BAD_FRAME', `the Runtime's ${f.t} could not be read: ${ok.error}`))
          sock.destroy()
          return
        }
        want.resolve(ok)
        return
      }
      case 'result': {
        const p = pending.get(f.id)
        pending.delete(f.id)
        p?.resolve({ status: f.status, body: f.body, ...(f.replayed ? { replayed: true } : {}), ...(f.observed ? { observed: true } : {}) })
        return
      }
      case 'error': {
        const e = new RemoteError(f.code, f.message)
        if (f.id !== undefined) {
          const p = pending.get(f.id)
          pending.delete(f.id)
          p?.reject(e)
        } else {
          closeCode ??= f.code
          failAll(new RemoteError(f.code, f.message, { lost: true }))
        }
        return
      }
      case 'closing':
        closeCode ??= f.code
        return
      case 'subscribed':
      case 'pty-out':
      case 'checkpoint':
      case 'output-gap':
      case 'sub-error': {
        // Checked as the Gateway checks the Host's (review M9): a malformed frame never reaches a view.
        const ok = parseSubscriptionFrame(f as unknown as Record<string, unknown>)
        if ('error' in ok) return
        const to = streams.get(ok.sub)
        // A refused stream is over: its handler goes, so nothing later under its id reaches it.
        if (ok.t === 'sub-error') streams.delete(ok.sub)
        to?.(ok)
        return
      }
      default:
        return
    }
  }

  // Silence is a lost link (N14): a half-open socket after sleep or a network change would otherwise hold every call.
  const hb = o.heartbeat ?? HEARTBEAT
  let heard = Date.now()
  sock.on('data', () => {
    heard = Date.now()
  })
  const beat = setInterval(() => {
    if (Date.now() - heard > hb.silenceMs) {
      sock.destroy()
      return
    }
    send({ t: 'ping' })
  }, hb.everyMs)
  beat.unref()
  sock.on(
    'data',
    createLineReader({
      maxLine: FRAME_CAP,
      onMessage: (v) => onFrame(v as ServerFrame),
      onBadLine: () => sock.destroy(),
      onHandlerError: () => sock.destroy(),
      onOverflow: () => sock.destroy()
    })
  )
  const closed = new Promise<{ code?: string }>((resolve) => {
    const done = (): void => {
      clearInterval(beat)
      failAll(new RemoteError(closeCode ?? 'RUNTIME_OFFLINE', 'the connection to the Runtime closed', { lost: true }))
      resolve(closeCode !== undefined ? { code: closeCode } : {})
    }
    sock.once('close', done)
    sock.on('error', () => {})
  })

  const begin = <T>(want: 'hello' | 'paired', frame: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      handshake = { want, resolve: resolve as (v: unknown) => void, reject }
      send(frame)
    })

  return {
    auth: async (token, client) => {
      return begin<HelloFrame>('hello', { t: 'auth', token, client })
    },
    redeem: async (code, name, client) => {
      const p = await begin<{ clientId: string; token: string }>('paired', { t: 'redeem', code, name, client })
      return { clientId: p.clientId, token: p.token }
    },
    call: (cmd, args, co = {}) =>
      new Promise<CallReply>((resolve, reject) => {
        // Nothing was written: the call is lost with its connection, and a caller may send it again (review C1).
        if (sock.destroyed) return reject(new RemoteError(closeCode ?? 'RUNTIME_OFFLINE', 'the connection to the Runtime is closed', { lost: true, unsent: true }))
        const id = String(++n)
        pending.set(id, { resolve, reject })
        send({ t: 'call', id, cmd, args, ...co })
      }),
    subscribe: (sub, pty, so, onFrame) => {
      streams.set(sub, onFrame)
      send({ t: 'subscribe', sub, pty, ...(so.fromSeq !== undefined ? { fromSeq: so.fromSeq } : {}), ...(so.bootId !== undefined ? { bootId: so.bootId } : {}) })
    },
    unsubscribe: (sub) => {
      streams.delete(sub)
      send({ t: 'unsubscribe', sub })
    },
    close: () => sock.end(),
    closed
  }
}
