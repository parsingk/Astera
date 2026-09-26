// `runs checks` (CLI spec §20): each Task's completion checks, read from what OrchState already holds.
// No engine runs here: validation is `Task.checks` (the last round), and review is the Task's review
// Dispatches and `Task.reviewIssues`.
import { describe, it, expect } from 'vitest'
import { checksForRun } from './runChecks'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'
import type { CheckResult, Dispatch, Job, JobRun, ReviewIssue, Task } from './types'

const NOW = '2026-08-04T00:00:00.000Z'

const job = (over: Partial<Job> = {}): Job => ({ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: NOW, ...over })
const run: JobRun = { id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW }
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  runId: 'run_1',
  title: `title ${id}`,
  spec: 's',
  deps: [],
  status: 'completed',
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})
const review = (id: string, taskId: string, over: Partial<Dispatch> = {}): Dispatch => ({
  id,
  taskId,
  provider: 'codex',
  accountId: 'acc',
  sessionId: `s_${id}`,
  cwd: 'D:/p',
  specPath: 'D:/p/spec.md',
  startedAt: NOW,
  workerState: 'stopped',
  retained: false,
  review: true,
  ...over
})
const check = (over: Partial<CheckResult>): CheckResult => ({ configId: 'cfg_build', name: 'build', status: 'passed', ...over })
const issue = (over: Partial<ReviewIssue>): ReviewIssue => ({
  id: 'iss_1',
  severity: 'high',
  blocking: true,
  title: 'missing test',
  description: 'd',
  ...over
})

const stateWith = (tasks: Task[], dispatches: Dispatch[] = [], j: Job = job()): OrchState => ({
  ...emptyState(),
  jobs: [j],
  runs: [run],
  tasks,
  dispatches
})

const rowOf = (s: OrchState, id: string) => {
  const r = checksForRun(s, 'run_1')
  if (r === null) throw new Error('run not found')
  const row = r.tasks.find((t) => t.id === id)
  if (!row) throw new Error(`no row for ${id}`)
  return row
}

describe('checksForRun', () => {
  it('names the run and its Job, and lists every Task of the run in order', () => {
    const other = task('t_other', { runId: 'run_2' })
    const r = checksForRun(stateWith([task('t1'), other, task('t2')]), 'run_1')
    expect(r?.runId).toBe('run_1')
    expect(r?.jobId).toBe('job_1')
    expect(r?.tasks.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('is null for a run that is not there', () => {
    expect(checksForRun(stateWith([]), 'run_nope')).toBeNull()
  })

  it('a Task with no checks asked of it is not-required on both', () => {
    const row = rowOf(stateWith([task('t1')]), 't1')
    expect(row.validation).toEqual({ required: false, status: 'not-required', checks: [] })
    expect(row.review).toEqual({ required: false, status: 'not-required', verdict: null, issues: [] })
    expect(row.failureSummary).toBeNull()
  })

  it('validation: pending before its first round, running while validating, then the last round', () => {
    const asked = { validateConfigIds: ['cfg_build'] }
    expect(rowOf(stateWith([task('t1', { ...asked, status: 'dispatched' })]), 't1').validation.status).toBe('pending')
    expect(rowOf(stateWith([task('t1', { ...asked, status: 'validating' })]), 't1').validation.status).toBe('running')
    const passed = rowOf(stateWith([task('t1', { ...asked, checks: [check({})] })]), 't1')
    expect(passed.validation).toMatchObject({ required: true, status: 'passed' })
    expect(passed.validation.checks).toHaveLength(1)
  })

  it('an old Task that names one configuration by validateConfigId still requires validation', () => {
    const row = rowOf(stateWith([task('t1', { validateConfigId: 'cfg_old', status: 'dispatched' })]), 't1')
    expect(row.validation).toMatchObject({ required: true, status: 'pending' })
  })

  it('a failed check fails validation, and the summary names it, its exit code and its last line', () => {
    const t = task('t1', {
      status: 'failed',
      validateConfigIds: ['cfg_build', 'cfg_test'],
      checks: [
        check({ status: 'failed', exitCode: 2, outputTail: 'compiling\nerror TS2322: nope\n\n' }),
        check({ configId: 'cfg_test', name: 'test', status: 'not-run' })
      ]
    })
    const row = rowOf(stateWith([t]), 't1')
    expect(row.validation.status).toBe('failed')
    expect(row.failureSummary).toBe('build failed (exit 2): error TS2322: nope')
  })

  it('a timed-out check fails validation too', () => {
    const t = task('t1', { validateConfigIds: ['cfg_build'], checks: [check({ status: 'timed-out' })] })
    const row = rowOf(stateWith([t]), 't1')
    expect(row.validation.status).toBe('failed')
    expect(row.failureSummary).toBe('build timed out')
  })

  it('review: required when asked for, pending until a reviewer runs, running while it does', () => {
    expect(rowOf(stateWith([task('t1', { reviewRequested: true, status: 'dispatched' })]), 't1').review).toEqual({
      required: true,
      status: 'pending',
      verdict: null,
      issues: []
    })
    const open = review('d1', 't1', { workerState: 'ready' })
    expect(rowOf(stateWith([task('t1', { reviewRequested: true, status: 'reviewing' })], [open]), 't1').review.status).toBe(
      'running'
    )
  })

  it('without a convergence policy the reviewer’s outcome is the verdict', () => {
    const accepted = review('d1', 't1', { outcome: 'succeeded', endedAt: NOW })
    const a = rowOf(stateWith([task('t1', { reviewRequested: true })], [accepted]), 't1')
    expect(a.review).toMatchObject({ status: 'passed', verdict: 'accepted' })
    expect(a.failureSummary).toBeNull()

    const rejected = review('d1', 't1', { outcome: 'failed', endedAt: NOW, workerState: 'failed' })
    const t = task('t1', { reviewRequested: true, status: 'failed', result: 'the tests do not cover it\nmore' })
    const r = rowOf(stateWith([t], [rejected]), 't1')
    expect(r.review).toMatchObject({ status: 'failed', verdict: 'rejected' })
    expect(r.failureSummary).toBe('review rejected: the tests do not cover it')
  })

  it('with a convergence policy a blocking issue rejects, and the summary lists the blocking ones', () => {
    const decided = review('d1', 't1', { outcome: 'succeeded', endedAt: NOW })
    const t = task('t1', {
      reviewRequested: true,
      status: 'dispatched',
      reviewIssues: [
        issue({ file: 'src/a.ts', line: 12 }),
        issue({ id: 'iss_2', severity: 'low', blocking: false, title: 'naming' })
      ]
    })
    const row = rowOf(stateWith([t], [decided], job({ convergence: {} })), 't1')
    expect(row.review).toMatchObject({ status: 'failed', verdict: 'rejected' })
    expect(row.review.issues).toHaveLength(2)
    expect(row.failureSummary).toBe('review: HIGH missing test (src/a.ts:12)')
  })

  it('with a convergence policy and no blocking issue the review passed', () => {
    const decided = review('d1', 't1', { outcome: 'succeeded', endedAt: NOW })
    const t = task('t1', { reviewRequested: true, reviewIssues: [issue({ blocking: false, severity: 'low' })] })
    expect(rowOf(stateWith([t], [decided], job({ convergence: {} })), 't1').review).toMatchObject({
      status: 'passed',
      verdict: 'accepted'
    })
  })

  it('a review that ended without a verdict leaves the last verdict and reads pending', () => {
    const first = review('d1', 't1', { outcome: 'succeeded', endedAt: NOW })
    const lost = review('d2', 't1', { startedAt: '2026-08-04T01:00:00.000Z', endedAt: '2026-08-04T01:05:00.000Z' })
    const row = rowOf(stateWith([task('t1', { reviewRequested: true, status: 'dispatched' })], [first, lost]), 't1')
    expect(row.review).toMatchObject({ status: 'pending', verdict: 'accepted' })
  })

  it('both failures go into one summary, validation first', () => {
    const decided = review('d1', 't1', { outcome: 'failed', endedAt: NOW })
    const t = task('t1', {
      status: 'failed',
      reviewRequested: true,
      result: 'no',
      validateConfigIds: ['cfg_build'],
      checks: [check({ status: 'failed', exitCode: 1 })]
    })
    expect(rowOf(stateWith([t], [decided]), 't1').failureSummary).toBe('build failed (exit 1); review rejected: no')
  })

  it('carries a person’s override of the completion checks', () => {
    const t = task('t1', { completionOverride: { reason: 'flaky runner', at: NOW } })
    expect(rowOf(stateWith([t]), 't1').completionOverride).toEqual({ reason: 'flaky runner', at: NOW })
    expect('completionOverride' in rowOf(stateWith([task('t2')]), 't2')).toBe(false)
  })

  it('a review Dispatch of another Task does not count', () => {
    const theirs = review('d1', 't2', { outcome: 'failed', endedAt: NOW })
    expect(rowOf(stateWith([task('t1'), task('t2')], [theirs]), 't1').review.status).toBe('not-required')
  })
})

describe('runs checks — the command', () => {
  const deps = (s: OrchState): OrchServerDeps =>
    ({
      getState: () => s,
      setState: async () => {
        throw new Error('runs checks must not write')
      },
      startWorker: async () => ({ sessionId: 's', cwd: 'D:/p', specPath: 'D:/p/a.md' }),
      releaseWorker: async () => {},
      listAccounts: () => [],
      readWorker: async () => '',
      now: () => NOW
    }) as OrchServerDeps
  const call = (s: OrchState, args: Record<string, unknown>) => handleCommand(deps(s), { sessionId: '' }, 'runs-checks', args)

  it('answers the run’s checks without writing', async () => {
    const r = await call(stateWith([task('t1')]), { id: 'run_1' })
    expect(r.status).toBe(200)
    expect((r.body as { runId: string; tasks: unknown[] }).runId).toBe('run_1')
  })

  it('a missing id is 400, and an unknown run, a Job id included, is 404', async () => {
    const s = stateWith([task('t1')])
    expect((await call(s, {})).status).toBe(400)
    expect((await call(s, { id: 'run_nope' })).status).toBe(404)
    expect((await call(s, { id: 'job_1' })).status).toBe(404)
  })
})
