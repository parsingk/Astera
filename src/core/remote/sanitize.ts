import type { OrchState } from '../orchestration/state'
import type { CheckResult } from '../orchestration/types'

/** A check as a controller sees it: the output body is gone, its length stays. */
export type ControllerCheck = Omit<CheckResult, 'outputTail'> & { outputTailLength?: number }

/**
 * The state a controller is shown (remote runtime design §3.6, D10.2). A check's output tail is up to
 * 4,000 characters per check, carried on every push of the whole state. Keeping it out keeps pushes
 * small; a controller that wants the output asks for it (`tasks-check-output`). It is told the length.
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
