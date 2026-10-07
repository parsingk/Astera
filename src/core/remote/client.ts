// A controller's end of one connection to a Runtime (remote runtime design §3.2, §4.3, §4.4): pinned TLS, then
// `auth` or `redeem`, then calls. Phase 3 uses it to prove the Gateway end to end; Phase 4 builds the CLI and MCP
// link on it. Every refusal arrives as an Error with a `code` field (§3.10).
import type { TLSSocket } from 'node:tls'
import { createLineReader } from '../../host/framing'
import { connectPinned } from './pin'
import { createReassembler, type ChunkFrame } from './chunks'
import { FRAME_CAP, type ClientInfo, type HelloFrame, type ServerFrame } from './frames'

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
  close(): void
  /** Settles when the connection is gone, with the code the Runtime closed it with, if it said one. */
  closed: Promise<{ code?: string }>
}

export class RemoteError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export async function connectRuntime(o: { host: string; port: number; pin: string; answerPings?: boolean }): Promise<RuntimeLink> {
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
  const reassemble = createReassembler()

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
          failAll(new RemoteError(whole.error, 'a reply could not be put back together'))
          sock.destroy()
          return
        }
        onFrame(JSON.parse(whole) as ServerFrame)
        return
      }
      case 'hello':
      case 'paired':
        if (handshake?.want === f.t) handshake.resolve(f)
        handshake = null
        return
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
          failAll(e)
        }
        return
      }
      case 'closing':
        closeCode ??= f.code
        return
      default:
        return
    }
  }

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
      failAll(new RemoteError(closeCode ?? 'RUNTIME_OFFLINE', 'the connection to the Runtime closed'))
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
      const { t: _t, ...hello } = await begin<HelloFrame>('hello', { t: 'auth', token, client })
      return { t: 'hello', ...hello }
    },
    redeem: async (code, name, client) => {
      const p = await begin<{ clientId: string; token: string }>('paired', { t: 'redeem', code, name, client })
      return { clientId: p.clientId, token: p.token }
    },
    call: (cmd, args, co = {}) =>
      new Promise<CallReply>((resolve, reject) => {
        if (sock.destroyed) return reject(new RemoteError(closeCode ?? 'RUNTIME_OFFLINE', 'the connection to the Runtime is closed'))
        const id = String(++n)
        pending.set(id, { resolve, reject })
        send({ t: 'call', id, cmd, args, ...co })
      }),
    close: () => sock.end(),
    closed
  }
}
