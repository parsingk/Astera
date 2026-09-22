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
  close(): void
}

export type ConnectFailure = { error: 'unreachable' | 'protocol' | 'timeout' }

export async function connectHost(a: {
  address: string
  app: string
  timeoutMs?: number
}): Promise<HostConnection | ConnectFailure> {
  return new Promise((resolve) => {
    const listeners = new Set<(m: HostMessage) => void>()
    let settled = false
    const socket = net.connect(a.address)
    socket.setEncoding('utf8')
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
              close: () => socket.destroy()
            })
          return
        }
        for (const cb of listeners) cb(m)
      },
      // This connection has no logger of its own (unlike main/host/client.ts, which reports both of
      // these to the app's log). A malformed line or a handler throw here is dropped rather than
      // crashing the one command the CLI process is running.
      onBadLine: () => {},
      onHandlerError: () => {}
    })
    socket.on('data', (c: string) => read(c))
    socket.on('connect', () =>
      socket.write(encodeLine({ t: 'hello', protocol: HOST_PROTOCOL, app: a.app }))
    )
  })
}
