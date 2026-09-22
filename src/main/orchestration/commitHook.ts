// What this app owes an orchestration commit once it has landed — **whichever process made it**
// (ruling F54).
//
// **Why this is a module and not six lines inside one `setState`.** The app stopped being the only
// writer when the Host took the command layer (host control plane design §5, §6): every worker
// command is answered over there, and its commit reaches the app as an `orch-state` push. The push
// handler did two of these things and the app's own `setState` did six, so for a worker-driven
// transition the other four silently did not happen. The visible one was the worst: a two-Task Job
// with no check configuration dispatched Task 1, took its `worker_done`, and stopped — the scheduler
// that would have dispatched Task 2 was in the half the push did not run. One function with two
// callers is the only shape in which that cannot happen again, and a module is the only shape in
// which a test can hold it (`ipc.ts` has none).
import { justFinished } from '../../core/orchestration/runRecord'
import type { ContinuityEvent } from '../../core/continuity/events'
import type { OrchState } from '../../core/orchestration/state'

export interface OrchCommitHook {
  (a: {
    /** The state this commit moved away from — the base the journal and the finished-Run edge are
     *  diffed against. */
    prev: OrchState
    next: OrchState
    /** This is a gap being reconciled rather than a transition seen as it happened — the reconnect
     *  refill, where the state jumped by however many commits the Host made while the socket was
     *  down. Everything still runs **except the git checkpoints**, and that exception has a reason of
     *  its own (see below). */
    catchingUp?: boolean
  }): void
}

export function createOrchCommitHook(deps: {
  /** Job Continuity's journal. Returns the rows this transition produced; failures are logged inside
   *  and never thrown. Absent when the feature is off. */
  record?: (prev: OrchState, next: OrchState) => ContinuityEvent[]
  checkpoint?: (events: ContinuityEvent[], next: OrchState) => Promise<void>
  /** The Jobs sidebar. */
  push: (next: OrchState) => void
  /** One Run that reached a terminal outcome on this commit. Assembling the record is the caller's —
   *  it needs the project key and the understanding pipeline, neither of which is this file's. */
  onRunFinished: (a: { runId: string; outcome: 'completed' | 'failed'; state: OrchState }) => void
  /** The base the *next* commit will be diffed against, and the one this call used. Held by the
   *  caller because it has to survive across both call sites and outlive this closure. */
  previous: () => OrchState | null
  remember: (next: OrchState) => void
  /** The app's scheduler. Fire and forget — the caller attaches the terminal catch. */
  schedule: () => void
  log: (message: string) => void
}): OrchCommitHook {
  return ({ prev, next, catchingUp }) => {
    // **Recorded after the commit was accepted, not before it** (ruling F56/d). The journal used to be
    // written ahead of the write — Job Continuity spec §8's "intent first", so that a crash between
    // the two leaves a row with no projection rather than a projection with no row. That ordering was
    // written when the app was the only writer and a write could not be refused. It can now: a
    // `state-put` the Host rejects as stale leaves rows describing a transition that never happened,
    // and `RecoveryReconciler` reasons from exactly those rows — a false row is read as a positive
    // fact, where a missing one degrades to the conservative `promptConfirmed: false`.
    //
    // **What the move costs, precisely**: a crash in the window between the Host accepting and this
    // line losing that one row. What it does *not* cost is the half that actually protects a worker —
    // "the row lands before the spawn" — because the spawn follows `await deps.setState`, and this
    // runs inside that await.
    const events = deps.record?.(prev, next) ?? []
    // **Skipped while catching up, and this is the one thing a refill must not do.** A checkpoint is
    // not a note that something happened; it is a *git fact captured at the moment it happened*
    // (`writeCheckpoint` reads the worktree's HEAD as it is right now). Written for a transition that
    // landed while the socket was down, an `attempt-started` checkpoint would record a HEAD from
    // after the attempt's own work — and that value is the baseline `changedFilesSince` diffs
    // against, so a wrong one narrows the diff and hides the files it exists to surface (the mistake
    // `Dispatch.stopSnapshot.headCommit` already made once on this branch). No checkpoint is the
    // honest answer: the moment it would have described is gone.
    if (events.length > 0 && !catchingUp)
      deps.checkpoint?.(events, next).catch((e) => deps.log(`continuity: checkpoint failed: ${String(e)}`))
    deps.push(next)
    // A finished Run becomes a record. `previous() ?? next` on the first commit after boot treats
    // "before" as "after" — justFinished(next, next) is always empty — so a Run that was already
    // finished when the app started is not recorded (same rule as D2: the screen holds only what the
    // app watched happen, not what it finds already done).
    //
    // Caught per Run, not around the loop. Several Runs can finish in one commit (runRecord's own
    // test pins that), and a throw while handling the first would silently drop the rest. The catch
    // is needed at all because the commit has already landed by this point: a throw here must not
    // turn a successful write into a command that errors.
    for (const { runId, outcome } of justFinished(deps.previous() ?? next, next)) {
      try {
        deps.onRunFinished({ runId, outcome, state: next })
      } catch (e) {
        deps.log(`run-finished record failed for ${runId}: ${String(e)}`)
      }
    }
    deps.remember(next)
    // **Last, and after the commit** — the scheduler reads the committed state, so running it before
    // the commit lands would have it act on the state this transition replaced.
    //
    // **Running it from a push cannot echo back — but the guarantee is narrower than it looks, and
    // it is worth knowing exactly which one it is.**
    //
    // It is *not* that a push skips the socket that caused it. Only `state-put` answers that way
    // (`toOthers`, src/host/orch.ts); a commit the Host makes itself goes out through
    // `server.broadcast`, which writes to **every** greeted socket including the one whose
    // `orch-call` caused the commit (src/host/server.ts).
    //
    // What actually holds is that the app never sends an `orch-call` that commits. Its whole
    // outbound vocabulary is `state-get` (reads nothing into the file) and `state-put` (answered with
    // `toOthers`) — see `orchCall`'s own note in ipc.ts. So the scheduler's own dispatches are
    // executed in this process against the mirror and leave as `state-put`, and nothing this app does
    // can come back to it as a push.
    //
    // **What would break it**: the app sending any third message type that reaches `handleCommand` in
    // the Host. That commit would be broadcast back here, this hook would run the scheduler on it,
    // and the scheduler's write would go out again — a loop the re-entrancy guard bounds by one turn,
    // not endlessly. If that day comes, the fix is at the Host end (answer a caller's own commit with
    // `toOthers`), not here.
    deps.schedule()
  }
}
