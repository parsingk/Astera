// Where each Task of a run stands in completion (MCP design §3): read from Task status, the open
// Dispatch's repair reason and the convergence Gates, never stored. The MCP get_completion tool reads it
// through the Host command `runs-completion`.
import { completionDetailOf, type CompletionDetail } from './completion'
import { policyOf, repairCountOf } from './convergence'
import type { OrchState } from './state'
import type { Task } from './types'

export type CompletionState =
  | 'not-started'
  | 'checking'
  | 'rechecking'
  | 'reviewing'
  | 'fixing'
  | 'fixing-review'
  | 'waiting-for-user'
  | 'exhausted'
  | 'converged'
  | 'failed'

export interface TaskCompletion {
  taskId: string
  title: string
  state: CompletionState
  attempt: number
  maxAttempts: number | null
  detail: CompletionDetail | null
}

export interface RunCompletion {
  runId: string
  jobId: string
  state: CompletionState
  tasks: TaskCompletion[]
}

/** Most urgent first: the run wears the first of these any of its Tasks is in. */
const URGENCY: readonly CompletionState[] = [
  'exhausted',
  'waiting-for-user',
  'fixing',
  'fixing-review',
  'rechecking',
  'checking',
  'reviewing',
  'not-started'
]

// There is no 'needs-fix' state: routeFailure (state.ts) opens the repair Dispatch, or a Gate when it
// cannot, in the same state change that records the failure, so a failed result never sits unattended.
export function taskCompletionState(s: OrchState, task: Task): CompletionState {
  if (task.status === 'completed') return 'converged'
  if (task.status === 'failed') return 'failed'
  if (task.status === 'blocked') {
    const gate = s.gates.find((g) => g.taskId === task.id && g.status === 'open')
    return gate?.kind === 'convergence-exhausted' ? 'exhausted' : 'waiting-for-user'
  }
  if (task.status === 'validating') return repairCountOf(s, task.id) > 0 ? 'rechecking' : 'checking'
  if (task.status === 'reviewing') return 'reviewing'
  if (task.status === 'dispatched') {
    const open = s.dispatches.find((d) => d.taskId === task.id && d.endedAt === undefined && !d.review)
    if (open?.repair === 'check-failure') return 'fixing'
    if (open?.repair === 'review-failure') return 'fixing-review'
  }
  return 'not-started'
}

const withoutOutput = (d: CompletionDetail | null): CompletionDetail | null =>
  d === null ? null : { ...d, checks: d.checks.map(({ outputTail: _drop, ...rest }) => rest) }

export function completionForRun(s: OrchState, runId: string): RunCompletion | null {
  const run = s.runs.find((r) => r.id === runId)
  if (!run) return null
  const tasks = s.tasks
    .filter((t) => t.runId === runId)
    .map(
      (task): TaskCompletion => ({
        taskId: task.id,
        title: task.title,
        state: taskCompletionState(s, task),
        attempt: repairCountOf(s, task.id),
        maxAttempts: policyOf(s, task)?.maxFixAttempts ?? null,
        detail: withoutOutput(completionDetailOf(task))
      })
    )
  const states = tasks.map((t) => t.state)
  const state: CompletionState =
    states.length > 0 && states.every((x) => x === 'converged')
      ? 'converged'
      : states.length > 0 && states.every((x) => x === 'converged' || x === 'failed')
        ? 'failed'
        : (URGENCY.find((u) => states.includes(u)) ?? 'not-started')
  return { runId, jobId: run.jobId, state, tasks }
}
