// The Run-level lifecycle Task (GitHub lifecycle design L1, §3.2): added by Astera in the same write that completes a
// lifecycle Run's last ordinary Task, so no outcome reader ever sees the Run all-terminal in between. Pure.
import { GITHUB_CI_CHECK } from '../github/lifecycle'
import { checkConfigIdsOf, latestImplDispatch } from './convergence'
import { isTerminal, tasksOwnedBy } from './running'
import type { OrchState } from './state'
import { newId, recomputeReady, type Dispatch, type Task } from './types'

export const LIFECYCLE_TASK_TITLE = 'GitHub 전달'
const LIFECYCLE_TASK_SPEC = 'Astera가 이 Run의 브랜치를 GitHub으로 가져갑니다: push, draft PR, CI, 수리, 리뷰. 워커가 없는 Task입니다.'

export const isLifecycleTask = (t: Task): boolean => t.kind === 'lifecycle'

/** The Run's lifecycle Task while it still works: neither completed nor terminally failed. */
export function openLifecycleTaskOf(s: OrchState, runId: string): Task | undefined {
  return s.tasks.find((t) => t.runId === runId && isLifecycleTask(t) && !isTerminal(t))
}

/** The Run's most recently completed ordinary Task that a worker did, with that worker's Dispatch (GitHub lifecycle
 *  §3.4, G3c1): whose provider and accounts a lifecycle Task's repair and review take, having none of its own. Read from
 *  the Run's Tasks, not the lifecycle Task's deps, which a later lifecycle Task (reconverge) would not share. */
export function latestOrdinaryWork(s: OrchState, runId: string): { task: Task; dispatch: Dispatch } | null {
  const done = s.tasks.filter((t) => t.runId === runId && !isLifecycleTask(t) && t.status === 'completed').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  for (const task of done) {
    const dispatch = latestImplDispatch(s, task.id)
    if (dispatch) return { task, dispatch }
  }
  return null
}

/** `s` with the Run's lifecycle Task added when the Run's Job has GitHub lifecycle on, the Run has ordinary Tasks, every
 *  one of them is completed, and the Run has no lifecycle Task yet; else `s` itself. Called by every transition that
 *  moves a Task to completed (applyWorkerDone, applyValidationResult, applyReviewResult, task-update): a table test in
 *  state.test.ts walks each, so a new site without it fails there. A Run that already had one gets the next only from
 *  `runs reconverge` (design §3.5). */
export function withLifecycleTask(s: OrchState, runId: string | undefined, now: string): OrchState {
  if (runId === undefined) return s
  const run = s.runs.find((r) => r.id === runId)
  const job = run && s.jobs.find((j) => j.id === run.jobId)
  if (!job?.github) return s
  const own = tasksOwnedBy(s, runId).filter((t) => t.runId === runId)
  if (own.some(isLifecycleTask)) return s
  if (own.length === 0 || !own.every((t) => t.status === 'completed')) return s
  const checks = [...new Set(own.flatMap((t) => checkConfigIdsOf(t)))]
  const task: Task = {
    id: newId('tsk'),
    runId,
    kind: 'lifecycle',
    title: LIFECYCLE_TASK_TITLE,
    spec: LIFECYCLE_TASK_SPEC,
    deps: own.map((t) => t.id),
    validateConfigIds: [...checks, GITHUB_CI_CHECK],
    reviewRequested: true,
    status: 'pending',
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now
  }
  return { ...s, tasks: recomputeReady([...s.tasks, task]) }
}
