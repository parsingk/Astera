// The app's side of the channel (design §6, §7, §9). Its whole contract with the rest of the app is
// `status()`: nothing else in slice 1 depends on the Host being there, and every failure ends here,
// as a sentence somebody can read, rather than reaching a caller.
import net from 'node:net'
import { HOST_PROTOCOL, type ClientMessage, type HostMessage } from '../../core/host/protocol'
import { encodeLine, createLineReader } from '../../host/framing'
import type { HostStatus } from '../../core/types'

// HostStatus is declared in core/types.ts, not here, so the renderer can name it without importing
// from src/main. Re-exported so this file's own tests keep compiling against it.
export type { HostStatus }

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
}

const DEFAULT_ATTEMPTS = 25
const DEFAULT_RETRY_MS = 200
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
    this.socket?.destroy()
    this.socket = null
  }

  private send(m: ClientMessage): void {
    if (this.socket && !this.socket.destroyed) this.socket.write(encodeLine(m))
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
      onMessage: (v) => this.onMessage(v as HostMessage),
      onBadLine: (raw) => this.deps.log(`the Host sent a line that is not JSON: ${raw.slice(0, 200)}`)
    })
    socket.on('data', read)
    socket.on('close', () => {
      if (this.socket !== socket) return
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
      void sleep(wait).then(() => this.cycle())
    })
    socket.on('error', (err) => this.deps.log(`connection error: ${String(err)}`))
    this.send({ t: 'hello', protocol: this.deps.protocol ?? HOST_PROTOCOL, app: this.deps.appVersion })
  }

  private onMessage(m: HostMessage): void {
    if (m?.t === 'hello') {
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
      return
    }
    if (m?.t === 'protocol-mismatch') {
      // Slice 1 only: the Host holds nothing, so it can be told to leave and replaced. Once it owns
      // live terminals this is no longer an answer, and slice 2 has to give a different one.
      this.deps.log(`the Host speaks protocol ${m.protocol} — retiring it and starting one we can talk to`)
      this.send({ t: 'retire' })
      this.state = { ...this.state, connected: false, problem: `the Host speaks protocol ${m.protocol}` }
      this.socket?.end()
      return
    }
    this.deps.log(`unknown message from the Host: ${JSON.stringify(m).slice(0, 200)}`)
  }

  private fail(problem: string): void {
    this.state = { connected: false, protocol: null, hostVersion: null, startedAt: null, pid: null, problem }
    this.deps.log(problem)
  }
}
