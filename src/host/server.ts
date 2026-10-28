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
  HOST_FEATURE_PTY_SEQ,
  HOST_FEATURE_ORCH,
  HOST_FEATURE_REQUESTS,
  HOST_FEATURE_MCP,
  HOST_YIELD_ORCH_STATE_LATEST,
  ORCH_STATE_PUSH_MS,
  type ClientMessage,
  type HostMessage
} from '../core/host/protocol'
import { encodeLine, createLineReader } from './framing'
import type { HostLog } from './log'
import { sessionOfPresentedToken } from './gateway/tokens'
import { AppUnreachable, type OrchCall, type OrchCaller } from '../core/host/orchProtocol'
import { HOST_UNRESPONSIVE_MS } from '../core/host/unresponsive'
import { pidLives } from '../core/host/pidFile'
import { privateDirProblem } from '../core/host/socketDir'
import { appProofMatches, hostProof, newHostNonce } from '../core/host/hostKey'
import { mcpClientOf, mcpRemoteOf, type McpClient } from '../core/continuity/actor'

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
  role: 'app' | 'cli' | 'mcp'
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
  /** A socket has just proved it is the app (`app-proof`, sandbox follow-ups item 1), or a proved app said hello
   *  again (S6 D4). `send` reaches that socket alone, after the hello reply and the `app-proven` one, so what it sends is
   *  read with the features already known. Never called for a socket that has not proved it, a CLI, or a hello with
   *  no role. A throw is caught and logged, as `onAppsChanged`'s is. */
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
  /** `remote`: Remote is on, so the Host waits for controllers rather than leave idle (remote runtime N3). */
  liveCounts?(): { sessions: number; runs: number; remote?: boolean }
  /** Answers `orch-call` (design §5). Optional here only so a caller that never sends `orch-call`
   *  does not have to supply one; `host/index.ts` always does, because it always advertises
   *  HOST_FEATURE_ORCH below. */
  orch?: OrchCall
  /** The app session id of a live workload token (sandbox design §7), or null. An `orch-call` that carries a token is
   *  that session; one whose token this does not know is refused. */
  sessionOfToken?(token: string): string | null
  /** Whether a pid names a live process; defaults to `pidLives` (core/host/pidFile.ts). What
   *  `lastAppPid` probes with, injectable so a test's made-up pid is not judged by this machine. */
  pidLives?(pid: number): boolean
  /** The clock and timer the `orch-state` throttle runs on; `monotonicClock` when left out. **Monotonic
   *  on purpose** (review of T4): the wall clock steps back on an NTP correction or a resume from sleep,
   *  and a gap measured on it held a push for as long as the step. Injectable so a test can move time
   *  and fire the trailing push itself instead of waiting out real milliseconds. */
  stateClock?: StateClock
  /** The profile's Host key (core/host/hostKey.ts), made before this binds. A hello that carries a
   *  `nonce` is answered with its proof; without a key (tests that do not ask) no proof is sent. */
  hostKey?: string
  /** The profile's app key (core/host/hostKey.ts `readAppKeySync`), read when a socket answers its challenge, so a key
   *  the app made after this Host started is the one checked (sandbox follow-ups, item 1). At once, not awaited: the
   *  app's next messages are read right after its proof, and must find it the app. Absent or null, no socket can prove
   *  it is the app, and each is told so. */
  appKey?(): string | null
  /** The longest line a client may send, in characters; INBOUND_LINE_CAP when left out. A test passes a
   *  small one rather than writing 64 MiB. */
  maxLine?: number
  /** The Host process's boot id, in every hello; made once in index.ts (remote runtime design §3.2, N11). */
  bootId?: string
  /** What one client may leave unread before it is let go (performance audit H1): a client that stopped reading
   *  would otherwise hold every byte of output written to it in this process. 64 MiB when left out. */
  maxQueuedBytes?: number
  /** The same for the app, the one reader the Host must not lose (final review M3): a main thread that stalls falls
   *  behind every worker's output at once, and a cut socket costs a reconnect and a handover. 512 MiB when left out. */
  maxAppQueuedBytes?: number
}

/** Who a message the Host sends is for. **'app'**: only the Astera app reads it (src/main), so `broadcast` and
 *  `toOthers` send it to a proven app alone. A CLI reads the answers to its own calls only (cli/run.ts), an MCP client
 *  and the Gateway's link read `orch-result` and `pong`, and a hello that named the app and never proved it is a CLI
 *  still. Sent to one, terminal output and the whole state cost a parse of each in every waiting `astera` call, and the
 *  rest carry session ids, rolls and paths that only the app has a use for. **'any'**: a handshake message or the answer
 *  to a request, which goes to whoever asked.
 *
 *  Every kind of the protocol is placed here, so a new one fails tsc until someone decides which it is. Each 'app' kind
 *  was checked against src/cli (with src/cli/mcp), packages/client, src/pluginHost and the Gateway: none of them reads
 *  it; they read `orch-result`, `pong` and `retire-refused` only. */
const HOST_MESSAGE_AUDIENCE: Record<HostMessage['t'], 'app' | 'any'> = {
  'orch-state': 'app',
  'orch-act': 'app',
  'pty-data': 'app',
  'pty-exit': 'app',
  'pty-size': 'app',
  'pty-opened': 'app',
  'proc-line': 'app',
  'proc-opened': 'app',
  'proc-exit': 'app',
  'git-op': 'app',
  'worktrees-state': 'app',
  'understanding-state': 'app',
  'work-units-state': 'app',
  'mcp-http-state': 'app',
  'gateway-state': 'app',
  'work-units-goal-ignored': 'app',
  'roll-state': 'app',
  'chat-notice': 'app',
  'session-rolled': 'app',
  'blocks': 'app',
  'driver': 'app',
  'workspace': 'app',
  'hello': 'any',
  'protocol-mismatch': 'any',
  'retire-refused': 'any',
  'pong': 'any',
  'app-proven': 'any',
  'orch-result': 'any',
  'pty-spawned': 'any',
  'pty-failed': 'any',
  'pty-listed': 'any',
  'proc-spawned': 'any',
  'proc-failed': 'any',
  'proc-attached': 'any',
  'proc-listed': 'any'
}
/** The kinds `broadcast` and `toOthers` keep from every socket but the proven app (above). */
export const NOT_FOR_CLI: ReadonlySet<string> = new Set(
  (Object.keys(HOST_MESSAGE_AUDIENCE) as Array<HostMessage['t']>).filter((t) => HOST_MESSAGE_AUDIENCE[t] === 'app')
)
const MAX_QUEUED_BYTES = 64 * 1024 * 1024
const MAX_APP_QUEUED_BYTES = 512 * 1024 * 1024

/** What the `orch-state` throttle measures gaps with and waits on. `after` returns its cancel. */
export interface StateClock {
  now(): number
  after(ms: number, fn: () => void): () => void
}

/** `performance.now()`, which never steps back, and an unref'd timer: a held push is not a reason to
 *  keep the Host up. */
export const monotonicClock: StateClock = {
  now: () => performance.now(),
  after: (ms, fn) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return () => clearTimeout(t)
  }
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
  /** The caller of a `cli` command that did not come over a socket: the Gateway's loopback route (sandbox design §6). */
  cliCaller(): OrchCaller
  /** The Host's hello for a client on the loopback route, with the proof of `nonce` (see `helloBody`). */
  loopbackHello(nonce: string): { host: string; pid: number; startedAt: string; features: string[]; proof?: string }
  /** Sends to every connected client. Slice 2's pty output takes this rather than a reply, because
   *  the app that attaches after a restart is not the app that spawned. With `to`, only to the greeted
   *  sockets whose hello yields pass it (final review M4: a push only a newer app can read). */
  broadcast(m: HostMessage, to?: (yields: ReadonlySet<string>, features: ReadonlySet<string>) => boolean): void
  /** Whether an app is connected right now (design §5): a socket that said `role: 'app'` and proved it (`app-proof`,
   *  sandbox follow-ups item 1). It does its own work, so the Host does not drive, roll or open Slack beside it (S6-6,
   *  SL-11). A hello with no role is a CLI here: an app 1.3.25 or older speaks protocol 3 at another address and never
   *  reaches this Host, and presence is trusted like the rest of the role. */
  hasApp(): boolean
  /** The same question as `hasApp` since the no-role path became a CLI (sandbox follow-ups, item 1); kept, as callers
   *  ask it for the pushes only a current app reads (`session-rolled`, `blocks`, `orch-state`). */
  hasCurrentApp(): boolean
  /** Asks the app to do one thing the Host cannot (design §5) — one `orch-act` out, one `orch-acted`
   *  back, matched by call id. Only a socket that proved it is the app is asked; with none the call is refused at
   *  once with APP_REQUIRED.
   *  Rejects when no app is attached, when the app answers `ok: false`,
   *  when the app disconnects with the question still open, and when it stays connected and says
   *  nothing for HOST_UNRESPONSIVE_MS: a caller waiting on an answer that cannot arrive is the one
   *  outcome worse than a refusal. */
  act(name: string, args: unknown): Promise<unknown>
  /** An app is attached and its hello did not yield `duty`: that app still does it itself (ruling R4).
   *  The first app `act` asks. */
  appKeeps(duty: string): boolean
  /** Any attached app — not just the first — has not yielded `duty` (ruling R1): one S3 app among
   *  several is enough to keep the Host from driving that duty. */
  appsKeep(duty: string): boolean
  /** Whether any greeted app yielded `duty`: the reverse question of `appsKeep`. The agent workspace
   *  asks it before capturing a frame, since only an app that yields `workspace` reads one. */
  appsYield(duty: string): boolean
  /** The yields a greeted socket declared in its hello, or null once it is gone or never greeted (S6
   *  R1). By the socket number `onMessage` and `onClientGone` hand out, which is what `exits.holdersOf`
   *  names. Whatever role the socket has. */
  yieldsOf(socketNo: number): ReadonlySet<string> | null
  /** The pid the last app to say hello gave (`hello.pid`, leftovers Task 1), or null when none did. Kept
   *  after that socket closes: it is what `liveAppPid` asks about when `app.pid` names no live app, and
   *  the question matters most once the app's socket is down. Only from the hello of a socket that proved it is the
   *  app on this protocol, kept once it proved, and only a positive integer.
   *
   *  **Latched, so pid reuse cannot keep a gone app alive** (final review I1). Every call probes the pid,
   *  and the first probe that finds it dead forgets it: a process Windows later hands the same number is
   *  not that app. **A close forgets nothing**: an app that gave up on a stalled Host closes its socket
   *  cleanly and lives on, and when it also could not write app.pid this pid is all that says it is
   *  there, the case the fallback exists for. The driving tick asks while no app is attached, so the forgetting does not wait for the next
   *  worktree removal, which may come after the number has been reused. */
  lastAppPid(): number | null
  /** How many sockets the number index behind `yieldsOf` holds: every connection, greeted or not,
   *  until it closes. For the tests: `yieldsOf` answers null for a closed socket either way, so only
   *  this count shows the index forgetting it, and an index that did not would grow by one for every
   *  CLI call for as long as the Host lives. */
  knownSockets(): number
}

/** What `astera host status` shows when a Host's hello says `legacyApp` (leftovers Task 5): an older Host of this
 *  protocol counted a hello with no role as an app 1.3.25 or older. **This Host never says it** (sandbox follow-ups,
 *  item 1): such an app speaks protocol 3 at another address and cannot reach a protocol-4 Host, and a hello with no
 *  role is a CLI here, so nothing unproven counts as an attached app. */
export const LEGACY_APP_NOTICE = 'Astera 1.3.25 or older is attached; update it'

/** How long a peer that has connected but said nothing gets before the Host hangs up on it. */
const HANDSHAKE_MS = 10_000

/** The longest line a local client may send (remote runtime design §3.1, DC-5). Large enough for a
 *  whole-state `state-put` of a big profile (measured above 9 MB, X1-10), small enough that a sender
 *  that never ends its line cannot grow the Host's memory without bound. Over it the socket is closed. */
export const INBOUND_LINE_CAP = 64 * 1024 * 1024

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
    // The same question every client asks before connecting (core/host/socketDir.ts)
    const st = await fs.lstat(deps.dirToPrepare)
    const problem = privateDirProblem(st, process.getuid?.())
    if (problem !== null) {
      deps.log.write(`${deps.dirToPrepare} is not a directory only this user can open (${problem}) — not serving there`)
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
  /** What each greeted socket is. Kept beside `greetedSockets` rather than inside the
   *  set's element because the set is what `broadcast` walks and that must not change shape.
   *  A socket that is in `greetedSockets` is always in here too — both are written in one place.
   *  **`'app'` only once proved** (sandbox follow-ups, item 1): a hello naming the app makes the socket a `'cli'` with
   *  a challenge open (`challenges`), and its `app-proof` makes it the app. Every door only the app may use reads this:
   *  the spawns (`onMessage`'s role), `orch-act`, `orch-call`'s caller (who is the person in the records), presence,
   *  the yields that count, the state pushes and `onAppGreeted`. A hello with no role is a `'cli'`. */
  const roles = new Map<net.Socket, 'app' | 'cli' | 'mcp'>()
  /** What each greeted socket's first hello named, which a second hello may not change (N12): a socket that named the
   *  app is a `'cli'` in `roles` until it proves, and is still one that named the app. Written and deleted beside
   *  `roles`. */
  const named = new Map<net.Socket, 'app' | 'cli' | 'mcp'>()
  /** The challenge open on each socket that named the app and has not proved it, with the pid its hello gave
   *  (`lastAppPid` keeps it once proved). Random per connection and taken by the first `app-proof`, whatever it holds,
   *  so an answer is good on the connection it was asked on, once. */
  const challenges = new Map<net.Socket, { challenge: string; pid: number | null }>()
  /** The role the hooks and the command layer hear. */
  const outwardRole = (s: net.Socket): 'app' | 'cli' | 'mcp' => roles.get(s) ?? 'cli'
  /** `lastAppPid`: the pid of the last app hello that carried one, until a probe finds it dead (see
   *  `HostServer.lastAppPid`). */
  let lastAppPid: number | null = null
  const probePid = deps.pidLives ?? pidLives
  /** What each greeted socket's hello yielded to this Host (`hello.yields`, ruling R4). Written and
   *  deleted beside `roles`, for the same reason it is kept beside the set rather than inside it. */
  const yields = new Map<net.Socket, ReadonlySet<string>>()
  /** What each greeted socket's hello listed in `features` (`pty-seq`, remote runtime design §3.7). */
  const features = new Map<net.Socket, ReadonlySet<string>>()
  /** The MCP client each `mcp` socket's hello named, cleaned on arrival (MCP spec §29). Written and
   *  deleted beside `roles`; a socket of any other role never has one. */
  const mcpClients = new Map<net.Socket, McpClient>()
  /** The HTTP caller's address each `mcp` socket's hello named, cleaned on arrival (MCP HTTP design §5).
   *  Kept beside `mcpClients`, the same way; a stdio `mcp` socket never has one. */
  const mcpRemotes = new Map<net.Socket, string>()
  /** Every connected socket by its number, so `yieldsOf` can answer for the number `exits` keeps.
   *  Set when the number is handed out and deleted in `gone`. */
  const socketByNo = new Map<number, net.Socket>()
  let socketSeq = 0
  /**
   * **The `orch-state` push held for each client that reads the latest** (stage 3 T4).
   *
   * Every commit pushes the whole state, and it grows with every Run the file keeps; a burst of
   * commits — a worker's report, the dispatch it frees, the next Task's start — sent it whole each
   * time, and the app parsed and folded each one on its main thread. A client that says it reads
   * `orch-state` as "the latest" (HOST_YIELD_ORCH_STATE_LATEST; a CLI is sent none of
   * them) is sent the first push at once and after that at most one per ORCH_STATE_PUSH_MS, always
   * the newest. What is skipped is only ever a state a newer one replaces: each push carries the
   * whole state and its version, so the mirror that takes the newest takes everything.
   *
   * **A held push never falls behind anything that follows it** (`writeTo`): before any other
   * message to that socket, the held push goes first. A reply to a call whose commit is held, an
   * `orch-act` about a Dispatch just opened, a `pty-opened` for the worker it started — each is read
   * against the mirror, and each still finds its state there. Only terminal output (`pty-data`,
   * `proc-line`) passes it: it is bytes for a screen, and flushing on it would push on every line.
   *
   * `line` is encoded when it is sent, not when it is held, so a push that is replaced was never
   * serialised at all.
   */
  const clock = deps.stateClock ?? monotonicClock
  const stateLanes = new Map<net.Socket, { held: (() => string) | null; lastAt: number; cancel: (() => void) | null }>()
  // A CLI, or an app that has not proved itself, is not here: it is sent no `orch-state` at all (NOT_FOR_CLI)
  const readsLatest = (s: net.Socket): boolean =>
    roles.get(s) === 'app' && (yields.get(s)?.has(HOST_YIELD_ORCH_STATE_LATEST) ?? false)
  const laneOf = (s: net.Socket): { held: (() => string) | null; lastAt: number; cancel: (() => void) | null } => {
    let lane = stateLanes.get(s)
    if (!lane) {
      lane = { held: null, lastAt: -Infinity, cancel: null }
      stateLanes.set(s, lane)
    }
    return lane
  }
  /** Sends what is held for `s`, if anything, now. */
  const flushState = (s: net.Socket): void => {
    const lane = stateLanes.get(s)
    if (!lane) return
    lane.cancel?.()
    lane.cancel = null
    const held = lane.held
    if (!held) return
    lane.held = null
    lane.lastAt = clock.now()
    if (!s.destroyed) {
      s.write(held())
      overBudget(s)
    }
  }
  /** Forgets what is held for `s` without sending it — the sender of a `state-put` holds newer. */
  const dropState = (s: net.Socket): void => {
    const lane = stateLanes.get(s)
    if (!lane) return
    lane.cancel?.()
    lane.cancel = null
    lane.held = null
  }
  /** One `orch-state` for one socket: at once, or held as the newest until the gap has passed. */
  const pushState = (s: net.Socket, line: () => string): void => {
    if (s.destroyed) return
    if (!readsLatest(s)) {
      s.write(line())
      overBudget(s)
      return
    }
    const lane = laneOf(s)
    const now = clock.now()
    const since = now - lane.lastAt
    if (!lane.cancel && since >= ORCH_STATE_PUSH_MS) {
      lane.held = null
      lane.lastAt = now
      s.write(line())
      overBudget(s)
      return
    }
    lane.held = line
    if (lane.cancel) return
    // **Clamped to the gap, whatever the clock says** (review of T4). The clock is monotonic, so
    // `since` should never be negative; if it ever were, a wait of `gap - since` would hold this push
    // for as long as the clock jumped, and a quiet app would show a stale state all that time.
    const wait = Math.min(ORCH_STATE_PUSH_MS, Math.max(0, ORCH_STATE_PUSH_MS - since))
    lane.cancel = clock.after(wait, () => {
      lane.cancel = null
      // Caught: a timer's throw is uncaught, and it would end the Host with every pty it holds.
      try {
        flushState(s)
      } catch (err) {
        deps.log.write(`a held orch-state push failed: ${String(err)}`)
      }
    })
  }
  /** Every message to a socket goes through here, so nothing overtakes a held `orch-state`. */
  const queueCap = deps.maxQueuedBytes ?? MAX_QUEUED_BYTES
  const appQueueCap = deps.maxAppQueuedBytes ?? MAX_APP_QUEUED_BYTES
  const writeTo = (s: net.Socket, m: HostMessage, line: () => string): void => {
    if (s.destroyed) return
    if (m.t === 'orch-state') return pushState(s, line)
    if (m.t !== 'pty-data' && m.t !== 'proc-line') flushState(s)
    s.write(line())
    overBudget(s)
  }
  /** A client that reads nothing is let go before its unread output is this process's problem (audit H1), state pushes
   *  included (second pass H2-5). */
  function overBudget(s: net.Socket): void {
    if (s.writableLength > (roles.get(s) === 'app' ? appQueueCap : queueCap)) {
      deps.log.write(`a client left ${s.writableLength} bytes unread; closing it`)
      s.destroy()
    }
  }
  /** `encodeLine` once, on first use, for a message that may go to several sockets or to none. */
  const lazyLine = (m: HostMessage): (() => string) => {
    let line: string | null = null
    return () => (line ??= encodeLine(m))
  }
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
  /** A socket that proved it is the app, still open. */
  const isApp = (s: net.Socket): boolean => roles.get(s) === 'app' && !s.destroyed
  /** An MCP client reads only the answers to its own calls (MCP design §2), so no fan-out writes to
   *  it: an MCP link lives for hours, and every terminal's output and every state push would reach it. */
  const isMcp = (s: net.Socket): boolean => roles.get(s) === 'mcp'
  /** What a `hello` answers, for the pipe and for the loopback route's hello (`loopbackHello`): the same facts and the same
   *  proof, so a client checks one Host in both places. */
  const helloBody = (nonce: unknown) => ({
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
    // HOST_FEATURE_MCP too: the MCP gate lives in `createHostOrch`, so it rides the same condition.
    features: [
      HOST_FEATURE_PROC,
      HOST_FEATURE_PING,
      HOST_FEATURE_PTY_SEQ,
      ...(deps.orch ? [HOST_FEATURE_ORCH, HOST_FEATURE_REQUESTS, HOST_FEATURE_MCP] : []),
      ...(deps.features ?? [])
    ],
    // Protocol 4: the answer that tells this account's Host from a squatter (core/host/hostKey.ts).
    // A nonce longer than any client sends is not worth hashing.
    ...(deps.hostKey && typeof nonce === 'string' && nonce.length > 0 && nonce.length <= 256
      ? { proof: hostProof(deps.hostKey, nonce) }
      : {}),
    ...(deps.bootId ? { bootId: deps.bootId } : {})
  })
  /** The `OrchCaller` of a command's sender, whichever way it came: a pipe socket, or the Gateway's loopback route (which
   *  has no socket). `toOthers` reaches every greeted socket except the sender's own, so a loopback caller's reaches all of
   *  them: the state it changed came from no socket that already holds it. */
  const orchCaller = (a: { role: 'app' | 'cli' | 'mcp'; socket?: net.Socket; socketNo?: number; client?: { name: string; version?: string }; remote?: string }): OrchCaller => ({
    role: a.role,
    ...(a.socketNo !== undefined ? { socket: a.socketNo } : {}),
    ...(a.client ? { client: a.client } : {}),
    ...(a.remote ? { remote: a.remote } : {}),
    toOthers: (msg) => {
      const line = lazyLine(msg)
      // The sender holds this state already; anything older held for it would put it back.
      if (a.socket && msg.t === 'orch-state') dropState(a.socket)
      const appOnly = NOT_FOR_CLI.has(msg.t)
      for (const s of greetedSockets) {
        if (s === a.socket || s.destroyed || isMcp(s)) continue
        // broadcast's rule: what only the app reads goes to a proven app alone
        if (appOnly && roles.get(s) !== 'app') continue
        writeTo(s, msg, line)
      }
    }
  })
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
      if (live === 0 && held.sessions === 0 && held.runs === 0 && held.remote !== true) {
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
    const send = (m: HostMessage): void => writeTo(socket, m, lazyLine(m))
    /** An `app-proof` (sandbox follow-ups, item 1): the HMAC of this connection's challenge under the profile's app key
     *  makes the socket the app. The challenge is taken by this try whatever it holds. A wrong or missing proof is
     *  logged and answered, and the socket stays what it was, open: the app is told rather than cut off. */
    const proveApp = (proof: unknown): void => {
      const open = challenges.get(socket)
      challenges.delete(socket)
      const refuse = (reason: string): void => {
        deps.log.write(`a socket did not prove it is the app (${reason}) — it stays ${isApp(socket) ? 'the app it proved to be before' : 'a CLI'}`)
        send({ t: 'app-proven', ok: false, reason })
      }
      if (!open) return refuse('no challenge is open on this connection')
      let key: string | null = null
      try {
        key = deps.appKey?.() ?? null
      } catch (err) {
        deps.log.write(`the app key could not be read: ${String(err)}`)
      }
      if (key === null) return refuse('this Host has no app key to check it against')
      if (!appProofMatches(key, open.challenge, proof)) return refuse("the proof does not match this profile's app key")
      roles.set(socket, 'app')
      if (open.pid !== null) lastAppPid = open.pid
      deps.log.write('the app proved it is the app')
      tellAppsChanged()
      send({ t: 'app-proven', ok: true })
      try {
        deps.onAppGreeted?.(send)
      } catch (err) {
        deps.log.write(`onAppGreeted failed: ${String(err)}`)
      }
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
          // **A socket keeps the role its first hello named** (remote runtime Phase 0, N12). A second hello
          // naming another one is refused, unanswered: an MCP socket that turned itself into the app would
          // be sent `orch-act`, count as attached and reach the pty messages its role keeps it from. One
          // naming the same role is answered as it always was.
          // A hello with no role is a CLI (`roles`): the careful default protocol.ts names for an absent role.
          const asked = m.role === 'app' ? 'app' : m.role === 'mcp' ? 'mcp' : 'cli'
          const had = greetedSockets.has(socket) ? named.get(socket) : undefined
          if (had !== undefined && had !== asked) {
            deps.log.write(`a second hello asked to change this socket's role from ${had} to ${asked} — refused`)
            return
          }
          deps.log.write(`client ${String(m.app)} connected`)
          // Only here, past the protocol check: a client on another protocol has been told so and is
          // owed nothing else. The address's version suffix exists to keep this protocol's messages
          // away from an app that cannot read them (core/host/protocol.ts), and broadcasting to one
          // that just announced a different number would walk around that.
          greetedSockets.add(socket)
          named.set(socket, asked)
          // **The app is a CLI until it proves it** (sandbox follow-ups, item 1): a socket that names the app is
          // answered with a challenge of this connection, and becomes the app at its `app-proof`. One that proved
          // already stays the app through a second hello.
          const wasApp = isApp(socket)
          roles.set(socket, asked === 'app' ? (wasApp ? 'app' : 'cli') : asked)
          // Junk entries are dropped rather than refused: a hello is not the place to turn a client
          // away over a field that only ever narrows what it keeps.
          yields.set(socket, new Set(Array.isArray(m.yields) ? m.yields.filter((x): x is string => typeof x === 'string') : []))
          features.set(socket, new Set(Array.isArray(m.features) ? m.features.filter((x): x is string => typeof x === 'string') : []))
          // The client names itself, so it is cleaned here whatever the sender did (never trust the wire).
          const client = roles.get(socket) === 'mcp' ? mcpClientOf(m.client) : undefined
          if (client) mcpClients.set(socket, client)
          else mcpClients.delete(socket)
          const remote = roles.get(socket) === 'mcp' ? mcpRemoteOf(m.remote) : undefined
          if (remote) mcpRemotes.set(socket, remote)
          else mcpRemotes.delete(socket)
          const pid = typeof m.pid === 'number' && Number.isSafeInteger(m.pid) && m.pid > 0 ? m.pid : null
          if (isApp(socket) && pid !== null) lastAppPid = pid
          // A fresh one for each hello of an app not yet proved: whatever was open before is taken back.
          const challenge = asked === 'app' && !isApp(socket) ? newHostNonce() : null
          if (challenge !== null) challenges.set(socket, { challenge, pid })
          else challenges.delete(socket)
          if (isApp(socket) || wasApp) tellAppsChanged()
          send({ t: 'hello', ...helloBody(m.nonce), ...(challenge !== null ? { challenge } : {}) })
          if (isApp(socket)) {
            try {
              deps.onAppGreeted?.(send)
            } catch (err) {
              deps.log.write(`onAppGreeted failed: ${String(err)}`)
            }
          }
          return
        }
        // **An MCP socket may send `hello`, `ping` and `orch-call`, and nothing else** (MCP design §2).
        // Placed after the hello branch and before every other one, so `retire`, `orch-acted` and the
        // pty and proc messages `onMessage` serves are all out of its reach, not only the ones listed
        // today. Dropped, not answered: it is not a client of those.
        if (roles.get(socket) === 'mcp' && m?.t !== 'ping' && m?.t !== 'orch-call') {
          deps.log.write(`an MCP socket sent ${String(m?.t)} — dropped`)
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
          const client = mcpClients.get(socket)
          const remote = mcpRemotes.get(socket)
          const from = orchCaller({ role: outwardRole(socket), socket, socketNo, client, remote })
          // A token names the session, not the `session` field, which any process on the pipe can write. A Host with no
          // token table cannot vouch for one, so it refuses it too.
          let sessionId = m.session ?? ''
          if (m.token !== undefined) {
            // A token that is no string, or longer than any this Host made, is refused outright (sessionOfPresentedToken).
            const owner = sessionOfPresentedToken(deps.sessionOfToken, m.token)
            if (owner === null) {
              send({ t: 'orch-result', call: m.call, status: 401, body: { error: 'workload token not recognised' } })
              return
            }
            sessionId = owner
          }
          void deps.orch
            .call({ cmd: m.cmd, args: m.args, sessionId, from, request: m.request })
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
        // **Nothing past this point for a socket that has not said hello** (remote runtime Phase 0, N12).
        // `orch-call` and `orch-acted` above already refused it; the pty and proc messages `onMessage`
        // serves did not, so a peer that never greeted could write into a terminal or spawn one. `retire`
        // stays above on purpose: protocol-mismatch replacement sends it with no hello (X1-04).
        if (!greetedSockets.has(socket)) {
          deps.log.write(`a socket that has not said hello sent ${String(m?.t)} — dropped`)
          return
        }
        if (m?.t === 'app-proof') {
          proveApp(m.proof)
          return
        }
        if (deps.onMessage?.(m, send, { role: outwardRole(socket), socket: socketNo, greeted: true }) === true) return
        deps.log.write(`unknown message: ${JSON.stringify(v).slice(0, 200)}`)
      },
      onBadLine: (raw) => deps.log.write(`line that is not JSON, ignored: ${raw.slice(0, 200)}`),
      onHandlerError: (v, err) =>
        deps.log.write(`message failed: ${JSON.stringify(v).slice(0, 200)} — ${String(err)}`),
      maxLine: deps.maxLine ?? INBOUND_LINE_CAP,
      onOverflow: () => {
        deps.log.write(`a line ran past the inbound cap of ${deps.maxLine ?? INBOUND_LINE_CAP} characters — closing that connection`)
        socket.destroy()
      }
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
      const wasApp = roles.get(socket) === 'app'
      const role = outwardRole(socket)
      roles.delete(socket)
      named.delete(socket)
      challenges.delete(socket)
      yields.delete(socket)
      features.delete(socket)
      mcpClients.delete(socket)
      mcpRemotes.delete(socket)
      dropState(socket)
      stateLanes.delete(socket)
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
    cliCaller: () => orchCaller({ role: 'cli' }),
    loopbackHello: (nonce) => helloBody(nonce),
    clients: () => live,
    hasApp: () => appSocket() !== null,
    hasCurrentApp: () => appSocket() !== null,
    // The same "first app socket" `act` sends to: the app that keeps a duty is the one that would be
    // asked to do it.
    appKeeps: (duty) => {
      const s = appSocket()
      return s !== null && !(yields.get(s)?.has(duty) ?? false)
    },
    appsKeep: (duty) => [...greetedSockets].some((s) => isApp(s) && !(yields.get(s)?.has(duty) ?? false)),
    appsYield: (duty) => [...greetedSockets].some((s) => isApp(s) && (yields.get(s)?.has(duty) ?? false)),
    yieldsOf: (socketNo) => {
      const s = socketByNo.get(socketNo)
      if (!s || s.destroyed || !greetedSockets.has(s)) return null
      return yields.get(s) ?? null
    },
    knownSockets: () => socketByNo.size,
    lastAppPid: () => {
      if (lastAppPid !== null && !probePid(lastAppPid)) lastAppPid = null
      return lastAppPid
    },
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
        const ask: HostMessage = { t: 'orch-act', call, act: name, args }
        writeTo(sock, ask, lazyLine(ask))
      }),
    broadcast: (m, to) => {
      const line = lazyLine(m)
      const notForCli = NOT_FOR_CLI.has(m.t)
      for (const s of greetedSockets) {
        if (s.destroyed || isMcp(s)) continue
        if (notForCli && roles.get(s) !== 'app') continue
        if (to && !to(yields.get(s) ?? new Set<string>(), features.get(s) ?? new Set<string>())) continue
        writeTo(s, m, line)
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
        for (const s of [...stateLanes.keys()]) dropState(s)
        stateLanes.clear()
        sockets.clear()
        greetedSockets.clear()
        roles.clear()
        named.clear()
        challenges.clear()
        yields.clear()
        mcpClients.clear()
        mcpRemotes.clear()
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
