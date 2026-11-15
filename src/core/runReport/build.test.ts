import { describe, it, expect } from 'vitest'
import { buildRunReport } from './build'
import { emptyState, type OrchState } from '../orchestration/state'
import { HISTORY_MAX, type ActorGroup, type CheckResult, type Dispatch, type Gate, type JobRun, type Task } from '../orchestration/types'
import { RERUNS_MAX, type GitHubRerun, type RunGitHubState } from '../github/lifecycle'

const T0 = '2026-11-15T09:00:00.000Z'
const END = '2026-11-15T10:00:00.000Z'
const at = (min: number): string => new Date(Date.parse(T0) + min * 60_000).toISOString()

const run = (extra: Partial<JobRun> = {}): JobRun => ({ id: 'run_1', jobId: 'job_1', ordinal: 3, createdAt: T0, endedAt: END, ...extra }) as JobRun
const task = (id: string, extra: Partial<Task> = {}): Task =>
  ({ id, runId: 'run_1', title: `Task ${id}`, spec: '', deps: [], status: 'completed', createdAt: at(Number(id.replace(/\D/g, '')) || 0), updatedAt: END, ...extra }) as Task
const dispatch = (id: string, taskId: string, extra: Partial<Dispatch> = {}): Dispatch =>
  ({ id, taskId, provider: 'claude', accountId: 'acc_a', sessionId: `s_${id}`, cwd: '/w', specPath: '/s', startedAt: at(1), workerState: 'stopped', retained: false, outcome: 'succeeded', endedAt: at(2), ...extra }) as Dispatch
const gate = (id: string, extra: Partial<Gate> = {}): Gate =>
  ({ id, runId: 'run_1', taskId: 't1', question: 'q', status: 'resolved', resolution: 'ok', createdAt: T0, resolvedAt: END, ...extra }) as Gate
const check = (configId: string, status: CheckResult['status'], extra: Partial<CheckResult> = {}): CheckResult => ({ configId, name: configId, status, ...extra })

const world = (o: { tasks?: Task[]; dispatches?: Dispatch[]; gates?: Gate[]; run?: Partial<JobRun>; github?: boolean; coordinatorAccountId?: string }): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'Ship it', cwd: '/w', ...(o.github ? { github: {} } : {}), ...(o.coordinatorAccountId ? { coordinatorAccountId: o.coordinatorAccountId } : {}) } as never],
  runs: [run(o.run)],
  tasks: o.tasks ?? [task('t1')],
  dispatches: o.dispatches ?? [],
  gates: o.gates ?? []
})
const report = (s: OrchState) => buildRunReport(s, 'run_1')!

describe('buildRunReport', () => {
  it('counts repairs by reason', () => {
    const s = world({
      dispatches: [
        dispatch('d1', 't1'),
        dispatch('d2', 't1', { repair: 'check-failure', workerState: 'outcome_unknown', outcome: undefined, endedAt: at(3) }),
        dispatch('d3', 't1', { repair: 'check-failure' }),
        dispatch('d4', 't1', { repair: 'review-failure' })
      ]
    })
    const t = report(s).tasks[0]
    expect(t.repairs).toEqual({ check: 1, review: 1 })
    expect(t.attempts).toBe(4)
  })

  it('a Task with no checks has none, not a pass', () => {
    const t = report(world({ dispatches: [dispatch('d1', 't1')] })).tasks[0]
    expect(t.checks).toEqual([])
    expect(t.review).toBeUndefined()
  })

  it('a check that never ran reads not-run', () => {
    const t = report(world({ tasks: [task('t1', { validateConfigIds: ['build'] })] })).tasks[0]
    expect(t.checks).toEqual([{ name: 'build', final: 'not-run', failedRounds: 0 }])
  })

  it('capped history says at least', () => {
    const hist = (n: number, failed: number): ('passed' | 'failed')[] => Array.from({ length: n }, (_, i) => (i < failed ? 'failed' : 'passed'))
    const capped = report(world({ tasks: [task('t1', { validateConfigIds: ['build'], checks: [check('build', 'passed')], checkHistory: { build: hist(HISTORY_MAX, 3) } })] })).tasks[0]
    expect(capped.checks[0]).toEqual({ name: 'build', final: 'passed', failedRounds: 3, atLeast: true })
    const short = report(world({ tasks: [task('t1', { validateConfigIds: ['build'], checks: [check('build', 'passed')], checkHistory: { build: hist(HISTORY_MAX - 1, 3) } })] })).tasks[0]
    expect(short.checks[0].atLeast).toBeUndefined()
    const reruns: GitHubRerun[] = Array.from({ length: RERUNS_MAX }, (_, i) => ({ ciRunId: i, attempt: 1, sha: 'a', by: 'astera', at: T0 }))
    const gh: RunGitHubState = { reruns, log: [], seq: 0 }
    const r = report({ ...world({ github: true }), runs: [run({ githubState: gh })] })
    expect(r.github?.reruns).toEqual({ astera: RERUNS_MAX, person: 0, atLeast: true })
  })

  it('every caveat appears', () => {
    const gh: RunGitHubState = { ciOverride: { sha: 'x', at: T0 }, log: [], seq: 0 }
    const t = task('t1', {
      validateConfigIds: ['a', 'b', 'c'],
      checks: [check('a', 'not-run', { skipped: true }), check('b', 'passed', { outsideSandbox: true }), check('c', 'passed', { unstable: true })],
      completionOverride: { reason: 'ship', at: T0 },
      completionOverrideBy: 'person',
      reviewRequested: true,
      reviewFileToolsOnly: true,
      policyChanged: true,
      suspiciousFiles: ['x', 'y']
    })
    const r = report({ ...world({ tasks: [t], github: true }), runs: [run({ githubState: gh })] })
    expect(r.caveats).toEqual([
      { kind: 'forced', task: 'Task t1', by: 'person', reason: 'ship' },
      { kind: 'check-skipped', task: 'Task t1', check: 'a' },
      { kind: 'ci-skipped' },
      { kind: 'outside-sandbox', task: 'Task t1', checks: ['b'] },
      { kind: 'review-outside-sandbox', task: 'Task t1' },
      { kind: 'policy-changed', task: 'Task t1' },
      { kind: 'suspicious-files', task: 'Task t1', count: 2 },
      { kind: 'unstable', task: 'Task t1', check: 'c' }
    ])
  })

  it('groups the checks that ran outside the sandbox per Task, and puts what let work past a check first', () => {
    const gh: RunGitHubState = { ciOverride: { sha: 'x', at: T0 }, log: [], seq: 0 }
    const t1 = task('t1', {
      validateConfigIds: ['a', 'b', 'c'],
      checks: [check('a', 'passed', { outsideSandbox: true, unstable: true }), check('b', 'passed', { outsideSandbox: true }), check('c', 'passed')],
      reviewFileToolsOnly: true
    })
    const t2 = task('t2', {
      validateConfigIds: ['d'],
      checks: [check('d', 'not-run', { skipped: true })],
      completionOverride: { reason: 'ship', at: T0 },
      completionOverrideBy: 'coordinator'
    })
    const r = report({ ...world({ tasks: [t1, t2], github: true }), runs: [run({ githubState: gh })] })
    expect(r.caveats).toEqual([
      { kind: 'forced', task: 'Task t2', by: 'coordinator', reason: 'ship' },
      { kind: 'check-skipped', task: 'Task t2', check: 'd' },
      { kind: 'ci-skipped' },
      { kind: 'outside-sandbox', task: 'Task t1', checks: ['a', 'b'] },
      { kind: 'review-outside-sandbox', task: 'Task t1' },
      { kind: 'unstable', task: 'Task t1', check: 'a' }
    ])
  })

  it('marks the lifecycle Task and the caveats that name it', () => {
    const life = task('t1', {
      kind: 'lifecycle',
      title: 'GitHub 전달',
      validateConfigIds: ['lint'],
      checks: [check('lint', 'not-run', { skipped: true })],
      completionOverride: { reason: 'r', at: T0 }
    })
    const r = report(world({ tasks: [life] }))
    expect(r.tasks[0].lifecycle).toBe(true)
    expect(r.caveats.map((c) => ('lifecycle' in c ? c.lifecycle : undefined))).toEqual([true, true])
  })

  it('a forced completion with no group recorded reads unknown', () => {
    const r = report(world({ tasks: [task('t1', { completionOverride: { reason: 'r', at: T0 } })] }))
    expect(r.tasks[0].override).toEqual({ reason: 'r', by: 'unknown' })
    expect(r.interventions.forced).toEqual([{ task: 'Task t1', by: 'unknown' }])
    expect(r.caveats).toEqual([{ kind: 'forced', task: 'Task t1', by: 'unknown', reason: 'r' }])
    expect(r.interventions.noPersonSteppedIn).toBe(false)
  })

  it('stores a forced completion’s reason cut at 300 characters, on one line', () => {
    const r = report(world({ tasks: [task('t1', { completionOverride: { reason: `${'r'.repeat(200)}\n\n${'s'.repeat(800)}`, at: T0 }, completionOverrideBy: 'person' })] }))
    const c = r.caveats[0]
    expect(c.kind === 'forced' && c.reason).toBe(`${'r'.repeat(200)} ${'s'.repeat(99)}…`)
  })

  it('names the Job on one line, cut at 60 characters', () => {
    const s = world({})
    const long = report({ ...s, jobs: [{ ...s.jobs[0], objective: `First line\n\nand ${'w'.repeat(500)}` } as never] })
    expect(long.job).toBe(`First line and ${'w'.repeat(44)}…`)
    expect(report(s).job).toBe('Ship it')
  })

  it('lists the Tasks in the order they were made, without a lifecycle Task a later one superseded (R11)', () => {
    const tasks = [
      task('t3', { createdAt: at(30) }),
      task('t1', { createdAt: at(10) }),
      task('t5', { kind: 'lifecycle', title: 'later carrying', createdAt: at(50) }),
      task('t4', { kind: 'lifecycle', title: 'earlier carrying', status: 'failed', createdAt: at(40) }),
      task('t2', { createdAt: at(20) })
    ]
    const r = report(world({ tasks }))
    expect(r.tasks.map((t) => t.title)).toEqual(['Task t1', 'Task t2', 'Task t3', 'later carrying'])
    expect(r.outcome).toBe('completed')
  })

  it('merge-ready names its head', () => {
    const base: RunGitHubState = {
      headSha: 'h1',
      pr: { state: 'open' } as never,
      mergeReady: { headSha: 'h1' } as never,
      binding: { number: 7, url: 'https://x/pull/7' } as never,
      ci: { sha: 'h1', verdict: 'passed', basis: 'required', checks: [], changedAt: T0 },
      log: [],
      seq: 0
    }
    const holds = report({ ...world({ github: true }), runs: [run({ githubState: base })] }).github!
    expect(holds.mergeReady).toEqual({ headSha: 'h1' })
    expect(holds.pr).toEqual({ number: 7, url: 'https://x/pull/7' })
    expect(holds.ci).toEqual({ verdict: 'passed', sha: 'h1' })
    const gone = report({ ...world({ github: true }), runs: [run({ githubState: { ...base, invalidated: { reason: 'head-changed', at: T0 } } })] }).github!
    expect(gone.mergeReady).toBeUndefined()
    expect(gone.withheld).toBe('head-changed')
  })

  it('groups answers and never counts unknown as a person', () => {
    const g = (id: string, by?: ActorGroup, extra: Partial<Gate> = {}) => gate(id, { ...(by ? { resolvedBy: by } : {}), ...extra })
    const r = report(world({ gates: [g('g1', 'person'), g('g2', 'coordinator'), g('g3', 'astera'), g('g4'), g('g5', 'person', { resolution: 'superseded' }), g('g6', 'person', { status: 'open' })] }))
    expect(r.interventions.answers).toEqual({ person: 1, coordinator: 1, astera: 1, unknown: 1 })
  })

  it('says no person stepped in only when that holds', () => {
    const forcedBy = (by: ActorGroup) => task('t1', { completionOverride: { reason: 'r', at: T0 }, completionOverrideBy: by })
    const gs = [gate('g1', { resolvedBy: 'coordinator' }), gate('g2', { resolvedBy: 'astera' })]
    expect(report(world({ gates: gs, tasks: [forcedBy('coordinator')] })).interventions.noPersonSteppedIn).toBe(true)
    expect(report(world({ gates: [...gs, gate('g3')], tasks: [forcedBy('coordinator')] })).interventions.noPersonSteppedIn).toBe(false)
    const p = report(world({ gates: gs, tasks: [forcedBy('person')] })).interventions
    expect(p.noPersonSteppedIn).toBe(false)
    expect(p.forced).toEqual([{ task: 'Task t1', by: 'person' }])
  })

  it("counts the workers' waits and switches", () => {
    const s = world({
      dispatches: [
        dispatch('d1', 't1', {
          workerState: 'outcome_unknown',
          resumes: [
            { stoppedAt: at(10), reason: 'waiting', fromAccountId: 'acc_a', resumedAt: at(15), toAccountId: 'acc_a' },
            { stoppedAt: at(50), reason: 'waiting', fromAccountId: 'acc_a' },
            { stoppedAt: at(20), reason: 'switching', fromAccountId: 'acc_a', resumedAt: at(21), toAccountId: 'acc_b' }
          ]
        }),
        dispatch('d2', 't1', { retryOf: 'd1' })
      ]
    })
    expect(report(s).interruptions).toEqual({ limitWaits: 2, waitedMs: 5 * 60_000 + 10 * 60_000, switches: 1, restarts: 1 })
  })

  it('leaves cost out without token data and lists the accounts', () => {
    const s = world({
      coordinatorAccountId: 'acc_c',
      dispatches: [
        dispatch('d2', 't1', { accountId: 'acc_b', startedAt: at(5) }),
        dispatch('d1', 't1', { accountId: 'acc_a', startedAt: at(1), resumes: [{ stoppedAt: at(2), reason: 'switching', fromAccountId: 'acc_a', toAccountId: 'acc_d', resumedAt: at(3) }] })
      ]
    })
    const r = report(s)
    expect(r.cost?.tokens).toBeUndefined()
    expect(r.cost?.accountIds).toEqual(['acc_a', 'acc_d', 'acc_b', 'acc_c'])
    const withTokens = buildRunReport(s, 'run_1', { spent: [{ sessionId: 's_d1', dispatchId: 'd1', input: 3, output: 4 }] })!
    expect(withTokens.cost?.tokens).toEqual({ input: 3, output: 4, total: 7 })
  })

  it('reads review rounds, pass and blocking issues', () => {
    const s = world({
      tasks: [task('t1', { reviewRequested: true, reviewFileToolsOnly: true, reviewIssues: [{ id: 'i', severity: 'high', blocking: true, title: 'Bad', description: '' }] })],
      dispatches: [dispatch('d1', 't1'), dispatch('d2', 't1', { review: true, outcome: 'failed', startedAt: at(3) })]
    })
    expect(report(s).tasks[0].review).toEqual({ rounds: 1, passed: false, blocking: ['Bad'], fileToolsOnly: true, reviewedBy: ['Claude'] })
  })

  it('returns null for a running Run and an unknown Run', () => {
    expect(buildRunReport(world({ tasks: [task('t1', { status: 'dispatched' })] }), 'run_1')).toBeNull()
    expect(buildRunReport(world({}), 'run_nope')).toBeNull()
  })
})

describe('buildRunReport: who reviewed', () => {
  const rev = (id: string, min: number, extra: Partial<Dispatch> = {}): Dispatch =>
    dispatch(id, 't1', { review: true, startedAt: at(min), endedAt: at(min + 1), ...extra })
  const ext = (name: string): Partial<Dispatch> => ({ accountId: '', externalReviewer: { id: 'ext_0a0b0c0d', name } })
  const reviewedBy = (ds: Dispatch[]) =>
    report(world({ tasks: [task('t1', { reviewRequested: true })], dispatches: [dispatch('d0', 't1'), ...ds] })).tasks[0].review?.reviewedBy

  it('says Claude for a claude review and Codex for a codex review', () => {
    expect(reviewedBy([rev('d1', 3, { provider: 'claude' })])).toEqual(['Claude'])
    expect(reviewedBy([rev('d1', 3, { provider: 'codex' })])).toEqual(['Codex'])
  })
  it('says the external reviewer by name, never the placeholder provider', () => {
    expect(reviewedBy([rev('d1', 3, ext('Gemini CLI'))])).toEqual(['Gemini CLI'])
  })
  it('lists distinct names in start order across rounds', () => {
    expect(
      reviewedBy([rev('d1', 3, ext('Gemini CLI')), rev('d2', 6, { provider: 'codex' }), rev('d3', 9, ext('Gemini CLI')), rev('d4', 12, { provider: 'codex' })])
    ).toEqual(['Gemini CLI', 'Codex'])
  })
  it('is absent, not empty, when no review Dispatch has an outcome', () => {
    const r = report(world({ tasks: [task('t1', { reviewRequested: true })], dispatches: [dispatch('d0', 't1')] })).tasks[0].review!
    expect('reviewedBy' in r).toBe(false)
    const open = reviewedBy([rev('d1', 3, { outcome: undefined, endedAt: undefined })])
    expect(open).toBeUndefined()
  })
  it('keeps the empty account id of an external review out of the accounts list', () => {
    const s = world({ tasks: [task('t1', { reviewRequested: true })], dispatches: [dispatch('d0', 't1'), rev('d1', 3, ext('Gemini CLI'))] })
    expect(report(s).cost?.accountIds).toEqual(['acc_a'])
  })
})
