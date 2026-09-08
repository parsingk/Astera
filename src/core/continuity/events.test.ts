import { describe, it, expect } from 'vitest'
import { deriveEvents } from './events'
import { emptyState, type OrchState } from '../orchestration/state'
import { FAILURE_LIMIT, type Run, type Task } from '../orchestration/types'

const NOW = '2026-09-08T10:00:00.000Z'
const T1 = '2026-09-08T09:00:00.000Z'

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  objective: 'o',
  cwd: 'D:/p',
  createdAt: T1,
  ...over
})
const task = (over: Partial<Task> = {}): Task => ({
  id: 'tsk_1',
  runId: 'run_1',
  title: 't',
  spec: 's',
  deps: [],
  status: 'pending',
  consecutiveFailures: 0,
  createdAt: T1,
  updatedAt: T1,
  ...over
})
const withRun = (r: Run, tasks: Task[] = []): OrchState => ({ ...emptyState(), runs: [r], tasks })

describe('deriveEvents — runs', () => {
  it('a run appearing without pendingStart has started', () => {
    const ev = deriveEvents(emptyState(), withRun(run()), NOW)
    expect(ev.map((e) => e.type)).toEqual(['JOB_RUN_STARTED'])
    expect(ev[0]).toMatchObject({ runId: 'run_1', at: NOW, payload: { objective: 'o', cwd: 'D:/p' } })
  })

  it('a sidebar run starts when pendingStart is dropped, not when it appears', () => {
    const drafted = withRun(run({ pendingStart: true }))
    expect(deriveEvents(emptyState(), drafted, NOW)).toEqual([])
    expect(deriveEvents(drafted, withRun(run()), NOW).map((e) => e.type)).toEqual(['JOB_RUN_STARTED'])
  })

  it('a schedule template never produces run events; its fires do', () => {
    const template = run({ schedule: { kind: 'daily', at: '09:00' } as never })
    expect(deriveEvents(emptyState(), withRun(template), NOW)).toEqual([])
    const fire = run({ id: 'run_2', templateId: 'run_1', fireOrdinal: 1 })
    expect(deriveEvents(withRun(template), { ...withRun(template), runs: [template, fire] }, NOW).map((e) => e.type)).toEqual([
      'JOB_RUN_STARTED'
    ])
  })

  it('paused and resumed follow the flag', () => {
    const on = withRun(run())
    const paused = withRun(run({ paused: true }))
    expect(deriveEvents(on, paused, NOW).map((e) => e.type)).toEqual(['JOB_RUN_PAUSED'])
    expect(deriveEvents(paused, on, NOW).map((e) => e.type)).toEqual(['JOB_RUN_RESUMED'])
  })

  it('the run completes or fails when its last task turns terminal, after the task event', () => {
    const running = withRun(run(), [task({ status: 'dispatched' })])
    const done = withRun(run(), [task({ status: 'completed', updatedAt: NOW })])
    expect(deriveEvents(running, done, NOW).map((e) => e.type)).toEqual(['TASK_COMPLETED', 'JOB_RUN_COMPLETED'])
    // consecutiveFailures must reach FAILURE_LIMIT for a failed Task to be terminal (view.ts
    // isTerminal) — a failed Task with retries left does not end the Run. Same convention as
    // reap.test.ts and view.test.ts's `exhausted`.
    const failed = withRun(run(), [task({ status: 'failed', consecutiveFailures: FAILURE_LIMIT, updatedAt: NOW })])
    expect(deriveEvents(running, failed, NOW).map((e) => e.type)).toEqual(['TASK_FAILED', 'JOB_RUN_FAILED'])
  })

  it('a run started in the same write as its tasks is journaled before them', () => {
    const next = withRun(run(), [task({ status: 'ready' })])
    expect(deriveEvents(emptyState(), next, NOW).map((e) => e.type)).toEqual(['JOB_RUN_STARTED', 'TASK_BECAME_READY'])
  })
})

describe('deriveEvents — tasks', () => {
  const move = (from: Task['status'], to: Task['status']): string[] =>
    deriveEvents(
      withRun(run(), [task({ status: from })]),
      withRun(run(), [task({ status: to, updatedAt: NOW })]),
      NOW
    )
      .filter((e) => e.type.startsWith('TASK_'))
      .map((e) => e.type)

  it('maps each transition to the spec event', () => {
    expect(move('pending', 'ready')).toEqual(['TASK_BECAME_READY'])
    expect(move('ready', 'dispatched')).toEqual(['TASK_STARTED'])
    expect(move('dispatched', 'validating')).toEqual(['TASK_CHECK_STARTED'])
    expect(move('validating', 'completed')).toEqual(['TASK_CHECK_PASSED', 'TASK_COMPLETED'])
    expect(move('validating', 'reviewing')).toEqual(['TASK_CHECK_PASSED'])
    expect(move('validating', 'failed')).toEqual(['TASK_CHECK_FAILED', 'TASK_FAILED'])
    expect(move('validating', 'ready')).toEqual(['TASK_CHECK_FAILED'])
    expect(move('dispatched', 'blocked')).toEqual(['TASK_WAITING_INPUT'])
    expect(move('dispatched', 'completed')).toEqual(['TASK_COMPLETED'])
    expect(move('dispatched', 'failed')).toEqual(['TASK_FAILED'])
    expect(move('dispatched', 'reviewing')).toEqual(['TASK_STATE_CHANGED'])
  })

  it('an interrupted check that becomes a question is waiting for input, not a failed check', () => {
    expect(move('validating', 'blocked')).toEqual(['TASK_WAITING_INPUT'])
  })

  it('carries from/to and the gate question when blocked', () => {
    const before = withRun(run(), [task({ status: 'dispatched' })])
    const after: OrchState = {
      ...withRun(run(), [task({ status: 'blocked', updatedAt: NOW })]),
      gates: [{ id: 'g1', runId: 'run_1', taskId: 'tsk_1', question: 'Which db?', status: 'open', createdAt: NOW }]
    }
    const [e] = deriveEvents(before, after, NOW)
    expect(e).toMatchObject({
      type: 'TASK_WAITING_INPUT',
      taskId: 'tsk_1',
      payload: { from: 'dispatched', to: 'blocked', question: 'Which db?' }
    })
  })

  it('carries the resolution when leaving blocked', () => {
    const before: OrchState = {
      ...withRun(run(), [task({ status: 'blocked' })]),
      gates: [{ id: 'g1', runId: 'run_1', taskId: 'tsk_1', question: 'Which db?', status: 'open', createdAt: T1 }]
    }
    const after: OrchState = {
      ...withRun(run(), [task({ status: 'pending', updatedAt: NOW })]),
      gates: [{ id: 'g1', runId: 'run_1', taskId: 'tsk_1', question: 'Which db?', status: 'resolved', resolution: 'sqlite', createdAt: T1, resolvedAt: NOW }]
    }
    const [e] = deriveEvents(before, after, NOW)
    expect(e).toMatchObject({ type: 'TASK_STATE_CHANGED', payload: { from: 'blocked', to: 'pending', resolution: 'sqlite' } })
  })

  it('a new task that is ready at once became ready', () => {
    expect(deriveEvents(withRun(run()), withRun(run(), [task({ status: 'ready' })]), NOW).map((e) => e.type)).toEqual([
      'TASK_BECAME_READY'
    ])
    expect(deriveEvents(withRun(run()), withRun(run(), [task()]), NOW)).toEqual([])
  })

  it('identical states derive nothing, and the same diff twice yields the same keys', () => {
    const s = withRun(run(), [task({ status: 'ready' })])
    expect(deriveEvents(s, s, NOW)).toEqual([])
    const a = deriveEvents(withRun(run(), [task()]), s, NOW)
    const b = deriveEvents(withRun(run(), [task()]), s, NOW)
    expect(a.map((e) => e.idempotencyKey)).toEqual(b.map((e) => e.idempotencyKey))
    expect(a[0].idempotencyKey).toBe(`TASK_BECAME_READY:tsk_1:pending->ready:${NOW}`)
  })
})
