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
  /**
   * Re-drives whatever the state says a restart interrupted. `why` goes in the log line so the reason
   * this ran is readable beside what it did.
   *
   * **Safe to call again, and both halves of that are somebody else's rule.** A Task whose Dispatch is
   * open is not a candidate at all (`interruptedResumes`), so a re-driven review drops out as soon as
   * it has committed one. Inside the window before that commit — and inside the same window after
   * `applyWorkerDone` hands a Task straight to the reviewer — a second drive is refused by
   * `openReviewDispatch` with `dispatch already open`, and `createReviewGate.onOpenRefused` answers
   * that refusal by doing nothing (ruling F37). A validation driven twice is refused later and more
   * cheaply: the runner answers `'skip'` once the Task has left `validating`.
   */
  run(why: string): void
}

export function createResumeSweep(a: {
  /** The mirror, or null while it holds nothing. **Null is not an empty state**: before the Host has
   *  pushed, "nothing is interrupted" would be a guess dressed as an answer. */
  getState(): OrchState | null
  startValidation(a: { taskId: string; cwd: string }): void
  startReview(a: { taskId: string }): void
  now(): string
  log(message: string): void
}): ResumeSweep {
  return {
    run: (why) => {
      const state = a.getState()
      if (!state) return
      const { revalidate, rereview } = interruptedResumes(state, a.now())
      if (revalidate.length === 0 && rereview.length === 0) return
      for (const r of revalidate) a.startValidation(r)
      for (const taskId of rereview) a.startReview({ taskId })
      a.log(
        `restart cleanup (${why}) — restarted ${revalidate.length} interrupted validation(s) and ${rereview.length} interrupted review(s)`
      )
    }
  }
}
