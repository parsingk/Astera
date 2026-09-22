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
    /** The journal rows this commit's intent already produced, when the caller wrote them **before**
     *  the commit. That is this app's own write path and it is deliberate (Job Continuity spec §8,
     *  intent first: a crash between the two must leave a row with no projection, never a projection
     *  with no row). A commit that happened in the Host cannot have that ordering, so the push path
     *  leaves this out and the rows are written here instead. */
    journalled?: ContinuityEvent[]
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
  return ({ prev, next, journalled }) => {
    const events = journalled ?? deps.record?.(prev, next) ?? []
    if (events.length > 0)
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
    // **Running it from a push cannot echo back, and it is the protocol that says so rather than
    // anything here.** `orch-state` goes to every *other* greeted socket and never to the sender
    // (`toOthers` in src/host/orch.ts), so a dispatch this app makes in answer to a push comes back
    // as a reply, not as another push to this app. If that ever changes, this becomes a loop — the
    // scheduler's own re-entrancy guard bounds one turn of it, not an endless chain of them.
    deps.schedule()
  }
}
