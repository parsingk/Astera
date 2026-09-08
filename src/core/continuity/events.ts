// The Job Continuity journal's events, derived by comparing the orchestration state before and after
// a write (P0 design §5). Derived rather than emitted at each command so no command can forget one —
// the same reason core/orchestration/timeline.ts derives the Timeline. Pure: no fs, no clock; `now`
// is an argument. Main-side (view.ts pulls node:path in): not for tsconfig.web.json.
import type { OrchState } from '../orchestration/state'
import type { Gate, Run, TaskStatus } from '../orchestration/types'
import { outcomeOf } from '../orchestration/view'

export type ContinuityEventType =
  | 'JOB_RUN_STARTED'
  | 'JOB_RUN_PAUSED'
  | 'JOB_RUN_RESUMED'
  | 'JOB_RUN_COMPLETED'
  | 'JOB_RUN_FAILED'
  | 'TASK_BECAME_READY'
  | 'TASK_STARTED'
  | 'TASK_STATE_CHANGED'
  | 'TASK_WAITING_INPUT'
  | 'TASK_CHECK_STARTED'
  | 'TASK_CHECK_PASSED'
  | 'TASK_CHECK_FAILED'
  | 'TASK_COMPLETED'
  | 'TASK_FAILED'
  | 'ATTEMPT_START_REQUESTED'
  | 'ATTEMPT_STARTED'
  | 'ATTEMPT_WAITING'
  | 'ATTEMPT_EXITED'
  | 'ATTEMPT_LOST'
  | 'ATTEMPT_RESUMED'
  | 'ATTEMPT_COMPLETED'
  | 'ATTEMPT_FAILED'
  | 'AGENT_NATIVE_SESSION_BOUND'
  | 'AGENT_NATIVE_SESSION_CHANGED'
  | 'PROMPT_WRITE_REQUESTED'
  | 'PROMPT_WRITE_CONFIRMED'
  | 'CHECKPOINT_CREATED'
  | 'USAGE_LIMIT_DETECTED'
  | 'ACCOUNT_ROLL_REQUESTED'
  | 'ACCOUNT_ROLL_COMPLETED'
  | 'CONTINUITY_ENABLED'

export interface ContinuityEvent {
  runId: string
  taskId?: string
  dispatchId?: string
  type: ContinuityEventType
  /** ISO. The record's own time where it has one (a Dispatch ending, a resume entry), else `now`. */
  at: string
  /** Deterministic for a given observation so the same diff never lands twice: the journal inserts
   *  with `OR IGNORE` on it. Repeatable observations end in the write's `now`; one-shot attempt events
   *  end in the dispatch id (design §5 "Dedupe"). */
  idempotencyKey: string
  payload: Record<string, unknown>
}

const ev = (
  ids: { runId: string; taskId?: string; dispatchId?: string },
  type: ContinuityEventType,
  at: string,
  idempotencyKey: string,
  payload: Record<string, unknown>
): ContinuityEvent => ({ ...ids, type, at, idempotencyKey, payload })

/** A Run with `schedule` is a template and never runs (docs/jobs.md §7); its fires are ordinary Runs. */
const isTemplate = (r: Run): boolean => r.schedule !== undefined

function runStartEvents(prev: OrchState, next: OrchState, now: string): ContinuityEvent[] {
  const before = new Map(prev.runs.map((r) => [r.id, r]))
  const out: ContinuityEvent[] = []
  for (const run of next.runs) {
    if (isTemplate(run)) continue
    const was = before.get(run.id)
    const wasPending = was === undefined || was.pendingStart === true
    if (wasPending && run.pendingStart !== true)
      out.push(
        ev({ runId: run.id }, 'JOB_RUN_STARTED', now, `JOB_RUN_STARTED:${run.id}:${now}`, {
          objective: run.objective,
          cwd: run.cwd,
          worktree: run.worktree ?? null,
          templateId: run.templateId ?? null
        })
      )
  }
  return out
}

function runEndEvents(prev: OrchState, next: OrchState, now: string): ContinuityEvent[] {
  const before = new Map(prev.runs.map((r) => [r.id, r]))
  const out: ContinuityEvent[] = []
  for (const run of next.runs) {
    if (isTemplate(run)) continue
    const was = before.get(run.id)
    if (was && was.paused !== true && run.paused === true)
      out.push(ev({ runId: run.id }, 'JOB_RUN_PAUSED', now, `JOB_RUN_PAUSED:${run.id}:${now}`, {}))
    if (was && was.paused === true && run.paused !== true)
      out.push(ev({ runId: run.id }, 'JOB_RUN_RESUMED', now, `JOB_RUN_RESUMED:${run.id}:${now}`, {}))
    const outcomeBefore = was ? outcomeOf(prev, run.id) : 'running'
    const outcomeAfter = outcomeOf(next, run.id)
    if (outcomeBefore === 'running' && outcomeAfter !== 'running') {
      const type = outcomeAfter === 'completed' ? 'JOB_RUN_COMPLETED' : 'JOB_RUN_FAILED'
      out.push(ev({ runId: run.id }, type, now, `${type}:${run.id}:${now}`, {}))
    }
  }
  return out
}

/** Which events a Task transition is. A check's verdict (validating → a state other than blocked)
 *  comes first; blocked out of validating is a question about an interrupted check, not a verdict.
 *  A passed check leaves validating for completed, or for reviewing when a reviewer is queued
 *  (applyValidationResult) — both are TASK_CHECK_PASSED. */
function taskTransitionEvents(from: TaskStatus, to: TaskStatus): ContinuityEventType[] {
  const check: ContinuityEventType[] =
    from === 'validating' && to !== 'blocked'
      ? [to === 'completed' || to === 'reviewing' ? 'TASK_CHECK_PASSED' : 'TASK_CHECK_FAILED']
      : []
  const main: ContinuityEventType =
    to === 'ready' && from === 'pending'
      ? 'TASK_BECAME_READY'
      : to === 'dispatched'
        ? 'TASK_STARTED'
        : to === 'validating'
          ? 'TASK_CHECK_STARTED'
          : to === 'blocked'
            ? 'TASK_WAITING_INPUT'
            : to === 'completed'
              ? 'TASK_COMPLETED'
              : to === 'failed'
                ? 'TASK_FAILED'
                : 'TASK_STATE_CHANGED'
  // validating → ready (a retry after a failed check): the verdict says it all
  return main === 'TASK_STATE_CHANGED' && check.length > 0 ? check : [...check, main]
}

const latestGate = (gates: Gate[], taskId: string, status: Gate['status']): Gate | undefined =>
  gates
    .filter((g) => g.taskId === taskId && g.status === status)
    .sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt))[0]

function taskEvents(prev: OrchState, next: OrchState, now: string): ContinuityEvent[] {
  const before = new Map(prev.tasks.map((t) => [t.id, t]))
  const out: ContinuityEvent[] = []
  for (const task of next.tasks) {
    // A task that appears already `ready` (no deps: createTask + recomputeReady in one write) became
    // ready; one that appears `pending` has nothing to say yet.
    const from: TaskStatus = before.get(task.id)?.status ?? 'pending'
    const to = task.status
    if (from === to) continue
    const payload: Record<string, unknown> = { from, to }
    if (to === 'blocked') payload.question = latestGate(next.gates, task.id, 'open')?.question ?? null
    if (from === 'blocked') payload.resolution = latestGate(next.gates, task.id, 'resolved')?.resolution ?? null
    for (const type of taskTransitionEvents(from, to))
      out.push(
        ev({ runId: task.runId, taskId: task.id }, type, now, `${type}:${task.id}:${from}->${to}:${now}`, payload)
      )
  }
  return out
}

/** Added by Task 5 of the P0 plan. */
function dispatchEvents(_prev: OrchState, _next: OrchState, _now: string): ContinuityEvent[] {
  return []
}

/** Everything the write prev → next did, in journal order: runs that started, then task transitions,
 *  then dispatch (worker attempt) changes, then runs that paused, resumed or finished. */
export function deriveEvents(prev: OrchState, next: OrchState, now: string): ContinuityEvent[] {
  return [
    ...runStartEvents(prev, next, now),
    ...taskEvents(prev, next, now),
    ...dispatchEvents(prev, next, now),
    ...runEndEvents(prev, next, now)
  ]
}
