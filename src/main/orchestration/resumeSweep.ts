// Re-drives the validations and reviews a restart interrupted, from the state the app already holds.
//
// **Why this exists at all.** The Host outlives the app, and it hands its boot findings out once per
// Host lifetime (`bootHandedOut`, src/host/orch.ts): the first app start after a Host boots gets
// them, and every restart against that same Host gets `boot: null`. That rule is right — `before` and
// the counters describe the one load that produced them — but it leaves a hole this fills. A Task
// left `validating` when the app is killed has nobody to re-drive it: validations are app-local, and
// the recovery reconciler only looks at lost Dispatches. Before the Host owned the state, every app
// boot's `store.load` re-found those Tasks. Now the app finds them itself, in its own mirror, on
// every Host attachment rather than once per Host lifetime.
//
// **The predicate is not here.** It is `interruptedResumes` in core/orchestration/store.ts, which
// `store.load` also calls — one function, because two copies would drift and the drifted copy would
// leave a Task stuck with nothing on screen to say why.
import { interruptedResumes } from '../../core/orchestration/store'
import type { OrchState } from '../../core/orchestration/state'

export interface ResumeSweep {
  /** Re-drives whatever the state says a restart interrupted. `why` goes in the log line so the
   *  reason this ran is readable beside what it did. Safe to call again — see `driven`. */
  run(why: string): void
  /** "A resume for this Task is already under way in this app."
   *
   *  **Called by the ordinary path too, not only by this sweep.** A Task that has just been handed to
   *  the validator or the reviewer by `applyWorkerDone` looks exactly like an interrupted one from
   *  the state: `validating` or `reviewing`, with no open Dispatch yet. A sweep landing in that window
   *  would start a second one — wasteful for a validation (the runner answers `'skip'` once the Task
   *  has moved) and destructive for a review (`openReviewDispatch` refuses the second with "dispatch
   *  already open", and `startReview` answers that refusal by deleting the open review Dispatch and
   *  gating the Task). The boot's pending-report drain is a real instance of that window. */
  markDriven(taskId: string): void
}

export function createResumeSweep(a: {
  /** The mirror, or null while it holds nothing. **Null is not an empty state**: before the Host has
   *  pushed, "nothing is interrupted" would be a guess dressed as an answer. */
  getState(): OrchState | null
  /** Whether agent orchestration itself is on. The wiring runs for any of the four toggles, and with
   *  orchestration off the server answers every worker report with a 409 — a validation started then
   *  could never finish. */
  enabled(): boolean
  startValidation(a: { taskId: string; cwd: string }): void
  startReview(a: { taskId: string }): void
  now(): string
  log(message: string): void
}): ResumeSweep {
  /** Tasks a resume is already under way for, whoever started it.
   *
   *  **The state alone cannot carry this.** A resume only marks the state once `startReview` has
   *  picked an account and committed its Dispatch, which is several awaits later; anything looking in
   *  that window sees the Task exactly as it was. See `markDriven` for what a second start costs.
   *
   *  **An entry is forgotten as soon as the state stops naming that Task**, so the set cannot grow
   *  with the app's uptime and a Task that comes back round is not permanently ignored. */
  const driven = new Set<string>()

  return {
    markDriven: (taskId) => {
      driven.add(taskId)
    },
    run: (why) => {
      const state = a.getState()
      if (!state) return
      const { revalidate, rereview } = interruptedResumes(state, a.now())
      const named = new Set<string>([...revalidate.map((r) => r.taskId), ...rereview])
      for (const id of [...driven]) if (!named.has(id)) driven.delete(id)
      const validations = revalidate.filter((r) => !driven.has(r.taskId))
      const reviews = rereview.filter((id) => !driven.has(id))
      if (validations.length === 0 && reviews.length === 0) return
      if (!a.enabled()) {
        a.log(
          `restart cleanup (${why}) — orchestration is off, so ${validations.length} interrupted validation(s) and ${reviews.length} interrupted review(s) were not restarted; turning it on without restarting does not retry them — a restart with it already on will`
        )
        return
      }
      // Marked before the call, not after: `startReview` is fire-and-forget inside and could reach
      // back here through a synchronous callback.
      for (const r of validations) {
        driven.add(r.taskId)
        a.startValidation(r)
      }
      for (const taskId of reviews) {
        driven.add(taskId)
        a.startReview({ taskId })
      }
      a.log(
        `restart cleanup (${why}) — restarted ${validations.length} interrupted validation(s) and ${reviews.length} interrupted review(s)`
      )
    }
  }
}
