// The CLI's side of the Host channel. Deliberately smaller than the app's HostClient
// (src/main/host/client.ts): a CLI process connects once, asks one thing and exits, so there is no
// reconnect cycle, no spawn, and no retry — those belong to a process that stays.
import net from 'node:net'
import { HOST_PROTOCOL, type ClientMessage, type HostMessage } from './protocol'
import { createLineReader, encodeLine } from '../../host/framing'

export interface HostConnection {
  hello: { host: string; pid: number; startedAt: string; features: string[] }
  call(m: ClientMessage): void
  onMessage(cb: (m: HostMessage) => void): () => void
  /** Fires once the connection ends, however that happens — including the Host closing its side,
   *  which is what `astera host stop` (`src/cli/host.ts`) reads as "it left": a `retire` that is
   *  honoured gets no reply, only a socket that goes away. */
  onClose(cb: () => void): () => void
  close(): void
}

export type ConnectFailure = { error: 'unreachable' | 'protocol' | 'timeout' }

export async function connectHost(a: {
  address: string
  app: string
  timeoutMs?: number
  /** Where a malformed line or a handler that threw gets reported. Every other real caller of
   *  `createLineReader` in this repo — `main/host/client.ts`'s `attach()`, `host/server.ts`'s
   *  connection handler — logs both rather than swallowing them; before this, `connectHost` did not,
   *  and the only visible effect of a broken line was the generic `unreachable`/`timeout`, which
   *  sends whoever is debugging it looking in the wrong place. */
  log(m: string): void
}): Promise<HostConnection | ConnectFailure> {
  return new Promise((resolve) => {
    const listeners = new Set<(m: HostMessage) => void>()
    const closeListeners = new Set<() => void>()
    let settled = false
    const socket = net.connect(a.address)
    socket.setEncoding('utf8')
    socket.on('close', () => { for (const cb of closeListeners) cb() })
    const done = (v: HostConnection | ConnectFailure): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if ('error' in v) socket.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done({ error: 'timeout' }), a.timeoutMs ?? 5000)
    timer.unref?.()
    socket.on('error', () => done({ error: 'unreachable' }))
    const read = createLineReader({
      onMessage: (v) => {
        const m = v as HostMessage
        if (!settled) {
          if (m.t === 'protocol-mismatch') return done({ error: 'protocol' })
          if (m.t === 'hello')
            return done({
              hello: { host: m.host, pid: m.pid, startedAt: m.startedAt, features: m.features ?? [] },
              call: (out) => socket.write(encodeLine(out)),
              onMessage: (cb) => {
                listeners.add(cb)
                return () => listeners.delete(cb)
              },
              onClose: (cb) => {
                closeListeners.add(cb)
                return () => closeListeners.delete(cb)
              },
              close: () => socket.destroy()
            })
          return
        }
        for (const cb of listeners) cb(m)
      },
      // Same wording as `main/host/client.ts`'s `attach()` — this is the same failure reported at the
      // same seam, just without a persistent log file to write it to.
      onBadLine: (raw) => a.log(`the Host sent a line that is not JSON: ${raw.slice(0, 200)}`),
      onHandlerError: (v, err) =>
        a.log(`a message from the Host failed: ${JSON.stringify(v).slice(0, 200)} — ${String(err)}`)
    })
    socket.on('data', (c: string) => read(c))
    socket.on('connect', () =>
      socket.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: a.app, role: 'cli' }))
    )
  })
}
