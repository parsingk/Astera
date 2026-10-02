// Which Runs stopped running between two orchestration states, and the record each one gets.
//
// **A transition, not a state.** `outcomeOf` is derived — it recomputes from the tasks every time it
// is asked (see its comment in view.ts) — so "this Run is finished" is true on every round after the
// last task lands. Recording on the state would write the same record forever; recording on the edge
// writes it once.
import { outcomeOf } from './view'
import { jobOf, type OrchState } from './state'
import type { RunRecordInput } from '../understanding/pipeline'

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

/**
 * The How It Works record of a finished Run, keyed by its Job's cwd (unfolded: each writer folds a
 * worktree onto its repository over its own registry). **One builder for both writers**, the app's
 * commit hook and the Host's commits (E1 §3), so a record reads the same whoever made it. Null when the
 * Run or its Job is gone. The validation follows `outcomeOf`, which for a Run `justFinished` named is the
 * outcome it named.
 */
export function runRecordInputOf(state: OrchState, runId: string): (RunRecordInput & { projectPath: string }) | null {
  const run = state.runs.find((r) => r.id === runId)
  if (!run) return null
  const job = jobOf(state, run)
  if (!job) return null
  const tasks = state.tasks.filter((t) => t.runId === runId)
  return {
    projectPath: job.cwd,
    runId,
    jobName: job.objective.slice(0, 60),
    objective: job.objective,
    at: new Date().toISOString(),
    taskIds: tasks.map((t) => t.id),
    tasks: tasks.map((t) => ({ title: t.title, outcome: t.status })),
    changedFiles: [...new Set(tasks.flatMap((t) => t.filesModified ?? []))],
    validation: { status: outcomeOf(state, runId) === 'completed' ? 'passed' : 'failed' }
  }
}
