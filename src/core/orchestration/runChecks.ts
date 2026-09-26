// `astera runs checks` (CLI spec §20): each Task's completion checks and what they came to.
//
// **No new engine.** The spec is explicit, and nothing here runs, schedules or judges a check. It reads
// what the engine already left in OrchState: `Task.checks` is the last validation round, overwritten each
// round (types.ts), and a review is a Dispatch marked `review` with `Task.reviewIssues` beside it
// (state.ts `applyReviewResult`). The words it answers with are the ones those records already use.
//
// **Pure, and beside view.ts for view.ts's reason**: the verdict rules are the part worth testing, and a
// test reaches them here without a Host or a socket.
import { checkConfigIdsOf, policyOf } from './convergence'
import type { OrchState } from './state'
import type { CheckResult, ReviewIssue, Task, TaskStatus } from './types'

/**
 * Where one kind of check stands for one Task.
 * - `not-required`: the Task asked for none.
 * - `pending`: asked for, and no round has given an answer yet.
 * - `running`: a round is under way now.
 * - `passed` / `failed`: what the last round that gave an answer said.
 */
export type CheckStanding = 'not-required' | 'pending' | 'running' | 'passed' | 'failed'

export interface TaskValidation {
  /** Whether the Task names run configurations to validate with (`tasks add --validate`). */
  required: boolean
  status: CheckStanding
  /** The last round, each check as the engine recorded it. Empty before the first round. */
  checks: CheckResult[]
}

export interface TaskReview {
  /** Whether the Task asked for a review (`tasks add --review`), or has had one. */
  required: boolean
  status: CheckStanding
  /** The verdict of the last review that gave one, even while a later one runs; null before any. */
  verdict: 'accepted' | 'rejected' | null
  /** The last review's findings, each with whether the Job's policy counts it as blocking. */
  issues: ReviewIssue[]
}

export interface TaskChecks {
  /** The Task's id, named `id` as in `tasks list`, so `--quiet` prints the Task ids. */
  id: string
  title: string
  status: TaskStatus
  validation: TaskValidation
  review: TaskReview
  /** One line on what failed, validation first; null when nothing did. */
  failureSummary: string | null
  /** A person moved the Task to completed without the checks being met, and why. */
  completionOverride?: { reason: string; at: string }
}

export interface RunChecks {
  runId: string
  jobId: string
  tasks: TaskChecks[]
}

/** The last line of a check's output with anything on it, cut to a length a summary can carry. */
const lastLine = (tail: string | undefined): string | null => {
  const line = (tail ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1)
  return line === undefined ? null : line.slice(0, 200)
}

const firstLine = (text: string | undefined): string | null => {
  const line = (text ?? '').split(/\r?\n/)[0].trim()
  return line === '' ? null : line.slice(0, 200)
}

const checkFailed = (c: CheckResult): boolean => c.status === 'failed' || c.status === 'timed-out'

function validationOf(task: Task): TaskValidation {
  const checks = task.checks ?? []
  const required = checkConfigIdsOf(task).length > 0 || checks.length > 0
  const status: CheckStanding = !required
    ? 'not-required'
    : task.status === 'validating'
      ? 'running'
      : checks.some(checkFailed)
        ? 'failed'
        : checks.length > 0 && checks.every((c) => c.status === 'passed')
          ? 'passed'
          : 'pending'
  return { required, status, checks }
}

function reviewOf(s: OrchState, task: Task): TaskReview {
  const reviews = s.dispatches
    .filter((d) => d.taskId === task.id && d.review === true)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const issues = task.reviewIssues ?? []
  const required = task.reviewRequested === true || reviews.length > 0
  if (!required) return { required, status: 'not-required', verdict: null, issues }
  const decided = reviews.filter((d) => d.outcome !== undefined).at(-1)
  // **Which rule decides is the Job's policy, as in `applyReviewResult`.** Without one the reviewer's
  // own outcome is the verdict. With one, the app classifies the findings, and any blocking one rejects.
  const verdict: TaskReview['verdict'] =
    decided === undefined
      ? null
      : decided.outcome === 'failed' || (policyOf(s, task) !== null && issues.some((i) => i.blocking))
        ? 'rejected'
        : 'accepted'
  const open = reviews.some((d) => d.outcome === undefined && d.endedAt === undefined)
  // A review that closed without a verdict (stopped, or lost with the app) leaves the one before it
  // standing, and the Task needs another review: that is `pending`, not the old verdict's standing.
  const lostLast = reviews.length > 0 && reviews.at(-1) !== decided
  const status: CheckStanding =
    task.status === 'reviewing' || open
      ? 'running'
      : verdict === null || lostLast
        ? 'pending'
        : verdict === 'accepted'
          ? 'passed'
          : 'failed'
  return { required, status, verdict, issues }
}

function summaryOf(task: Task, validation: TaskValidation, review: TaskReview): string | null {
  const parts: string[] = []
  if (validation.status === 'failed')
    for (const c of validation.checks.filter(checkFailed)) {
      const exit = c.exitCode === undefined ? '' : ` (exit ${c.exitCode})`
      const line = lastLine(c.outputTail)
      parts.push(`${c.name} ${c.status === 'timed-out' ? 'timed out' : 'failed'}${exit}${line === null ? '' : `: ${line}`}`)
    }
  if (review.status === 'failed') {
    const blocking = review.issues.filter((i) => i.blocking)
    if (blocking.length > 0)
      parts.push(
        `review: ${blocking
          .map((i) => `${i.severity.toUpperCase()} ${i.title}${i.file ? ` (${i.file}${i.line !== undefined ? `:${i.line}` : ''})` : ''}`)
          .join(', ')}`
      )
    else {
      // Without a policy the reviewer's reason is kept only as the Task's result (applyReviewResult).
      const why = firstLine(task.result)
      parts.push(why === null ? 'review rejected' : `review rejected: ${why}`)
    }
  }
  return parts.length === 0 ? null : parts.join('; ')
}

/** Every Task of the run, in the order they were made, with its checks. Null for a run not there. */
export function checksForRun(s: OrchState, runId: string): RunChecks | null {
  const run = s.runs.find((r) => r.id === runId)
  if (!run) return null
  const tasks = s.tasks
    .filter((t) => t.runId === runId)
    .map((task): TaskChecks => {
      const validation = validationOf(task)
      const review = reviewOf(s, task)
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        validation,
        review,
        failureSummary: summaryOf(task, validation, review),
        ...(task.completionOverride ? { completionOverride: task.completionOverride } : {})
      }
    })
  return { runId, jobId: run.jobId, tasks }
}
