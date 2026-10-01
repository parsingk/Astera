// `runs-completion` (MCP design §3): where each Task of a run stands in completion, read from Task status,
// the open Dispatch's repair reason and the convergence Gates. Nothing here is stored or run.
import { describe, it, expect } from 'vitest'
import { completionForRun, taskCompletionState } from './runCompletion'
import { emptyState, type OrchState } from './state'
import type { CheckResult, Dispatch, Gate, Job, JobRun, Task } from './types'

const NOW = '2026-10-01T00:00:00.000Z'

const job = (over: Partial<Job> = {}): Job => ({ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: NOW, ...over })
const run: JobRun = { id: 'r1', jobId: 'job_1', ordinal: 1, createdAt: NOW }
const task = (id: string, status: Task['status'], over: Partial<Task> = {}): Task => ({
  id,
  runId: 'r1',
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
const gate = (id: string, taskId: string, over: Partial<Gate> = {}): Gate => ({
  id,
  runId: 'r1',
  taskId,
  question: 'q',
  status: 'open',
  createdAt: NOW,
  ...over
})
const stateWith = (tasks: Task[], dispatches: Dispatch[] = [], gates: Gate[] = [], j: Job = job()): OrchState => ({
  ...emptyState(),
  jobs: [j],
  runs: [run],
  tasks,
  dispatches,
  gates
})

describe('taskCompletionState', () => {
  it.each<[Task['status'], Partial<Dispatch>[], Partial<Gate>[], string]>([
    ['pending', [], [], 'not-started'],
    ['ready', [], [], 'not-started'],
    ['dispatched', [{ repair: undefined }], [], 'not-started'],
    ['validating', [], [], 'checking'],
    ['validating', [{ repair: 'check-failure', outcome: 'succeeded', endedAt: 'x' }], [], 'rechecking'],
    ['reviewing', [], [], 'reviewing'],
    ['dispatched', [{ repair: 'check-failure' }], [], 'fixing'],
    ['dispatched', [{ repair: 'review-failure' }], [], 'fixing-review'],
    ['blocked', [], [{ kind: undefined, status: 'open' }], 'waiting-for-user'],
    ['blocked', [], [{ kind: 'convergence-blocked', status: 'open' }], 'waiting-for-user'],
    ['blocked', [], [{ kind: 'convergence-exhausted', status: 'open' }], 'exhausted'],
    ['completed', [], [], 'converged'],
    ['failed', [], [], 'failed']
  ])('%s with dispatches %j and gates %j is %s', (status, dispatches, gates, expected) => {
    const s = stateWith(
      [task('t1', status)],
      dispatches.map((d, i) => dispatch(`d${i}`, 't1', d)),
      gates.map((g, i) => gate(`g${i}`, 't1', g))
    )
    expect(taskCompletionState(s, s.tasks[0])).toBe(expected)
  })

  it('a resolved exhausted Gate does not make a blocked Task exhausted', () => {
    const s = stateWith([task('t1', 'blocked')], [], [gate('g1', 't1', { kind: 'convergence-exhausted', status: 'resolved' })])
    expect(taskCompletionState(s, s.tasks[0])).toBe('waiting-for-user')
  })

  it('a review Dispatch open on a dispatched Task is not a repair', () => {
    const s = stateWith([task('t1', 'dispatched')], [dispatch('d1', 't1', { review: true, repair: 'check-failure' })])
    expect(taskCompletionState(s, s.tasks[0])).toBe('not-started')
  })
})

describe('completionForRun', () => {
  it('is null for a run that is not there', () => {
    expect(completionForRun(emptyState(), 'nope')).toBeNull()
  })

  it('names the run and its Job, and lists only the Tasks of the run', () => {
    const s = stateWith([task('t1', 'completed'), task('t_other', 'completed', { runId: 'r2' }), task('t2', 'completed')])
    const c = completionForRun(s, 'r1')
    expect(c?.runId).toBe('r1')
    expect(c?.jobId).toBe('job_1')
    expect(c?.tasks.map((t) => t.taskId)).toEqual(['t1', 't2'])
    expect(c?.tasks[0].title).toBe('title t1')
  })

  it('the run is the most urgent task: exhausted beats fixing beats checking', () => {
    const s = stateWith(
      [task('t1', 'dispatched'), task('t2', 'blocked'), task('t3', 'validating')],
      [dispatch('d1', 't1', { repair: 'check-failure' })],
      [gate('g1', 't2', { kind: 'convergence-exhausted' })]
    )
    expect(completionForRun(s, 'r1')?.state).toBe('exhausted')
    const noGate = stateWith([task('t1', 'dispatched'), task('t3', 'validating')], [dispatch('d1', 't1', { repair: 'check-failure' })])
    expect(completionForRun(noGate, 'r1')?.state).toBe('fixing')
    expect(completionForRun(stateWith([task('t3', 'validating'), task('t4', 'reviewing')]), 'r1')?.state).toBe('checking')
  })

  it('the run is converged only when every task converged', () => {
    expect(completionForRun(stateWith([task('t1', 'completed'), task('t2', 'completed')]), 'r1')?.state).toBe('converged')
    expect(completionForRun(stateWith([task('t1', 'completed'), task('t2', 'pending')]), 'r1')?.state).toBe('not-started')
  })

  it('a run of converged and failed tasks is failed, and a run with no tasks is not-started', () => {
    expect(completionForRun(stateWith([task('t1', 'completed'), task('t2', 'failed')]), 'r1')?.state).toBe('failed')
    expect(completionForRun(stateWith([]), 'r1')?.state).toBe('not-started')
  })

  it('counts attempts against the Job policy and drops outputTail', () => {
    const failed: CheckResult = { configId: 'cfg_build', name: 'build', status: 'failed', exitCode: 1, outputTail: 'boom' }
    const s = stateWith(
      [task('t1', 'validating', { checks: [failed] })],
      [dispatch('d1', 't1', { repair: 'check-failure', outcome: 'succeeded', endedAt: 'x' })],
      [],
      job({ convergence: { maxFixAttempts: 3 } })
    )
    const t = completionForRun(s, 'r1')!.tasks[0]
    expect(t.state).toBe('rechecking')
    expect(t.attempt).toBe(1)
    expect(t.maxAttempts).toBe(3)
    expect(t.detail?.checks).toEqual([{ configId: 'cfg_build', name: 'build', status: 'failed', exitCode: 1 }])
    expect(t.detail?.checks.every((c) => !('outputTail' in c))).toBe(true)
    // the stored result is untouched
    expect(s.tasks[0].checks?.[0].outputTail).toBe('boom')
  })

  it('maxAttempts is null when the Job has no convergence policy, and detail is null with nothing to show', () => {
    const t = completionForRun(stateWith([task('t1', 'pending')]), 'r1')!.tasks[0]
    expect(t.maxAttempts).toBeNull()
    expect(t.attempt).toBe(0)
    expect(t.detail).toBeNull()
  })
})
