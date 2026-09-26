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

/** Which client a message came from, or which one left. `socket` is a number this server gives each
 *  connection in turn, never reused while it runs, so two clients of the same role can be told apart
 *  without handing the socket itself out. */
export interface ClientRef {
  role: 'app' | 'cli'
  socket: number
  /** Whether this socket has said hello on this protocol (review of Task 1). A mark made for one that
   *  has not is never released: close runs `onClientGone` only for a greeted socket. */
  greeted: boolean
}

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
   *  the server treat it as unknown. Slice 2's pty-* messages arrive here. `from` is the sender: the
   *  Host records which ptys an app holds by it (host S2 ruling R2). A socket that has not said hello
   *  reads as `'cli'`, the same careful default the role itself has. */
  onMessage?(m: ClientMessage, send: (h: HostMessage) => void, from: ClientRef): boolean
  /** A client that had said hello has closed. Not called for a peer that never did: it was never
   *  anybody, and held nothing. */
  onClientGone?(from: ClientRef): void
  /** An app's `yields` changed shape — one attached, one left, or the roster of who is keeping what
   *  duty otherwise moved (§4.3). Never fired for a CLI: only an app's yields decide who drives.
   *  Called in the same turn as the record that caused it, so a reader inside this callback sees the
   *  new state already in place. A throw is caught and logged; the handshake or close it rode in on
   *  is not affected. */
  onAppsChanged?(): void
  /** A socket that called itself the app has just been answered its `hello` (S6 D4). `send` reaches
   *  that socket alone, after the hello reply, so what it sends is read with the features already
   *  known. Not called for a CLI, nor for a hello with no role (an app that old reads no new push). A
   *  throw is caught and logged, as `onAppsChanged`'s is. */
  onAppGreeted?(send: (h: HostMessage) => void): void
  /** Feature names announced in `hello` after the built-in ones. Given only by a caller that serves
   *  them: advertising a feature and being able to serve it are the same fact, as the `orch`
   *  condition below says. */
  features?: string[]
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
  /** Stops taking new clients and keeps the ones connected (Host S2 fix round, I3). A Host that is
   *  leaving can wait up to SPAWN_DEADLINE_MS for its spawns in flight before `close`, and an app
   *  replacing it in that time must not reach it: it would hand the leaving Host its new sessions,
   *  and `killAll` would end them a moment later. So every new connection is destroyed as it lands,
   *  and the peer reads a hang-up it can retry on.
   *
   *  **The listener itself stays open until `close`.** Measured on win32 (2026-09-24): after
   *  `net.Server.close()` with a client still connected, a new `connect` to the pipe neither connects
   *  nor fails; it hangs, because the pipe name lives on in the connected instance. A peer told
   *  nothing waits out its own deadline; one that is hung up on retries at once. A new Host still
   *  cannot bind the address until this one closes it, so an app converges on the new Host at its
   *  next attempt after this one has gone, which the client's backoff may place up to ~16 s later. */
  stopAccepting(): void
  clients(): number
  /** When this Host began serving, the same string its `hello` carries. Exposed so the entry point can
   *  write it where an app that never gets a `hello` can still read it
   *  (docs/2026-09-22-host-unresponsive-recovery-design.md F3) — one Host, one answer to "which one
   *  is this", whether it is answering or not. */
  startedAt: string
  /** Sends to every connected client. Slice 2's pty output takes this rather than a reply, because
   *  the app that attaches after a restart is not the app that spawned. With `to`, only to the greeted
   *  sockets whose hello yields pass it (final review M4: a push only a newer app can read). */
  broadcast(m: HostMessage, to?: (yields: ReadonlySet<string>) => boolean): void
  /** Whether an app is connected right now (design §5): one that announced `role: 'app'`, or an app
   *  1.3.25 or older, whose hello carries no role (LEGACY_APP_NOTICE). Both do their own work, so the
   *  Host does not drive, roll or open Slack beside either (S6-6, SL-11). The command layer asks this
   *  before it forwards an action; `act` then refuses at once for an old app, which cannot answer. */
  hasApp(): boolean
  /** Whether an app that announced `role: 'app'` is connected: the one `act` asks and the one that
   *  reads the pushes newer than 1.3.25 (`session-rolled`, `blocks`, `orch-state`). An app 1.3.25 or
   *  older counts for `hasApp` and not here (leftovers Task 5). */
  hasCurrentApp(): boolean
  /** Asks the app to do one thing the Host cannot (design §5) — one `orch-act` out, one `orch-acted`
   *  back, matched by call id. Only an app that said `role: 'app'` is asked: an app 1.3.25 or older has
   *  never heard of `orch-act`, and the call is refused at once with APP_REQUIRED, naming the update.
   *  Rejects when no app is attached, when the app answers `ok: false`,
   *  when the app disconnects with the question still open, and when it stays connected and says
   *  nothing for HOST_UNRESPONSIVE_MS: a caller waiting on an answer that cannot arrive is the one
   *  outcome worse than a refusal. */
  act(name: string, args: unknown): Promise<unknown>
  /** An app is attached and its hello did not yield `duty`: that app still does it itself (ruling R4).
   *  The first app `act` asks, and any app 1.3.25 or older besides: it yields nothing, and it writes
   *  worktrees.json whole, so an entry the Host made behind it would be erased. */
  appKeeps(duty: string): boolean
  /** Any attached app — not just the first — has not yielded `duty` (ruling R1): one S3 app among
   *  several is enough to keep the Host from driving that duty. */
  appsKeep(duty: string): boolean
  /** The yields a greeted socket declared in its hello, or null once it is gone or never greeted (S6
   *  R1). By the socket number `onMessage` and `onClientGone` hand out, which is what `exits.holdersOf`
   *  names. Whatever role the socket gave: an app 1.3.25 or older sends no role and still holds ptys,
   *  and it yielded nothing, so it keeps every duty. */
  yieldsOf(socketNo: number): ReadonlySet<string> | null
  /** The pid the last app to say hello gave (`hello.pid`, leftovers Task 1), or null when none did. Kept
   *  after that socket closes: it is what `liveAppPid` asks about when `app.pid` names no live app, and
   *  the question matters most once the app's socket is down. Only from a hello that said `role: 'app'`
   *  on this protocol, and only a positive integer. */
  lastAppPid(): number | null
  /** How many sockets the number index behind `yieldsOf` holds: every connection, greeted or not,
   *  until it closes. For the tests: `yieldsOf` answers null for a closed socket either way, so only
   *  this count shows the index forgetting it, and an index that did not would grow by one for every
   *  CLI call for as long as the Host lives. */
  knownSockets(): number
}

/** What the Host says, once per attach, when an app 1.3.25 or older says hello, and what `astera host
 *  status` shows while one is attached (leftovers Task 5). Every released app up to 1.3.25 sends a
 *  `hello` with no `role` and no `yields`, and no released CLI talks to the Host at all (the CLI's
 *  `core/host/connect.ts` came later and always says `role: 'cli'`), so a hello with no role is always
 *  such an app. **It is never answered with `protocol-mismatch`**: the address and the number are the
 *  same, and a 1.3.25 app told so would retire this Host and take every terminal in it along. */
export const LEGACY_APP_NOTICE = 'Astera 1.3.25 or older is attached; update it'

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
   *  A socket that is in `greetedSockets` is always in here too — both are written in one place.
   *  `'legacy-app'` is a hello with no role: an app 1.3.25 or older (LEGACY_APP_NOTICE). It counts
   *  for `hasApp`, `appKeeps` and `appsKeep`, is never sent `orch-act`, and reaches `onMessage`,
   *  `onClientGone` and `orch-call` as `'cli'`, so no door that only an app may use opens for it. */
  const roles = new Map<net.Socket, 'app' | 'legacy-app' | 'cli'>()
  /** The role the hooks and the command layer hear: a legacy app is a `'cli'` to them (see `roles`). */
  const outwardRole = (s: net.Socket): 'app' | 'cli' => (roles.get(s) === 'app' ? 'app' : 'cli')
  /** `lastAppPid`: the pid of the last app hello that carried one. */
  let lastAppPid: number | null = null
  /** What each greeted socket's hello yielded to this Host (`hello.yields`, ruling R4). Written and
   *  deleted beside `roles`, for the same reason it is kept beside the set rather than inside it. */
  const yields = new Map<net.Socket, ReadonlySet<string>>()
  /** Every connected socket by its number, so `yieldsOf` can answer for the number `exits` keeps.
   *  Set when the number is handed out and deleted in `gone`. */
  const socketByNo = new Map<number, net.Socket>()
  let socketSeq = 0
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
  /** Whether an app 1.3.25 or older is attached (`roles`). */
  const legacyAttached = (): boolean => {
    for (const s of greetedSockets) if (roles.get(s) === 'legacy-app' && !s.destroyed) return true
    return false
  }
  /** An app of either kind: both do their own work (`hasApp`). */
  const isApp = (s: net.Socket): boolean => {
    const r = roles.get(s)
    return (r === 'app' || r === 'legacy-app') && !s.destroyed
  }
  /** Wraps `deps.onAppsChanged` so a caller's throw costs the handshake or close it rode in on
   *  nothing — logged instead, the same as `onClientGone`'s own guard below. */
  const tellAppsChanged = (): void => {
    try {
      deps.onAppsChanged?.()
    } catch (err) {
      deps.log.write(`onAppsChanged failed: ${String(err)}`)
    }
  }
  // Set at the top of close(), before any socket is destroyed. A destroyed socket's 'close' event
  // arrives asynchronously, after close() has already returned — without this flag that deferred
  // event would re-arm the idle timer on a server that is already gone, and onIdle() would fire again.
  let closing = false
  /** Cleared by `stopAccepting`. */
  let accepting = true

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
    if (!accepting) {
      socket.destroy()
      return
    }
    live += 1
    const socketNo = ++socketSeq
    sockets.add(socket)
    socketByNo.set(socketNo, socket)
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
          // **No role means an app 1.3.25 or older** (LEGACY_APP_NOTICE), not a CLI: no CLI that talks
          // to a Host sends a hello without one. It counts as attached, so the Host does not drive or
          // open Slack beside it (S6-6, SL-11), and it is still never sent an `orch-act` it cannot
          // answer: `act` refuses with APP_REQUIRED, which would otherwise leave the caller waiting
          // forever (protocol.ts's `hello` has the whole reason). A role that is neither is a CLI.
          const wasApp = isApp(socket)
          const wasLegacy = roles.get(socket) === 'legacy-app'
          roles.set(socket, m.role === 'app' ? 'app' : m.role === undefined ? 'legacy-app' : 'cli')
          if (roles.get(socket) === 'legacy-app' && !wasLegacy) deps.log.write(LEGACY_APP_NOTICE)
          // Junk entries are dropped rather than refused: a hello is not the place to turn a client
          // away over a field that only ever narrows what it keeps.
          yields.set(socket, new Set(Array.isArray(m.yields) ? m.yields.filter((x): x is string => typeof x === 'string') : []))
          if (roles.get(socket) === 'app' && typeof m.pid === 'number' && Number.isSafeInteger(m.pid) && m.pid > 0) lastAppPid = m.pid
          if (isApp(socket) || wasApp) tellAppsChanged()
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
              ...(deps.orch ? [HOST_FEATURE_ORCH, HOST_FEATURE_REQUESTS] : []),
              ...(deps.features ?? [])
            ],
            // Only while one is attached, so `astera host status` can say so (LEGACY_APP_NOTICE).
            ...(legacyAttached() ? { legacyApp: true as const } : {})
          })
          if (roles.get(socket) === 'app') {
            try {
              deps.onAppGreeted?.(send)
            } catch (err) {
              deps.log.write(`onAppGreeted failed: ${String(err)}`)
            }
          }
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
            role: outwardRole(socket),
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
        if (deps.onMessage?.(m, send, { role: outwardRole(socket), socket: socketNo, greeted: greetedSockets.has(socket) }) === true) return
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
      socketByNo.delete(socketNo)
      // Read before the two deletes below: they are what says who this was.
      const wasGreeted = greetedSockets.delete(socket)
      // `isApp` checks `destroyed`, which is true by now: read the role itself.
      const wasApp = roles.get(socket) === 'app' || roles.get(socket) === 'legacy-app'
      const role = outwardRole(socket)
      roles.delete(socket)
      yields.delete(socket)
      if (wasGreeted && wasApp) tellAppsChanged()
      // Whatever this socket was asked and never answered is refused now. Left in the map it would
      // be a promise nothing can ever settle, and the CLI call waiting behind it would hang for as
      // long as the Host lives.
      for (const [call, p] of pendingActs)
        if (p.socket === socket) {
          pendingActs.delete(call)
          p.settle({ ok: false, error: 'the Astera app disconnected before it answered' })
        }
      live = Math.max(0, live - 1)
      // Inside the socket's 'close' event, where a throw is uncaught and ends the Host with every pty it
      // holds; and even caught, it would skip the idle arming below and the Host would never leave.
      if (wasGreeted)
        try {
          deps.onClientGone?.({ role, socket: socketNo, greeted: true })
        } catch (err) {
          deps.log.write(`onClientGone failed for socket ${socketNo}: ${String(err)}`)
        }
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
    hasApp: () => appSocket() !== null || legacyAttached(),
    hasCurrentApp: () => appSocket() !== null,
    // The same "first app socket" `act` sends to: the app that keeps a duty is the one that would be
    // asked to do it. And an app 1.3.25 or older keeps every duty, whoever else is attached.
    appKeeps: (duty) => {
      if (legacyAttached()) return true
      const s = appSocket()
      return s !== null && !(yields.get(s)?.has(duty) ?? false)
    },
    appsKeep: (duty) => [...greetedSockets].some((s) => isApp(s) && !(yields.get(s)?.has(duty) ?? false)),
    yieldsOf: (socketNo) => {
      const s = socketByNo.get(socketNo)
      if (!s || s.destroyed || !greetedSockets.has(s)) return null
      return yields.get(s) ?? null
    },
    knownSockets: () => socketByNo.size,
    lastAppPid: () => lastAppPid,
    act: (name, args) =>
      new Promise((resolve, reject) => {
        const sock = appSocket()
        // The same sentence `orchDeps.ts` refuses with, so the reason reads the same however the
        // caller got here — the app can go away between that check and this one.
        if (!sock)
          return reject(
            new AppUnreachable(
              legacyAttached()
                ? `APP_REQUIRED: ${name} needs a newer Astera app: ${LEGACY_APP_NOTICE}`
                : `APP_REQUIRED: ${name} needs the Astera app running`
            )
          )
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
    broadcast: (m, to) => {
      const line = encodeLine(m)
      for (const s of greetedSockets) {
        if (s.destroyed) continue
        if (to && !to(yields.get(s) ?? new Set<string>())) continue
        s.write(line)
      }
    },
    stopAccepting: () => {
      if (!accepting) return
      accepting = false
      deps.log.write('leaving — no new clients from here on')
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
        yields.clear()
        socketByNo.clear()
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
