// Which Runs stopped running between two orchestration states.
//
// **A transition, not a state.** `outcomeOf` is derived — it recomputes from the tasks every time it
// is asked (see its comment in view.ts) — so "this Run is finished" is true on every round after the
// last task lands. Recording on the state would write the same record forever; recording on the edge
// writes it once.
import { outcomeOf } from './view'
import type { OrchState } from './state'

export function justFinished(
  before: OrchState,
  after: OrchState
): { runId: string; outcome: 'completed' | 'failed' }[] {
  const out: { runId: string; outcome: 'completed' | 'failed' }[] = []
  for (const run of after.runs) {
    const now = outcomeOf(after, run.id)
    if (now === 'running') continue
    if (outcomeOf(before, run.id) !== 'running') continue
    out.push({ runId: run.id, outcome: now })
  }
  return out
}
