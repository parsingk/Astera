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

/** Thrown by `startHostServer` when the directory the socket would go in is not one this user alone
 *  can open. See the check in `startHostServer` for why an existing directory cannot be trusted. */
export const UNSAFE_ADDRESS_DIR = 'astera-host: the address directory is not private to this user'

export interface HostServerDeps {
  address: string
  /** posix: created with mode 0700 before binding. null on win32 (design §5). */
  dirToPrepare: string | null
  /** The Host's own version, reported in the handshake. */
  version: string
  /** How long with no client before `onIdle` fires. */
  idleMs: number
  /** How long a connection has to say `hello` before it is dropped. Defaults to HANDSHAKE_MS. */
  helloMs?: number
  /** What to do when the last client has been gone for `idleMs`, or when a client says `retire`. */
  onIdle(): void
  log: HostLog
  /** A handler for messages the server does not own. Returns true when it handled one; false lets
   *  the server treat it as unknown. Slice 2's pty-* messages arrive here. */
  onMessage?(m: ClientMessage, send: (h: HostMessage) => void): boolean
  /** Whether something is keeping the Host alive beyond its clients — a live terminal, from slice 2.
   *  The idle timer checks it rather than only the connection count. */
  holdsWork?(): boolean
}

export interface HostServer {
  close(): Promise<void>
  clients(): number
  /** Sends to every connected client. Slice 2's pty output takes this rather than a reply, because
   *  the app that attaches after a restart is not the app that spawned. */
  broadcast(m: HostMessage): void
}

/** How long a peer that has connected but said nothing gets before the Host hangs up on it. */
const HANDSHAKE_MS = 10_000

/** Whether something is answering at this address right now. Used to tell a stale socket file from a
 *  live one — unlinking a path someone is listening on would take a working Host's address away. */
const answers = (address: string): Promise<boolean> =>
  new Promise((resolve) => {
    const probe = net.connect(address)
    // A last resort for an address that neither accepts nor refuses. Cleared as soon as the probe
    // settles, so it does not sit in the loop with an answer nobody is waiting for any more.
    const fallback = setTimeout(() => done(false), 1000)
    const done = (v: boolean): void => {
      clearTimeout(fallback)
      probe.destroy()
      resolve(v)
    }
    probe.on('connect', () => done(true))
    probe.on('error', () => done(false))
  })

export async function startHostServer(deps: HostServerDeps): Promise<HostServer> {
  if (deps.dirToPrepare) {
    await fs.mkdir(deps.dirToPrepare, { recursive: true, mode: 0o700 })
    // The mode above is a guarantee only for a directory this call created: `recursive: true` against
    // one that is already there neither errors nor changes its mode. On linux the parent is /tmp at
    // 1777 and the address key is a hash of a guessable profile path, so another local user can make
    // the directory first and leave it open to everyone — or bind their own socket in it, which the
    // EADDRINUSE path below would read as a live Host and step aside for. Design section 5 says
    // access control is the operating system, and that only holds while the directory's own mode says
    // so, so check it rather than assume it.
    const st = await fs.lstat(deps.dirToPrepare)
    if (!st.isDirectory() || process.getuid?.() !== st.uid || (st.mode & 0o077) !== 0) {
      deps.log.write(
        `${deps.dirToPrepare} is not a directory only this user can open (uid ${st.uid}, mode ${(st.mode & 0o777).toString(8)}) — not serving there`
      )
      throw new Error(UNSAFE_ADDRESS_DIR)
    }
  }

  const startedAt = new Date().toISOString()
  let live = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const sockets = new Set<net.Socket>()
  // Set at the top of close(), before any socket is destroyed. A destroyed socket's 'close' event
  // arrives asynchronously, after close() has already returned — without this flag that deferred
  // event would re-arm the idle timer on a server that is already gone, and onIdle() would fire again.
  let closing = false

  const armIdle = (): void => {
    if (closing) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (live === 0 && !(deps.holdsWork?.() ?? false)) {
        deps.log.write(`idle for ${deps.idleMs}ms with no client — leaving`)
        deps.onIdle()
        return
      }
      // Still held. Look again after the same interval rather than never: the hold ends when the
      // last terminal does, and nobody will call back to say so.
      if (live === 0) armIdle()
    }, deps.idleMs)
    // The Host should not be kept alive by this timer alone; the server handle is what holds it.
    idleTimer.unref?.()
  }

  const server = net.createServer((socket) => {
    live += 1
    sockets.add(socket)
    if (idleTimer) clearTimeout(idleTimer)
    socket.setEncoding('utf8')
    // A peer that connects and never speaks holds `live` above zero for good, and the idle shutdown —
    // slice 1's only lifecycle rule — never fires again. Give the handshake a deadline.
    let helloTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      helloTimer = null
      deps.log.write(`a connection did not say hello within ${deps.helloMs ?? HANDSHAKE_MS}ms — dropping it`)
      socket.destroy()
    }, deps.helloMs ?? HANDSHAKE_MS)
    // Same reason as the idle timer's: the server handle is what keeps the Host alive, not this.
    helloTimer.unref?.()
    const greeted = (): void => {
      if (helloTimer) clearTimeout(helloTimer)
      helloTimer = null
    }
    const send = (m: HostMessage): void => {
      if (!socket.destroyed) socket.write(encodeLine(m))
    }
    const read = createLineReader({
      onMessage: (v) => {
        const m = v as ClientMessage
        if (m?.t === 'hello') {
          // Said hello, whatever protocol it turned out to speak — the deadline is about silence.
          greeted()
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
        if (deps.onMessage?.(m, send) === true) return
        deps.log.write(`unknown message: ${JSON.stringify(v).slice(0, 200)}`)
      },
      onBadLine: (raw) => deps.log.write(`line that is not JSON, ignored: ${raw.slice(0, 200)}`)
    })
    socket.on('data', read)
    const gone = (): void => {
      // Otherwise a peer that hangs up before saying anything still gets a "did not say hello" line
      // logged against it after it has already gone.
      greeted()
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
      // A raw errno here would leave the caller unable to tell "somebody else has it" from a real
      // fault, same as the first attempt above.
      server.once('error', () => reject(new Error(ADDRESS_TAKEN)))
      server.listen(deps.address, resolve)
    }
    server.once('error', (e) => void onError(e as NodeJS.ErrnoException))
    server.listen(deps.address, resolve)
  })
  // The listener above only ever needed to catch a bind-time error. Left attached, it would sit for
  // the server's whole life and swallow a later runtime error as an unheard `reject` on a promise
  // that settled long ago, instead of the error reaching the log.
  server.removeAllListeners('error')
  server.on('error', (err) => deps.log.write(`server error: ${String(err)}`))

  deps.log.write(`listening at ${deps.address}`)
  armIdle()

  return {
    clients: () => live,
    broadcast: (m) => {
      const line = encodeLine(m)
      for (const s of sockets) if (!s.destroyed) s.write(line)
    },
    close: () =>
      new Promise<void>((resolve) => {
        // Idempotent: a deferred socket 'close' can call back in after this has already run once
        // (see `closing` above), and the caller has no obligation to call this at most once either.
        if (closing) return resolve()
        closing = true
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
