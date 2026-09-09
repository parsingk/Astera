// The app's side of the channel (design §6, §7, §9). Its whole contract with the rest of the app is
// `status()`: nothing else in slice 1 depends on the Host being there, and every failure ends here,
// as a sentence somebody can read, rather than reaching a caller.
import net from 'node:net'
import { HOST_PROTOCOL, type ClientMessage, type HostMessage } from '../../core/host/protocol'
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
  /** Callers waiting on `ready()` for the current connection attempt to have an outcome. */
  private readonly readyWaiters = new Set<() => void>()
  /** Runs from `attach` until the Host answers. See where it is armed for what it is for. */
  private handshake: ReturnType<typeof setTimeout> | null = null
  private state: HostStatus = {
    connected: false,
    protocol: null,
    hostVersion: null,
    startedAt: null,
    pid: null,
    problem: null
  }

  constructor(private readonly deps: HostClientDeps) {}

  status(): HostStatus {
    return { ...this.state }
  }

  start(): void {
    void this.cycle()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.clearHandshake()
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
    const read = createLineReader({
      onMessage: (v) => this.handleHostMessage(v as HostMessage),
      onBadLine: (raw) => this.deps.log(`the Host sent a line that is not JSON: ${raw.slice(0, 200)}`),
      onHandlerError: (v, err) =>
        this.deps.log(`a message from the Host failed: ${JSON.stringify(v).slice(0, 200)} — ${String(err)}`)
    })
    socket.on('data', read)
    // A peer that accepts the connection and then says nothing is not a dropped connection: nothing
    // closes, so the 'close' handler below never runs and the status would sit at "not connected, no
    // reason" for the app's whole life, with no retry. Ending the socket ourselves puts that case
    // back on the path that already handles a connection going away.
    this.handshake = setTimeout(() => {
      this.handshake = null
      // Only a socket that never answered can reach here: the hello and the mismatch both clear this.
      if (this.socket !== socket) return
      this.fail('the Host accepted the connection but did not answer')
      socket.end()
    }, this.deps.helloMs ?? HANDSHAKE_MS)
    // Same reason as `sleep`'s timer: a client waiting on a handshake is not work the app has to
    // finish before quitting.
    this.handshake.unref?.()
    socket.on('close', () => {
      if (this.socket !== socket) return
      this.clearHandshake()
      this.socket = null
      if (this.stopped) return
      this.state = {
        ...this.state,
        connected: false,
        // A reason already set (a protocol mismatch, say) is more use than this one, and the next
        // successful handshake clears it either way.
        problem: this.state.problem ?? 'the connection to the Host dropped'
      }
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
    this.send({ t: 'hello', protocol: this.deps.protocol ?? HOST_PROTOCOL, app: this.deps.appVersion })
  }

  private handleHostMessage(m: HostMessage): void {
    if (m?.t === 'hello') {
      this.clearHandshake()
      this.drops = 0
      this.state = {
        connected: true,
        protocol: m.protocol,
        hostVersion: m.host,
        startedAt: m.startedAt,
        pid: m.pid,
        problem: null
      }
      this.deps.log(`connected to Host ${m.host} (pid ${m.pid}, protocol ${m.protocol})`)
      this.settleReady()
      return
    }
    if (m?.t === 'protocol-mismatch') {
      // Answered, so the handshake deadline has done its job — what follows is a decision, not silence.
      this.clearHandshake()
      // Slice 1 only: the Host holds nothing, so it can be told to leave and replaced. Once it owns
      // live terminals this is no longer an answer, and slice 2 has to give a different one.
      this.deps.log(`the Host speaks protocol ${m.protocol} — retiring it and starting one we can talk to`)
      this.send({ t: 'retire' })
      this.state = { ...this.state, connected: false, problem: `the Host speaks protocol ${m.protocol}` }
      this.socket?.end()
      this.settleReady()
      return
    }
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
    this.state = { connected: false, protocol: null, hostVersion: null, startedAt: null, pid: null, problem }
    this.deps.log(problem)
    this.settleReady()
  }
}
