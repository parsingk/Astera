import { describe, it, expect } from 'vitest'
import { deriveEvents } from './events'
import { emptyState, type OrchState } from '../orchestration/state'
import { FAILURE_LIMIT, type Run, type Task, type Dispatch } from '../orchestration/types'

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

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1',
  taskId: 'tsk_1',
  provider: 'claude',
  accountId: 'acc_1',
  sessionId: 'pending:abcd',
  cwd: 'D:/wt',
  specPath: 'D:/spec.md',
  startedAt: T1,
  workerState: 'ready',
  retained: false,
  ...over
})
const withDispatch = (d: Dispatch | null, t: Task = task({ status: 'dispatched' })): OrchState => ({
  ...withRun(run(), [t]),
  dispatches: d ? [d] : []
})
const types = (prev: OrchState, next: OrchState): string[] =>
  deriveEvents(prev, next, NOW)
    .filter((e) => !e.type.startsWith('TASK_') && !e.type.startsWith('JOB_'))
    .map((e) => e.type)

describe('deriveEvents — dispatches', () => {
  it('a placeholder session id is a start request; the real id is the start', () => {
    const requested = withDispatch(dispatch())
    const ev = deriveEvents(withDispatch(null, task({ status: 'ready' })), requested, NOW)
    const attempt = ev.find((e) => e.type === 'ATTEMPT_START_REQUESTED')
    expect(attempt).toMatchObject({
      runId: 'run_1',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      idempotencyKey: 'ATTEMPT_START_REQUESTED:dsp_1',
      payload: { provider: 'claude', accountId: 'acc_1', retryOf: null, review: false }
    })
    expect(types(requested, withDispatch(dispatch({ sessionId: 'sess-1' })))).toEqual(['ATTEMPT_STARTED'])
  })

  it('a reused terminal appears with a real id: requested and started in one write', () => {
    expect(types(withDispatch(null, task({ status: 'ready' })), withDispatch(dispatch({ sessionId: 'sess-1' })))).toEqual([
      'ATTEMPT_START_REQUESTED',
      'ATTEMPT_STARTED'
    ])
  })

  it('each ending has its own event, stamped with endedAt', () => {
    const live = withDispatch(dispatch({ sessionId: 'sess-1' }))
    const end = (over: Partial<Dispatch>): OrchState =>
      withDispatch(dispatch({ sessionId: 'sess-1', endedAt: NOW, ...over }))
    expect(types(live, end({ outcome: 'succeeded' }))).toEqual(['ATTEMPT_COMPLETED'])
    expect(types(live, end({ outcome: 'failed', workerState: 'failed' }))).toEqual(['ATTEMPT_FAILED'])
    expect(types(live, end({ workerState: 'stopped' }))).toEqual(['ATTEMPT_EXITED'])
    const lost = deriveEvents(live, end({ workerState: 'outcome_unknown' }), '2026-09-09T00:00:00.000Z')
    expect(lost.map((e) => e.type)).toEqual(['ATTEMPT_LOST'])
    expect(lost[0]).toMatchObject({ at: NOW, idempotencyKey: 'ATTEMPT_LOST:dsp_1', payload: { workerState: 'outcome_unknown', outcome: null } })
  })

  it('a usage-limit stop is detected, and is a wait or a roll request by its reason', () => {
    const live = withDispatch(dispatch({ sessionId: 'sess-1' }))
    const waiting = withDispatch(
      dispatch({ sessionId: 'sess-1', resumes: [{ stoppedAt: NOW, reason: 'waiting', resetsAt: '2026-09-08T11:00:00.000Z', fromAccountId: 'acc_1' }] })
    )
    expect(types(live, waiting)).toEqual(['USAGE_LIMIT_DETECTED', 'ATTEMPT_WAITING'])
    const switching = withDispatch(dispatch({ sessionId: 'sess-1', resumes: [{ stoppedAt: NOW, reason: 'switching', fromAccountId: 'acc_1' }] }))
    const ev = deriveEvents(live, switching, NOW)
    expect(ev.map((e) => e.type)).toEqual(['USAGE_LIMIT_DETECTED', 'ACCOUNT_ROLL_REQUESTED'])
    expect(ev[0].idempotencyKey).toBe('USAGE_LIMIT_DETECTED:dsp_1:0')
    expect(ev[1].idempotencyKey).toBe('ACCOUNT_ROLL_REQUESTED:dsp_1:0')
  })

  it('a resume closes the entry; a rekey is a completed roll', () => {
    const stopped = withDispatch(dispatch({ sessionId: 'sess-1', resumes: [{ stoppedAt: T1, reason: 'switching', fromAccountId: 'acc_1' }] }))
    const rolled = withDispatch(
      dispatch({
        sessionId: 'sess-2',
        accountId: 'acc_2',
        resumes: [{ stoppedAt: T1, reason: 'switching', fromAccountId: 'acc_1', resumedAt: NOW, toAccountId: 'acc_2' }]
      })
    )
    const ev = deriveEvents(stopped, rolled, NOW)
    expect(ev.map((e) => e.type)).toEqual(['ACCOUNT_ROLL_COMPLETED', 'ATTEMPT_RESUMED'])
    expect(ev[0].payload).toEqual({ fromSessionId: 'sess-1', toSessionId: 'sess-2', fromAccountId: 'acc_1', toAccountId: 'acc_2' })
    expect(ev[1]).toMatchObject({ at: NOW, idempotencyKey: 'ATTEMPT_RESUMED:dsp_1:0', payload: { toAccountId: 'acc_2' } })
  })

  it('the native session id is bound once and changed afterwards', () => {
    const live = withDispatch(dispatch({ sessionId: 'sess-1' }))
    const bound = withDispatch(dispatch({ sessionId: 'sess-1', nativeSessionId: 'uuid-a' }))
    const ev = deriveEvents(live, bound, NOW)
    expect(ev.map((e) => e.type)).toEqual(['AGENT_NATIVE_SESSION_BOUND'])
    expect(ev[0]).toMatchObject({ idempotencyKey: 'AGENT_NATIVE_SESSION_BOUND:dsp_1:uuid-a', payload: { nativeSessionId: 'uuid-a', provider: 'claude' } })
    expect(types(bound, withDispatch(dispatch({ sessionId: 'sess-1', nativeSessionId: 'uuid-b' })))).toEqual(['AGENT_NATIVE_SESSION_CHANGED'])
  })

  it('a dispatch whose task is gone derives nothing rather than throwing', () => {
    const orphan: OrchState = { ...emptyState(), runs: [run()], dispatches: [dispatch({ sessionId: 'sess-1' })] }
    expect(deriveEvents(emptyState(), orphan, NOW).filter((e) => e.dispatchId)).toEqual([])
  })

  it('a dispatch the person abandoned is not a lost attempt', () => {
    const live = withDispatch(dispatch({ sessionId: 'sess-1' }))
    const abandoned = withDispatch(
      dispatch({ sessionId: 'sess-1', endedAt: NOW, workerState: 'outcome_unknown', closedBy: 'abandon' })
    )
    expect(types(live, abandoned)).toEqual(['ATTEMPT_ABANDONED'])
  })

  it('a stop and a pause stay ordinary exits', () => {
    const live = withDispatch(dispatch({ sessionId: 'sess-1' }))
    for (const closedBy of ['stop', 'pause'] as const)
      expect(
        types(live, withDispatch(dispatch({ sessionId: 'sess-1', endedAt: NOW, workerState: 'stopped', closedBy })))
      ).toEqual(['ATTEMPT_EXITED'])
  })
})
