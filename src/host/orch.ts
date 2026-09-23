// The Host's orchestration: the real command layer over the real store (host control plane design
// §5, §6). This is what replaces the wire slice's `version`-only stub — `server.ts` calls
// `OrchCall.call` and did not change when it did.
import path from 'node:path'
import { handleCommand, type OrchServerDeps } from '../core/orchestration/command'
import { OrchestrationStore, isValidState, type OrchLoadResult } from '../core/orchestration/store'
import { readPendingReports } from '../core/orchestration/pendingDrain'
import { pendingReportsDirIn, reportedDispatchIdsOf } from '../core/orchestration/pendingReports'
import type { OrchState } from '../core/orchestration/state'
import { runningRunCount } from '../core/orchestration/running'
import type { OrchCall, OrchCaller } from '../core/host/orchProtocol'
import { hostOrchDeps } from './orchDeps'

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
 * **The honest reading of each answer, shipped with the answer** (request receipts design §6). Copied
 * from Orca, whose comment is the argument: `absent` is genuinely ambiguous, "so the honest reading
 * ships with the row instead of being re-derived (and softened) by every caller".
 *
 * **And so the guide cannot drift from the runtime.** Orca's guide and Orca's runtime disagree about
 * `pending` today — the guide says to replay it, the runtime refuses — because the sentence was
 * written twice. Here it is written once, and the guide quotes it.
 */
const interpretationOf = {
  completed: (id: string, cmd: string): string =>
    `Request ${id} already took effect (${cmd}). The recorded response is what this Host answered the first time. ` +
    `Treat it exactly as if you had received it then: the ids in it name things that exist. ` +
    `Do not send the command again.`,
  pending: (id: string, cmd: string): string =>
    `Request ${id} is running on this Host right now (${cmd}). Nothing is lost and nothing is decided: wait and ask again. ` +
    `Do not send the command again, because a second attempt while this one is in flight is refused with 409.`,
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
}

export function createHostOrch(a: {
  profileDir: string
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
}): HostOrch {
  const store = new OrchestrationStore(path.join(a.profileDir, 'orchestration.json'))

  /** **Nothing is read at construction, and `host/index.ts` never calls `ready()`.**
   *
   *  The load happens at the first call that needs the state — and, once the app has pushed its state
   *  with `state-put`, never at all. Lazy because a Host that nobody asks anything of has no reason to
   *  touch the file, and memoized because the restart cleanup inside `load` must run exactly once. */
  let loading: Promise<void> | null = null
  /** What that one load found. Handed to the app once, with `state-get` — see `stateGet`. */
  let loadResult: OrchLoadResult | null = null
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
      // **Nothing is applied here**: applying a report reaches session spawning, which is the app's,
      // and the app still reads and drains this same queue at its own boot. So two processes read
      // this folder, and **reading it is not read-only** — `readPendingReports` also sweeps abandoned
      // `.json.tmp` files and renames unreadable reports aside. Why the two sweeps cannot destroy
      // anything between them: the swept set (`.json.tmp`) and the read set (`.json`) are disjoint by
      // suffix; a working file is swept only after an hour untouched (`WORKING_FILE_TTL_MS`), so a
      // write in flight in the other process is never the one swept; and both the `rm` and the
      // `rename` are guarded, so the loser of a race does nothing rather than failing. The one
      // visible effect is cosmetic and belongs to this side: if the app's drain deletes a `.json` it
      // has just applied, between this `readdir` and its `readFile`, the log below says "setting
      // aside … — it is not a report this app can read" about a report that applied perfectly well.
      const queued = await readPendingReports({ dir: pendingReportsDirIn(a.profileDir), log: a.log })
      loadResult = await store.load({
        aliveSessionIds: a.aliveSessionIds(),
        reportedDispatchIds: reportedDispatchIdsOf(queued.map((q) => q.report))
      })
    })())

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
   *  **`committed` and `acted` are the two halves of "did this call do anything"** (request receipts
   *  design §3), and a receipt is kept only when one of them is set. They ride here rather than in a
   *  second object because this one is already built per call, and a flag that lives no longer than
   *  the call it belongs to cannot be read by the next one. */
  type CallMarks = { appRefused: boolean; committed: boolean; acted: boolean }

  /** **Built per call**, because the marks above are. One object literal per call costs nothing
   *  beside running a command. */
  const depsFor = (marks: CallMarks): OrchServerDeps =>
    hostOrchDeps({
      getState: () => store.get(),
      setState: async (next) => {
        // Reserved before the write, for `reserveVersion`'s reason and for one that is this path's
        // own: a `state-put` arriving while this commit is still writing would otherwise read the
        // pre-commit number, pass the check, and land a whole state that does not contain this
        // commit — the exact loss ruling F56 is about, with the Host as the losing side.
        const committed = reserveVersion()
        // Marked here rather than after the write, in the same synchronous step as the number it
        // takes: `store.save` moves memory before it queues the disk write, so this state is the one
        // every later command reads even if the file write then fails. A receipt that said otherwise
        // would let a retry re-run a command whose effect the next command can already see.
        marks.committed = true
        await store.save(next)
        a.onState(next, committed)
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
      onEffect: () => {
        marks.acted = true
      },
      onAppRequired: (name, why) => {
        marks.appRefused = true
        a.log(`${name} could not be put to the app: ${why}`)
      }
    })

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
    const sent = args.version
    if (typeof sent === 'number' && sent !== version)
      return {
        status: 409,
        body: {
          error: `the state moved on: this Host is at version ${version}, the write was built on ${sent}`,
          state: store.get(),
          version
        }
      }
    // Taken here, not after the write lands — the whole of `reserveVersion`'s note.
    const committed = reserveVersion()
    await store.save(state)
    // To the others and not back to the sender: the state came from there, and an app that received
    // its own push would write its own state back over itself.
    from.toOthers({ t: 'orch-state', state, version: committed })
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
     *  it is when this receipt reached the state it is in, not when the call arrived. */
    | { state: 'pending'; cmd: string; at: string }
    | { state: 'completed'; cmd: string; at: string; reply: Reply }
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
   */
  const holdRequest = (
    sessionId: string,
    requestId: string,
    cmd: string,
    args: Record<string, unknown>
  ): { answer: Reply } | { observe: { key: string; recorded: Reply; args: Record<string, unknown> } } | { key: string } => {
    const bad = badRequestId(requestId)
    if (bad) return { answer: { status: 400, body: { error: bad } } }
    const key = `${sessionId}\u0000${requestId}`
    const held = receipts.get(key)
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
        receipts.set(key, { state: 'pending', cmd, at: a.now() })
        return { observe: { key, recorded: held.reply, args: observed.afresh(args, held.reply) } }
      }
      // Byte for byte what the first attempt answered, including its status — the point of a replay
      // is that it is indistinguishable from having received the first answer.
      return { answer: held.reply }
    }
    if (held)
      return {
        answer: {
          status: 409,
          body: {
            error: `request ${requestId} is already running — wait for that answer rather than sending it again`
          }
        }
      }
    receipts.set(key, { state: 'pending', cmd, at: a.now() })
    return { key }
  }

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
  const remember = (key: string, entry: { state: 'completed'; cmd: string; at: string; reply: Reply }): void => {
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
  const settleRequest = (key: string, cmd: string, marks: CallMarks, reply: Reply): Reply => {
    // Deleted first even when a receipt follows: `Map.set` leaves an existing key where it was, and
    // the sweep reads insertion order as "how recently this was written". A receipt that kept its
    // claim's place would be evicted ahead of older ones that were merely claimed later.
    receipts.delete(key)
    if (marks.committed || marks.acted) remember(key, { state: 'completed', cmd, at: a.now(), reply })
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
  const settleObserved = (key: string, cmd: string, recorded: Reply, reply: Reply): Reply => {
    receipts.delete(key)
    remember(key, { state: 'completed', cmd, at: a.now(), reply: reply.status < 400 ? reply : recorded })
    return reply
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
  const requestsShow = (args: Record<string, unknown>, sessionId: string): Reply => {
    const id = args.id
    // A missing id is the caller's mistake and is worth saying so, rather than answering `absent`
    // about nothing: every answer below is about *some* id, and there is none here to be about.
    if (typeof id !== 'string') return { status: 400, body: { error: 'requests-show needs a request id' } }
    const bad = badRequestId(id)
    if (bad) return { status: 400, body: { error: bad } }
    const hostStartedAt = a.hostStartedAt()
    const held = receipts.get(`${sessionId}\u0000${id}`)
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
    call: async ({ cmd, args, sessionId, from, request }) => {
      // **Everything is inside the try, including `state-put` and `ready()`.** `server.ts` answers
      // `orch-call` from this promise and has no catch of its own, so anything that escapes here is
      // not a 500 — it is no `orch-result` at all, a caller waiting forever, and an unhandled
      // rejection that takes the Host down with every terminal it owns. Both of the excluded halves
      // could reject for real: `store.save` is an unguarded mkdir/writeFile/rename, and `state-put`
      // is the app's first message after it connects. The HTTP shell has always turned a throw into
      // a 500 the same way.
      const marks: CallMarks = { appRefused: false, committed: false, acted: false }
      /** The claim this call took, released on **every** way out below — including the catch, which
       *  is why it is declared out here. A claim nobody releases is a request that answers `pending`
       *  forever. */
      let claimed: string | null = null
      /** Set instead of `claimed` when this call is an **observed** replay (§7): the receipt already
       *  holds an answer, and what is running is the fresh look the caller actually wanted. The
       *  recorded reply rides along because a failed observation must not destroy it. */
      let observing: { key: string; recorded: Reply } | null = null
      /** What the command is actually run with. The same `args` in every case but one: `ask`'s
       *  observed replay resumes the question the receipt names rather than asking a new one. */
      let runArgs = args
      try {
        // **A key presented on these two is refused, not dropped.** They answer above the receipt
        // line below, so a `request` sent with one would be accepted and silently ignored — which is
        // precisely the fault §3 is built on: Orca's `check --peek` takes `--retry-request` and drops
        // it, and "the caller's whole reason for passing the flag is a belief about what happens
        // next". Unreachable today, because only the app sends these and it sends no key; written
        // anyway, because the thing that makes it unreachable is a fact about today's clients and not
        // a property of this code.
        if ((cmd === 'state-put' || cmd === 'state-get') && request !== undefined)
          return { status: 400, body: { error: `${cmd} does not take a request id` } }
        if (cmd === 'state-put') return await statePut(args, from)
        // Open to anyone: reading the state is something every CLI client can already do through
        // `jobs-list` and its neighbours, so a refusal here would be a new one nobody needs. The half
        // of it that is not a read — the boot findings — is the app's alone, inside.
        if (cmd === 'state-get') return await stateGet(args, from)
        // **Request receipts, and still the same synchronous step the call entered in** — nothing
        // above has awaited on this path, so the lookup and the claim cannot be split by a second
        // `orch-call` arriving in between (§7). The two commands above are deliberately on the other
        // side of this line: neither goes through `handleCommand`, the app is the only client that
        // sends them, and `state-put` has its own answer to the same problem in ruling F56's version
        // check.
        //
        // **A caller that sent no id skips all of it** and gets the same answer, the same exit code
        // and the same order as before this existed (§9).
        if (request !== undefined) {
          const held = holdRequest(sessionId, request, cmd, args)
          if ('answer' in held) return held.answer
          if ('observe' in held) {
            observing = { key: held.observe.key, recorded: held.observe.recorded }
            runArgs = held.observe.args
          } else claimed = held.key
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
          const shown = requestsShow(args, sessionId)
          return claimed === null ? shown : settleRequest(claimed, cmd, marks, shown)
        }
        // Design §8: a call that arrives before the state is loaded waits, rather than failing.
        await ready()
        const r = await handleCommand(depsFor(marks), { sessionId }, cmd, runArgs)
        // Only an error reply is rewritten: a command that carried on past a refusal it swallowed
        // (the fire-and-forget ones) succeeded, and a success is not a conflict.
        const reply = r.status >= 400 && marks.appRefused ? { status: 409, body: r.body } : r
        if (observing) return settleObserved(observing.key, cmd, observing.recorded, reply)
        return claimed === null ? reply : settleRequest(claimed, cmd, marks, reply)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const reply = { status: marks.appRefused ? 409 : 500, body: { error: message } }
        if (observing) return settleObserved(observing.key, cmd, observing.recorded, reply)
        return claimed === null ? reply : settleRequest(claimed, cmd, marks, reply)
      }
    }
  }
}
