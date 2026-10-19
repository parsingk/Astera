// The Run-level lifecycle Task (GitHub lifecycle design L1, §3.2): added by Astera in the same write that completes a
// lifecycle Run's last ordinary Task, so no outcome reader ever sees the Run all-terminal in between. Pure.
import { GITHUB_CI_CHECK, type MergeReadyEvidence } from '../github/lifecycle'
import { ciTargetNames } from '../github/ciVerdict'
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

const BRIEF_TASKS = 20

/** What a lifecycle Task's repair and review are asked to satisfy (G3c1 final review I1): the Run's objective and the
 *  Tasks folded into its branch, not the lifecycle Task's own placeholder, which describes Astera's carrying. */
export function lifecycleBriefOf(s: OrchState, task: Task): { title: string; spec: string } {
  const run = s.runs.find((r) => r.id === task.runId)
  const job = run && s.jobs.find((j) => j.id === run.jobId)
  const objective = job?.objective.trim() ?? ''
  const own = s.tasks.filter((t) => t.runId === task.runId && !isLifecycleTask(t))
  const shown = own.slice(0, BRIEF_TASKS)
  const lines = shown.map((t) => `- ${t.title}: ${(t.spec.split('\n').find((l) => l.trim() !== '') ?? '').trim().slice(0, 200)}`)
  if (own.length > shown.length) lines.push(`- … ${own.length - shown.length} more`)
  const head = objective.split('\n')[0].slice(0, 80)
  return {
    title: head ? `GitHub: ${head}` : LIFECYCLE_TASK_TITLE,
    spec:
      `This task carries the whole Run to GitHub. What the Run has to achieve:\n\n${objective || '(no objective was written)'}\n\n` +
      `The Tasks folded into this branch:\n${lines.length > 0 ? lines.join('\n') : '- (none)'}`
  }
}

/** What a lifecycle Task's repair is told about GitHub (GitHub lifecycle G3c1, design §4.8). */
export interface LifecycleRepairFacts {
  pr?: { number: number; url: string }
  /** The head Astera pushed last. */
  head?: string
  /** The GitHub check that failed this round, with the class Astera gave it; absent when a local check failed. */
  failing?: { check: string; class?: string; summary: string }
  /** CI failures of this lifecycle Task's earlier rounds, oldest first, at most EARLIER_CI_FAILURES. */
  earlier: { sha?: string; check?: string; class?: string }[]
}

const EARLIER_CI_FAILURES = 5

/** The facts a lifecycle repair is told, from the Run's GitHub record: its pull request, the head pushed, the failing
 *  check of this round when it was GitHub CI's, and the CI failures logged since this lifecycle Task began. */
export function lifecycleRepairFacts(s: OrchState, task: Task): LifecycleRepairFacts {
  const gs = s.runs.find((r) => r.id === task.runId)?.githubState
  // This round's GitHub CI result, when it is the one CI gave (the carrier's own failure — uncommitted changes, no commits
  // — reads nothing from CI; the failure kept from an earlier head is not this round's, G3c1 final review M5)
  const ciResult = (task.checks ?? []).find((c) => c.configId === GITHUB_CI_CHECK && c.status === 'failed')
  const failure = ciResult && gs?.ci?.verdict === 'failed' && gs.ci.failure?.summary === ciResult.summary ? gs.ci.failure : undefined
  const now = failure ? gs?.ci?.sha : undefined
  const earlier = (gs?.log ?? [])
    .filter((e) => e.kind === 'ci-failed' && e.at >= task.createdAt && !(now !== undefined && e.sha === now))
    .slice(-EARLIER_CI_FAILURES)
    .map((e) => ({ ...(e.sha ? { sha: e.sha } : {}), ...(e.check ? { check: e.check } : {}), ...(e.class ? { class: e.class } : {}) }))
  return {
    ...(gs?.binding ? { pr: { number: gs.binding.number, url: gs.binding.url } } : {}),
    ...(gs?.lastPushedSha ? { head: gs.lastPushedSha } : {}),
    ...(failure ? { failing: { check: failure.check, class: failure.class, summary: failure.summary } } : {}),
    earlier
  }
}

/** `s` with the Run's lifecycle Task added when the Run's Job has GitHub lifecycle on, the Run has ordinary Tasks, every
 *  one of them is completed, and the Run has no lifecycle Task yet; else `s` itself. Called by every transition that
 *  moves a Task to completed (applyWorkerDone, applyValidationResult, applyReviewResult, task-update): a table test in
 *  state.test.ts walks each, so a new site without it fails there. A Run that already had one gets the next only from
 *  `runs reconverge` (design §3.5). */
/** Why a passing lifecycle review is not merge-ready (G5b), as `invalidated.reason`. */
export type MergeReadyRefusal = 'not-bound' | 'pr-not-open' | 'head-not-pushed' | 'review-of-another-head' | 'ci-not-passed' | 'question-open' | 'local-check-failed'

/** Merge-ready, decided from state alone when a lifecycle Task's review passes (G5b, design §3.5, §5.4, S3): the pull
 *  request open, its head the one Astera pushed, the review read that head (`reviewHead`), CI passed on it or a person
 *  chose to go on without CI there, no question open on the Run, the local checks passed. The evidence, or the first
 *  part that failed. */
export function mergeReadyOf(
  s: OrchState,
  task: Task,
  review: Dispatch
): { evidence: Omit<MergeReadyEvidence, 'evaluatedAt'> } | { reason: MergeReadyRefusal } {
  const run = s.runs.find((r) => r.id === task.runId)
  const gs = run?.githubState
  if (!run || !gs?.binding) return { reason: 'not-bound' }
  if (gs.pr?.state !== 'open') return { reason: 'pr-not-open' }
  const head = gs.lastPushedSha
  if (head === undefined || gs.headSha !== head) return { reason: 'head-not-pushed' }
  if (review.reviewHead !== head) return { reason: 'review-of-another-head' }
  const ciPassed = gs.ci?.sha === head && gs.ci.verdict === 'passed'
  const noCi = gs.ciOverride?.sha === head
  if (!ciPassed && !noCi) return { reason: 'ci-not-passed' }
  if (s.gates.some((g) => g.runId === run.id && g.status === 'open')) return { reason: 'question-open' }
  if ((task.checks ?? []).some((c) => c.configId !== GITHUB_CI_CHECK && c.status !== 'passed')) return { reason: 'local-check-failed' }
  const selected = s.jobs.find((j) => j.id === run.jobId)?.github?.ci.selectedChecks
  return {
    evidence: {
      pullRequestNumber: gs.binding.number,
      headSha: head,
      localChecksPassed: true,
      requiredCiPassed: ciPassed,
      ...(ciPassed ? {} : { ciOverride: 'no-ci' as const }),
      reviewPassed: true,
      unresolvedQuestions: 0,
      ciChecks: ciPassed && gs.ci ? ciTargetNames(gs.ci.checks, gs.ci.basis, selected) : []
    }
  }
}

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
