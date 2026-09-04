// Runs a LaunchPlan. Everything it decides came from core/run/launch.ts; what is left here is the
// waiting — which is why the two RunManager calls it needs are injected rather than reached for.
import type { RunStatus } from '../../core/run/config'
import type { LaunchPlan } from '../../core/run/launch'

export interface LaunchDeps {
  /** Starts one configuration exactly as a bare ▶ would: decideStart, then start or restart.
   *  decideStart is evaluated **when the step runs**, not when the plan was made — a server that was
   *  live when ▶ was pressed and exited during the build must be started, not restarted. */
  startOne: (configId: string) => Promise<RunStatus>
  whenExited: (runId: string) => Promise<number | null>
  /** The run the console should move to: the configuration whose ▶ was actually pressed. The whole
   *  status, not just the id — the renderer has to know which project it belongs to before it moves
   *  the selection, and that is on the status. */
  onFocus: (status: RunStatus) => void
  onFailed: (configId: string, detail: string) => void
}

/** Starts the plan and resolves with the run the panel should open on — the first step's. The rest of
 *  the chain continues after this resolves; the renderer follows it through run:status and run:focus.
 *
 *  There is no cancellation path, and none is needed: quitting the app kills the live runs, a user's
 *  ⏹ kills one, and either way the exit code is not 0, which is what stops every pending step. */
export async function executeLaunch(
  plan: Extract<LaunchPlan, { ok: true }>,
  deps: LaunchDeps
): Promise<RunStatus> {
  // The plan arrives topologically sorted, so one forward pass can build each step's promises and
  // always find its dependencies' promises already made.
  const done = new Map<string, Promise<number | null>>()
  let first: Promise<RunStatus> | undefined

  for (const step of plan.steps) {
    const isFirst = first === undefined
    const gate = Promise.all(step.after.map((id) => done.get(id) ?? Promise.resolve(null)))
    const started: Promise<RunStatus | null> = gate.then(async (codes) => {
      // A skipped step's exit code is null too, so skipping propagates with no rule of its own.
      if (!codes.every((c) => c === 0)) return null
      try {
        const status = await deps.startOne(step.configId)
        if (step.configId === plan.focusId) deps.onFocus(status)
        return status
      } catch (e) {
        // The first step's failure is run.start's own rejection, and the renderer already toasts
        // that — reporting an event as well would say it twice. Only a later step needs one: by then
        // run.start has long resolved and there is nothing else carrying the news.
        if (isFirst) throw e
        deps.onFailed(step.configId, e instanceof Error ? e.message : String(e))
        return null
      }
    })
    // The first step waits on nothing, so its gate cannot skip it — it either produces a run or
    // throws. That is claimed, not merely hoped: topoSort filters `after` to recorded step ids while
    // the steps it returns carry the unfiltered list, so the two could diverge in a future change and
    // let this gate skip after all. The throw below is what enforces the invariant where it is
    // claimed — without it a skipped first step would resolve null and the caller would read .runId
    // off it.
    if (isFirst) {
      first = started.then((st): RunStatus => {
        if (st === null) throw new Error('LAUNCH_FIRST_STEP_SKIPPED')
        return st
      })
    }
    // .catch keeps a rejected first step from leaving later gates with an unhandled rejection; they
    // read it as "did not run", the same as a skip.
    done.set(
      step.configId,
      started.then((st) => (st ? deps.whenExited(st.runId) : null)).catch(() => null)
    )
  }

  // prepareLaunch refuses a plan with no steps before this is reached (a compound whose members
  // amount to nothing), so this is a guard against a future planner change, not a reachable state.
  if (!first) throw new Error('LAUNCH_EMPTY')
  return first
}
