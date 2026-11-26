import type { OrchState } from '../orchestration/state'
import type { AskedFinding, CheckResult, ReviewSeverity, Task } from '../orchestration/types'
import { jobName } from '../findings/make'
import type { Diagnostic, DiagnosticSeverity } from './diagnostic'
import { findingRef } from './findingRef'

/** A problem as the Job state holds it: its file as the finding wrote it (relative to wherever the check or the review
 *  ran) and the folders to look for it in, newest worker folder first and the Job's folder last. Main resolves it. */
export type RawProblem = Omit<Diagnostic, 'path' | 'stale' | 'root'> & { file?: string; folders: string[] }

/**
 * Where a Task's findings were made: the folders of its attempts, newest first, then its Job's folder, each once. Main
 * looks for a finding's file in them in this order, and a finding's reference reads an absolute file under one of them as
 * the relative file it is (findingRef `base`), so the Problems row and the Host's repair agree on it.
 */
export function taskFoldersOf(state: Pick<OrchState, 'dispatches' | 'jobs'>, task: Pick<Task, 'id' | 'jobId'>): string[] {
  const jobCwd = state.jobs.find((j) => j.id === task.jobId)?.cwd
  return [
    ...state.dispatches
      .filter((d) => d.taskId === task.id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((d) => d.cwd),
    ...(jobCwd !== undefined ? [jobCwd] : [])
  ].filter((f, i, all) => all.indexOf(f) === i)
}

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

/** The last line of a check's output with anything on it, the check's own last word on why it failed. */
const lastLine = (tail: string | undefined): string | undefined =>
  (tail ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .at(-1)

const failed = (c: CheckResult): boolean => c.status === 'failed' || c.status === 'timed-out' || c.status === 'error'

/**
 * The first producers of the Problems list (spec W5, audit §8 item 7): what Jobs' completion found. For each Job with a
 * run among `runIds` (the project's, as main's ownership check gives them), its latest run only, since a later run
 * supersedes an earlier one's findings; of that run's Tasks:
 * - the findings of the last check round (plugin checks and GitHub CI, which reaches `checks` as one), with one row for
 *   the findings a check counted but kept no detail of;
 * - a failed check with no findings at all (a run configuration's, an unannotated CI failure) as one row without a file,
 *   in its own words (its summary, else its output's last line), so a red Job never reads as no problems;
 * - the review issues that name a file.
 *
 * Tasks and attempts are indexed once per call: this runs on main's thread every time the list is asked for.
 */
export function completionProblemsOf(state: OrchState, runIds: ReadonlySet<string>): RawProblem[] {
  const latest = new Map<string, OrchState['runs'][number]>()
  for (const r of state.runs) {
    if (!runIds.has(r.id)) continue
    const seen = latest.get(r.jobId)
    if (!seen || r.ordinal > seen.ordinal) latest.set(r.jobId, r)
  }
  if (latest.size === 0) return []
  const tasksOf = new Map<string, OrchState['tasks']>()
  for (const t of state.tasks) {
    if (t.runId === undefined) continue
    const list = tasksOf.get(t.runId)
    if (list) list.push(t)
    else tasksOf.set(t.runId, [t])
  }
  const attemptsOf = new Map<string, OrchState['dispatches']>()
  for (const d of state.dispatches) {
    const list = attemptsOf.get(d.taskId)
    if (list) list.push(d)
    else attemptsOf.set(d.taskId, [d])
  }
  const out: RawProblem[] = []
  for (const run of latest.values()) {
    const job = state.jobs.find((j) => j.id === run.jobId)
    for (const task of tasksOf.get(run.id) ?? []) {
      const attempts = attemptsOf.get(task.id) ?? []
      const folders = taskFoldersOf({ dispatches: attempts, jobs: job !== undefined ? [job] : [] }, { id: task.id, jobId: run.jobId })
      const origin = { runId: run.id, taskId: task.id, task: task.title, ...(job !== undefined ? { job: jobName(job) } : {}) }
      for (const c of task.checks ?? []) {
        const source = { kind: 'check' as const, id: c.configId, label: c.name }
        const at = c.endedAt !== undefined ? { producedAt: c.endedAt } : {}
        const findings = c.diagnostics ?? []
        // The check as a whole: what its row without a file and its uncounted findings name
        const checkRef = findingRef({ kind: 'check', taskId: task.id, source: c.configId, message: '' })
        findings.forEach((dg, i) => {
          out.push({
            schemaVersion: 1,
            id: `check:${task.id}:${c.configId}:${i}`,
            ref: findingRef({ kind: 'check', taskId: task.id, source: c.configId, file: dg.file, base: folders, message: dg.message }),
            source,
            severity: checkSeverity(c, dg.severity),
            message: dg.message,
            file: dg.file,
            ...(dg.line !== undefined ? { line: dg.line } : {}),
            ...at,
            origin,
            folders
          })
        })
        const unlisted = (c.diagnosticsTotal ?? findings.length) - findings.length
        if (unlisted > 0) {
          out.push({ schemaVersion: 1, id: `check:${task.id}:${c.configId}:more`, ref: checkRef, source, severity: 'info', message: '', unlisted, ...at, origin, folders })
        }
        if (findings.length === 0 && failed(c)) {
          const said = c.summary !== undefined && c.summary.trim() !== '' && c.summary !== c.status ? c.summary.trim() : lastLine(c.outputTail)
          out.push({ schemaVersion: 1, id: `check:${task.id}:${c.configId}`, ref: checkRef, source, severity: 'error', message: said ?? '', ...at, origin, folders })
        }
      }
      // The last review attempt's end; with none on record (an external reviewer writes its issues without one), the
      // Task's last change, an upper bound on when its issues were written: a later status move can push it past an
      // edit, so such a review can read fresh when it is not. Real reviews close their attempt with an end.
      const reviewedAt =
        attempts
          .filter((d) => d.review === true && d.endedAt !== undefined)
          .map((d) => d.endedAt as string)
          .sort()
          .at(-1) ?? task.updatedAt
      for (const issue of task.reviewIssues ?? []) {
        if (issue.file === undefined) continue
        out.push({
          schemaVersion: 1,
          id: `review:${task.id}:${issue.id}`,
          ref: findingRef({ kind: 'review', taskId: task.id, file: issue.file, base: folders, message: issue.title }),
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

/**
 * What the Problems list is made of, as a key that moves when it does: the runs, and each Task's check rounds (by when
 * they ended and what they found) and review issues. main compares it on every orchestration write and tells the
 * renderer to ask again only when it moved, whatever view is open; a status move alone does not move it.
 */
export function problemsKeyOf(state: OrchState): string {
  const runs = state.runs.map((r) => `${r.id}:${r.jobId}:${r.ordinal}`).join(',')
  const tasks = state.tasks
    .filter((t) => t.runId !== undefined && ((t.checks?.length ?? 0) > 0 || (t.reviewIssues?.length ?? 0) > 0))
    .map((t) => {
      const checks = (t.checks ?? []).map((c) => `${c.configId}/${c.status}/${c.endedAt ?? ''}/${c.diagnostics?.length ?? 0}/${c.diagnosticsTotal ?? ''}`).join('+')
      const reviews = (t.reviewIssues ?? []).map((i) => `${i.id}/${i.file ?? ''}/${i.line ?? ''}`).join('+')
      return `${t.id}:${checks}:${reviews}`
    })
    .join(';')
  return `${runs}|${tasks}`
}

/**
 * A Task's findings as a repair request names them (Phase 3 Part 1, `tasks-repair`): each Problems row of the Task, in
 * the rows' order, with its reference (the same call completionProblemsOf makes for the row) and its words as one line,
 * `severity place who: words`, the way the app's preview writes them. What the Host fills a reference's words from when
 * the CLI names only the reference. A check's uncounted findings have no words of their own and are left out. `folders`
 * is the Task's folders (taskFoldersOf), so a reference matches its row's.
 */
export function taskFindings(task: Task, folders: readonly string[] = []): AskedFinding[] {
  const out: AskedFinding[] = []
  const place = (file: string | undefined, line: number | undefined): string => (file !== undefined ? `${file}${line !== undefined ? `:${line}` : ''} ` : '')
  for (const c of task.checks ?? []) {
    const findings = c.diagnostics ?? []
    for (const dg of findings)
      out.push({
        ref: findingRef({ kind: 'check', taskId: task.id, source: c.configId, file: dg.file, base: folders, message: dg.message }),
        text: `${checkSeverity(c, dg.severity)} ${place(dg.file, dg.line)}${c.name}: ${dg.message}`
      })
    if (findings.length === 0 && failed(c)) {
      const said = c.summary !== undefined && c.summary.trim() !== '' && c.summary !== c.status ? c.summary.trim() : lastLine(c.outputTail)
      out.push({ ref: findingRef({ kind: 'check', taskId: task.id, source: c.configId, message: '' }), text: `error ${c.name}: ${said ?? 'the check failed'}` })
    }
  }
  for (const issue of task.reviewIssues ?? []) {
    if (issue.file === undefined) continue
    out.push({
      ref: findingRef({ kind: 'review', taskId: task.id, file: issue.file, base: folders, message: issue.title }),
      text: `${REVIEW_SEVERITY[issue.severity] ?? 'warning'} ${place(issue.file, issue.line)}Review: ${issue.title}`
    })
  }
  return out
}
