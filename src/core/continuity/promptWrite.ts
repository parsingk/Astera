// Job Continuity's two prompt rows, built from the coordinator's PromptWriteEvent. Not a state
// transition, so they cannot come out of the setState diff: only the coordinator knows when the prompt
// left. In core so the app and the Host (whose workers' prompt writes A19 left unjournaled) build the
// same row. The Run comes from the Task because the event carries no runId.
import { runIdOf, type OrchState } from '../orchestration/state'
import type { PromptWriteEvent } from '../orchestration/exec/coordinator'
import type { JournalActor } from './actor'
import type { ContinuityEvent } from './events'

/** The row for `e`, keyed once per Dispatch and phase, or null when `state` has no such Task. */
export function promptWriteEventOf(
  state: OrchState,
  e: PromptWriteEvent,
  at: string,
  actor?: JournalActor | null
): ContinuityEvent | null {
  const task = state.tasks.find((t) => t.id === e.taskId)
  if (!task) return null
  const type = e.phase === 'requested' ? 'PROMPT_WRITE_REQUESTED' : 'PROMPT_WRITE_CONFIRMED'
  return {
    runId: runIdOf(task),
    taskId: task.id,
    dispatchId: e.dispatchId,
    type,
    at,
    idempotencyKey: `${type}:${e.dispatchId}`,
    payload: { via: e.via, promptLength: e.promptLength, specPath: e.specPath },
    ...(actor ? { actor } : {})
  }
}
