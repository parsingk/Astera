import type { OrchState } from '../orchestration/state'
import type { CheckResult, ReviewSeverity } from '../orchestration/types'
import type { Diagnostic, DiagnosticSeverity } from './diagnostic'

/** A problem as the Job state holds it: its file as the finding wrote it (relative to wherever the check or the review
 *  ran) and the folders to look for it in, newest worker folder first and the Job's folder last. Main resolves it. */
export type RawProblem = Omit<Diagnostic, 'path' | 'stale'> & { file?: string; folders: string[] }

const REVIEW_SEVERITY: Record<ReviewSeverity, DiagnosticSeverity> = {
  critical: 'error',
  high: 'error',
  medium: 'warning',
  low: 'info',
  info: 'info'
}

/** A check's finding without a severity reads as the check went: an error from a check that failed, a warning else. */
const checkSeverity = (c: CheckResult, given: 'error' | 'warning' | undefined): DiagnosticSeverity =>
  given ?? (c.status === 'passed' ? 'warning' : 'error')

/**
 * The first producers of the Problems list (spec W5, audit §8 item 7): what Jobs' completion found, with a place. For each
 * Job with a run among `runIds` (the project's, as main's ownership check gives them), its latest run only, since a later
 * run supersedes an earlier one's findings; of that run's Tasks, the findings of the last check round (plugin checks and
 * GitHub CI, which reaches `checks` as one) and the review issues that name a file.
 */
export function completionProblemsOf(state: OrchState, runIds: ReadonlySet<string>): RawProblem[] {
  const latest = new Map<string, OrchState['runs'][number]>()
  for (const r of state.runs) {
    if (!runIds.has(r.id)) continue
    const seen = latest.get(r.jobId)
    if (!seen || r.ordinal > seen.ordinal) latest.set(r.jobId, r)
  }
  const out: RawProblem[] = []
  for (const run of latest.values()) {
    const jobCwd = state.jobs.find((j) => j.id === run.jobId)?.cwd
    for (const task of state.tasks) {
      if (task.runId !== run.id) continue
      const attempts = state.dispatches.filter((d) => d.taskId === task.id)
      const folders = [
        ...new Set([...attempts].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map((d) => d.cwd)),
        ...(jobCwd !== undefined ? [jobCwd] : [])
      ].filter((f, i, all) => all.indexOf(f) === i)
      const origin = { runId: run.id, taskId: task.id, task: task.title }
      for (const c of task.checks ?? []) {
        ;(c.diagnostics ?? []).forEach((dg, i) => {
          out.push({
            schemaVersion: 1,
            id: `check:${task.id}:${c.configId}:${i}`,
            source: { kind: 'check', id: c.configId, label: c.name },
            severity: checkSeverity(c, dg.severity),
            message: dg.message,
            file: dg.file,
            ...(dg.line !== undefined ? { line: dg.line } : {}),
            ...(c.endedAt !== undefined ? { producedAt: c.endedAt } : {}),
            origin,
            folders
          })
        })
      }
      const reviewedAt = attempts
        .filter((d) => d.review === true && d.endedAt !== undefined)
        .map((d) => d.endedAt as string)
        .sort()
        .at(-1)
      for (const issue of task.reviewIssues ?? []) {
        if (issue.file === undefined) continue
        out.push({
          schemaVersion: 1,
          id: `review:${task.id}:${issue.id}`,
          source: { kind: 'review', id: 'review', label: 'Review' },
          severity: REVIEW_SEVERITY[issue.severity] ?? 'warning',
          message: issue.title,
          file: issue.file,
          ...(issue.line !== undefined ? { line: issue.line } : {}),
          ...(reviewedAt !== undefined ? { producedAt: reviewedAt } : {}),
          origin,
          folders
        })
      }
    }
  }
  return out
}
