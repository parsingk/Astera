// SDK 1d: the public events one commit makes, derived from the state before and after it (SDK spec §6). Pure: what
// these tests build is all the derivation sees.
import { describe, it, expect } from 'vitest'
import { derivePublicEvents, type EventDraft } from './publicEvents'
import { emptyState, type OrchState } from './state'
import { FAILURE_LIMIT, type CheckResult, type Dispatch, type Gate, type Job, type JobRun, type Message, type Task } from './types'

const NOW = '2026-10-12T00:00:00.000Z'

const job = (over: Partial<Job> = {}): Job => ({ id: 'job_1', objective: 'o', cwd: 'D:/p', projectId: 'proj_1', createdAt: NOW, ...over })
const run: JobRun = { id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW }
const task = (id: string, status: Task['status'], over: Partial<Task> = {}): Task => ({
  id,
  runId: 'run_1',
  title: `title ${id}`,
  spec: 's',
  deps: [],
  status,
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})
const dispatch = (id: string, taskId: string, over: Partial<Dispatch> = {}): Dispatch => ({
  id,
  taskId,
  provider: 'codex',
  accountId: 'acc',
  sessionId: `s_${id}`,
  cwd: 'D:/p',
  specPath: 'D:/p/spec.md',
  startedAt: NOW,
  workerState: 'ready',
  retained: false,
  ...over
})
const gate = (id: string, taskId: string, over: Partial<Gate> = {}): Gate => ({ id, runId: 'run_1', taskId, question: 'q', status: 'open', createdAt: NOW, ...over })
const state = (over: Partial<OrchState> = {}): OrchState => ({ ...emptyState(), jobs: [job()], runs: [run], ...over })
const types = (es: readonly EventDraft[]): string[] => es.map((e) => e.type)
/** The same state with one Task replaced: every other object keeps its identity, as a commit leaves them. */
const withTask = (s: OrchState, t: Task, over: Partial<OrchState> = {}): OrchState => ({ ...s, tasks: s.tasks.map((x) => (x.id === t.id ? t : x)), ...over })

describe('derivePublicEvents', () => {
  it('gives nothing for a commit that changes nothing public', () => {
    const s = state({ tasks: [task('t1', 'ready')] })
    expect(derivePublicEvents(s, s)).toEqual([])
    const message = { id: 'msg_1' } as unknown as Message
    expect(derivePublicEvents(s, { ...s, messages: [...s.messages, message] })).toEqual([])
  })

  it('gives nothing when an array is copied but its objects are the same', () => {
    const s = state({ tasks: [task('t1', 'ready')], gates: [gate('g1', 't1')], dispatches: [dispatch('d1', 't1')] })
    expect(derivePublicEvents(s, { ...s, jobs: [...s.jobs], runs: [...s.runs], tasks: [...s.tasks], gates: [...s.gates], dispatches: [...s.dispatches] })).toEqual([])
  })

  it('job.created for a new Job, with its project and a pending outcome', () => {
    const before = state({ jobs: [], runs: [] })
    const after = state({ runs: [] })
    const [e, ...rest] = derivePublicEvents(before, after)
    expect(rest).toEqual([])
    expect(e).toMatchObject({ type: 'job.created', jobId: 'job_1', projectId: 'proj_1' })
    expect(e.payload).toMatchObject({ id: 'job_1', objective: 'o', outcome: 'pending', questionsOpen: 0 })
    expect(e).not.toHaveProperty('runId')
  })

  it('job.updated when a public field changes, not for a copy or a derived field', () => {
    const before = state({ tasks: [task('t1', 'reviewing'), task('t2', 'ready')] })
    const paused = { ...before, jobs: [job({ paused: true })] }
    expect(types(derivePublicEvents(before, paused))).toEqual(['job.updated'])
    expect(derivePublicEvents(before, paused)[0].payload).toMatchObject({ paused: true, outcome: 'running' })
    expect(derivePublicEvents(before, { ...before, jobs: [job()] })).toEqual([])
    // A Task of its Run completes: the Job's progress moves, the Job does not
    expect(types(derivePublicEvents(before, withTask(before, task('t1', 'completed'))))).not.toContain('job.updated')
  })

  it('run.started for a new Run, with its Job and project', () => {
    const before = state({ runs: [] })
    const after = state()
    const [e, ...rest] = derivePublicEvents(before, after)
    expect(rest).toEqual([])
    expect(e).toMatchObject({ type: 'run.started', runId: 'run_1', jobId: 'job_1', projectId: 'proj_1' })
    expect(e.payload).toEqual({ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW, outcome: 'running', progress: { done: 0, total: 0 }, questionsOpen: 0 })
  })

  it('task.started, task.completed and task.failed on those moves, with every id', () => {
    const before = state({ tasks: [task('t1', 'ready'), task('t2', 'reviewing'), task('t3', 'dispatched'), task('t4', 'ready')] })
    const started = derivePublicEvents(before, withTask(before, task('t1', 'dispatched'), { dispatches: [dispatch('d1', 't1')] }))
    expect(types(started)).toEqual(['task.started'])
    expect(started[0]).toMatchObject({ taskId: 't1', runId: 'run_1', jobId: 'job_1', projectId: 'proj_1' })
    expect(types(derivePublicEvents(before, withTask(before, task('t2', 'completed'))))).toEqual(['task.completed', 'completion.converged'])
    expect(types(derivePublicEvents(before, withTask(before, task('t3', 'failed', { consecutiveFailures: 1 }))))).toEqual(['task.failed'])
    // A move that is none of the three
    expect(derivePublicEvents(before, withTask(before, task('t4', 'blocked')))).toEqual([])
  })

  it('nothing for a Job definition Task', () => {
    const definition = task('t1', 'ready', { runId: undefined, jobId: 'job_1' })
    const before = state({ tasks: [definition] })
    expect(derivePublicEvents(before, withTask(before, { ...definition, status: 'dispatched' }))).toEqual([])
  })

  it('a Task payload is cut like tasks list --brief and carries no check output', () => {
    const checks: CheckResult[] = [{ configId: 'c', name: 'tests', status: 'failed', exitCode: 1, outputTail: 'x'.repeat(4000) }]
    const before = state({ tasks: [task('t1', 'dispatched', { spec: 'a'.repeat(300) })] })
    const [e] = derivePublicEvents(before, withTask(before, task('t1', 'failed', { spec: 'a'.repeat(300), checks, consecutiveFailures: 1 })))
    const payload = e.payload as { spec: string; spec_truncated: boolean; checks: unknown[] }
    expect(payload.spec).toHaveLength(160)
    expect(payload.spec_truncated).toBe(true)
    expect(payload.checks).toEqual([{ configId: 'c', name: 'tests', status: 'failed', exitCode: 1 }])
  })

  it('completion.started when a Task enters its first check', () => {
    const before = state({ tasks: [task('t1', 'dispatched')], dispatches: [dispatch('d1', 't1')] })
    const after = state({ tasks: [task('t1', 'validating')], dispatches: [dispatch('d1', 't1', { endedAt: NOW, outcome: 'succeeded' })] })
    const es = derivePublicEvents(before, after)
    expect(types(es)).toEqual(['completion.started'])
    expect(es[0]).toMatchObject({ taskId: 't1', runId: 'run_1', jobId: 'job_1', projectId: 'proj_1' })
    expect(es[0].payload).toMatchObject({ taskId: 't1', state: 'checking', attempt: 0 })
  })

  it('completion.failed then completion.repair_started when a failed check starts a repair', () => {
    const before = state({ tasks: [task('t1', 'validating')], dispatches: [dispatch('d1', 't1', { endedAt: NOW })] })
    const after = state({
      tasks: [task('t1', 'dispatched')],
      dispatches: [dispatch('d1', 't1', { endedAt: NOW }), dispatch('d2', 't1', { repair: 'check-failure' })]
    })
    const es = derivePublicEvents(before, after)
    expect(types(es)).toEqual(['task.started', 'completion.failed', 'completion.repair_started'])
    expect(es[2].payload).toMatchObject({ state: 'fixing', attempt: 1 })
  })

  // 5d (performance review M3): an event carries how many findings a check has, not the findings; completion.get reads them
  it('a completion event counts a plugin check’s findings and leaves the list to the completion read', () => {
    const found: CheckResult = {
      configId: 'plugin:d',
      name: 'D',
      status: 'failed',
      summary: '3 leftovers',
      diagnostics: [{ message: 'a' }, { message: 'b' }, { message: 'c' }]
    }
    const cut: CheckResult = { ...found, configId: 'plugin:e', name: 'E', diagnosticsTotal: 150 }
    const before = state({ tasks: [task('t1', 'validating')], dispatches: [dispatch('d1', 't1', { endedAt: NOW })] })
    const after = state({
      tasks: [task('t1', 'dispatched', { checks: [found, cut] })],
      dispatches: [dispatch('d1', 't1', { endedAt: NOW }), dispatch('d2', 't1', { repair: 'check-failure' })]
    })
    const failed = derivePublicEvents(before, after).find((e) => e.type === 'completion.failed')!
    const checks = (failed.payload as { detail: { checks: Array<Record<string, unknown>> } }).detail.checks
    expect(checks[0]).not.toHaveProperty('diagnostics')
    expect(checks[0].diagnosticsTotal).toBe(3)
    expect(checks[1]).not.toHaveProperty('diagnostics')
    expect(checks[1].diagnosticsTotal).toBe(150)
    expect(checks[0].summary).toBe('3 leftovers')
  })

  // 5d final review I1: a task.* event counts a check's findings as completion.* events do, in the same commit
  it('a task event counts a plugin check’s findings too, as the completion event of the same change does', () => {
    const found: CheckResult = {
      configId: 'plugin:d',
      name: 'D',
      status: 'failed',
      summary: '30 leftovers',
      diagnostics: Array.from({ length: 20 }, (_, i) => ({ message: `m${i}` })),
      diagnosticsTotal: 30
    }
    const before = state({ tasks: [task('t1', 'validating')], dispatches: [dispatch('d1', 't1', { endedAt: NOW })] })
    const after = state({
      tasks: [task('t1', 'dispatched', { checks: [found] })],
      dispatches: [dispatch('d1', 't1', { endedAt: NOW }), dispatch('d2', 't1', { repair: 'check-failure' })]
    })
    const started = derivePublicEvents(before, after).find((e) => e.type === 'task.started')!
    const check = (started.payload as { checks: Array<Record<string, unknown>> }).checks[0]
    expect(check).not.toHaveProperty('diagnostics')
    expect(check.diagnosticsTotal).toBe(30)
    const failed = derivePublicEvents(before, state({ tasks: [task('t1', 'failed', { checks: [{ ...found, diagnosticsTotal: undefined }] })] })).find(
      (e) => e.type === 'task.failed'
    )!
    expect((failed.payload as { checks: Array<Record<string, unknown>> }).checks[0]).toMatchObject({ diagnosticsTotal: 20 })
    expect((failed.payload as { checks: Array<Record<string, unknown>> }).checks[0]).not.toHaveProperty('diagnostics')
  })

  it('completion.failed then completion.exhausted, then the question, when repairs run out', () => {
    const before = state({ tasks: [task('t1', 'validating')] })
    const after = state({ tasks: [task('t1', 'blocked')], gates: [gate('g1', 't1', { kind: 'convergence-exhausted' })] })
    expect(types(derivePublicEvents(before, after))).toEqual(['completion.failed', 'completion.exhausted', 'question.created'])
  })

  // 5a final review M2: a check that could not be made is no failed round; the question says the Task waits
  it('a check that could not be made gives the question, and no completion.failed', () => {
    const before = state({ tasks: [task('t1', 'validating')] })
    const after = state({ tasks: [task('t1', 'blocked')], gates: [gate('g1', 't1', { kind: 'check-unavailable', options: ['retry', 'skip-check', 'mark-failed'] })] })
    expect(types(derivePublicEvents(before, after))).toEqual(['question.created'])
  })

  it('a completion move made by a Dispatch alone, the Task object unchanged', () => {
    const before = state({ tasks: [task('t1', 'dispatched')], dispatches: [] })
    const after = { ...before, dispatches: [dispatch('d2', 't1', { repair: 'review-failure' })] }
    // A repair's worker starting is a start of the Task too
    expect(types(derivePublicEvents(before, after))).toEqual(['task.started', 'completion.repair_started'])
  })

  it('a completion move made by a Gate alone, the Task object unchanged', () => {
    const before = state({ tasks: [task('t1', 'blocked')], gates: [] })
    const after = { ...before, gates: [gate('g1', 't1', { kind: 'convergence-exhausted' })] }
    expect(types(derivePublicEvents(before, after))).toEqual(['completion.exhausted', 'question.created'])
  })

  it('question.created for a new open Gate and question.answered when it is resolved', () => {
    const before = state({ tasks: [task('t1', 'ready')] })
    const opened = { ...before, gates: [gate('g1', 't1')] }
    const created = derivePublicEvents(before, opened)
    expect(types(created)).toEqual(['question.created'])
    expect(created[0]).toMatchObject({ taskId: 't1', runId: 'run_1', jobId: 'job_1', projectId: 'proj_1' })
    expect(created[0].payload).toEqual({ id: 'g1', runId: 'run_1', taskId: 't1', question: 'q', status: 'open', createdAt: NOW })
    const answered = derivePublicEvents(opened, { ...opened, gates: [gate('g1', 't1', { status: 'resolved', resolution: 'retry', resolvedAt: NOW })] })
    expect(types(answered)).toEqual(['question.answered'])
    expect(answered[0].payload).toMatchObject({ status: 'resolved', resolution: 'retry' })
  })

  it('run.completed after the last Task completes, last', () => {
    const before = state({ tasks: [task('t1', 'completed'), task('t2', 'reviewing')] })
    const es = derivePublicEvents(before, withTask(before, task('t2', 'completed')))
    expect(types(es)).toEqual(['task.completed', 'completion.converged', 'run.completed'])
    expect(es[2]).toMatchObject({ runId: 'run_1', jobId: 'job_1', projectId: 'proj_1' })
    expect(es[2].payload).toMatchObject({ outcome: 'completed', progress: { done: 2, total: 2 } })
  })

  it('run.failed when its last open Task fails for good', () => {
    const before = state({ tasks: [task('t1', 'completed'), task('t2', 'dispatched', { consecutiveFailures: FAILURE_LIMIT - 1 })] })
    const es = derivePublicEvents(before, withTask(before, task('t2', 'failed', { consecutiveFailures: FAILURE_LIMIT })))
    expect(types(es)).toEqual(['task.failed', 'run.failed'])
  })

  // Final review Minor 5: a start commits a `pending:` placeholder Dispatch first and its real session after; a start
  // that fails rolls both back. Nothing has started until a worker has a session.
  it('task.started waits for the worker’s real session, and a start rolled back says nothing', () => {
    const before = state({ tasks: [task('t1', 'ready')] })
    const placed = state({ tasks: [task('t1', 'dispatched')], dispatches: [dispatch('d1', 't1', { sessionId: 'pending:abc' })] })
    expect(derivePublicEvents(before, placed)).toEqual([])
    const started = state({ tasks: placed.tasks, dispatches: [dispatch('d1', 't1', { sessionId: 'ses_real' })] })
    const es = derivePublicEvents(placed, started)
    expect(types(es)).toEqual(['task.started'])
    expect(es[0]).toMatchObject({ taskId: 't1' })
    expect(derivePublicEvents(placed, before)).toEqual([])
  })

  it('a repair in a new session starts at its real session too', () => {
    const before = state({ tasks: [task('t1', 'validating')], dispatches: [dispatch('d1', 't1', { endedAt: NOW })] })
    const placed = state({ tasks: [task('t1', 'dispatched')], dispatches: [dispatch('d1', 't1', { endedAt: NOW }), dispatch('d2', 't1', { repair: 'check-failure', sessionId: 'pending:x' })] })
    expect(types(derivePublicEvents(before, placed))).toEqual(['completion.failed'])
    const started = state({ tasks: placed.tasks, dispatches: [dispatch('d1', 't1', { endedAt: NOW }), dispatch('d2', 't1', { repair: 'check-failure', sessionId: 'ses_2' })] })
    expect(types(derivePublicEvents(placed, started))).toEqual(['task.started', 'completion.repair_started'])
  })

  it('a worker that rolls to another account in a new Dispatch is not a new start', () => {
    const before = state({ tasks: [task('t1', 'dispatched')], dispatches: [dispatch('d1', 't1')] })
    const rolled = state({ tasks: before.tasks, dispatches: [dispatch('d1', 't1', { endedAt: NOW, outcome: 'failed' }), dispatch('d2', 't1', { accountId: 'acc2' })] })
    expect(derivePublicEvents(before, rolled)).toEqual([])
  })

  // Final review Minor 4: an app's state-put brings every object new, so nothing can be skipped by identity; each
  // Task's Gates and Dispatches, and each Run's Tasks, must still be gathered once, not searched for each.
  it('reads each Dispatch a bounded number of times for a state that is all new', () => {
    const runs = Array.from({ length: 50 }, (_, i): JobRun => ({ ...run, id: `run_${i}`, ordinal: i + 1 }))
    const tasks = Array.from({ length: 1000 }, (_, i) => task(`t${i}`, 'dispatched', { runId: `run_${i % 50}` }))
    const dispatches = tasks.flatMap((t, i) => [dispatch(`d${i}a`, t.id, { endedAt: NOW, outcome: 'failed' }), dispatch(`d${i}b`, t.id)])
    const prev = state({ runs, tasks, dispatches })
    let reads = 0
    const counted = <T extends object>(xs: T[]): T[] =>
      new Proxy(xs, {
        get(target, key, receiver) {
          if (typeof key === 'string' && /^\d+$/.test(key)) reads += 1
          return Reflect.get(target, key, receiver)
        }
      })
    const copy = JSON.parse(JSON.stringify(prev)) as OrchState
    const next: OrchState = { ...copy, dispatches: counted(copy.dispatches) }
    const counting: OrchState = { ...prev, dispatches: counted([...prev.dispatches]) }
    expect(derivePublicEvents(counting, next)).toEqual([])
    expect(reads).toBeLessThan(10 * dispatches.length)
  })

  it('no Run ending for a Run removed by the commit', () => {
    const before = state({ tasks: [task('t1', 'completed'), task('t2', 'reviewing')] })
    expect(derivePublicEvents(before, state({ runs: [], tasks: [] }))).toEqual([])
  })
})

describe('github events (GitHub lifecycle G1)', () => {
  const policy = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
  const entry = (seq: number, kind: 'pr-bound' | 'head-changed' | 'ci-passed' | 'ci-failed' | 'source-changed') => ({ seq, at: NOW, kind })
  const withLog = (log: ReturnType<typeof entry>[]): OrchState =>
    state({ jobs: [job({ github: policy })], runs: [{ ...run, githubState: { log, seq: log.at(-1)?.seq ?? 0 } }] })

  it('one event per new log entry, in order, each carrying the Run with its github field', () => {
    const prev = withLog([entry(1, 'pr-bound')])
    const next = withLog([entry(1, 'pr-bound'), entry(2, 'head-changed'), entry(3, 'ci-failed')])
    const es = derivePublicEvents(prev, next)
    expect(types(es)).toEqual(['github.head_changed', 'github.ci_failed'])
    expect(es[0]).toMatchObject({ jobId: 'job_1', runId: 'run_1', projectId: 'proj_1' })
    expect((es[0].payload as { github?: { state: string } }).github?.state).toBe('unbound')
    expect(es[0].payload).not.toHaveProperty('githubState')
  })

  it('maps every kind', () => {
    const next = withLog([entry(1, 'pr-bound'), entry(2, 'head-changed'), entry(3, 'ci-passed'), entry(4, 'ci-failed'), entry(5, 'source-changed')])
    expect(types(derivePublicEvents(withLog([]), next))).toEqual([
      'github.pr_bound', 'github.head_changed', 'github.ci_passed', 'github.ci_failed', 'github.source_changed'
    ])
  })

  it('a record that moved nothing makes no event', () => {
    const prev = withLog([entry(1, 'pr-bound')])
    expect(derivePublicEvents(prev, { ...prev, runs: [{ ...prev.runs[0] }] })).toEqual([])
  })
})
