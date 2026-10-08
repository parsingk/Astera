// The Host's orchestration: the real command layer over the real store (host control plane design
// §5, §6). This is what replaces the wire slice's `version`-only stub — `server.ts` calls
// `OrchCall.call` and did not change when it did.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { jobsViewOf, runsTimelineOf, type RuntimeFacts } from './remoteReads'
import { handleCommand, handleExit, type OrchServerDeps } from '../core/orchestration/command'
import { OrchestrationStore, isValidState, type OrchLoadResult } from '../core/orchestration/store'
import { applyPendingReports, readPendingReports, type QueuedReport } from '../core/orchestration/pendingDrain'
import { dispatchesHeldOnlyByReport, pendingReportsDirIn, reportedDispatchIdsOf } from '../core/orchestration/pendingReports'
import { writeOffDispatch, type OrchState } from '../core/orchestration/state'
import { runningRunCount } from '../core/orchestration/running'
import { isPlaceholderSessionId } from '../core/orchestration/types'
import { sweepStaleSpecFiles } from '../core/orchestration/exec/specFiles'
import { coordinatorReleaseOf } from '../core/orchestration/exec/releaseDefer'
import type { OrchCall, OrchCaller } from '../core/host/orchProtocol'
import { mcpRefusal } from '../core/host/mcpGate'
import { controllerRefusal } from '../core/host/controllerGate'
import { sanitizeForController } from '../core/remote/sanitize'
import type { GatewayState } from '../core/remote/gatewayState'
import type { ControllerRegistry } from './controllers'
import { readMcpAccess } from '../core/settings/mcpAccess'
import { readMcpSessions } from '../core/settings/mcpSessions'
import { readMcpGithubWrite } from '../core/settings/mcpGithubWrite'
import { HOST_CALLER, type Driver } from '../core/host/driver'
import { hostOrchDeps } from './orchDeps'
import { createCheckWaits } from '../core/orchestration/checkWaits'
import { readAccountsFile } from '../core/accounts/accountsFile'
import { isLoggedIn } from '../core/accounts/loginCheck'
import { makeDescriptors } from '../core/providers/descriptor'
import type { Account } from '../core/types'
import { readRunConfigsFile } from '../core/run/runConfigsFile'
import type { HostChecks } from './checks'
import type { HostSessions } from './sessions'
import type { HostLocal } from './spawner'
import type { HostRolling } from './rolling'
import type { HostChats } from './hostChats'
import type { RollJournal } from './rollJournal'
import type { HostSlackWiring } from './slackWiring'
import type { McpHttpSupervisor } from './mcpHttp'
import { WORKTREE_CALLS, type HostWorktrees } from './worktrees'
import type { HostJournal } from './hostJournal'
import { NOT_WRITER, type HostUnderstanding } from './hostUnderstanding'
import type { HostWorkUnits } from './hostWorkUnits'
import { ensureProject, findProject } from '../core/orchestration/projects'
import type { SessionWorkUnit } from '../core/workUnit/types'
import { justFinished, runRecordInputOf } from '../core/orchestration/runRecord'
import type { WorkspaceManager } from './workspace/manager'
import { DESKTOP_ACTOR, HOST_ACTOR, actorOf, type JournalActor } from '../core/continuity/actor'
import { parseJournalOps } from '../core/continuity/journalOps'

/** One reply — today's HTTP status and body, the shape `OrchCall.call` already answers with. Named
 *  only because the receipt store below holds one. */
type Reply = { status: number; body: unknown }

/** What a request id may look like (request receipts design §5). **Not a UUID**: Orca validates one
 *  in its client and enforces nothing in its runtime, and its own federation code writes ids that
 *  would fail that check — a rule that exists in one place and is broken in another. What is enforced
 *  is only what the store needs to stay safe: the map key is the session id and the request id joined
 *  by a NUL, so a NUL inside the id would forge another session's scope, and the rest of the control
 *  characters go with it because an id is written into logs and into messages a person reads. */
const REQUEST_ID_MAX = 200
const hasControlChar = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}
/** Why a request id cannot be used, or `null`. **Both ends of the store ask this and get the same
 *  sentence**: the claim that writes a receipt, and `requests-show`, which reads one. Reading is not
 *  the harmless half — the map key is the session id and the request id joined by a NUL, so a NUL in
 *  the id read back could name a receipt belonging to a session whose own id carries one. */
const badRequestId = (id: string): string | null =>
  id.length === 0 || id.length > REQUEST_ID_MAX || hasControlChar(id)
    ? `bad request id: it must be 1 to ${REQUEST_ID_MAX} characters with no control characters`
    : null

/**
 * **What the fingerprint refuses to look at, and why each one** (request receipts design §5, §12/6).
 *
 * The principle is Orca's and it is one line: *exclude what changes how long we wait, never what
 * changes what we do.*
 *
 * - **`requestId`** because it is the key. It never reaches here through `args` today — the CLI lifts
 *   it onto the envelope — but a client that put it in `args` as well would otherwise fingerprint the
 *   id into the hash of the call the id names.
 * - **`timeoutMs`** because a caller that retries with a longer deadline is asking the same thing
 *   with more patience. Refusing that would make the id useless for exactly the commands that lose
 *   answers most, the ones that wait.
 *
 * Whether the set is exactly these two is a question about how agents really retry, and the only way
 * to learn it is to ship and watch: a mismatch is loud by design (400, and it names the command),
 * which is what makes this safe to calibrate in the open.
 */
const FINGERPRINT_BLIND = new Set(['requestId', 'timeoutMs'])

/** Object keys sorted, `undefined` dropped, **arrays left in the order they came**. Order inside an
 *  array is the caller's statement — `ask --options` is a list a person will be shown — so reordering
 *  one is a different call, while the order the keys of an object happen to be written in is not. */
const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical)
  if (v === null || typeof v !== 'object') return v
  const held = v as Record<string, unknown>
  // **`Object.create(null)`, and that is a correctness fix rather than a style.** `JSON.parse` does
  // create an own `__proto__` key, and assigning one into a plain `{}` hits the prototype setter
  // instead: the key would vanish from the hash, and two different argument payloads would fingerprint
  // alike — which is the one thing this function must never do.
  const out = Object.create(null) as Record<string, unknown>
  for (const k of Object.keys(held).sort()) if (held[k] !== undefined) out[k] = canonical(held[k])
  return out
}

/**
 * **What this id was used for, as one string** (request receipts design §5).
 *
 * A receipt hands back a recorded response, so an id used for a second, different call must be
 * refused rather than answered — two scripts that both pick `req-1` get an error instead of each
 * other's answers. Auto-minting (§8) narrows what this has to defend without removing the need for
 * it: a minted id is a UUID and never collides, so what is left here is exactly the ids a caller
 * chose deliberately, which are the ones that collide.
 *
 * The command name is inside the hash rather than compared separately, because "the same arguments
 * to a different command" is the same fault as "different arguments" and deserves the same sentence.
 */
export const fingerprintOf = (cmd: string, args: Record<string, unknown>): string => {
  // Null-prototype for `canonical`'s reason — an own `__proto__` at the top level would disappear the
  // same way.
  const kept = Object.create(null) as Record<string, unknown>
  for (const k of Object.keys(args)) if (!FINGERPRINT_BLIND.has(k)) kept[k] = args[k]
  return createHash('sha256').update(JSON.stringify([cmd, canonical(kept)])).digest('hex')
}

/**
 * **The honest reading of each answer, shipped with the answer** (request receipts design §6). Copied
 * from Orca, whose comment is the argument: `absent` is genuinely ambiguous, "so the honest reading
 * ships with the row instead of being re-derived (and softened) by every caller".
 *
 * **And so the guide cannot drift from the runtime.** Orca's guide and Orca's runtime disagree about
 * `pending` today — the guide says to replay it, the runtime refuses — because the sentence was
 * written twice. Here it is written once, the guide quotes it with `<requestId>` and `<command>` where
 * a real answer carries values, and a test in `orch.test.ts` reads the guide and checks that the three
 * sentences are still in it. Exported for that test: it is the only reader outside this file.
 */
export const interpretationOf = {
  completed: (id: string, cmd: string): string =>
    `Request ${id} already took effect (${cmd}). The recorded response is what this Host answered the first time. ` +
    `Treat it exactly as if you had received it then: the ids in it name things that exist. ` +
    `Do not send the command again.`,
  /** **Exit 6, not 409, and the design says so** (§6: "if you do, it is refused with `6` and the same
   *  message"). The status on the wire really is 409, but everybody who reads this sentence reads it
   *  through the CLI, where what they see is an exit code — and the guide quotes this sentence, so an
   *  HTTP number here puts HTTP into a document whose readers have no other use for it. */
  pending: (id: string, cmd: string): string =>
    `Request ${id} is running on this Host right now (${cmd}). Nothing is lost and nothing is decided: wait and ask again. ` +
    `Do not send the command again, because a second attempt while this one is in flight is refused with exit 6.`,
  absent: (id: string): string =>
    `This Host holds no receipt for request ${id} under your caller identity, and that is not proof that nothing happened. ` +
    `There are four ways to see it and only one of them means nothing happened: the request never reached a Host, and retrying is correct; ` +
    `it reached a Host that has since restarted, which comparing hostStartedAt with the time you sent it will tell you; ` +
    `you are asking under a different session than the one that sent it; ` +
    `or the command changed nothing, so there was nothing to record and retrying gets the same answer. ` +
    `Before retrying, look at the state rather than at the receipt, because the state is the only record that survives everything.`
}

/**
 * **How much of what this Host has answered it keeps** (request receipts design §4, §12/4).
 *
 * **The policy is decided and only the numbers are calibration**: evict, never refuse. Orca's
 * `mutation_ledger_full` refuses to start a new mutation while its table is full of unresolved
 * claims, and that is the one behaviour of theirs this design will not ship at any size —
 * bookkeeping that refuses real work is a worse failure than the one it guards against. Nothing
 * below is ever consulted before a command runs; the sweep only takes things out afterwards.
 *
 * - **200 completed receipts per caller.** A coordinator issuing a few acting commands a minute
 *   fills that in about the hour the TTL gives it, so the two caps bind at roughly the same place.
 *   The shared `''` bucket (every caller with no `ASTERA_SESSION`: a person at a shell, a CI job, a
 *   worker whose environment was never planted) holds 200 *between* them, which §4 already names as
 *   the first thing to look at when these numbers are set against a measurement.
 * - **One hour.** The longest call this Host takes is `runs wait`, at an hour, so a receipt outlives
 *   the call that made it.
 * - **2000 across all callers.** The per-caller cap bounds each bucket and not their number, and a
 *   Host that is up for a fortnight meets a new session id every time the app restarts. Ten full
 *   buckets is the ceiling: reachable only by ten busy callers at once, and worth a few megabytes.
 *   §12/5 worries about the size of a recorded body and names `worker-read`'s tail of output and
 *   `inbox`'s fifty messages — **neither can occur**, because both are reads and §3's rule leaves
 *   them no receipt at all. The one acting command that carries bulk is `check`, which returns a
 *   delivered batch, so the count really is the lever the design says it is.
 */
export const RECEIPTS_PER_CALLER = 200
export const RECEIPT_TTL_MS = 60 * 60 * 1000
export const RECEIPTS_TOTAL = 2000

/**
 * Which of the receipts held right now fall off, given the caps above. **Pure, and separate from the
 * map it decides about**, so the policy can be read and tested as a policy: reaching the 2000 ceiling
 * through the command layer costs two thousand commits and two thousand whole-file writes, which is a
 * test that measures the store rather than the rule.
 *
 * `entries` is oldest first, the order the map holds them in, and the key is `${sessionId}\u0000${id}`
 * — so the caller is everything before the first NUL, which is also why an id may not contain one.
 *
 * **A claim is never evicted, however full the store is.** It is not a record of a call, it is the
 * call; evicting one would let the retry it is refusing through, which is the fault the whole
 * mechanism exists to prevent. Claims do not count towards either cap either — a caller holding
 * several long polls must not push its own answered receipts out with them.
 */
export function receiptsToEvict(
  entries: readonly { key: string; pending: boolean; at: string }[],
  nowMs: number
): string[] {
  const gone: string[] = []
  const perCaller = new Map<string, number>()
  let kept = 0
  // Newest first, so the caps keep the newest and the oldest fall off the end.
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.pending) continue
    const caller = e.key.slice(0, e.key.indexOf('\u0000'))
    const mine = perCaller.get(caller) ?? 0
    // An unparseable clock reads as "not expired" rather than as "expired", which is the safe way
    // round: a receipt kept too long costs memory, and one dropped too early costs a caller its answer.
    if (mine >= RECEIPTS_PER_CALLER || kept >= RECEIPTS_TOTAL || nowMs - Date.parse(e.at) > RECEIPT_TTL_MS) {
      gone.push(e.key)
      continue
    }
    perCaller.set(caller, mine + 1)
    kept++
  }
  return gone
}

/** Whether `understanding-unit`'s unit has the fields the pipeline reads before its own guard: the app's
 *  collector sends a whole SessionWorkUnit, so this only turns away a call that is not one. */
const isUnitShaped = (u: unknown): u is SessionWorkUnit => {
  if (typeof u !== 'object' || u === null || Array.isArray(u)) return false
  const o = u as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.sessionId === 'string' && typeof o.status === 'string' && typeof o.git === 'object' && o.git !== null
}

/** The app's calls into the Host's session work units (E2 §5), answered above the receipt line. */
const WORK_UNITS_CALLS: ReadonlySet<string> = new Set([
  'work-units-fork',
  'work-units-reload',
  'work-units-complete',
  'work-units-cancel',
  'work-units-git-op'
])

/** `work-units-*`'s 409: an attached app keeps the duty, and its collector holds the units. */
export const NOT_WORK_UNITS_WRITER = 'an attached Astera app is tracking session work units; ask it'

/** A reply body as a bag of fields, for the two predicates below. Anything that is not an object
 *  reads as empty, which makes every question asked of it answer "no". */
const bodyOf = (reply: Reply): Record<string, unknown> =>
  typeof reply.body === 'object' && reply.body !== null ? (reply.body as Record<string, unknown>) : {}

/**
 * **A command that committed and then waited, and what its replay must answer instead** (request
 * receipts design §7).
 *
 * The rule: *a receipt is replayed verbatim unless the command committed and then waited. When it
 * did, its replay is **observed** — the Host answers with what is true now, never with what was true
 * at the moment some earlier call gave up waiting.* A recorded `timedOut: true` is not a fact about
 * the world; it is a fact about how long one call waited, and handing it back to a caller that is
 * retrying *because it wants to keep waiting* answers instantly out of somebody else's stopwatch.
 * That caller is then in a loop that cannot end, which is worse than the lost answer it was
 * recovering from.
 *
 * **Each member answers for itself, and that is deliberate.** There is no single mechanism here that
 * decides for both, because one that did would decide for the *third* member too — silently, and by
 * whichever of the two it was modelled on. `stale` and `afresh` are two questions this design cannot
 * answer in general: whether a particular recorded reply is a stopwatch reading depends on how that
 * command reports a deadline, and reproducing the answer depends on what re-running would cost. So a
 * new member writes two lines here rather than inheriting somebody else's.
 *
 * **What holds the line is not this table but the guard over it** (§13 step 6): a test that every
 * command in the command layer which both commits and polls has an entry here. Membership is a shape,
 * and this table is only the two answers that shape cannot supply.
 */
interface ObservedReplay {
  /** Is this recorded reply a reading of a stopwatch rather than a fact about the world? */
  stale(reply: Reply): boolean
  /** The arguments that ask the same question again, now. */
  afresh(args: Record<string, unknown>, recorded: Reply): Record<string, unknown>
}
export const OBSERVED: Record<string, ObservedReplay> = {
  /**
   * `ask` commits `createQuestion` and then long-polls for ten minutes. **Re-running it would create
   * a second question** — a person sees the same thing asked twice, answers one, and the worker goes
   * on waiting on the other — so the replay re-reads the question the receipt names, which is what
   * `--resume` already does.
   *
   * **A recorded timeout with no question id is left verbatim**, which is why `stale` asks for the id
   * rather than only for the timeout. Without that, `afresh` would hand `resume: undefined` to a
   * command whose create branch it then falls into, and a stale answer is a far smaller fault than a
   * duplicate question.
   */
  ask: {
    stale: (reply) => bodyOf(reply).timedOut === true && typeof bodyOf(reply).questionId === 'string',
    afresh: (args, recorded) => ({ ...args, resume: bodyOf(recorded).questionId })
  },
  /**
   * `check --ack <id> --wait` commits `ackDelivery` **before** the poll, so a deadline leaves a
   * receipt holding `{count: 0, messages: [], timedOut: true}`. **This is the worse of the two**: the
   * orchestration guide already tells an agent that a `check --wait` timeout is a checkpoint and to
   * call again, so every later presentation of that id would answer `{count: 0}` instantly while real
   * messages piled up behind an ack that had already landed.
   *
   * It is observed by **re-running**, which is safe for the reason the pure layer gives: `ackDelivery`
   * on an already-acked delivery returns the state unchanged, so the ack is a no-op the second time
   * and the poll — the whole of what the caller wants — runs fresh.
   */
  check: {
    stale: (reply) => bodyOf(reply).timedOut === true,
    afresh: (args) => args
  },
  /**
   * `sessions send --wait` types a turn (an effect, `sendSession` or `chatSend`) and then waits for it
   * to end (CLI spec §15). **Re-running it would type the text a second time**, so the replay waits
   * again for the turn the first call sent (`resumeWait`, which the command reads as "send nothing").
   * Only a recorded deadline is a stopwatch reading; an ended turn, a prompt and an ended session are
   * facts, replayed as they were.
   */
  'sessions-send': {
    stale: (reply) => {
      const turn = bodyOf(reply).turn
      return typeof turn === 'object' && turn !== null && (turn as { state?: unknown }).state === 'timeout'
    },
    afresh: (args) => ({ ...args, resumeWait: true })
  },
  /**
   * `runs resume` waits for a stopped coordinator's slot to empty **before** it commits anything
   * (review fix round 1, I2 of the MCP planning work). A wait that runs out is a 409 that committed
   * nothing, which leaves no receipt, so a retry runs afresh. A reply that did commit is a fact (the
   * Run resumed, with or without a new coordinator), never a stopwatch reading: replayed verbatim.
   */
  'runs-resume': {
    stale: () => false,
    afresh: (args) => args
  }
}

export interface HostOrch extends OrchCall {
  /** Loads the state, once. Lazy and memoized on purpose — see `createHostOrch`. */
  ready(): Promise<void>
  /** Runs with work actually in flight — what `astera host stop` refuses over and names (ruling F57,
   *  docs/cli.md).
   *
   *  **Synchronous, and it deliberately does not load.** Not merely to stay cheap: loading is not a
   *  read. `store.load` runs the restart cleanup — it writes off open Dispatches, opens Gates and
   *  saves — and triggering that from `host stop`, whose whole point is to disturb nothing, would be
   *  worse than any answer it could produce.
   *
   *  **And 0 is the true answer for a Host that has not loaded**, not a convenient one. For a Run to
   *  be running *here*, some command must have gone through `handleCommand`, which awaits `ready()` —
   *  so a Host that has never loaded has never dispatched anything. A file that still says a Run is
   *  `dispatched` is describing work from a process that is gone; refusing to stop over it would
   *  leave `host stop` permanently refusing until somebody cleaned the file up by hand. Work this
   *  Host really holds from before a load is a live pty, and that is counted as a session. */
  runningRuns(): number
  /** The state as the store holds it (`store.get()`). For the Host's spawner, whose every caller is
   *  a command already behind `ready()`, so it never triggers or races the load. */
  state(): OrchState
  /** A session this Host holds has ended and no app handles it (host/exits.ts): closes its open
   *  Dispatch through `handleExit`, the app's own path, then empties a coordinator slot it held. A
   *  session a live pty says was rolled from it is rekeyed instead, and nothing is closed (S6 R7).
   *  Waits for the load, as every command does. */
  sessionExited(e: { sessionId: string; exitCode: number }): Promise<void>
  /** The sessions the state still counts on that `isAlive` says are gone: open Dispatches (never a
   *  `pending:` one, which has no session yet) and coordinator slots, each id once. **Empty before
   *  the first load**, and deliberately not a load: the handover sweep asks this, and a Host that has
   *  never loaded has closed nothing and started nothing, while loading would run the restart cleanup
   *  from an app leaving. */
  orphanedSessions(isAlive: (sessionId: string) => boolean): string[]
  /** A command the Host issues for itself, after the load, under HOST_CALLER (R9). It answers exactly
   *  as `call` would — the same 409 rewrite from the call's own marks, so a retiring spawner's refusal
   *  arrives as 409 with `retry` (B1). No request id, so no receipt: the Host is not a caller that
   *  retries a lost answer, it reads the state again. */
  handle(cmd: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
  /** The Host's deps for its own doors: routed like a command's, marks read by nobody (R9). */
  internalDeps(): OrchServerDeps
  /** Whether the state is in memory: the load finished, or the app pushed a whole one. */
  loaded(): boolean
  /** Hears every commit after the snapshot it returns, as a controller sees it: sanitized (remote runtime
   *  design §3.6). Null before the state is in memory: there is no version yet to hand back, and subscribing must not trigger a load. */
  subscribe(deliver: (s: OrchState, version: number) => void): { state: OrchState; version: number; unsubscribe(): void } | null
  /** Runs the drain once, if it has not run in this Host's life (C6): for a Host that was `'app'` at
   *  its load and becomes `'host'` later. Re-reads the queue. Answers whether it ran. */
  drainOnce(): Promise<boolean>
}

export function createHostOrch(a: {
  profileDir: string
  /** The login rule `accounts-list` and `--coordinator-provider` mark each provider's default by, with
   *  no app attached. Defaults to the one rule (loginCheck.ts, C8) the Host's checks and spawner use. */
  isLoggedIn?(account: Account): Promise<boolean>
  /** The Host's own version (`ASTERA_HOST_VERSION`) — what `status` and `version` answer with. */
  version: string
  now(): string
  /** When this Host began serving — **the same string its `hello` carries**, which is the whole point
   *  of asking for it rather than taking one at construction (request receipts design §6). A receipt
   *  lives only as long as the Host that holds it, so an `absent` is dangerous exactly when the Host
   *  that took the request is gone; the caller tells those apart by comparing this against when it
   *  sent the request, and the value it already holds is the handshake's. Two clocks here would be
   *  two answers to one question.
   *
   *  A function because `host/index.ts` builds this before it has a server to ask — the same reason
   *  `act` and `hasApp` are functions. */
  hostStartedAt(): string
  runningSessions(): number
  /** The sessions this Host is still running, by the app's own id for each — its registry's live
   *  entries whose note says `kind: 'session'`, mapped to `meta.id`.
   *
   *  **That is literally a `Dispatch.sessionId`.** An adopted session keeps the id it had before the
   *  restart (`src/main/host/reattach.ts`), so a stored Dispatch pointing at one of these is pointing
   *  at a worker that is still working. **And it is never `'unknown'`**: the app had to ask another
   *  process and could be told nothing, and design §6 says that answer cannot exist inside the Host —
   *  "we asked and got no answer" is not a state a process can be in about itself. */
  aliveSessionIds(): ReadonlySet<string>
  act(name: string, args: unknown[]): Promise<unknown>
  hasApp(): boolean
  /** Called with the state every commit leaves behind, so the Host can push it to the app — and with
   *  the version that commit is, which the app quotes back on its own writes (ruling F56). */
  onState(s: OrchState, version: number): void
  /** The Host's log. Handed to the command layer as well — see `hostOrchDeps`. */
  log(message: string): void
  /** The agent sessions this Host holds, for `astera sessions` (orchDeps' HOST_SESSIONS). */
  sessions: HostSessions
  /** The Host's own spawner (orchDeps' HOST_LOCAL). Null or absent when the Host was started without
   *  the CLI paths, and then every one of those calls takes its pre-S2 route. */
  local?: HostLocal | null
  /** The spec folder this Host sweeps at its load (Host S2 design §2.7). Given only when the Host
   *  has a spawner and so announces `spawn`: from then on it writes specs itself, and the app leaves
   *  the sweep to it. Absent, nothing is swept here and the app's boot sweeps as before. */
  specsDir?: string
  /** The Host's own worktree registry (Host S3, §3.1). Only `call` is asked here — the four
   *  `worktree-*` names, answered on this side of the request-receipt line because none of them goes
   *  through `handleCommand` (R1: the app is their only caller). Absent exactly when there is no
   *  spawner (R5): with no spawner nothing built here ever reaches `worktrees`, so the four answer 501. */
  worktrees?: Pick<HostWorktrees, 'call'> & Partial<Pick<HostWorktrees, 'isRegistered' | 'list'>>
  /** The next fire time of a scheduled Job's armed template (the driving's loop), for `jobs-view`. Absent: none. */
  nextFireOf?(runId: string): number | null
  /** Paired remote controllers (src/host/controllers.ts, remote runtime design §3.3). Absent: this Host pairs nobody,
   *  and `pair-create`, `clients-list` and `clients-revoke` answer 501. */
  controllers?: ControllerRegistry
  /** Closes a revoked client's live connections: the Gateway link's `closeConns` (design §3.3's last revocation step).
   *  Absent before a Gateway runs, when there is nothing open to close. */
  closeControllerConns?(conns: Array<{ linkGen: number; conn: string }>): void
  /** The Remote Gateway's supervisor (remote runtime design §2.3): `runtime-reload` and `runtime-status`. Absent on a
   *  Host built without one; both then answer 501. */
  gateway?: { reload(o?: { now?: boolean }): Promise<void>; status(): GatewayState }
  /** The Host's own checks and whether it drives now (orchDeps' HOST_DRIVES), passed through to
   *  `hostOrchDeps`. Absent: validation, review and repair take their pre-S5 routes. */
  drive?: { owns(): boolean; checks: HostChecks } | null
  /** The Host's own project-root resolver (orchDeps' HOST_RESOLVES, `host/projectRoots.ts`), passed
   *  through to `hostOrchDeps`. Absent: `resolveProjectRoot` is forwarded to the app as before. */
  resolveProjectRoot?(cwd: string): Promise<string>
  /** The Host's own rolling (S6): `unregister` is passed through to `hostOrchDeps` (HOST_ROLLS, R8);
   *  the other three members are for the roll tap and the app's calls (Tasks 11 and 13): `stateOf` and
   *  `forceRoll` answer `roll-state`/`roll-force`, and `has` is `roll-force`'s 404 check for a session
   *  this Host holds no chain for. Absent: `unregisterRolling` only forwards to the app, as before. */
  rolling?: Pick<HostRolling, 'unregister' | 'stateOf' | 'forceRoll' | 'has'> | null
  /** The Host's own recovery (remote runtime design §2.6), passed through to `hostOrchDeps` (HOST_RECOVERS). Absent:
   *  `onDispatchLost` only forwards to the app, as before. */
  recovery?: { owns(): boolean; lost(dispatchId: string): void } | null
  /** The Host's own chat sessions (chat takeover Task 8), passed through to `hostOrchDeps`: its
   *  HOST_CHATS and the Host-writer routes of `chatPending` and `chatSend` (P10). Absent: the Host
   *  answers no chat prompt of its own and forwards both names to the app. */
  chats?: (Pick<HostChats, 'prompts' | 'isWriter' | 'answer' | 'requests' | 'send'> & Partial<Pick<HostChats, 'turnOf'>>) | null
  /** Whether the apps holding a session's chat proc all yield `chat-takeover` (HOST_CHATS), passed
   *  through to `hostOrchDeps`. Absent: every app is asked. */
  chatAppAnswers?(sessionId: string): boolean
  /** The Host's roll journal (S6 limits D5; rollJournal.ts), for the app's `roll-journal` call. Absent
   *  exactly when there is no rolling: the call then answers 501. */
  rollJournal?: Pick<RollJournal, 'take'> | null
  /** The Host's Slack (Slack in the Host, P17), for the app's `slack-reload` call. Absent exactly when
   *  this Host does not own Slack (no spawner or no SDK): the call then answers 501. */
  slack?: Pick<HostSlackWiring, 'reload' | 'active'>
  /** The MCP HTTP entrance's supervisor (mcpHttp.ts, MCP HTTP design §3), for the app's `mcp-http-reload` and
   *  `mcp-http-status`. Absent: both answer 501. */
  mcpHttp?: Pick<McpHttpSupervisor, 'reload' | 'status'>
  /** R7: the live session a pty note says was rolled from this one, or null. */
  rolledInto?(sessionId: string): { id: string; accountId: string } | null
  /** R7: rekeys through the Host's roll tap instead of closing. */
  rekeyRolled?(oldSessionId: string, info: { id: string; accountId: string }): Promise<void>
  /** `validation-stop`: the app's stop button on a validation run this Host started (S4+S5 §5.1).
   *  Marks the run stopped and kills it, so its exit reads as "not proven" rather than a failure;
   *  true when `runId` was such a run. Absent: the call answers 501. */
  validationStop?(runId: string): boolean
  /** Every commit this Host makes, after it has landed in memory and been pushed (R5): a command's,
   *  the Host's own, and an accepted `state-put`. The driver's kick. Isolated: a throw is logged, and
   *  the commit it followed stands. */
  onCommit?(): void
  /** Whether the drain may run at this load (driver === 'host'), computed on the spot. **Awaited**
   *  inside ready() (N2): at the first load the driver's cached value may not exist yet. A rejection
   *  is logged and read as no, which leaves the drain to `drainOnce`. */
  mayDrain?(): Promise<boolean>
  /** Called once, at the end of the load, after `loaded = true` (B2). Isolated: a throw is logged. */
  onLoaded?(): void
  /** The two status fields, or null when this Host does not drive (R6). */
  driverStatus?(): { driver: Driver; appAttached: boolean } | null
  /** The Host's dispatch loop placing one ready Task (`tasks dispatch`), passed through to
   *  `hostOrchDeps`. Absent: the command answers 409. */
  dispatchTask?(taskId: string): Promise<{ status: number; body: unknown }>
  /** `sessions create` (sessionCreate.ts), passed through to `hostOrchDeps`. Absent: the command
   *  answers 409. */
  createSession?: OrchServerDeps['createSession']
  /** GitHub through the Host's gh (MCP P2-B), passed through to `hostOrchDeps`. Absent: the `github-*`
   *  commands answer 409. */
  github?: OrchServerDeps['github']
  /** How It Works records (MCP P2-C), passed through to `hostOrchDeps`. Absent: the `understanding-*`
   *  commands answer 409. */
  readUnderstanding?: OrchServerDeps['readUnderstanding']
  /** The Host's Job Journal (hostJournal.ts). Absent: nothing is journaled here, `journal-append` and
   *  `journal-reload` answer 501, and `runs follow` shows no journal rows. */
  journal?: Pick<HostJournal, 'committed' | 'loaded' | 'append' | 'reload' | 'timeline'> | null
  /** How It Works in the Host (hostUnderstanding.ts, E1 §3, §4): handed every Run a commit finishes, and
   *  the app's `understanding-unit` and the app's and MCP's `understanding-regenerate`. Absent: this Host
   *  records no Run, and both calls answer 501. */
  understanding?: Pick<HostUnderstanding, 'onRunFinished' | 'onUnitClosed' | 'regenerate' | 'isWriter'> | null
  /** The agent app workspace (agent workspace design): `app-js` below the receipt line (plan ruling
   *  P2), and the app only `workspace-list`, `workspace-stop`, `workspace-close` and `workspace-size` above
   *  it. Absent: all five answer 501. */
  workspaces?: Pick<WorkspaceManager, 'run' | 'stop' | 'close' | 'list' | 'resize'>
  /** Session work units in the Host (E2 §5), asked per call: `index.ts` builds them after this orch (their
   *  in-Run test reads its state). Passed through to `hostOrchDeps` (HOST_TRACKS), and the app only
   *  `work-units-fork`, `-reload`, `-complete`, `-cancel` and `-git-op`. Absent, or null (no spawner, so no
   *  duty): the session-task commands are forwarded as before and the five answer 501. `sessionTasks.list` is not
   *  here on purpose: it answers from the collector's memory, which is stale while the collector is stopped,
   *  so a reader app reads workUnits.json itself (E2 §6) and the Host serves no list. */
  workUnits?():
    | (Pick<HostWorkUnits, 'isWriter' | 'isRunning' | 'trackingEnabled' | 'fork' | 'reload' | 'gitOpBegin' | 'gitOpEnd'> & {
        sessionTasks: Omit<HostWorkUnits['sessionTasks'], 'list'>
      })
    | null
}): HostOrch {
  const store = new OrchestrationStore(path.join(a.profileDir, 'orchestration.json'))
  // Built at the first ask: only a call that marks the default needs the descriptors.
  let descriptors: ReturnType<typeof makeDescriptors> | undefined
  const loggedIn = a.isLoggedIn ?? ((x: Account) => isLoggedIn(x, (descriptors ??= makeDescriptors(process.platform))))

  /** The journal, isolated (R3): hostJournal.ts never throws, and a journal that does anyway must not
   *  turn a landed commit into a failed command. */
  const journalSafely = (what: string, fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      a.log(`continuity: ${what} failed on the Host: ${String(err)}`)
    }
  }

  /** E1 §3: a Run this commit finished, caught as an edge (runRecord.ts), is handed to How It Works so
   *  a Run that finishes with no Astera window open still gets its record. **Fire and forget**: the
   *  commit has already landed, and nothing the record does, a throw included, may turn it into a failed
   *  command. Whether to record (writer, settings) is hostUnderstanding's to judge and log. */
  const recordFinishedRuns = (prev: OrchState, next: OrchState): void => {
    const understanding = a.understanding
    if (!understanding) return
    const failed = (runId: string, err: unknown): void => a.log(`understanding: recording run ${runId} failed on the Host: ${String(err)}`)
    let finished: ReturnType<typeof justFinished>
    try {
      finished = justFinished(prev, next)
    } catch (err) {
      a.log(`understanding: could not tell which Runs this commit finished: ${String(err)}`)
      return
    }
    for (const { runId } of finished) {
      try {
        const input = runRecordInputOf(next, runId)
        if (input) void understanding.onRunFinished(input).catch((err) => failed(runId, err))
      } catch (err) {
        failed(runId, err)
      }
    }
  }

  /** **Nothing is read at construction, and `host/index.ts` never calls `ready()`.**
   *
   *  The load happens at the first call that needs the state — and, once the app has pushed its state
   *  with `state-put`, never at all. Lazy because a Host that nobody asks anything of has no reason to
   *  touch the file, and memoized because the restart cleanup inside `load` must run exactly once. */
  let loading: Promise<void> | null = null
  /** What that one load found. Handed to the app once, with `state-get` — see `stateGet`. */
  let loadResult: OrchLoadResult | null = null
  /** Whether the state is in memory: the load finished, or the app pushed a whole one. `loading`
   *  alone cannot say it, because it is set the moment a load starts. */
  let loaded = false
  const ready = (): Promise<void> =>
    (loading ??= (async () => {
      // **The two pieces of evidence the app used to gather, gathered here instead** (design §6).
      //
      // - The live sessions are this Host's own registry, so `'unknown'` — the answer that closed
      //   nothing — has no meaning here any more. A process is not in the dark about itself.
      // - The undelivered reports are the third reason a Dispatch stays open, and the case that
      //   matters most is the one where nothing survived to be alive: the machine was turned off
      //   after a worker had already finished and written its report down. Closing that Dispatch
      //   here would throw the report away (`applyWorkerDone` answers `alreadyReported` for a
      //   Dispatch that already has `endedAt`) and hand the reconciler a lost worker to replace.
      //
      // Reading the queue cannot throw — `readPendingReports` swallows its own failures, a missing
      // folder being the ordinary case — and `reportedDispatchIdsOf` is pure. A queue that cannot be
      // read costs the reports in it, never the load.
      //
      // **Applied here only when this Host drives** (R4, below): otherwise applying a report reaches
      // session spawning that is the app's, and the app still reads and drains this same queue at its
      // own boot. So two processes read this folder, and **reading it is not read-only** — `readPendingReports` also sweeps abandoned
      // `.json.tmp` files and renames unreadable reports aside. Why the two sweeps cannot destroy
      // anything between them: the swept set (`.json.tmp`) and the read set (`.json`) are disjoint by
      // suffix; a working file is swept only after an hour untouched (`WORKING_FILE_TTL_MS`), so a
      // write in flight in the other process is never the one swept; and both the `rm` and the
      // `rename` are guarded, so the loser of a race does nothing rather than failing. The one
      // visible effect is cosmetic and belongs to this side: if the app's drain deletes a `.json` it
      // has just applied, between this `readdir` and its `readFile`, the log below says "setting
      // aside … — it is not a report this app can read" about a report that applied perfectly well.
      const queued = await readPendingReports({ dir: pendingReportsDirIn(a.profileDir), log: a.log })
      const alive = a.aliveSessionIds()
      loadResult = await store.load({
        aliveSessionIds: alive,
        reportedDispatchIds: reportedDispatchIdsOf(queued.map((q) => q.report))
      })
      // The restart cleanup is a transition like any other (the app did this at its boot): every worker it
      // closed as outcome_unknown lands as ATTEMPT_LOST, by the Host (P5).
      journalSafely('recording the load', () => a.journal?.loaded({ before: loadResult!.before, state: store.get() }))
      // **The stale spec sweep, once, here** (§2.7), after the cleanup because only the cleanup knows
      // which Dispatches are still open. This load is the one place every writer of that folder is
      // past its restart: the Host's own spawns wait on `ready()`, and an app in front of a Host
      // that announces `spawn` does not sweep. The same live set the load judged by, so the two
      // cannot disagree about a session. It never throws, so it cannot cost the load.
      if (a.specsDir) {
        const removed = await sweepStaleSpecFiles({ dir: a.specsDir, state: store.get(), live: alive })
        if (removed.length > 0) a.log(`spec files — swept ${removed.length} stale file(s) at the Host's load`)
      }
      // **The pending-report drain, inside the load, when this Host drives** (R4). Inside, so an app's
      // `state-get` — which awaits `ready()` — is answered only after it, and the app's recovery sweep,
      // which runs after that answer, never sees a Dispatch a report is about to close. Through
      // `handleCommand` directly, never `call`, which awaits `ready()` and would wait on itself.
      //
      // **`mayDrain` is awaited** (N2): at the first load the driver's cached value may not exist
      // yet, and a decision still being computed is not a no. When it is no — an old app caused this
      // load and drives — the queue is that app's, as it always was, and `drainOnce` takes it later.
      if (await mayDrainNow()) {
        drained = true
        // `applyPendingReports` already swallows every per-report failure; this catches what is left,
        // because a load that rejects is memoized and would refuse every command this Host is asked.
        await drain(queued).catch((err) => a.log(`pending reports — the drain at the Host's load failed: ${String(err)}`))
      }
      loaded = true
      // After `loaded`, so the pass it starts sees a loaded Host (B2). Once: this promise is memoized.
      try {
        a.onLoaded?.()
      } catch (err) {
        a.log(`the Host's after-load pass failed to start: ${String(err)}`)
      }
    })())
  /** Whether the drain has run in this Host's life (C6). Set before it runs, so a second caller that
   *  arrives while it is running does not start another. */
  let drained = false
  /** `mayDrain`, with a throw or a rejection logged and read as no — a driver that cannot decide must
   *  not cost the load. */
  const mayDrainNow = async (): Promise<boolean> => {
    try {
      return (await a.mayDrain?.()) === true
    } catch (err) {
      a.log(`pending reports — could not tell whether this Host drives, so the queue is left: ${String(err)}`)
      return false
    }
  }

  /** What one call did, filled in by the dependencies as it runs. Three flags, two questions.
   *
   *  **`appRefused` is what makes the CONFLICT decision honest.** A forwarded action refuses by
   *  throwing, and each command turns a dependency failure into its own status: `worker-start` rolls
   *  its Dispatch back and answers 400 ("failed to start worker: ..."), which is right for a spawn
   *  that failed and wrong for this one — 400 tells a person their arguments were bad, and they were
   *  fine. So the status is corrected on the way out, and what it is corrected on is this flag, set
   *  by the forwarder itself. It used to be a substring match on the reply body, which most error
   *  paths fill with ids and titles the caller supplied: an id with APP_REQUIRED in it turned a 404
   *  into a 409 and a script read exit 6 where exit 4 was the truth.
   *
   *  **`commits` and `effects` are the two halves of "did this call do anything"** (request receipts
   *  design §3), and a receipt is kept only when one of them ends the call above zero. They ride
   *  here rather than in a second object because this one is already built per call, and a count
   *  that lives no longer than the call it belongs to cannot be read by the next one.
   *
   *  **Counts, not flags** (Host S3 follow-up A36). A mark can be taken back once what it marked is
   *  known to be undone: a Run worktree removed again, a start that left nothing, a rollback commit
   *  that undoes this call's own earlier commit. The call did something when either count ends above
   *  zero. */
  type CallMarks = { appRefused: boolean; commits: number; effects: number; repair?: string; retry?: string }

  /** **Built per call**, because the marks above are. One object literal per call costs nothing
   *  beside running a command. */
  /** The `check --wait` calls this Host serves, for its whole life (final round 2, I-A): built once, not
   *  per call like the deps below, since a wait entered by one call is asked about by another. */
  const checkWaits = createCheckWaits()
  const depsFor = (marks: CallMarks, actor: JournalActor): OrchServerDeps =>
    hostOrchDeps({
      checkWaits,
      getState: () => store.get(),
      setState: async (next, how) => {
        // The diff base, read before the save moves memory: each commit is journaled once, from here.
        const prev = store.get()
        // Reserved before the write, for `reserveVersion`'s reason and for one that is this path's
        // own: a `state-put` arriving while this commit is still writing would otherwise read the
        // pre-commit number, pass the check, and land a whole state that does not contain this
        // commit — the exact loss ruling F56 is about, with the Host as the losing side.
        const committed = reserveVersion()
        // Marked here rather than after the write, in the same synchronous step as the number it
        // takes: `store.save` moves memory before it queues the disk write, so this state is the one
        // every later command reads even if the file write then fails. A receipt that said otherwise
        // would let a retry re-run a command whose effect the next command can already see.
        // A rollback of this call's own earlier commit takes that one back instead (A36).
        marks.commits += how?.rollsBack ? -1 : 1
        // Published as memory moves, not after the disk: `subscribe` snapshots memory and `version`, which move
        // together right here, so a push taken any later could reach a subscriber older than its snapshot.
        const saving = store.save(next)
        publish(next, committed)
        await saving
        a.onState(next, committed)
        // J1: journaled after the commit landed (the spec's accepted crash window), with who made it (J4,
        // P5) and its version under this Host's life as the key (J6, P1).
        journalSafely('recording a commit', () => a.journal?.committed({ prev, next, version: committed, actor }))
        recordFinishedRuns(prev, next)
        kickDriver()
      },
      now: a.now,
      runningSessions: a.runningSessions,
      appVersion: () => a.version,
      // `reset` 이 지우기 전에 파일을 옆으로 복사한다. **store 의 쓰기 큐를 통과하므로** 아직 땅에
      // 닿지 않은 저장을 앞지르지 않는다 — 앱이 이 복사를 대신하던 동안은 그 보장이 없었다.
      backup: () => store.backup(),
      act: a.act,
      hasApp: a.hasApp,
      log: a.log,
      // 앱이 없을 때 계정 목록은 앱이 쓴 파일이 답한다(orchDeps 의 LOCAL_WHEN_ABSENT). 읽기만 한다.
      readAccounts: (provider, opts) =>
        readAccountsFile(path.join(a.profileDir, 'accounts.json'), provider, opts?.withDefault ? loggedIn : undefined),
      // 실행 구성도 같다 — 앱이 쓴 run-configs.json 과 계획의 폴더를 읽기만 한다(CLI phase D).
      readRunConfigs: (projectPath) => readRunConfigsFile(path.join(a.profileDir, 'run-configs.json'), projectPath),
      sessions: a.sessions,
      local: a.local ?? null,
      drive: a.drive ?? null,
      resolveProjectRoot: a.resolveProjectRoot,
      rolling: a.rolling ?? null,
      recovery: a.recovery ?? null,
      chats: a.chats ?? null,
      chatAppAnswers: a.chatAppAnswers,
      ...(a.dispatchTask ? { dispatchTask: a.dispatchTask } : {}),
      ...(a.createSession ? { createSession: a.createSession } : {}),
      ...(a.github ? { github: a.github } : {}),
      ...(a.readUnderstanding ? { readUnderstanding: a.readUnderstanding } : {}),
      workUnits: a.workUnits?.() ?? null,
      ...(a.journal ? { journalTimeline: (runId: string, st: OrchState) => a.journal!.timeline(runId, st) } : {}),
      onEffect: () => {
        marks.effects += 1
      },
      withdrawEffect: () => {
        marks.effects -= 1
      },
      onAppRequired: (name, why, detail) => {
        marks.appRefused = true
        // A profile file only the app can repair: the 409 names it (`repair`), so the CLI can say
        // there is no command to run rather than point at `astera status`.
        if (detail?.repair) marks.repair = detail.repair
        // A Host that is leaving: the 409 says to retry (`retry`), so the CLI offers the same command.
        if (detail?.retry) marks.retry = detail.retry
        // Said as what happened: with `detail` the Host refused it itself and asked nobody.
        a.log(detail ? `${name} refused by the Host: ${why}` : `${name} could not be put to the app: ${why}`)
      }
    })

  /** A 409 body with the file to repair (`marks.repair`), or the retry a leaving Host asks for
   *  (`marks.retry`), beside its error. Fields, so the CLI reads which it is rather than matching the
   *  sentence. */
  const withRepair = (body: unknown, marks: CallMarks): unknown =>
    (marks.repair || marks.retry) && typeof body === 'object' && body !== null
      ? { ...body, ...(marks.repair ? { repair: marks.repair } : {}), ...(marks.retry ? { retry: marks.retry } : {}) }
      : body

  /** The driver's kick after a commit (R5). Isolated (Constraint 14): the commit has landed and been
   *  pushed, and a driver that throws must not turn it into a failed command. */
  const kickDriver = (): void => {
    try {
      a.onCommit?.()
    } catch (err) {
      a.log(`the driver failed to take a commit: ${String(err)}`)
    }
  }

  const driverStatusNow = (): { driver: Driver; appAttached: boolean } | null => {
    try {
      return a.driverStatus?.() ?? null
    } catch (err) {
      a.log(`status — the driver could not say who drives: ${String(err)}`)
      return null
    }
  }

  /** Marks nobody reads: the Host's own doors (R9), which have no reply to correct and no receipt. */
  const throwaway = (): CallMarks => ({ appRefused: false, commits: 0, effects: 0 })

  /** **One rewrite for both doors** (B1). A forwarded or local refusal that the command turned into its
   *  own error status is a conflict, carrying its `repair` or `retry` field. Only an error reply is
   *  rewritten: a command that carried on past a refusal it swallowed (the fire-and-forget ones)
   *  succeeded, and a success is not a conflict. `handle` answers through this too, which is what lets
   *  the loop read a retiring spawner's refusal as 409 with `retry` (R15) rather than a failed start. */
  const answerOf = (r: Reply, marks: CallMarks): Reply =>
    r.status >= 400 && marks.appRefused ? { status: 409, body: withRepair(r.body, marks) } : r
  /** A command that threw: a conflict if a refusal is what stopped it, a 500 otherwise. */
  const failureOf = (err: unknown, marks: CallMarks): Reply => {
    const message = err instanceof Error ? err.message : String(err)
    return { status: marks.appRefused ? 409 : 500, body: withRepair({ error: message }, marks) }
  }

  /**
   * **The pending-report drain, the app's own, run by the Host** (R4). The same `applyPendingReports`
   * and the same write-off the app's boot runs (`ipc.ts`, the drain block), so a report is applied —
   * or refused, or given up on — by one rule whichever process drains it.
   *
   * **Each report runs under its worker's own session**, as the app runs it: `send` checks that the
   * caller is the session the Dispatch names.
   *
   * **The held-only-by-report set is taken before the first report is applied**, for the app's
   * reason: it names the Dispatches the restart cleanup left open only for a report, and asking again
   * midway would catch Dispatches earlier reports in this very drain opened.
   */
  const drain = async (queued: readonly QueuedReport[]): Promise<void> => {
    if (queued.length === 0) return
    const heldOnlyByReport = dispatchesHeldOnlyByReport({
      dispatches: store.get().dispatches,
      reported: reportedDispatchIdsOf(queued.map((q) => q.report)),
      alive: a.aliveSessionIds()
    })
    const drainedNow = await applyPendingReports({
      queued,
      apply: (r) =>
        handleCommand(depsFor(throwaway(), { surface: 'agent', sessionId: r.sessionId }), { sessionId: r.sessionId }, r.cmd, r.args).then((reply) => ({
          ok: reply.status >= 200 && reply.status < 300,
          detail: `${reply.status} ${JSON.stringify(reply.body)}`
        })),
      writeOff: async (r) => {
        const dispatchId = String(r.args.dispatchId)
        if (!heldOnlyByReport.has(dispatchId)) return
        const res = writeOffDispatch(store.get(), { dispatchId }, a.now())
        if (!res.closed) return
        await depsFor(throwaway(), HOST_ACTOR).setState(res.state)
        a.log(
          `pending reports — dispatch=${dispatchId} is written off: it was left open only for a report that could not be applied, and recovery can take its Task at this start` +
            (res.interrupted === 'validation' ? '. Its Task was validating and is now gated' : '') +
            (res.interrupted === 'review' ? '. Its Task was reviewing and is now gated' : '') +
            (res.stuck ? '. Its Task could not be interrupted and was left as it was' : '')
        )
      },
      log: a.log
    })
    a.log(
      `pending reports — ${drainedNow.applied} applied, ${drainedNow.rejected} refused, ${drainedNow.kept} left for the next start, ${drainedNow.gaveUp} given up on`
    )
  }

  /** The app handing over its whole state (design §5). Not part of `handleCommand`: it is not a
   *  command anybody types, it writes the state wholesale rather than through a transition, and only
   *  one kind of client may send it. */
  const statePut = async (
    args: Record<string, unknown>,
    from: OrchCaller | undefined
  ): Promise<{ status: number; body: unknown }> => {
    // A client that did not call itself the app — or one the server could not identify at all — is
    // not the owner of the state. 403 rather than 501: the command exists, this caller may not use it.
    if (from?.role !== 'app') return { status: 403, body: { error: 'state-put is the app’s to send' } }
    const state = args.state
    // The same check the store uses on the file, for the same reason: what arrives here is written to
    // that file, and a malformed state saved over a good one costs every Job in it.
    if (!isValidState(state)) return { status: 400, body: { error: 'state-put needs a whole orchestration state' } }
    // **The file is not read after this.** This is a whole state, so a load would be reading an older
    // copy of what we were just given, and it would run the restart cleanup a second time. In the
    // ordinary case the load has already happened — the app fills its mirror with `state-get` before
    // it can write anything at all — and a load already in flight is waited for rather than raced:
    // its own assignment would otherwise land after this one.
    //
    // **Ahead of the version check below, deliberately.** Everything from that check to the commit
    // has to be one synchronous step (see `reserveVersion`), and this is the last thing in this
    // function that can suspend.
    //
    // **A write that is about to be refused loads instead of standing in for the load.** On a fresh
    // Host a stale version is certain to be refused below, and a refusal changes nothing — so it must
    // not mark this Host as holding a state. Setting `loading` for it would leave memory empty for good:
    // the refusal would hand the app an empty state, every later read would answer it, and the app's
    // next write, built from it, could be saved over the file. Loading here first means the refusal
    // carries the file's state, which is what the app's mirror needs.
    const sent = args.version
    if (!loading && typeof sent === 'number' && sent !== version) await ready()
    // P15: whether this put has a base to diff against. Read before the lines below, where a put on a
    // Host that never loaded stands in for the load. A load (or an earlier put) already started counts:
    // it is awaited below, so memory holds its state by the time `prev` is read.
    const hadState = loading !== null
    if (loading) await loading
    else loading = Promise.resolve()
    // **The write the app built is against a state this Host has since replaced** (ruling F56). It
    // carries a whole state, so landing it would erase every commit made in between — and the commit
    // most likely to be in between is a worker's `worker_done`, whose author has already exited.
    //
    // The current state travels with the refusal so the app can put its mirror right without a second
    // round trip: what it is holding is wrong by definition at this point, and leaving it wrong is
    // the second half of the same fault (it would go on reading a state the file does not have).
    //
    // **An omitted version is not a mismatch.** It means the caller has no version to quote — an app
    // built before this field, or one writing before its first `state-get` — and refusing those would
    // be a new failure in place of the one being fixed. The check is a safety net over a client that
    // opts into it, which is what keeps this additive and the protocol at 3.
    if (typeof sent === 'number' && sent !== version)
      return {
        status: 409,
        body: {
          error: `the state moved on: this Host is at version ${version}, the write was built on ${sent}`,
          state: store.get(),
          version
        }
      }
    // The diff base, read before the save moves memory.
    const prev = store.get()
    // Taken here, not after the write lands — the whole of `reserveVersion`'s note.
    const committed = reserveVersion()
    // Published as memory moves, for the reason in `depsFor`'s setState.
    const saving = store.save(state)
    loaded = true
    publish(state, committed)
    await saving
    // To the others and not back to the sender: the state came from there, and an app that received
    // its own push would write its own state back over itself.
    from.toOthers({ t: 'orch-state', state, version: committed })
    // P15: a put that stood in for the load has no base to diff against.
    // Not recorded either without one: every Run the put carries would read as just finished.
    if (hadState) {
      journalSafely('recording a state-put', () => a.journal?.committed({ prev, next: state, version: committed, actor: DESKTOP_ACTOR }))
      recordFinishedRuns(prev, state)
    } else a.log('state-put: taken before this Host held a state, so it is not journaled as a diff from nothing')
    // An accepted whole state is a commit like any other (R5): the app may have just added the work
    // the driver is to place. A refused one above changed nothing, so it kicks nothing.
    kickDriver()
    return { status: 200, body: { ok: true, version: committed } }
  }

  /** Whether the load's findings have already been handed to somebody. See `stateGet`. */
  let bootHandedOut = false

  /**
   * How many commits this Host has made. **The app quotes it back on `state-put` and a stale one is
   * refused** (ruling F56).
   *
   * `state-put` is a whole-state write, and the state the app built it from came out of a mirror that
   * a push can supersede while the app is awaiting. Without this, the sequence that costs work is one
   * click: a worker's `worker_done` commits B here and is pushed; a moment earlier the person pressed
   * Pause, so the app read S0, awaited, and its write of A lands after — and A does not contain B.
   * The worker has already exited, so its report, its dispatch closure and its task transition are
   * gone with nothing to reproduce them.
   *
   * **This is the detection half only.** Refusing the write turns silent data loss into something the
   * person is told about and the mirror recovers from; making the refused action succeed needs the
   * app's mutation to be re-appliable, and today it is not — it arrives here as a finished state, not
   * as a transform. That decision is deliberately left open rather than guessed at.
   *
   * Starts at 0, which no app can hold before its first `state-get`, so the first write of a session
   * always carries a version the Host has really issued.
   */
  let version = 0
  /**
   * Takes the next version. **Called at accept time, in the same synchronous step as the check that
   * precedes it — never after the write has landed.**
   *
   * Raising it after `await store.save` looks equivalent and is not, because the app's mirror raises
   * its own copy the moment it hands a write over (`mirrorStore`, ruling F56/d). Two overlapping app
   * writes therefore arrive quoting N and N+1, and a Host still at N while the first is on disk
   * refuses the second — a write that was built on the first and was never stale. That is the same
   * lost commit this check exists to prevent, moved to the other end of the window.
   *
   * **Why this rather than serialising `state-put`.** A queue would make the second write wait out
   * the first's disk write, so every app commit would pay the previous one's fsync before it could
   * even be judged — and worse, a refusal would then be able to mean "somebody is still writing"
   * instead of only ever meaning "somebody else committed". Ordering is not what is missing:
   * `OrchestrationStore.save` already moves memory synchronously and serialises the disk writes
   * behind its own queue, so the file lands in call order either way. What was missing is that the
   * number and the memory move together, which is exactly what the mirror does at the other end. Two
   * ends, one rule.
   */
  const reserveVersion = (): number => ++version

  /**
   * Who hears every commit, with its version (remote runtime design §3.6). Both commit paths call
   * `publish` in the same synchronous step that moves memory and takes the version, which is what lets
   * `subscribe` snapshot both without a push older than the snapshot ever following it. Subscribers are
   * controllers, so they hear the sanitized state, made once per commit. A subscriber's throw is logged
   * and the others still hear it.
   */
  const subscribers = new Set<(s: OrchState, version: number) => void>()
  const publish = (s: OrchState, v: number): void => {
    if (subscribers.size === 0) return
    const view = sanitizeForController(s)
    for (const deliver of subscribers) {
      try {
        deliver(view, v)
      } catch (e) {
        a.log(`a state subscriber threw: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  /**
   * The app filling its mirror (design §5, §6). Not part of `handleCommand` for the same reasons
   * `state-put` is not: nobody types it, and it answers with the whole state rather than a view of it.
   *
   * **Why the load's findings ride along.** `store.load` is where the restart cleanup happens, and
   * half of what that cleanup starts is the app's: journalling every worker the restart lost (Job
   * Continuity), restarting the validations and reviews it interrupted, and saying in the log what
   * was written off. The app used to have those findings because it was the process that loaded. Now
   * the Host loads, so they travel.
   *
   * **Once, and only to the app asking for them.** Three rules, and they cover the three ways this
   * could go wrong. Only `boot: true` is answered with them, so the app's re-mirror after a reconnect
   * cannot consume findings that belong to the next app start. Only a client that called itself the
   * app is answered with them at all — **`boot: true` is not a read**: taking these findings
   * consumes them, so a CLI that asked for them, by mistake or otherwise, would leave the app booting
   * with nothing and the restart's interrupted validations never restarted. The plain read stays open
   * to anyone, because it really is one. And only the first such caller gets them, because an app
   * restarting against a Host that has been up for hours would otherwise be handed a cleanup that
   * happened long ago — re-journalling a diff spanning everything since, and restarting validations
   * for Tasks that have moved on. `null` is the honest answer there: nothing was lost, because the
   * Host never went away.
   */
  const stateGet = async (
    args: Record<string, unknown>,
    from: OrchCaller | undefined
  ): Promise<{ status: number; body: unknown }> => {
    await ready()
    // A controller gets the sanitized state and never the boot findings (remote runtime design §3.6).
    if (from?.role === 'controller') return { status: 200, body: { state: sanitizeForController(store.get()), boot: null, version } }
    // Not a 403: asking for the state is allowed, and this caller is getting it. What it is not
    // getting is the boot findings, and the honest way to say so is the same `boot: null` an app
    // that arrived second is told — there is nothing here for you.
    const wantsBoot = args.boot === true && from?.role === 'app' && !bootHandedOut
    if (wantsBoot) bootHandedOut = true
    // `version` rides along so the app's first write of this session can quote something the Host
    // really issued (ruling F56). Every later value comes from the pushes.
    return { status: 200, body: { state: store.get(), boot: wantsBoot ? loadResult : null, version } }
  }

  /**
   * **What this Host has been asked, by request id** (request receipts design §4). A claim while the
   * command runs, the reply it produced once it is over — and nothing at all for a call that changed
   * nothing, so what is stored is proportional to what was done rather than to how much was asked.
   *
   * **In memory, beside `version` and `loadResult`, and that costs a Host restart.** A durable
   * receipt cannot be made atomic with the effect here: our commit is a whole-file rename and
   * `worker-start` commits up to three times, so a durable record would be written *after* the
   * effect, in a commit of its own — a promise of durability that is not kept, which is worse than no
   * promise. The honest answer to a retry after a restart is that this Host never saw the request,
   * and `hello.startedAt` is what lets a caller tell that apart from "it never arrived" (§6).
   *
   * **Scoped by session** (§5), because a replay hands back a recorded response and a response can
   * hold another worker's question, the body of the coordinator's reply, the spec of another Task —
   * the same room `COORDINATOR_ONLY` walls off. Guessing another session's request id must not be a
   * second door into it.
   */
  const receipts = new Map<
    string,
    /** `cmd` and `at` are what `requests-show` answers with beside the state. `cmd` because a caller
     *  that lost an answer is usually holding an id and not much else, and "this id was `run-create`"
     *  is half of what it needs to know; `at` because it is the one fact that separates a claim taken
     *  a moment ago from one a long poll has been holding for an hour. `at` moves when the state does:
     *  it is when this receipt reached the state it is in, not when the call arrived.
     *
     *  `fp` is `fingerprintOf` over the command and its arguments: what this id was used for, so an
     *  id presented for a *different* call is refused rather than answered with somebody else's. */
    | { state: 'pending'; cmd: string; at: string; fp: string }
    | { state: 'completed'; cmd: string; at: string; fp: string; reply: Reply }
  >()

  /**
   * The reply to send **instead of** running the command, or the key this call now holds a claim on.
   *
   * **Called in the same synchronous step as the lookup inside it** — `reserveVersion`'s discipline,
   * for the same class of bug (§7). A claim taken after an `await` lets two `orch-call`s both find
   * the key free, and then the thing the caller said was one request happens twice.
   *
   * **A retry that arrives mid-flight is refused, not joined**, and that is this design's largest
   * departure from Orca. Three of our commands are long polls — `ask` holds for ten minutes,
   * `check --wait` for five, `runs wait` for an hour — so joining would hold a caller for up to an
   * hour on a call it already believes has failed, which is worse than the failure it was recovering
   * from. 409 is the code that already means "the current state makes this impossible"; there is no
   * eleventh exit code.
   *
   * **And an id presented for a different call is refused rather than answered** (§5). That check
   * comes before both of the above, because "this id is not yours to reuse" is true whether the first
   * call has finished or is still running, and answering a collision with somebody else's recorded
   * response is the one failure a mechanism like this must never have.
   */
  const holdRequest = (
    caller: string,
    requestId: string,
    cmd: string,
    args: Record<string, unknown>,
    retry: boolean
  ):
    | { answer: Reply; replayed?: true }
    | { observe: { key: string; recorded: Reply; args: Record<string, unknown>; fp: string } }
    | { key: string; fp: string } => {
    const bad = badRequestId(requestId)
    if (bad) return { answer: { status: 400, body: { error: bad } } }
    const key = `${caller}\u0000${requestId}`
    const fp = fingerprintOf(cmd, args)
    const held = receipts.get(key)
    // **A collision is a refusal, never a wrong answer.** The caller is told which command the id
    // belongs to, because that is the half it does not have: it is holding an id it believed was
    // free, and what it needs to know is what that id was spent on.
    if (held && held.fp !== fp)
      return {
        answer: {
          status: 400,
          body: {
            error: `request ${requestId} was already used for ${held.cmd} with different arguments — one request id names one call, so a different call needs a different id`
          }
        }
      }
    if (held?.state === 'completed') {
      // **Observed rather than returned, when what was recorded is a stopwatch reading** (§7).
      //
      // The claim is taken over the completed entry in this same synchronous step, so a retry that
      // arrives *while an observation is running* is refused by the branch below rather than
      // starting a second one. That is not tidiness: two `check` observations polling at once both
      // see a state with no open delivery, both build a batch out of the same undelivered messages,
      // and the second commit overwrites the first — one batch of messages carrying two delivery
      // ids, only one of which anybody can ack.
      const observed = OBSERVED[cmd]
      if (observed?.stale(held.reply)) {
        receipts.set(key, { state: 'pending', cmd, at: a.now(), fp })
        return { observe: { key, recorded: held.reply, args: observed.afresh(args, held.reply), fp } }
      }
      // Byte for byte what the first attempt answered, including its status — the point of a replay
      // is that it is indistinguishable from having received the first answer. **The one thing that
      // does say so is outside the body** (§8): `replayed` rides the envelope, so `data`'s shape
      // stays the command's own published contract.
      return { answer: held.reply, replayed: true }
    }
    if (held)
      return {
        answer: {
          status: 409,
          body: {
            error: `request ${requestId} is already running — wait for that answer rather than sending it again`,
            // **The id as a field, not only inside the sentence.** What a caller does next here is
            // ask about *this request*, and the CLI cannot tell this 409 from "the Job is already
            // running" without reading the message — which is the one thing that must never decide a
            // contract (`codeForStatus`'s note). Given the field, the CLI's `nextSteps` for this
            // failure can be `requests show --id <it>` instead of a general `astera status`.
            requestId
          }
        }
      }
    // **A retry never claims a free id** (remote runtime design §3.9, X1-03): the first attempt may have run, and the
    // record that would say so is gone. Decided in the same synchronous step that would otherwise claim it, so there is
    // no lookup-then-resubmit race.
    if (retry)
      return {
        answer: {
          status: 409,
          body: {
            error: `request ${requestId} may or may not have run: this Runtime no longer holds its receipt — list what it changed before sending it again`,
            code: 'RUNTIME_OUTCOME_UNKNOWN',
            retry: 'outcome-unknown',
            requestId
          }
        }
      }
    receipts.set(key, { state: 'pending', cmd, at: a.now(), fp })
    return { key, fp }
  }

  /** Whose receipts these are (remote runtime design §3.9, N11): a controller by the client the Host bound it to,
   *  everyone else by the session they sent, as before. A NUL cannot occur in either. */
  const receiptCaller = (sessionId: string, from: OrchCaller | undefined): string =>
    from?.role === 'controller' && from.principal ? `controller:${from.principal.clientId}` : sessionId

  /**
   * Writes one completed receipt down and then sweeps — **lazily, on the write that made the store
   * bigger, and never on a timer or at startup**.
   *
   * **A claim is never swept, however full the store is.** It is not a record of a call, it is the
   * call: evicting one would let the retry it is refusing through, which is the fault this whole
   * mechanism exists to prevent. Claims are bounded by how many calls are in flight, and every one
   * of them ends (`call` settles on every path, including its catch).
   *
   * **Nothing here can refuse anything.** The sweep runs after the command has already answered, and
   * no caller is told about it — see the caps above for why that is the rule and not an oversight.
   */
  const remember = (
    key: string,
    entry: { state: 'completed'; cmd: string; at: string; fp: string; reply: Reply }
  ): void => {
    receipts.set(key, entry)
    const held = [...receipts].map(([k, v]) => ({ key: k, pending: v.state === 'pending', at: v.at }))
    for (const gone of receiptsToEvict(held, Date.parse(a.now()))) receipts.delete(gone)
  }

  /**
   * The end of a claimed call. **The claim is discarded, not completed, when the command turns out
   * not to have acted** (§7): a keyed read that left a claim behind would answer `pending` forever
   * about a command that finished, and a keyed rejection that left a receipt would hand the same
   * refusal back to a retry the world has since made valid.
   *
   * A failure that *did* act is recorded like any other — the recorded response is whatever the
   * command answered, error envelope included, because a caller that lost that answer wants the
   * answer it lost.
   */
  const settleRequest = (claim: { key: string; fp: string }, cmd: string, marks: CallMarks, reply: Reply): Reply => {
    // Deleted first even when a receipt follows: `Map.set` leaves an existing key where it was, and
    // the sweep reads insertion order as "how recently this was written". A receipt that kept its
    // claim's place would be evicted ahead of older ones that were merely claimed later.
    receipts.delete(claim.key)
    if (marks.commits > 0 || marks.effects > 0)
      remember(claim.key, { state: 'completed', cmd, at: a.now(), fp: claim.fp, reply })
    return reply
  }

  /**
   * The end of an observed replay (§7). **Not `settleRequest`**, and the difference is not a detail:
   * that one discards a claim the command did not earn, and an observed `ask --resume` that times out
   * again commits nothing at all. Discarding there would make the id `absent`, and the next retry
   * would run `ask` from the top and create the second question this whole path exists to prevent.
   *
   * **The fresh answer replaces the recorded one**, and the reason is that an answer which has been
   * produced has to survive. Leave the stale reading in place and every later retry observes again —
   * against a world that has moved on. `ask` is the worked example: once the question is gone, which
   * a closed dispatch or a `reset` does, a re-read answers `unknown question` to a caller whose
   * question *was* answered and whose only record of that answer is this receipt.
   *
   * **A failed observation keeps what was recorded.** The receipt is the only record this request has;
   * an error from re-asking is a fact about now, and it is returned to the caller, but it is not worth
   * the record.
   */
  const settleObserved = (
    observed: { key: string; fp: string },
    cmd: string,
    recorded: Reply,
    reply: Reply
  ): Reply => {
    receipts.delete(observed.key)
    remember(observed.key, {
      state: 'completed',
      cmd,
      at: a.now(),
      // The fingerprint of the call as it was **first** made, never of the observation: `ask`'s
      // observed replay runs with `resume` added (`OBSERVED.ask.afresh`), and storing that would make
      // the next ordinary retry of the same id look like a different call and answer 400.
      fp: observed.fp,
      reply: reply.status < 400 ? reply : recorded
    })
    return reply
  }

  /** `astera app js` (agent workspace design). Answered by the Host, never by `handleCommand`: the
   *  workspace lives here whether or not an app is open (W2). A 200 marks one effect, so a retried
   *  request id replays this answer instead of launching the app twice (plan ruling P2); a refusal
   *  marks nothing and leaves no receipt. */
  const appJs = async (args: Record<string, unknown>, sessionId: string, marks: CallMarks): Promise<Reply> => {
    if (!a.workspaces) return { status: 501, body: { error: 'this Host has no agent app workspace' } }
    const script = args.script
    if (typeof script !== 'string' || script.trim() === '') return { status: 400, body: { error: 'script is required' } }
    if (sessionId === '')
      return { status: 400, body: { error: 'app js runs inside an agent session Astera started (ASTERA_SESSION is not set)' } }
    const r = await a.workspaces.run(sessionId, script)
    if (r.status === 200) marks.effects += 1
    return r
  }

  /** `understanding-regenerate` (E1 §4, §5): one command for both its callers, and the role decides
   *  which argument names the project. The app sends its `projectPath`; an MCP client sends a project
   *  id (`project`), resolved here to the project's root, as `understanding-list` resolves it. */
  const understandingRegenerate = async (args: Record<string, unknown>, from: OrchCaller | undefined, marks: CallMarks): Promise<Reply> => {
    const role = from?.role
    if (role !== 'app' && role !== 'mcp')
      return { status: 403, body: { error: 'understanding-regenerate is for the app and MCP clients' } }
    if (!a.understanding) return { status: 501, body: { error: 'this Host does not write How It Works records' } }
    const recordId = args.recordId
    if (typeof recordId !== 'string' || recordId === '')
      return { status: 400, body: { error: 'understanding-regenerate needs a recordId' } }
    let projectPath: string
    if (role === 'app') {
      const given = args.projectPath
      if (typeof given !== 'string' || given === '') return { status: 400, body: { error: 'understanding-regenerate needs a projectPath' } }
      projectPath = given
    } else {
      const projectId = args.project
      if (typeof projectId !== 'string' || projectId === '')
        return { status: 400, body: { error: 'understanding-regenerate needs a project id' } }
      await ready()
      const project = findProject(store.get(), projectId)
      if (!project) return { status: 404, body: { error: `unknown project: ${projectId}` } }
      projectPath = project.path
    }
    if (!a.understanding.isWriter()) return { status: 409, body: { error: NOT_WRITER } }
    const r = await a.understanding.regenerate(projectPath, recordId)
    if (!r.ok) return { status: r.status, body: { error: r.error } }
    marks.effects += 1
    return { status: 200, body: { id: r.id, status: 'generating' } }
  }

  /** The app's five `work-units-*` calls (E2 §5): 403 for any other caller, 501 without the duty, 400 for
   *  missing arguments, 409 while an attached app keeps the duty. `-complete` and `-cancel` answer the
   *  collector's own result as it is, a refusal included (`unknown task: <id>`, `task is <status>`): which
   *  of those the renderer's button reads as done is the app's mapping (ipc.ts), not the Host's.
   *  `-git-op` registers a Job merge the app runs itself on this collector, which watches HEAD (the
   *  app's appWorkUnits): its begin is refused 409 as the others are, **its end never is**, since an op
   *  this Host opened and never closed would explain every later HEAD move of that folder. */
  const workUnitsCall = async (cmd: string, args: Record<string, unknown>, from: OrchCaller | undefined): Promise<Reply> => {
    if (from?.role !== 'app') return { status: 403, body: { error: `${cmd} is the app’s to send` } }
    const units = a.workUnits?.() ?? null
    if (!units) return { status: 501, body: { error: 'this Host does not track session work units' } }
    const optional = (v: unknown): v is string | undefined => v === undefined || (typeof v === 'string' && v !== '')
    if (cmd === 'work-units-fork') {
      const { newSessionId, transcriptPath, oldSessionId } = args
      if (typeof newSessionId !== 'string' || newSessionId === '' || !optional(transcriptPath) || !optional(oldSessionId))
        return { status: 400, body: { error: 'work-units-fork needs a newSessionId, and takes a transcriptPath and an oldSessionId' } }
      if (!units.isWriter()) return { status: 409, body: { error: NOT_WORK_UNITS_WRITER } }
      units.fork(newSessionId, transcriptPath, oldSessionId)
      // A collector that is not running ignores a fork (tracking off): said, so the app need not guess.
      return { status: 200, body: { forked: units.isRunning() } }
    }
    if (cmd === 'work-units-git-op') {
      const { phase, kind, cwd, op } = args
      if (phase === 'end') {
        if (typeof op !== 'string' || op === '') return { status: 400, body: { error: 'work-units-git-op end needs an op' } }
        return { status: 200, body: { ended: units.gitOpEnd(op) } }
      }
      if (phase !== 'begin' || kind !== 'job-merge' || typeof cwd !== 'string' || cwd === '')
        return { status: 400, body: { error: "work-units-git-op needs a phase of 'begin' with a kind of 'job-merge' and a cwd, or 'end' with an op" } }
      if (!units.isWriter()) return { status: 409, body: { error: NOT_WORK_UNITS_WRITER } }
      // By the calling socket, so its close ends what it began (hostWorkUnits' clientGone).
      return { status: 200, body: { op: units.gitOpBegin(kind, cwd, from.socket) } }
    }
    if (cmd === 'work-units-reload') {
      if (!units.isWriter()) return { status: 409, body: { error: NOT_WORK_UNITS_WRITER } }
      await units.reload()
      return { status: 200, body: { reloaded: true, running: units.isRunning() } }
    }
    const { projectPath, id } = args
    if (typeof projectPath !== 'string' || projectPath === '' || typeof id !== 'string' || id === '')
      return { status: 400, body: { error: `${cmd} needs a projectPath and an id` } }
    if (!units.isWriter()) return { status: 409, body: { error: NOT_WORK_UNITS_WRITER } }
    const r =
      cmd === 'work-units-complete'
        ? await units.sessionTasks.completeById(projectPath, id)
        : await units.sessionTasks.cancelById(projectPath, id)
    return { status: 200, body: r }
  }

  /**
   * **The answer to "did my call land?"** (request receipts design §6). Three states, and 200 for all
   * three: not finding a receipt is an answer, not a failure. Notably it is not a 404 — `NOT_FOUND`
   * means "this Host is here and knows no such id", and the guide says not to retry a 404, which is
   * the precise opposite of what a caller should conclude from `absent`.
   *
   * **Scoped by the asking session, and that is the whole of the access control** (§5). A replay hands
   * back a recorded response, and a response can hold another worker's question or the body of the
   * coordinator's reply — the room `COORDINATOR_ONLY` walls off. So a caller asking about an id that
   * belongs to another session is told `absent`, the same as for an id nobody ever sent, because that
   * is the truth *under its own identity* and anything more would be the second door into that room.
   *
   * **`hostStartedAt` rides on every answer, not only on `absent`.** It is a fact about this Host
   * rather than about the receipt, and the caller that most needs it is the one being told `absent`:
   * receipts live in memory, so a Host that started after the request was sent never saw it and the
   * one that did is gone (§4).
   */
  const requestsShow = (args: Record<string, unknown>, caller: string): Reply => {
    const id = args.id
    // A missing id is the caller's mistake and is worth saying so, rather than answering `absent`
    // about nothing: every answer below is about *some* id, and there is none here to be about.
    if (typeof id !== 'string') return { status: 400, body: { error: 'requests-show needs a request id' } }
    const bad = badRequestId(id)
    if (bad) return { status: 400, body: { error: bad } }
    const hostStartedAt = a.hostStartedAt()
    const held = receipts.get(`${caller}\u0000${id}`)
    if (!held)
      return { status: 200, body: { id, state: 'absent', hostStartedAt, interpretation: interpretationOf.absent(id) } }
    const head = { id, state: held.state, cmd: held.cmd, at: held.at, hostStartedAt }
    if (held.state === 'pending')
      return { status: 200, body: { ...head, interpretation: interpretationOf.pending(id, held.cmd) } }
    return {
      status: 200,
      body: {
        ...head,
        interpretation: interpretationOf.completed(id, held.cmd),
        // **The recorded reply whole, status and all** — what the command answered, error body
        // included, because a caller that lost that answer wants the answer it lost. The status is
        // half of it: a recorded 404 is a different fact from a recorded 200, and the CLI turns the
        // one it is given into the envelope and the exit code the original would have had.
        response: { status: held.reply.status, body: held.reply.body }
      }
    }
  }

  return {
    ready,
    runningRuns: () => runningRunCount(store.get()),
    state: () => store.get(),
    // Atomic: the snapshot and the registration happen in one synchronous step, so no commit falls
    // between the version handed back and the first one delivered.
    subscribe: (deliver) => {
      if (!loaded) return null
      subscribers.add(deliver)
      return { state: sanitizeForController(store.get()), version, unsubscribe: () => void subscribers.delete(deliver) }
    },
    sessionExited: async (e) => {
      await ready()
      // S6 R7: a session some live pty says it was rolled from is not dead work — an app that died
      // between its roll's spawn and its tap's commit left the Dispatch on this id. Rekey, do not close.
      const into = a.rolledInto?.(e.sessionId) ?? null
      if (into && a.rekeyRolled) {
        // Every Host respawn carries rolledFrom, so this also runs after the Host's own rolls, whose tap
        // rekeyed already: then there is nothing left on the old id, and it says so (preflight C13).
        const leftOn = (): boolean => {
          const st = store.get()
          return st.dispatches.some((x) => x.sessionId === e.sessionId && !x.endedAt) || st.runs.some((r) => r.coordinatorSessionId === e.sessionId)
        }
        if (leftOn()) {
          // A coordinator's slot follows through the same tap but gets no retarget: retarget is keyed by
          // a Dispatch, and a coordinator has none.
          await a.rekeyRolled(e.sessionId, into)
          // Asked again (Task 11 review): the tap swallows a refused rekey or a failed commit, so the
          // call returning says nothing about whether the old id was let go.
          if (leftOn()) a.log(`session ${e.sessionId} was rolled into ${into.id} — the rekey did not land, the Dispatch stays on the old id`)
          else a.log(`session ${e.sessionId} was rolled into ${into.id} — rekeyed, not closed`)
        } else {
          a.log(`session ${e.sessionId} was rolled into ${into.id} — already rekeyed, nothing left on the old id`)
        }
        return
      }
      // Marks nobody reads: this is not a command, so there is no reply to correct and no receipt.
      const deps = depsFor(throwaway(), HOST_ACTOR)
      await handleExit(deps, e)
      // The slot rule is `releaseCoordinator`'s in the app, whole, and the same function
      // (`coordinatorReleaseOf`, S6 R14): an exit that only says the session was lost sight of keeps
      // the slot, as `handleExit` keeps the Dispatch. **No second defer**, unlike the app's
      // `PendingCoordinatorReleases`: this handler already runs EXIT_DEFER_MS after the exit
      // (host/exits.ts), the same window the app's release waits, so a roll's rekey has landed by now.
      // Read after `handleExit`, which commits.
      const released = coordinatorReleaseOf(store.get(), e.sessionId, e.exitCode)
      if (!released) return
      await deps.setState(released.state)
      a.log(`coordinator gone run=${released.run.id} session=${e.sessionId} — restart it from the Jobs list`)
    },
    orphanedSessions: (isAlive) => {
      if (!loaded) return []
      const st = store.get()
      const ids = new Set<string>()
      for (const d of st.dispatches)
        if (!d.endedAt && !isPlaceholderSessionId(d.sessionId) && !isAlive(d.sessionId)) ids.add(d.sessionId)
      for (const r of st.runs)
        if (r.coordinatorSessionId && !isAlive(r.coordinatorSessionId)) ids.add(r.coordinatorSessionId)
      return [...ids]
    },
    handle: async (cmd, args) => {
      const marks: CallMarks = { appRefused: false, commits: 0, effects: 0 }
      // Inside the try for `call`'s reason: the loop that asks this must be told, not thrown at.
      try {
        await ready()
        return answerOf(await handleCommand(depsFor(marks, HOST_ACTOR), { sessionId: HOST_CALLER }, cmd, args), marks)
      } catch (err) {
        return failureOf(err, marks)
      }
    },
    internalDeps: () => depsFor(throwaway(), HOST_ACTOR),
    loaded: () => loaded,
    drainOnce: async () => {
      // The load first, and only then the question: a load this call triggers may drain by itself,
      // and asking before it would drain the same queue twice.
      await ready()
      if (drained) return false
      drained = true
      // The queue read again: the load's reading is as old as the load, and the app may have drained
      // some of it since.
      const queued = await readPendingReports({ dir: pendingReportsDirIn(a.profileDir), log: a.log })
      // Caught for the load path's reason, and for one of the driver's: it awaits this before its
      // resume sweep and its pass, so a failure that escaped would cost both. The reports stay on disk
      // for the next start, as they do when the load's drain fails. It still ran, so the answer is true.
      await drain(queued).catch((err) => a.log(`pending reports — the drain failed: ${String(err)}`))
      return true
    },
    call: async ({ cmd, args, sessionId, from, request, retry }) => {
      // **Everything is inside the try, including `state-put` and `ready()`.** `server.ts` answers
      // `orch-call` from this promise and has no catch of its own, so anything that escapes here is
      // not a 500 — it is no `orch-result` at all, a caller waiting forever, and an unhandled
      // rejection that takes the Host down with every terminal it owns. Both of the excluded halves
      // could reject for real: `store.save` is an unguarded mkdir/writeFile/rename, and `state-put`
      // is the app's first message after it connects. The HTTP shell has always turned a throw into
      // a 500 the same way.
      const marks: CallMarks = { appRefused: false, commits: 0, effects: 0 }
      /** The claim this call took, released on **every** way out below — including the catch, which
       *  is why it is declared out here. A claim nobody releases is a request that answers `pending`
       *  forever. */
      let claimed: { key: string; fp: string } | null = null
      /** Set instead of `claimed` when this call is an **observed** replay (§7): the receipt already
       *  holds an answer, and what is running is the fresh look the caller actually wanted. The
       *  recorded reply rides along because a failed observation must not destroy it. */
      let observing: { key: string; fp: string; recorded: Reply } | null = null
      /** What the command is actually run with. The same `args` in every case but one: `ask`'s
       *  observed replay resumes the question the receipt names rather than asking a new one. */
      let runArgs = args
      try {
        // **A controller has no session** (remote runtime design §2.5, D2.1): whatever it named is dropped, so
        // COORDINATOR_ONLY, chats-answer and actorOf never read it as one, and its receipts are keyed by its principal.
        if (from?.role === 'controller') sessionId = ''
        // A retry names the request it retries (§3.9). Without one there is no receipt to look for, and running it
        // as a fresh call is exactly what `retry` exists to prevent.
        if (retry === true && request === undefined) return { status: 400, body: { error: 'retry needs the request id it retries' } }
        // **MCP callers pass the allowlist first** (MCP design §2), before receipts and before the
        // app-only commands, so a refused call leaves no receipt and reaches nothing. Read per call, as
        // `app js` reads its toggle: the app may change it while the Host runs. A settings file that
        // cannot be read refuses (readMcpAccess throws; the catch below answers 500 with its message).
        if (from?.role === 'mcp') {
          const settingsFile = path.join(a.profileDir, 'app-settings.json')
          const refused = mcpRefusal(
            cmd,
            await readMcpAccess(settingsFile),
            await readMcpSessions(settingsFile),
            await readMcpGithubWrite(settingsFile)
          )
          if (refused) return refused
        }
        // **Controllers pass their gate first too** (remote runtime design §3.4, N15), with the permission the Host
        // bound them to (`from.principal`, X1-08), before receipts and before any command, so a refused call leaves
        // no receipt and reaches nothing.
        if (from?.role === 'controller') {
          const refused = controllerRefusal(cmd, from.principal)
          if (refused) return refused
        }
        // **A key presented on these two is refused, not dropped.** They answer above the receipt
        // line below, so a `request` sent with one would be accepted and silently ignored — which is
        // precisely the fault §3 is built on: Orca's `check --peek` takes `--retry-request` and drops
        // it, and "the caller's whole reason for passing the flag is a belief about what happens
        // next". Unreachable today, because only the app sends these and it sends no key; written
        // anyway, because the thing that makes it unreachable is a fact about today's clients and not
        // a property of this code.
        if (
          (cmd === 'state-put' ||
            cmd === 'state-get' ||
            cmd === 'jobs-view' ||
            cmd === 'runs-timeline' ||
            cmd === 'validation-stop' ||
            cmd === 'roll-state' ||
            cmd === 'roll-force' ||
            cmd === 'roll-journal' ||
            cmd === 'slack-reload' ||
            cmd === 'mcp-http-reload' ||
            cmd === 'mcp-http-status' ||
            cmd === 'journal-append' ||
            cmd === 'journal-reload' ||
            cmd === 'understanding-unit' ||
            WORK_UNITS_CALLS.has(cmd) ||
            cmd === 'coordinator-idle' ||
            cmd === 'workspace-list' ||
            cmd === 'workspace-stop' ||
            cmd === 'workspace-close' ||
            cmd === 'workspace-size' ||
            cmd === 'runtime-reload' ||
            cmd === 'runtime-status' ||
            cmd === 'pair-create' ||
            cmd === 'clients-list' ||
            cmd === 'clients-revoke' ||
            WORKTREE_CALLS.has(cmd)) &&
          request !== undefined
        )
          return { status: 400, body: { error: `${cmd} does not take a request id` } }
        if (cmd === 'state-put') return await statePut(args, from)
        // Open to anyone: reading the state is something every CLI client can already do through
        // `jobs-list` and its neighbours, so a refusal here would be a new one nobody needs. The half
        // of it that is not a read — the boot findings — is the app's alone, inside.
        if (cmd === 'state-get') return await stateGet(args, from)
        // **A remote Jobs view's two reads** (remote runtime design Phase 6, X1-05): folded and paged here, with this
        // Runtime's own path rules and facts, so a controller never folds with its own. Read only; anyone may ask.
        if (cmd === 'jobs-view' || cmd === 'runs-timeline') {
          await ready()
          const facts: RuntimeFacts = {
            aliveSessionIds: a.aliveSessionIds(),
            worktrees: a.worktrees?.list?.() ?? [],
            nextFireOf: (id) => a.nextFireOf?.(id) ?? null,
            exists: (p) => existsSync(p),
            journalTimeline: (id, st) => a.journal?.timeline(id, st) ?? []
          }
          return cmd === 'jobs-view' ? jobsViewOf(store.get(), args.project, facts) : runsTimelineOf(store.get(), args, facts)
        }
        // **Answered here, beside the two above, and for the same reason (Host S3, §3.1).** None of
        // the four `worktree-*` names goes through `handleCommand` — the app is their only caller
        // (`HostWorktrees.call` itself checks `from?.role === 'app'`) — so a Host too old to own
        // worktrees answers 501 rather than the coordinator's own commands ever seeing these names.
        // Absent exactly when there is no spawner (R5): with no spawner nothing built in `index.ts`
        // ever reaches `a.worktrees`.
        if (WORKTREE_CALLS.has(cmd))
          return a.worktrees
            ? await a.worktrees.call(cmd, args, from)
            : { status: 501, body: { error: 'this Host does not own worktrees.json' } }
        // **Beside the worktree-* names, for their reason** (S4+S5 §5.1): the app is the only caller,
        // when a person stops a validation run the Host started, and nothing in `handleCommand` knows
        // the name. Above the receipt line: it acts on a pty, not on the state, and the app sends no
        // key. A Host with no checks answers 501, and the app's stop then degrades as §5.1 says.
        if (cmd === 'validation-stop') {
          if (from?.role !== 'app') return { status: 403, body: { error: 'validation-stop is the app’s to send' } }
          if (!a.validationStop) return { status: 501, body: { error: 'this Host does not run validations' } }
          const runId = args.runId
          if (typeof runId !== 'string' || runId === '')
            return { status: 400, body: { error: 'validation-stop needs a runId' } }
          return { status: 200, body: { stopped: a.validationStop(runId) } }
        }
        // **Beside validation-stop, for the same reason (S6 §3.4).** The app's own reads and its own
        // button on a Host chain — never a command layer command, so a Host too old to roll answers
        // 501, exactly as a Host with no checks answers validation-stop.
        if (cmd === 'roll-state' || cmd === 'roll-force') {
          if (from?.role !== 'app') return { status: 403, body: { error: `${cmd} is the app’s to send` } }
          if (!a.rolling) return { status: 501, body: { error: 'this Host does not roll sessions' } }
          const sessionId = args.sessionId
          if (typeof sessionId !== 'string' || sessionId === '') return { status: 400, body: { error: `${cmd} needs a sessionId` } }
          if (cmd === 'roll-state') return { status: 200, body: { state: a.rolling.stateOf(sessionId) } }
          if (!a.rolling.has(sessionId)) return { status: 404, body: { error: `no Host rolling chain for session ${sessionId}` } }
          // 200 either way (S6 final review M1): a chain that declined is not an error, and the app reads
          // `forced: false` as "nothing happened" rather than throwing on a status.
          if (await a.rolling.forceRoll(sessionId)) return { status: 200, body: { forced: true } }
          const now = a.rolling.stateOf(sessionId)?.state ?? 'none'
          return {
            status: 200,
            body: {
              forced: false,
              why: `the chain did not act (roll state: ${now}): it forces only when it is not rolling, waiting or settling after a roll, and no other process holds its pty`
            }
          }
        }
        // **Beside roll-state, for its reason (final round 3, I-A).** The app, when it drives, asks whether a
        // coordinator is parked in `check --wait` here before a fire replaces its Run: every CLI call
        // reaches the Host, so only this process's record (`checkWaits`) sees those waits. A read of
        // memory, never a command layer command, and never a receipt.
        if (cmd === 'coordinator-idle') {
          if (from?.role !== 'app') return { status: 403, body: { error: 'coordinator-idle is the app’s to send' } }
          const runId = args.runId
          const idleSession = args.sessionId
          if (typeof runId !== 'string' || runId === '' || typeof idleSession !== 'string' || idleSession === '')
            return { status: 400, body: { error: 'coordinator-idle needs a runId and a sessionId' } }
          return { status: 200, body: { idle: checkWaits.parked(runId, idleSession) } }
        }
        // **Beside roll-state, for its reason (S6 limits D5).** The app reads what the Host journaled while
        // no app was attached, once after its adoption sweep, and acks it. `ack` prunes the entries up to
        // it before the answer, which is every entry after it.
        if (cmd === 'roll-journal') {
          if (from?.role !== 'app') return { status: 403, body: { error: 'roll-journal is the app’s to send' } }
          if (!a.rollJournal) return { status: 501, body: { error: 'this Host keeps no roll journal' } }
          const ack = args.ack
          if (ack !== undefined && !(Number.isSafeInteger(ack) && (ack as number) >= 0))
            return { status: 400, body: { error: 'roll-journal takes an ack that is a whole number, 0 or more' } }
          return { status: 200, body: await a.rollJournal.take(ack as number | undefined) }
        }
        // **Beside roll-journal, for its reason (Slack in the Host, P17).** The app, after its settings screen
        // wrote slack.json, has the Host read it again. Never a command layer command, never a receipt.
        if (cmd === 'slack-reload') {
          if (from?.role !== 'app') return { status: 403, body: { error: 'slack-reload is the app’s to send' } }
          if (!a.slack) return { status: 501, body: { error: 'this Host does not own Slack' } }
          await a.slack.reload()
          return { status: 200, body: { reloaded: true, active: a.slack.active() } }
        }
        // **Beside slack-reload, for its reason (MCP HTTP design §3).** The settings screen, after it wrote
        // `mcpHttp`, has the Host read it again, and asks the entrance's state. Both answer the state. A reload
        // is a person's action, so a failed entrance is tried again at once (`retry`).
        if (cmd === 'mcp-http-reload' || cmd === 'mcp-http-status') {
          if (from?.role !== 'app') return { status: 403, body: { error: `${cmd} is the app’s to send` } }
          if (!a.mcpHttp) return { status: 501, body: { error: 'this Host does not run the MCP HTTP entrance' } }
          if (cmd === 'mcp-http-reload') await a.mcpHttp.reload({ retry: true })
          return { status: 200, body: a.mcpHttp.status() }
        }
        // **Beside slack-reload, for its reason (Host journal J3, P7).** The app's reconciler rows and its
        // settings changes. Never a command layer command, never a receipt.
        if (cmd === 'journal-append' || cmd === 'journal-reload') {
          if (from?.role !== 'app') return { status: 403, body: { error: `${cmd} is the app’s to send` } }
          if (!a.journal) return { status: 501, body: { error: 'this Host keeps no journal' } }
          if (cmd === 'journal-reload') {
            await ready()
            return { status: 200, body: await a.journal.reload(() => store.get()) }
          }
          const parsed = parseJournalOps(args.ops)
          if ('error' in parsed) return { status: 400, body: { error: parsed.error } }
          return a.journal.append(parsed.ops)
        }
        // **Beside journal-append, for its reason (E1 §4).** A session unit the app's collector closed, sent
        // while this Host writes How It Works. Never a command layer command, never a receipt.
        if (cmd === 'understanding-unit') {
          if (from?.role !== 'app') return { status: 403, body: { error: 'understanding-unit is the app’s to send' } }
          if (!a.understanding) return { status: 501, body: { error: 'this Host does not write How It Works records' } }
          const projectPath = args.projectPath
          if (typeof projectPath !== 'string' || projectPath === '' || !isUnitShaped(args.unit))
            return { status: 400, body: { error: 'understanding-unit needs a projectPath and a unit' } }
          if (!a.understanding.isWriter()) return { status: 409, body: { error: NOT_WRITER } }
          const r = await a.understanding.onUnitClosed(projectPath, args.unit)
          if (r.ok) return { status: 200, body: { accepted: true } }
          return { status: r.reason === NOT_WRITER ? 409 : 500, body: { error: r.reason ?? 'the unit was not recorded' } }
        }
        // **Beside understanding-unit, for its reason (E2 §5).** What only the app sees of session work units:
        // a history-resume fork, the tracking toggle, the renderer's two buttons, and the Job merges the app
        // runs itself. Never a command layer command, never a receipt.
        if (WORK_UNITS_CALLS.has(cmd)) return await workUnitsCall(cmd, args, from)
        // **Beside journal-append, for its reason (agent workspace design).** The mirror tab's reads and
        // its two buttons. Never a command layer command, never a receipt.
        // **The Host's controllers, for local callers only** (remote runtime design §3.3, N18): the app and the CLI on
        // this machine. A controller is refused by its gate before this; MCP by its allowlist; anything else here.
        // **Remote Runtime on this machine, for local callers only** (design §2.9, §3.3): the CLI's `runtime start` and
        // `stop` write remote-runtime.json and then ask for a reload; `status` reads. The link never routes these.
        if (cmd === 'runtime-reload' || cmd === 'runtime-status') {
          if (from?.role !== 'app' && from?.role !== 'cli') return { status: 403, body: { error: `${cmd} is for this machine's app and CLI only` } }
          if (!a.gateway) return { status: 501, body: { error: 'this Host does not run the Remote Gateway' } }
          if (cmd === 'runtime-reload') await a.gateway.reload({ now: true })
          return { status: 200, body: { gateway: a.gateway.status(), clients: a.controllers?.list() ?? [] } }
        }
        if (cmd === 'pair-create' || cmd === 'clients-list' || cmd === 'clients-revoke') {
          if (from?.role !== 'app' && from?.role !== 'cli') return { status: 403, body: { error: `${cmd} is for this machine's app and CLI only` } }
          if (!a.controllers) return { status: 501, body: { error: 'this Host pairs no remote controllers' } }
          if (cmd === 'pair-create') {
            // An unknown level is refused, not widened: the gate denies one, so pairing must not grant one.
            if (args.permission !== undefined && args.permission !== 'read-only' && args.permission !== 'full-control')
              return { status: 400, body: { error: 'permission must be read-only or full-control' } }
            const permission = args.permission === 'read-only' ? 'read-only' : 'full-control'
            const name = typeof args.name === 'string' ? args.name : undefined
            // The code goes to the caller and nowhere else: never into a log line (design §4.4).
            return { status: 200, body: { ...a.controllers.createPairing({ permission, ...(name ? { name } : {}) }), permission } }
          }
          if (cmd === 'clients-list') return { status: 200, body: { clients: a.controllers.list() } }
          const id = args.id
          if (typeof id !== 'string' || id === '') return { status: 400, body: { error: 'clients-revoke needs --id' } }
          const out = await a.controllers.revoke(id)
          // Design §3.3's order: the record and its bindings are gone (inside `revoke`), then its connections close.
          a.closeControllerConns?.(out.conns)
          if (out.saveError !== undefined)
            return { status: 500, body: { error: `revoked until this Host stops, but clients.json could not be written: ${out.saveError}`, clientId: id } }
          return out.revoked ? { status: 200, body: { revoked: true, clientId: id } } : { status: 404, body: { error: `unknown client: ${id}` } }
        }
        if (cmd === 'workspace-list' || cmd === 'workspace-stop' || cmd === 'workspace-close' || cmd === 'workspace-size') {
          if (from?.role !== 'app') return { status: 403, body: { error: `${cmd} is the app’s to send` } }
          if (!a.workspaces) return { status: 501, body: { error: 'this Host has no agent app workspace' } }
          if (cmd === 'workspace-list') return { status: 200, body: { workspaces: a.workspaces.list() } }
          const target = args.sessionId
          if (typeof target !== 'string' || target === '') return { status: 400, body: { error: `${cmd} needs a sessionId` } }
          if (cmd === 'workspace-stop') return { status: 200, body: { stopped: a.workspaces.stop(target) } }
          // The mirror tab's size (HOST_FEATURE_WORKSPACE_SIZE): a size, or null when the tab closed.
          if (cmd === 'workspace-size') {
            if (!a.workspaces.resize(target, args.size)) return { status: 400, body: { error: 'workspace-size needs a size: { width, height } in CSS pixels, or null' } }
            return { status: 200, body: { sized: true } }
          }
          return { status: 200, body: { closed: await a.workspaces.close(target) } }
        }
        // **Request receipts, and still the same synchronous step the call entered in** — nothing
        // above has awaited on this path, so the lookup and the claim cannot be split by a second
        // `orch-call` arriving in between (§7). The three groups above are deliberately on the other
        // side of this line: none of them goes through `handleCommand`, and `state-put` has its own
        // answer to the same problem in ruling F56's version check.
        //
        // **A caller that sent no id skips all of it** and gets the same answer, the same exit code
        // and the same order as before this existed (§9).
        if (request !== undefined) {
          const held = holdRequest(receiptCaller(sessionId, from), request, cmd, args, retry === true)
          // **A refusal is not a replay.** A malformed id and a call that is already in flight both
          // answer from this branch without a receipt behind them, so only the one that really came
          // out of a receipt carries the word.
          if ('answer' in held)
            return held.replayed === true ? { ...held.answer, replayed: true } : held.answer
          if ('observe' in held) {
            observing = { key: held.observe.key, fp: held.observe.fp, recorded: held.observe.recorded }
            runArgs = held.observe.args
          } else claimed = held
        }
        // **Answered by the Host, below the receipt line (plan ruling P2).** The CLI puts an id on every
        // call, so a command above the line would refuse `astera app js` outright.
        if (cmd === 'app-js') {
          const answered = await appJs(args, sessionId, marks)
          return claimed === null ? answered : settleRequest(claimed, cmd, marks, answered)
        }
        // **Answered by the Host, below the receipt line for app-js' reason** (E1 §5): MCP puts a request id
        // on every regenerate_work_record. A generation started marks one effect, so a retried id replays
        // the answer instead of starting a second one; a refusal marks nothing and leaves no receipt.
        if (cmd === 'understanding-regenerate') {
          const answered = await understandingRegenerate(args, from, marks)
          return claimed === null ? answered : settleRequest(claimed, cmd, marks, answered)
        }
        // **Answered by the Host, like the two above — but on *this* side of the receipt line.**
        //
        // Beside them in every other respect: nobody's `case` in `handleCommand` runs, and a Host too
        // old to know it answers 501, which `codeForStatus` turns into exit 9 for free (§8).
        //
        // **Below the line because the CLI will one day put an id on every call** (§8's auto-minting).
        // `state-put`/`state-get` refuse a presented id because the app never sends one and a key on
        // them could only be accepted and ignored; do the same here and `requests show` becomes the
        // one command that stops working the moment every command starts carrying an id. Below the
        // line it needs no rule of its own: it reads, so it commits nothing and acts on nothing, the
        // claim is discarded by `settleRequest`, and it leaves no receipt — exactly what §6's fourth
        // cause says a keyed read should leave.
        //
        // **And the state is not loaded for it.** Receipts are not in the state file (§4), so a `ready()`
        // here would read a file to answer a question the file has nothing to say about.
        if (cmd === 'requests-show') {
          const shown = requestsShow(args, receiptCaller(sessionId, from))
          return claimed === null ? shown : settleRequest(claimed, cmd, marks, shown)
        }
        // **One folder, registered by the person on the Runtime machine** (remote runtime N5): `astera runtime projects
        // add <path>`. Answered and committed by the Host itself, like the other local management commands, because what
        // decides it is the Runtime machine's own: the folder is there, it is absolute, and it is not one of this
        // Host's worktrees. Idempotent like the app's own registration (ensureProject). Below the receipt line: it commits.
        if (cmd === 'projects-add') {
          if (from?.role !== 'app' && from?.role !== 'cli') {
            const refused = { status: 403, body: { error: 'projects-add is for this machine’s app and CLI only' } }
            return claimed === null ? refused : settleRequest(claimed, cmd, marks, refused)
          }
          const p = args.path
          const isDir = typeof p === 'string' && path.isAbsolute(p) && (await stat(p).then((st) => st.isDirectory(), () => false))
          const refusal =
            typeof p !== 'string' || !path.isAbsolute(p)
              ? 'projects-add needs an absolute --path'
              : !isDir
                ? `not a folder on this machine: ${p}`
                : a.worktrees?.isRegistered?.(p)
                  ? `${p} is one of Astera's worktrees; add the repository it belongs to`
                  : null
          if (refusal !== null) {
            const refused = { status: 400, body: { error: refusal } }
            return claimed === null ? refused : settleRequest(claimed, cmd, marks, refused)
          }
          await ready()
          const before = store.get()
          const { state, project } = ensureProject(before, { path: p as string, now: a.now() })
          if (state !== before)
            await depsFor(marks, actorOf({ sessionId, role: from?.role, state: before })).setState(state)
          const added = { status: 200, body: project }
          return claimed === null ? added : settleRequest(claimed, cmd, marks, added)
        }
        // Design §8: a call that arrives before the state is loaded waits, rather than failing.
        await ready()
        // P5: judged on the state the call found, so a worker's report that closes its own Dispatch is
        // still the agent's.
        const actor = actorOf({ sessionId, role: from?.role, client: from?.client, remote: from?.remote, principal: from?.principal, state: store.get() })
        const r = await handleCommand(depsFor(marks, actor), { sessionId, role: from?.role }, cmd, runArgs)
        const answered = answerOf(r, marks)
        // **Who drives, on `status`, from the Host and not from `handleCommand`** (R6): the two fields
        // exist only on a Host that drives, and their absence tells a script this one does not.
        // A driver that cannot say costs the two fields, never the status itself.
        const driving = cmd === 'status' && answered.status === 200 ? driverStatusNow() : null
        const reply =
          driving && typeof answered.body === 'object' && answered.body !== null
            ? { ...answered, body: { ...answered.body, ...driving } }
            : answered
        // **An observed replay says `observed`, not `replayed`** (§7, and `orch-result`'s comment).
        // The id had already taken effect and its commit was not repeated, which is what the caller
        // needs to know; but the command *did* run again and this body is what is true now, so the
        // word that means "the command was not run a second time" would be false here. `check --ack
        // --wait` is the case that matters: its fresh poll can open a delivery nobody has seen, and
        // a caller that skipped it as already handled would lose that batch.
        if (observing) return { ...settleObserved(observing, cmd, observing.recorded, reply), observed: true }
        return claimed === null ? reply : settleRequest(claimed, cmd, marks, reply)
      } catch (err) {
        const reply = failureOf(err, marks)
        if (observing) return { ...settleObserved(observing, cmd, observing.recorded, reply), observed: true }
        return claimed === null ? reply : settleRequest(claimed, cmd, marks, reply)
      }
    }
  }
}
