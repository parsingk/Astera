// The Host's side of the channel: listen, shake hands, and leave when there is nothing to stay for
// (design §6, §7, §8).
//
// Everything that decides behaviour arrives in the deps — the address, the idle time, what to do when
// idle — so this module can be started for real inside a test at an address of that test's own.
import net from 'node:net'
import { promises as fs } from 'node:fs'
import {
  HOST_PROTOCOL,
  HOST_FEATURE_PROC,
  HOST_FEATURE_PING,
  HOST_FEATURE_ORCH,
  HOST_FEATURE_REQUESTS,
  type ClientMessage,
  type HostMessage
} from '../core/host/protocol'
import { encodeLine, createLineReader } from './framing'
import type { HostLog } from './log'
import { AppUnreachable, type OrchCall, type OrchCaller } from '../core/host/orchProtocol'
import { HOST_UNRESPONSIVE_MS } from '../core/host/unresponsive'

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
  /** Sessions and Runs the Host is holding right now. One dep rather than two because a `retire`
   *  refusal always needs both counts together, to name them (public CLI spec §12: "Cannot stop Host:
   *  2 sessions and 1 run are still running"). Both halves are answered for real — `runs` counts the
   *  Runs with work in flight, off the state the Host now owns (`runningRunCount`, ruling F57).
   *
   *  **`runs`, not `jobs`, and the spec was amended to match rather than deviated from** (ruling
   *  F57/e). It counted Runs under the other name, which made one Job with two concurrent Runs report
   *  2 and collided with `astera host status`'s own `jobs` (the number of Jobs in the file). A Run is
   *  the thing that runs and the thing that holds this Host, so the word follows the unit — in the
   *  refusal message, in docs/cli.md, and beside the original sentence in
   *  docs/ASTERA_PUBLIC_HEADLESS_CLI_IMPLEMENTATION_SPEC_20260919.md §12.
   *
   *  **The idle timer asks this too**, so "does this Host hold work" has one answer. It used to ask a
   *  separate `holdsWork` that counted only terminals, and a Host `astera host start` had started
   *  left after `idleMs` with a run in flight while `host stop` would have refused to stop it
   *  (conformance audit #100). A Host holding nothing still leaves. */
  liveCounts?(): { sessions: number; runs: number }
  /** Answers `orch-call` (design §5). Optional here only so a caller that never sends `orch-call`
   *  does not have to supply one; `host/index.ts` always does, because it always advertises
   *  HOST_FEATURE_ORCH below. */
  orch?: OrchCall
}

export interface HostServer {
  close(): Promise<void>
  clients(): number
  /** When this Host began serving, the same string its `hello` carries. Exposed so the entry point can
   *  write it where an app that never gets a `hello` can still read it
   *  (docs/2026-09-22-host-unresponsive-recovery-design.md F3) — one Host, one answer to "which one
   *  is this", whether it is answering or not. */
  startedAt: string
  /** Sends to every connected client. Slice 2's pty output takes this rather than a reply, because
   *  the app that attaches after a restart is not the app that spawned. */
  broadcast(m: HostMessage): void
  /** Whether a client that announced `role: 'app'` is connected right now (design §5). The command
   *  layer asks this before it forwards an action, so that a command that needs the app is refused
   *  at once instead of waiting for one that may never come. */
  hasApp(): boolean
  /** Asks the app to do one thing the Host cannot (design §5) — one `orch-act` out, one `orch-acted`
   *  back, matched by call id. Rejects when no app is attached, when the app answers `ok: false`,
   *  when the app disconnects with the question still open, and when it stays connected and says
   *  nothing for HOST_UNRESPONSIVE_MS: a caller waiting on an answer that cannot arrive is the one
   *  outcome worse than a refusal. */
  act(name: string, args: unknown): Promise<unknown>
}

/** How long a peer that has connected but said nothing gets before the Host hangs up on it. */
const HANDSHAKE_MS = 10_000

/** Whether something is answering at this address right now. Used to tell a stale socket file from a
 *  live one — unlinking a path someone is listening on would take a working Host's address away.
 *  The CLI asks the same of a sibling protocol's address (cli/host.ts `otherProtocolHost`). */
export const answers = (address: string): Promise<boolean> =>
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
  /**
   * The peers that have completed the handshake. **Broadcasts go here, never to `sockets`.**
   *
   * On win32 the pipe carries the default security descriptor, and that is not what design §5
   * assumed: measured 2026-09-21, it is
   * `D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<user>)(A;;FR;;;WD)(A;;FR;;;AN)` — FILE_GENERIC_READ for
   * Everyone and for ANONYMOUS LOGON. Any local user can open the address and be handed a socket, and
   * what this server broadcasts is every terminal's output. Node's `net` cannot set a pipe's ACL, so
   * the operating system is not going to keep them out.
   *
   * What does keep them out is that read access is all they have: without FILE_WRITE_DATA they cannot
   * send `hello`, so they never enter this set and never hear a thing. `sockets` stays the whole set
   * because `close()` has to destroy every connection, greeted or not.
   */
  const greetedSockets = new Set<net.Socket>()
  /** What each greeted socket called itself. Kept beside `greetedSockets` rather than inside the
   *  set's element because the set is what `broadcast` walks and that must not change shape.
   *  A socket that is in `greetedSockets` is always in here too — both are written in one place. */
  const roles = new Map<net.Socket, 'app' | 'cli'>()
  /** The `orch-act`s that have gone out and not been answered, by call id. The socket is kept with
   *  each one so that a disconnect can refuse exactly the questions it left unanswered. */
  const pendingActs = new Map<
    string,
    { socket: net.Socket; settle(r: { ok: boolean; value?: unknown; error?: string; fromApp?: boolean }): void }
  >()
  let actSeq = 0
  /** The app among the greeted sockets, or null. The first one: one profile has one app (the
   *  single-instance lock), and a second would be a second app for the same state anyway. */
  const appSocket = (): net.Socket | null => {
    for (const s of greetedSockets) if (roles.get(s) === 'app' && !s.destroyed) return s
    return null
  }
  // Set at the top of close(), before any socket is destroyed. A destroyed socket's 'close' event
  // arrives asynchronously, after close() has already returned — without this flag that deferred
  // event would re-arm the idle timer on a server that is already gone, and onIdle() would fire again.
  let closing = false

  const armIdle = (): void => {
    if (closing) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      const held = deps.liveCounts?.() ?? { sessions: 0, runs: 0 }
      if (live === 0 && held.sessions === 0 && held.runs === 0) {
        deps.log.write(`idle for ${deps.idleMs}ms with no client — leaving`)
        deps.onIdle()
        return
      }
      // Still held. Look again after the same interval rather than never: the hold ends when the
      // last terminal or the last run in flight does, and nobody will call back to say so.
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
          // Only here, past the protocol check: a client on another protocol has been told so and is
          // owed nothing else. The address's version suffix exists to keep this protocol's messages
          // away from an app that cannot read them (core/host/protocol.ts), and broadcasting to one
          // that just announced a different number would walk around that.
          greetedSockets.add(socket)
          // **No role means a CLI.** An app old enough not to send one is then refused with
          // APP_REQUIRED instead of being sent an `orch-act` it cannot answer, which would leave the
          // caller waiting forever (protocol.ts's `hello` has the whole reason).
          roles.set(socket, m.role === 'app' ? 'app' : 'cli')
          send({
            t: 'hello',
            protocol: HOST_PROTOCOL,
            host: deps.version,
            pid: process.pid,
            startedAt,
            // HOST_FEATURE_ORCH is conditional on `deps.orch` — unlike the two features beside it —
            // because advertising it and being able to serve it must be the same fact. Without this,
            // a caller that supplies no `orch` (several test call sites do not) would claim a
            // capability it cannot answer, and an `orch-call` sent to it would fall through to the
            // "unknown message" log below and never get a reply at all.
            //
            // **HOST_FEATURE_REQUESTS rides the same condition**, because it is the same fact:
            // receipts live inside the thing that answers `orch-call` (`createHostOrch`), so a Host
            // with no `orch` can neither run a command nor remember having run it. Announcing it
            // unconditionally would tell a caller that its presented `--request-id` protects a call
            // that is never answered at all.
            features: [
              HOST_FEATURE_PROC,
              HOST_FEATURE_PING,
              ...(deps.orch ? [HOST_FEATURE_ORCH, HOST_FEATURE_REQUESTS] : [])
            ]
          })
          return
        }
        if (m?.t === 'ping') {
          // Answered here rather than through `onMessage`, and deliberately carrying nothing: what the
          // app is asking is whether this event loop is still turning. A pty spawn stuck inside
          // node-pty stops it (2026-09-22), and then this answer simply never comes — which is the
          // signal (docs/2026-09-22-host-unresponsive-recovery-design.md F2).
          send({ t: 'pong', seq: m.seq })
          return
        }
        if (m?.t === 'retire') {
          // Only a person's own `astera host stop` (reason 'user') can be refused. The default,
          // 'protocol', is what the app already sends on finding a Host it cannot talk to — that
          // Host's sessions are unreachable to the app asking anyway, and refusing would strand it
          // there instead of letting a Host it can talk to take the address (design §12).
          if (m.reason === 'user') {
            const counts = deps.liveCounts?.() ?? { sessions: 0, runs: 0 }
            if (counts.sessions > 0 || counts.runs > 0) {
              deps.log.write(`asked to retire but ${counts.sessions} session(s) and ${counts.runs} run(s) are still running — refusing`)
              send({ t: 'retire-refused', sessions: counts.sessions, runs: counts.runs })
              return
            }
          }
          deps.log.write('asked to retire — leaving')
          deps.onIdle()
          return
        }
        if (m?.t === 'orch-call' && deps.orch) {
          // Explicit rather than incidental (design §9's security property): a socket that has not
          // said hello must hear nothing, here the same as everywhere else `send` is used directly
          // instead of through `broadcast`.
          if (!greetedSockets.has(socket)) return
          const from: OrchCaller = {
            role: roles.get(socket) ?? 'cli',
            toOthers: (msg) => {
              const line = encodeLine(msg)
              for (const s of greetedSockets) if (s !== socket && !s.destroyed) s.write(line)
            }
          }
          void deps.orch
            .call({ cmd: m.cmd, args: m.args, sessionId: m.session ?? '', from, request: m.request })
            .then((r) =>
              send({
                t: 'orch-result',
                call: m.call,
                status: r.status,
                body: r.body,
                // Only when they are true: these mean "this answer is about an id you had already
                // used", and a `false` on every ordinary answer would put a word about receipts in
                // front of every caller that never asked for one. They are never both set.
                ...(r.replayed === true ? { replayed: true as const } : {}),
                ...(r.observed === true ? { observed: true as const } : {})
              })
            )
          return
        }
        if (m?.t === 'orch-acted') {
          if (!greetedSockets.has(socket)) return
          const waiting = pendingActs.get(m.call)
          // An answer to a question this Host is not waiting on any more — the app disconnected and
          // reconnected, or answered twice. Dropped rather than logged as unknown: the message is
          // well formed and there is simply nobody left to hand it to.
          //
          // **And only from the socket that was asked.** Call ids are a counter, so any greeted
          // client could otherwise guess one and answer for the app — which would have the command
          // layer act on a result the app never produced.
          if (!waiting || waiting.socket !== socket) return
          pendingActs.delete(m.call)
          // `fromApp`: the app answered. A failure it reports is the action's, not the channel's.
          waiting.settle({ ok: m.ok, value: m.value, error: m.error, fromApp: true })
          return
        }
        if (deps.onMessage?.(m, send) === true) return
        deps.log.write(`unknown message: ${JSON.stringify(v).slice(0, 200)}`)
      },
      onBadLine: (raw) => deps.log.write(`line that is not JSON, ignored: ${raw.slice(0, 200)}`),
      onHandlerError: (v, err) =>
        deps.log.write(`message failed: ${JSON.stringify(v).slice(0, 200)} — ${String(err)}`)
    })
    socket.on('data', read)
    const gone = (): void => {
      // Otherwise a peer that hangs up before saying anything still gets a "did not say hello" line
      // logged against it after it has already gone.
      greeted()
      sockets.delete(socket)
      greetedSockets.delete(socket)
      roles.delete(socket)
      // Whatever this socket was asked and never answered is refused now. Left in the map it would
      // be a promise nothing can ever settle, and the CLI call waiting behind it would hang for as
      // long as the Host lives.
      for (const [call, p] of pendingActs)
        if (p.socket === socket) {
          pendingActs.delete(call)
          p.settle({ ok: false, error: 'the Astera app disconnected before it answered' })
        }
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
    startedAt,
    clients: () => live,
    hasApp: () => appSocket() !== null,
    act: (name, args) =>
      new Promise((resolve, reject) => {
        const sock = appSocket()
        // The same sentence `orchDeps.ts` refuses with, so the reason reads the same however the
        // caller got here — the app can go away between that check and this one.
        if (!sock) return reject(new AppUnreachable(`APP_REQUIRED: ${name} needs the Astera app running`))
        const call = `act_${++actSeq}`
        // **The fourth way a caller can be left waiting, and the one the other three do not cover:**
        // an app that stays connected and wedged. Its socket never closes, so nothing calls back, and
        // the Host's own handshake deadline is about silence before `hello`, not after it. The same
        // constant the rest of this codebase already judges a silent peer by — one number, so the two
        // directions cannot drift (see unresponsive.ts). This plan has paid for an unbounded wait
        // once already.
        const deadline = setTimeout(() => {
          const waiting = pendingActs.get(call)
          if (!waiting) return
          pendingActs.delete(call)
          waiting.settle({
            ok: false,
            error: `the Astera app is attached but did not answer ${name} within ${HOST_UNRESPONSIVE_MS}ms`
          })
        }, HOST_UNRESPONSIVE_MS)
        deadline.unref?.()
        pendingActs.set(call, {
          socket: sock,
          settle: (r) => {
            clearTimeout(deadline)
            // A refusal is always an AppUnreachable — the app could not be reached, or would not
            // answer. `ok: false` is the app answering, which is the action's own failure and not
            // this: it keeps the plain Error, and the command that asked decides what that means.
            if (r.ok) return resolve(r.value)
            reject(r.fromApp === true ? new Error(r.error ?? `${name} failed`) : new AppUnreachable(r.error ?? `${name} failed`))
          }
        })
        sock.write(encodeLine({ t: 'orch-act', call, act: name, args }))
      }),
    broadcast: (m) => {
      const line = encodeLine(m)
      for (const s of greetedSockets) if (!s.destroyed) s.write(line)
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
        greetedSockets.clear()
        roles.clear()
        // Destroying a socket fires its 'close' asynchronously, so the refusals `gone` sends would
        // arrive after this Host has already gone. Refused here instead, while there is still
        // somebody to tell.
        for (const [call, p] of pendingActs) {
          pendingActs.delete(call)
          p.settle({ ok: false, error: 'the Host is shutting down' })
        }
        server.close(() => resolve())
      })
  }
}
