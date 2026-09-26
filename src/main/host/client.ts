// The app's side of the channel (design §6, §7, §9). Its whole contract with the rest of the app is
// `status()`: nothing else in slice 1 depends on the Host being there, and every failure ends here,
// as a sentence somebody can read, rather than reaching a caller.
import net from 'node:net'
import { HOST_PROTOCOL, HOST_YIELD_WORKTREES, HOST_YIELD_DISPATCH, HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER, HOST_YIELD_SLACK, type ClientMessage, type HostMessage } from '../../core/host/protocol'
import { HOST_UNRESPONSIVE_MS, PING_MS } from '../../core/host/unresponsive'
import { hostIsOutdated, hostSpeaksPing } from './outdated'
import { encodeLine, createLineReader } from '../../host/framing'
// HostStatus is declared in core/types.ts, not here, so the renderer can name it without importing
// from src/main.
import type { HostStatus } from '../../core/types'

export interface HostClientDeps {
  address: string
  appVersion: string
  /** Start a Host. Called at most once per connect cycle; the client then waits for the address to
   *  answer rather than for the process. */
  spawnHost(): void
  log(m: string): void
  /** The protocol this app speaks. Injected only so a test can be the odd one out. */
  protocol?: number
  /** How many times to try the address before giving up on this cycle. */
  attempts?: number
  /** How long between those tries. */
  retryMs?: number
  /** How long to wait for the Host's `hello` after the socket connects. Defaults to HANDSHAKE_MS. */
  helloMs?: number
  /** The heartbeat's interval, and how many of its pings may be in flight unanswered before the Host
   *  is called unresponsive. Injected only so a test does not have to wait out the real ones. */
  pingMs?: number
  pingMisses?: number
  /** Whether the runtime the Host was started from is missing files (design F6). Read at every hello,
   *  not once: the answer belongs to the Host that just answered, and the next one may be started
   *  from a runtime this app has since repaired. */
  runtimeIncomplete?: () => boolean
  /** Whether this app holds its own Slack socket now (Slack in the Host Task 8). Read at every hello: while
   *  it is true the hello leaves the `slack` yield out, because a Slack-owning Host opens its socket the
   *  moment a yielding hello reaches it, and two sockets on one token split the replies. Absent: yields.
   *  A throw is read as true (no second socket) and logged. */
  keepsSlack?: () => boolean
}

const DEFAULT_ATTEMPTS = 25
const DEFAULT_RETRY_MS = 200
/** An upper bound on how long `cycle()` can spend trying to reach a peer at all, when neither
 *  `attempts` nor `retryMs` is overridden — `DEFAULT_ATTEMPTS` tries, `DEFAULT_RETRY_MS` apart, is
 *  this constant's own arithmetic, and it is the real figure rather than a rounded one: `cycle()`
 *  sleeps after the last failed try as well, on its way to giving up, so a peer that never answers
 *  costs all `DEFAULT_ATTEMPTS` waits and not one fewer. Exported so a caller
 *  waiting on `ready()` can size its own timeout from the real number instead of guessing one — see
 *  HANDSHAKE_MS just below, which is the phase that follows this one and has to be added to it, not
 *  used instead of it; READY_TIMEOUT_MS is that sum, already computed. */
export const CONNECT_PHASE_MS = DEFAULT_ATTEMPTS * DEFAULT_RETRY_MS
/** How long a peer that accepted the connection gets to answer the `hello` before it is written off.
 *  Matches the Host's own deadline on the other side of the same handshake. Exported so a caller
 *  waiting on `ready()` can set its own timeout above CONNECT_PHASE_MS + this one — otherwise it can
 *  expire while the Host is still mid-handshake, which reads no differently from there being no Host
 *  at all. */
export const HANDSHAKE_MS = 10_000
/** What a `ready()` caller should pass when this HostClient is built with neither `attempts` nor
 *  `retryMs` overridden: the sum of the two sequential phases `ready()` can be waiting out — the
 *  connect phase, then, once a peer accepts, the handshake phase. Exported as one number, computed
 *  here rather than left for a caller to add CONNECT_PHASE_MS and HANDSHAKE_MS together itself, so a
 *  future override of either one cannot silently strand a caller's own copy of that arithmetic. */
export const READY_TIMEOUT_MS = CONNECT_PHASE_MS + HANDSHAKE_MS
/** After a connection that worked drops, wait before trying again: 1s, 2s, 4s, capped at 30s. */
const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]

/** How many pings may be in flight unanswered before that Host is called unresponsive. Derived from
 *  `HOST_UNRESPONSIVE_MS` divided by `PING_MS` (both in core/host/unresponsive.ts), rather than a second
 *  literal that could drift from it — `cli/host.ts`'s `host stop` has to agree with the same 15s
 *  judgment. If a slow first spawn or a wake from sleep ever produces a false verdict, `HOST_UNRESPONSIVE_MS`
 *  is what moves (docs/2026-09-22-host-unresponsive-recovery-design.md §9), not this line. */
export const PING_MISSES = HOST_UNRESPONSIVE_MS / PING_MS

/** How long `retire()` waits for the Host to be gone. Covers the Host's own EXIT_HAMMER_MS
 *  (host/index.ts), which is the point by which it has stopped being polite about leaving. */
const RETIRE_SETTLE_MS = 2_000

/** Which Host answered, as the `hello` reports it. Two `hello`s with the same pair came from the same
 *  process, and one whose registry therefore still holds the ptys this app spawned before the drop. */
export interface HostIdentity {
  pid: number
  startedAt: string
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => {
    const timer = setTimeout(r, ms)
    // Nothing here should keep the process alive. A client waiting to retry is not work the app has
    // to finish before quitting, and `cycle` checks `stopped` when the wait is over anyway. The
    // Host's own idle timer unrefs itself for the same reason.
    timer.unref?.()
  })

const connectOnce = (address: string): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(address)
    socket.setEncoding('utf8')
    socket.once('connect', () => resolve(socket))
    socket.once('error', (err) => {
      socket.destroy()
      reject(err)
    })
  })

export class HostClient {
  private socket: net.Socket | null = null
  private stopped = false
  private drops = 0
  private readonly subscribers = new Set<(m: HostMessage) => void>()
  /** The connection to the Host went away. Notified from the socket's own 'close' handler, before a
   *  reconnect is scheduled — see `onDisconnect`. */
  private readonly disconnectSubscribers = new Set<() => void>()
  /** A handshake finished. Notified for every one, the first included — see `onConnect`. */
  private readonly connectSubscribers = new Set<(h: HostIdentity) => void>()
  /** Callers waiting on `ready()` for the current connection attempt to have an outcome. */
  private readonly readyWaiters = new Set<() => void>()
  /** Every change of `status()`. What decides where a new pty goes — the Host or the app's own
   *  node-pty — listens here, because that decision has to follow the Host becoming unresponsive and
   *  not only it connecting (design F1). */
  private readonly statusSubscribers = new Set<(s: HostStatus) => void>()
  /** Runs from `attach` until the Host answers. See where it is armed for what it is for. */
  private handshake: ReturnType<typeof setTimeout> | null = null
  /** The heartbeat, and how many of its pings are in flight with no answer (design F2). */
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private pingSeq = 0
  private pingsOutstanding = 0
  /** Whether anything ever accepted a connection at the address. Set once, in `attach`, and never
   *  cleared: see `sawPeer`. */
  private peerSeen = false
  private state: HostStatus = {
    connected: false,
    protocol: null,
    hostVersion: null,
    startedAt: null,
    pid: null,
    problem: null,
    outdated: false,
    unresponsive: false,
    runtimeIncomplete: false,
    features: []
  }

  constructor(private readonly deps: HostClientDeps) {}

  status(): HostStatus {
    return { ...this.state }
  }

  /** Notified after every change of `status()`, with the new value. Returns an unsubscribe. */
  onStatusChange(cb: (s: HostStatus) => void): () => void {
    this.statusSubscribers.add(cb)
    return () => this.statusSubscribers.delete(cb)
  }

  /** The one place `state` is written after construction, so no transition can reach the outside
   *  world without its subscribers hearing about it. */
  private setState(next: HostStatus): void {
    this.state = next
    for (const cb of [...this.statusSubscribers]) {
      try {
        cb({ ...next })
      } catch (err) {
        // Same rule as every other fan-out here: one subscriber's failure is its own.
        this.deps.log(`a status subscriber threw: ${String(err)}`)
      }
    }
  }

  /**
   * The Host is there and is not answering.
   *
   * Called from the heartbeat, from the handshake deadline, and by the wiring for a Host too old for
   * the heartbeat whose request ran its deadline out (design F1, F4). Idempotent, because all three
   * can fire about the same silence.
   *
   * **The socket is left alone** when there is one. Nothing about it is broken — the Host simply is
   * not reading it — and a late answer arriving on it is the one thing that takes this state back
   * without ending anybody's sessions.
   */
  markUnresponsive(problem: string): void {
    // **A later reason replaces an earlier one**, rather than the first one winning. The heartbeat
    // reaches this first with the general fact, and what comes after it is more specific — a restart
    // that could not end the Host, which is the only place a person learns why the button they just
    // pressed did nothing. (The heartbeat does not keep calling: see where it is armed.)
    if (this.state.unresponsive && this.state.problem === problem) return
    this.deps.log(problem)
    this.setState({ ...this.state, connected: false, unresponsive: true, problem })
    // A `ready()` caller waiting on this connection has its answer: there is a Host, and it is not
    // going to talk to us.
    this.settleReady()
  }

  /** Every message from the Host lands here first. Whatever it says, it proves the event loop on the
   *  other side is turning, which is the only question `unresponsive` asks. */
  private alive(): void {
    this.pingsOutstanding = 0
    if (!this.state.unresponsive) return
    this.deps.log('the Host is answering again')
    this.setState({ ...this.state, connected: true, unresponsive: false, problem: null })
  }

  /** Arms the heartbeat against a Host that announced it answers pings. A Host that did not is judged
   *  by the deadline on a request instead — see `hostSpeaksPing`. */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    if (!hostSpeaksPing(this.state)) return
    const misses = this.deps.pingMisses ?? PING_MISSES
    this.heartbeat = setInterval(() => {
      this.pingSeq += 1
      this.pingsOutstanding += 1
      this.send({ t: 'ping', seq: this.pingSeq })
      // Judged after sending, so the count is pings in flight: with the defaults this fires fifteen
      // seconds after the first one went unanswered. **Pinging continues past it on purpose** — a late
      // pong reaching `alive()` is what takes the state back, and a heartbeat that stopped at the
      // verdict would make that recovery impossible.
      //
      //
      // **It says this once, and then stops saying it.** The verdict is reached every interval from
      // here on, but the state it produces is already there, and something else may have added a more
      // useful sentence to it since — a restart explaining that the Host could not be ended, which is
      // the one thing that tells a person why the button did nothing. Repeating the generic reason
      // overwrote that, four seconds later, every time (measured in the dev app, 2026-09-22).
      if (this.pingsOutstanding >= misses && !this.state.unresponsive) {
        this.markUnresponsive('the Host stopped answering')
      }
    }, this.deps.pingMs ?? PING_MS)
    // Nothing here should keep the app alive, the same reason the retry sleep and the handshake
    // deadline unref themselves.
    this.heartbeat.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.pingsOutstanding = 0
  }

  /** Whether a Host was ever there — did anything accept a connection at the address, at any point in
   *  this client's life. Not the same question as `status().connected`, and the difference is the one
   *  a caller has to act on when the answer is "not connected": nothing ever answered the address
   *  (there is no Host, and never was) reads completely differently from a peer that accepted and then
   *  went quiet or dropped (a Host exists, and we know nothing about what it holds). `status().problem`
   *  separates those too, but only as a sentence, and a sentence is the wrong thing for a caller to
   *  branch on.
   *
   *  Never cleared once set. A Host that answered and then went away is still a Host that was there,
   *  and its ptys outlive the connection — that is the whole point of the Host. */
  sawPeer(): boolean {
    return this.peerSeen
  }

  start(): void {
    void this.cycle()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearHandshake()
    this.stopHeartbeat()
    this.socket?.destroy()
    this.socket = null
  }

  private clearHandshake(): void {
    if (this.handshake) clearTimeout(this.handshake)
    this.handshake = null
  }

  /** Sends a message when there is a connection. Returns false when there is not — callers treat that
   *  as "the Host is not there", which is a state slice 1 already made ordinary. */
  send(m: ClientMessage): boolean {
    if (!this.socket || this.socket.destroyed) return false
    this.socket.write(encodeLine(m))
    return true
  }

  /** Everything the Host says that is not the handshake. Returns an unsubscribe. */
  onMessage(cb: (m: HostMessage) => void): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  /** The connection to the Host went away. Every pty it held went with it, and no `pty-exit` will
   *  ever arrive to say so for any of them — this is what tells a Host-backed pty handle to end
   *  itself instead of waiting forever (ptyFactory.ts's `onHostGone`). Fired from the socket's own
   *  'close' handler, before the reconnect is scheduled. Returns an unsubscribe. */
  onDisconnect(cb: () => void): () => void {
    this.disconnectSubscribers.add(cb)
    return () => this.disconnectSubscribers.delete(cb)
  }

  /** A handshake finished — the counterpart to `onDisconnect`, and fired for the first connection as
   *  well as every reconnect after one.
   *
   *  **Why the identity is part of the event.** A drop ends every Host-backed pty handle in the app
   *  (`onDisconnect` above), but the ptys themselves are very probably still running: the Host outlives
   *  the app and a dropped socket is not the Host dying. So the subscriber's job is to take those ptys
   *  back — and whether there is anything to take back depends entirely on *which* Host just answered.
   *  The same one still holds them; a fresh one, started because the old one really did die, holds an
   *  empty registry and those ptys are genuinely gone. `pid` and `startedAt` come straight out of the
   *  `hello`, and together they separate the two cases without guessing (design §11). Returns an
   *  unsubscribe. */
  onConnect(cb: (h: HostIdentity) => void): () => void {
    this.connectSubscribers.add(cb)
    return () => this.connectSubscribers.delete(cb)
  }

  /** Resolves once the current connection attempt has an outcome — connected, or failed for now — or
   *  after `ms`, whichever comes first. A caller that waits past `ms` reads a Host that is merely
   *  slow the same as one that will never answer, via `status()` afterward; that is deliberate, so
   *  startup can decide whether to route new ptys through the Host without blocking on one that
   *  never answers. Not part of the design this task's brief names — added here because the startup
   *  wiring it exists for (deciding the ptyRouter fallback, then taking sessions back) has no other
   *  way to know when the handshake is settled; see this task's report for the reasoning. */
  ready(ms: number): Promise<void> {
    if (this.state.connected || this.state.problem) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.readyWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      timer.unref?.()
      this.readyWaiters.add(done)
    })
  }

  /** Wakes every pending `ready()` caller. Called from the three places a connection attempt's
   *  outcome becomes known: the handshake succeeding, a protocol mismatch, and giving up. */
  private settleReady(): void {
    for (const w of [...this.readyWaiters]) w()
  }

  /** One attempt at having a working connection: reach the address, spawning a Host if nothing
   *  answers, then shake hands. Returns when the connection is up or the cycle has given up. */
  /**
   * Asks the Host to leave, and stops trying to keep one.
   *
   * For the one moment the Host cannot be allowed to outlive the app: installing a new version over
   * it. The Host is the app's own executable run as node, so on win32 it pins `Astera.exe` and no
   * installer can write over a running image — and if it is merely killed, this client puts a new one
   * back a second later (see the reconnect in `attach`), which is what made an update fail to install
   * at all. `stop()` first, so nothing is restarted behind the retire.
   *
   * Waits out the Host's own way out (300ms to settle, 1.5s before it stops being polite — EXIT_*_MS
   * in host/index.ts) and returns. It never throws: a Host that was not there, or does not answer, is
   * the outcome this was asking for.
   */
  async retire(a: { announce?: boolean } = {}): Promise<void> {
    try {
      this.send({ t: 'retire' })
    } catch {
      /* nothing listening is the state this asks for */
    }
    try {
      await this.stop()
    } catch {
      /* same */
    }
    // `stop()` is deliberate, so the socket's close handler tells nobody — that is right for the
    // install path, where the app is quitting and will-quit owns what happens next. It is wrong for
    // a retire whose point is to *replace* the Host while the app keeps running: the Host ends every
    // pty it holds on the way out, and the `pty-exit`s it would report never arrive on a socket
    // already destroyed. Without this the app would show those sessions running forever. Announcing
    // runs the same fan-out a real drop runs, so each handle ends itself with PTY_LOST_SIGHT and each
    // manager marks its record the way it already knows how to.
    if (a.announce) {
      for (const cb of [...this.disconnectSubscribers]) {
        try {
          cb()
        } catch (err) {
          this.deps.log(`a disconnect subscriber threw: ${String(err)}`)
        }
      }
    }
    await sleep(RETIRE_SETTLE_MS)
  }

  /**
   * Starts trying again after `stop()` — the same cycle, from the top: reach the address, start a
   * Host if nothing answers, shake hands. `stop()` was written to be final, and the one caller that
   * needed it final (an install that must not have a Host put back behind it) still gets that; this
   * is the counterpart for the case that wants exactly the opposite — a Host retired *in order to*
   * be replaced (docs/superpowers/specs/2026-09-14-host-replacement-design.md §5). The Host it
   * starts is whatever `spawnHost` was built with, which is this app's own build.
   *
   * A no-op while the client is running: there is nothing to restart, and a second `cycle()` beside
   * the live one would race it for the socket.
   */
  restart(): void {
    if (!this.stopped) return
    this.stopped = false
    this.drops = 0
    // What is known about the *previous* Host is not a description of the one being started — and
    // that includes it having stopped answering, which is the reason a replacement is usually being
    // started at all (design F5).
    this.setState({ ...this.state, connected: false, protocol: null, hostVersion: null, startedAt: null, pid: null, problem: null, outdated: false, unresponsive: false, runtimeIncomplete: false, features: [] })
    void this.cycle()
  }

  private async cycle(): Promise<void> {
    if (this.stopped) return
    const attempts = this.deps.attempts ?? DEFAULT_ATTEMPTS
    const retryMs = this.deps.retryMs ?? DEFAULT_RETRY_MS
    let asked = false
    for (let i = 0; i < attempts && !this.stopped; i++) {
      try {
        const socket = await connectOnce(this.deps.address)
        // `stop()` may have landed while this connect was in flight. Attaching now would report a
        // connection the caller has already given up on, and the socket's own 'close' handler returns
        // early once stopped — so the status would never be corrected again.
        if (this.stopped) {
          socket.destroy()
          return
        }
        this.attach(socket)
        return
      } catch {
        // Nothing is listening. Ask for a Host once, then keep trying the address — the Host binds
        // some milliseconds after the process starts, and the address is the thing worth waiting on.
        if (!asked && !this.stopped) {
          asked = true
          this.deps.log('no Host at the address — starting one')
          try {
            this.deps.spawnHost()
          } catch (err) {
            this.fail(`the Host could not be started: ${String(err)}`)
            return
          }
        }
        await sleep(retryMs)
      }
    }
    if (!this.stopped) this.fail('no Host answered at the address')
  }

  private attach(socket: net.Socket): void {
    this.socket = socket
    // The connection was accepted, so something is listening at the address. Recorded before the
    // handshake, not after it: a peer that never says hello is exactly the case `sawPeer` exists to
    // tell apart from an address nothing answers.
    this.peerSeen = true
    const read = createLineReader({
      onMessage: (v) => this.handleHostMessage(v as HostMessage),
      onBadLine: (raw) => this.deps.log(`the Host sent a line that is not JSON: ${raw.slice(0, 200)}`),
      onHandlerError: (v, err) =>
        this.deps.log(`a message from the Host failed: ${JSON.stringify(v).slice(0, 200)} — ${String(err)}`)
    })
    socket.on('data', read)
    // A peer that accepts the connection and then says nothing is not a dropped connection: nothing
    // closes, so the 'close' handler below never runs and the status would sit at "not connected, no
    // reason" for the app's whole life, with no retry.
    //
    // **And it is not a peer to reconnect to, either.** This used to `end()` the socket to put the
    // case back on the reconnect path, which assumed the other side would close in return. A Host
    // whose event loop is stuck does not: measured 2026-09-22, the close never came, nothing retried,
    // and the status sat unchanged for the rest of the app's life — with a Host holding a person's
    // sessions the whole time. Reconnecting would not have helped either, because the next connect
    // gets accepted and ignored exactly like this one. So: destroy the socket, and say what is true.
    // `unresponsive` is a state the app acts on (design F1, F3), not a sentence nobody reads.
    this.handshake = setTimeout(() => {
      this.handshake = null
      // Only a socket that never answered can reach here: the hello and the mismatch both clear this.
      if (this.socket !== socket) return
      // Cleared before destroying, so the 'close' handler below returns early rather than scheduling a
      // reconnect to a peer this has just given up on.
      this.socket = null
      socket.destroy()
      this.markUnresponsive('the Host accepted the connection but did not answer')
    }, this.deps.helloMs ?? HANDSHAKE_MS)
    // Same reason as `sleep`'s timer: a client waiting on a handshake is not work the app has to
    // finish before quitting.
    this.handshake.unref?.()
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.clearHandshake()
      this.stopHeartbeat()
      this.socket = null
      if (this.stopped) return
      this.setState({
        ...this.state,
        connected: false,
        // A dropped connection is not an unresponsive Host: this one has a way forward of its own, the
        // backoff below, and the Host on the other side may be perfectly well.
        unresponsive: false,
        // A reason already set (a protocol mismatch, say) is more use than this one, and the next
        // successful handshake clears it either way.
        problem: this.state.problem ?? 'the connection to the Host dropped'
      })
      const wait = BACKOFF_MS[Math.min(this.drops, BACKOFF_MS.length - 1)]
      this.drops += 1
      this.deps.log(`connection to the Host dropped — retrying in ${wait}ms`)
      for (const cb of [...this.disconnectSubscribers]) {
        try {
          cb()
        } catch (err) {
          // Same reason a bad message subscriber does not cost the others theirs: nothing may throw
          // out of this class.
          this.deps.log(`a disconnect subscriber threw: ${String(err)}`)
        }
      }
      void sleep(wait).then(() => this.cycle())
    })
    socket.on('error', (err) => this.deps.log(`connection error: ${String(err)}`))
    // `role` is what makes this client the one the Host sends `orch-act` to; `app` cannot say it,
    // because the CLI's hello carries a version string in the same field (core/host/connect.ts).
    // `yields` hands the Host the Job worktrees (host S3 ruling R4): this app writes worktrees.json
    // through a Host that announces `worktrees` and understands `git-op`. `dispatch` (S4+S5 §4.2)
    // hands it the Jobs: a Host that announces `dispatch` drives them, and this app's scheduler stands
    // down in front of it (ipc.ts's `hostDrives`). `rolling` (S6): a Host that announces it rolls the
    // sessions it owns, and this app shows them. `chat-takeover`: this app writes its chat chains into
    // the proc notes and leaves a Host-started or Host-marked chat proc to a Host that announces it.
    // An older Host ignores the names, and this app goes on driving in front of it (D5).
    // `slack` (Slack in the Host P4): this app opens no socket and posts nothing in front of a Host that
    // announces `slack-owner`, and forwards what only it sees. Left out while this app holds its own socket
    // (keepsSlack), so that Host stays inactive rather than opening a second one beside it.
    let keepsSlack = false
    try {
      keepsSlack = this.deps.keepsSlack?.() === true
    } catch (err) {
      keepsSlack = true
      this.deps.log(`keepsSlack threw, so this hello keeps Slack: ${String(err)}`)
    }
    this.send({
      t: 'hello',
      protocol: this.deps.protocol ?? HOST_PROTOCOL,
      app: this.deps.appVersion,
      role: 'app',
      yields: [HOST_YIELD_WORKTREES, HOST_YIELD_DISPATCH, HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER, ...(keepsSlack ? [] : [HOST_YIELD_SLACK])]
    })
  }

  private handleHostMessage(m: HostMessage): void {
    // Before anything is read off it: whatever this message says, it says the Host's event loop is
    // turning. That is the only question `unresponsive` asks, so a Host written off a moment ago
    // takes itself back here rather than waiting for somebody to notice (design F1).
    this.alive()
    if (m?.t === 'hello') {
      this.clearHandshake()
      this.drops = 0
      // Judged here, from the two versions this handshake already carries, so the status the Info tab
      // reads and the replacement rule in ipc.ts act on cannot disagree about it.
      const outdated = hostIsOutdated(m.host, this.deps.appVersion)
      const runtimeIncomplete = this.deps.runtimeIncomplete?.() ?? false
      this.setState({
        connected: true,
        protocol: m.protocol,
        hostVersion: m.host,
        startedAt: m.startedAt,
        pid: m.pid,
        problem: null,
        outdated,
        unresponsive: false,
        runtimeIncomplete,
        features: Array.isArray(m.features) ? m.features.filter((f): f is string => typeof f === 'string') : []
      })
      this.deps.log(
        `connected to Host ${m.host} (pid ${m.pid}, protocol ${m.protocol})${outdated ? ` — older than this app (${this.deps.appVersion}); replaced once it holds nothing` : ''}${runtimeIncomplete ? ' — its runtime is missing files; replaced once it holds nothing' : ''}`
      )
      // Armed from the status this hello just set, which is what `hostSpeaksPing` reads.
      this.startHeartbeat()
      this.settleReady()
      // After settleReady, so a first-connection subscriber and a `ready()` caller see the same
      // already-connected status rather than racing over it.
      for (const cb of [...this.connectSubscribers]) {
        try {
          cb({ pid: m.pid, startedAt: m.startedAt })
        } catch (err) {
          // Same reason a disconnect subscriber's failure does not cost the others theirs: nothing
          // may throw out of this class.
          this.deps.log(`a connect subscriber threw: ${String(err)}`)
        }
      }
      return
    }
    if (m?.t === 'protocol-mismatch') {
      // Answered, so the handshake deadline has done its job — what follows is a decision, not silence.
      this.clearHandshake()
      // Not two Astera versions meeting — from slice 2 the address already carries the protocol, so
      // this client only ever connects to the one address that matches its own. What lands here
      // instead is a boundary check: the address is a named pipe or a socket in a temp directory, and
      // anything on the machine can connect to it. A peer that answers hello but claims a protocol
      // other than ours is turned away, whatever it actually is.
      this.deps.log(`the Host speaks protocol ${m.protocol} — retiring it and starting one we can talk to`)
      this.send({ t: 'retire' })
      this.setState({ ...this.state, connected: false, problem: `the Host speaks protocol ${m.protocol}` })
      this.socket?.end()
      this.settleReady()
      return
    }
    // The heartbeat's answer carries nothing but the fact that it arrived, and `alive()` above has
    // already taken that. Returning here keeps it out of the subscribers, who would have to know to
    // ignore it.
    if (m?.t === 'pong') return
    for (const cb of [...this.subscribers]) {
      try {
        cb(m)
      } catch (err) {
        // A subscriber's failure is its own; it must not cost the other subscribers their message,
        // and nothing may throw out of this class.
        this.deps.log(`a host message subscriber threw: ${String(err)}`)
      }
    }
  }

  private fail(problem: string): void {
    this.setState({ connected: false, protocol: null, hostVersion: null, startedAt: null, pid: null, problem, outdated: false, unresponsive: false, runtimeIncomplete: false, features: [] })
    this.deps.log(problem)
    this.settleReady()
  }
}
