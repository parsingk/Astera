// The Host's side of the channel: listen, shake hands, and leave when there is nothing to stay for
// (design §6, §7, §8).
//
// Everything that decides behaviour arrives in the deps — the address, the idle time, what to do when
// idle — so this module can be started for real inside a test at an address of that test's own.
import net from 'node:net'
import { promises as fs } from 'node:fs'
import { HOST_PROTOCOL, type ClientMessage, type HostMessage } from '../core/host/protocol'
import { encodeLine, createLineReader } from './framing'
import type { HostLog } from './log'

/** Thrown by `startHostServer` when another Host already answers at this address. The entry point
 *  turns it into a quiet exit: losing the race is the normal outcome of two apps starting at once. */
export const ADDRESS_TAKEN = 'astera-host: the address is already served'

export interface HostServerDeps {
  address: string
  /** posix: created with mode 0700 before binding. null on win32 (design §5). */
  dirToPrepare: string | null
  /** The Host's own version, reported in the handshake. */
  version: string
  /** How long with no client before `onIdle` fires. */
  idleMs: number
  /** What to do when the last client has been gone for `idleMs`, or when a client says `retire`. */
  onIdle(): void
  log: HostLog
}

export interface HostServer {
  close(): Promise<void>
  clients(): number
}

/** Whether something is answering at this address right now. Used to tell a stale socket file from a
 *  live one — unlinking a path someone is listening on would take a working Host's address away. */
const answers = (address: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.connect(address)
    const done = (v: boolean): void => {
      probe.destroy()
      resolve(v)
    }
    probe.on('connect', () => done(true))
    probe.on('error', () => done(false))
    setTimeout(() => done(false), 1000)
  })

export async function startHostServer(deps: HostServerDeps): Promise<HostServer> {
  if (deps.dirToPrepare) await fs.mkdir(deps.dirToPrepare, { recursive: true, mode: 0o700 })

  const startedAt = new Date().toISOString()
  let live = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const sockets = new Set<net.Socket>()

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (live === 0) {
        deps.log.write(`idle for ${deps.idleMs}ms with no client — leaving`)
        deps.onIdle()
      }
    }, deps.idleMs)
    // The Host should not be kept alive by this timer alone; the server handle is what holds it.
    idleTimer.unref?.()
  }

  const server = net.createServer((socket) => {
    live += 1
    sockets.add(socket)
    if (idleTimer) clearTimeout(idleTimer)
    socket.setEncoding('utf8')
    const send = (m: HostMessage): void => {
      if (!socket.destroyed) socket.write(encodeLine(m))
    }
    const read = createLineReader({
      onMessage: (v) => {
        const m = v as ClientMessage
        if (m?.t === 'hello') {
          if (m.protocol !== HOST_PROTOCOL) {
            deps.log.write(`client speaks protocol ${String(m.protocol)}, this Host speaks ${HOST_PROTOCOL}`)
            send({ t: 'protocol-mismatch', protocol: HOST_PROTOCOL })
            return
          }
          deps.log.write(`client ${String(m.app)} connected`)
          send({ t: 'hello', protocol: HOST_PROTOCOL, host: deps.version, pid: process.pid, startedAt })
          return
        }
        if (m?.t === 'retire') {
          deps.log.write('asked to retire — leaving')
          deps.onIdle()
          return
        }
        deps.log.write(`unknown message: ${JSON.stringify(v).slice(0, 200)}`)
      },
      onBadLine: (raw) => deps.log.write(`line that is not JSON, ignored: ${raw.slice(0, 200)}`)
    })
    socket.on('data', read)
    const gone = (): void => {
      sockets.delete(socket)
      live = Math.max(0, live - 1)
      if (live === 0) armIdle()
    }
    socket.on('close', gone)
    socket.on('error', (err) => deps.log.write(`connection error: ${String(err)}`))
  })

  await new Promise<void>((resolve, reject) => {
    const onError = async (err: NodeJS.ErrnoException): Promise<void> => {
      if (err.code !== 'EADDRINUSE') return reject(err)
      // Somebody has the address. Either a live Host — in which case this one loses the race and
      // says so — or a socket file an ungraceful exit left behind, which is ours to clear.
      if (await answers(deps.address)) return reject(new Error(ADDRESS_TAKEN))
      if (!deps.dirToPrepare) return reject(new Error(ADDRESS_TAKEN))
      try {
        await fs.unlink(deps.address)
      } catch {
        return reject(new Error(ADDRESS_TAKEN))
      }
      deps.log.write('a socket file was left behind by an earlier Host — replaced')
      server.once('error', reject)
      server.listen(deps.address, resolve)
    }
    server.once('error', (e) => void onError(e as NodeJS.ErrnoException))
    server.listen(deps.address, resolve)
  })

  deps.log.write(`listening at ${deps.address}`)
  armIdle()

  return {
    clients: () => live,
    close: () =>
      new Promise<void>((resolve) => {
        if (idleTimer) clearTimeout(idleTimer)
        // `server.close` stops accepting and waits for the open connections. The Host is leaving, so
        // it does not wait: a peer that has already ended its side may not have been reaped yet, and
        // a close that hangs on it is worse than a connection dropped a moment early.
        for (const s of sockets) s.destroy()
        sockets.clear()
        server.close(() => resolve())
      })
  }
}
