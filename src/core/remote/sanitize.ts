import type { OrchState } from '../orchestration/state'
import type { CheckResult } from '../orchestration/types'

/** A check as a controller sees it: the output body is gone, its length stays. */
export type ControllerCheck = Omit<CheckResult, 'outputTail'> & { outputTailLength?: number }

/**
 * The state a controller is shown (remote runtime design §3.6, D10.2). A check's output tail is the
 * one body in the state that carries raw process output, and output can carry whatever the check
 * printed, secrets included. A controller is told how long it was, not what it said.
 *
 * Pure and copying: the Host's own state is never touched, so the one object the store holds stays
 * the one every local caller reads. Typed as an OrchState because every other field is unchanged;
 * the checks inside are ControllerChecks.
 */
export function sanitizeForController(state: OrchState): OrchState {
  return {
    ...state,
    tasks: state.tasks.map((t) =>
      t.checks
        ? {
            ...t,
            checks: t.checks.map(({ outputTail, ...c }): ControllerCheck =>
              outputTail === undefined ? c : { ...c, outputTailLength: outputTail.length }
            )
          }
        : t
    )
  }
}
