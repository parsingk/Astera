import { describe, it, expect } from 'vitest'
import { deriveEvents, isContinuityEventType } from './events'
import { emptyState, type OrchState } from '../orchestration/state'
import { FAILURE_LIMIT, type Task, type Dispatch } from '../orchestration/types'
import { stateFromLegacy } from '../orchestration/legacyState'
import type { LegacyRun } from '../orchestration/legacy'

const NOW = '2026-09-08T10:00:00.000Z'
const T1 = '2026-09-08T09:00:00.000Z'

const run = (over: Partial<LegacyRun> = {}): LegacyRun => ({
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
const withRun = (r: LegacyRun, tasks: Task[] = []): OrchState => stateFromLegacy({ runs: [r], tasks })
const withRuns = (rs: LegacyRun[], tasks: Task[] = []): OrchState => stateFromLegacy({ runs: rs, tasks })

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
    expect(
      deriveEvents(withRun(template), withRuns([template, fire]), NOW).map((e) => e.type)
    ).toEqual(['JOB_RUN_STARTED'])
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
    // validating → reviewing now has its own main event (TASK_REVIEW_STARTED) instead of falling
    // back to TASK_STATE_CHANGED, so the collapsing rule no longer swallows it — the check verdict
    // and the review's start are both real, distinct facts.
    expect(move('validating', 'reviewing')).toEqual(['TASK_CHECK_PASSED', 'TASK_REVIEW_STARTED'])
    expect(move('validating', 'failed')).toEqual(['TASK_CHECK_FAILED', 'TASK_FAILED'])
    expect(move('validating', 'ready')).toEqual(['TASK_CHECK_FAILED'])
    expect(move('dispatched', 'blocked')).toEqual(['TASK_WAITING_INPUT'])
    expect(move('dispatched', 'completed')).toEqual(['TASK_COMPLETED'])
    expect(move('dispatched', 'failed')).toEqual(['TASK_FAILED'])
    // dispatched → reviewing (no checks configured): no verdict precedes it, just the review's own
    // start — no longer the meaningless TASK_STATE_CHANGED.
    expect(move('dispatched', 'reviewing')).toEqual(['TASK_REVIEW_STARTED'])
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
    const orphan: OrchState = stateFromLegacy({
      runs: [run()],
      dispatches: [dispatch({ sessionId: 'sess-1' })]
    })
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

describe('deriveEvents — convergence', () => {
  const checks = [{ configId: 'c1', name: 'T', status: 'failed' as const, exitCode: 1, outputTail: 'x' }]
  it('validating → dispatched 는 TASK_CHECK_FAILED + TASK_STARTED 이고 check 요약을 싣는다', () => {
    const prev = withRun(run(), [task({ status: 'validating' })])
    const next = withRun(run(), [task({ status: 'dispatched', checks })])
    const ev = deriveEvents(prev, next, NOW)
    expect(ev.map((e) => e.type)).toEqual(['TASK_CHECK_FAILED', 'TASK_STARTED'])
    expect(ev[0].payload.checks).toEqual([{ configId: 'c1', status: 'failed', exitCode: 1 }])
  })
  // 정책 없는 Run 도 이제 checks 를 기록하므로(state.ts, UI 설계 U2) 그 Run 의 validating → failed 도 check
  // 요약을 싣는다 — validatingVerdict 는 Task 에 checks 가 있는지로만 가리고, 그것이 맞다: Journal 을 읽는
  // 쪽에 "이 Run 은 자동 수정 Run 이었나" 를 따로 물릴 이유가 없다.
  it('정책 없는 Run 의 validating → failed 도 check 요약을 싣는다', () => {
    const ev = deriveEvents(
      withRun(run(), [task({ status: 'validating' })]),
      withRun(run(), [task({ status: 'failed', checks })]),
      NOW
    )
    expect(ev.map((e) => e.type)).toEqual(['TASK_CHECK_FAILED', 'TASK_FAILED'])
    expect(ev[0].payload.checks).toEqual([{ configId: 'c1', status: 'failed', exitCode: 1 }])
  })
  it('→ reviewing 은 TASK_REVIEW_STARTED 다(검증에서 왔으면 TASK_CHECK_PASSED 가 먼저)', () => {
    expect(deriveEvents(withRun(run(), [task({ status: 'validating' })]), withRun(run(), [task({ status: 'reviewing' })]), NOW).map((e) => e.type)).toEqual(['TASK_CHECK_PASSED', 'TASK_REVIEW_STARTED'])
    expect(deriveEvents(withRun(run(), [task({ status: 'dispatched' })]), withRun(run(), [task({ status: 'reviewing' })]), NOW).map((e) => e.type)).toEqual(['TASK_REVIEW_STARTED'])
  })
  it('reviewing → completed 는 TASK_REVIEW_PASSED + TASK_COMPLETED', () => {
    // filtered to TASK_ events: this Task is its Run's only one, so completing it also ends the Run
    // (outcomeOf) and derives a trailing JOB_RUN_COMPLETED — correct, and orthogonal to this task
    // transition, which "the run completes or fails..." (deriveEvents — runs) already covers.
    expect(
      deriveEvents(withRun(run(), [task({ status: 'reviewing' })]), withRun(run(), [task({ status: 'completed' })]), NOW)
        .filter((e) => e.type.startsWith('TASK_'))
        .map((e) => e.type)
    ).toEqual(['TASK_REVIEW_PASSED', 'TASK_COMPLETED'])
  })
  it('reviewing → dispatched 는 TASK_REVIEW_CHANGES_REQUESTED 이고 이슈 요약을 싣는다', () => {
    const issues = [{ id: 'r1', severity: 'high' as const, blocking: true, title: 'race', description: 'd' }]
    const ev = deriveEvents(withRun(run(), [task({ status: 'reviewing' })]), withRun(run(), [task({ status: 'dispatched', reviewIssues: issues })]), NOW)
    expect(ev.map((e) => e.type)).toEqual(['TASK_REVIEW_CHANGES_REQUESTED', 'TASK_STARTED'])
    expect(ev[0].payload.issues).toEqual([{ severity: 'high', title: 'race', blocking: true }])
  })
  it('소진 Gate 로 blocked 되면 TASK_CONVERGENCE_EXHAUSTED 가 TASK_WAITING_INPUT 앞에 오고, repairs·reviewRounds 를 싣는다', () => {
    const gate = { id: 'g1', runId: 'run_1', taskId: 'tsk_1', question: 'exhausted', status: 'open' as const, createdAt: NOW, kind: 'convergence-exhausted' as const, options: ['retry-once', 'mark-failed'] }
    const repairs = [
      { id: 'dsp_r1', taskId: 'tsk_1', provider: 'claude' as const, accountId: 'a', sessionId: 's1', cwd: 'D:/p', specPath: '', startedAt: T1, workerState: 'ready' as const, retained: false, repair: 'check-failure' as const, outcome: 'failed' as const, endedAt: T1 },
      { id: 'dsp_r2', taskId: 'tsk_1', provider: 'claude' as const, accountId: 'a', sessionId: 's2', cwd: 'D:/p', specPath: '', startedAt: T1, workerState: 'ready' as const, retained: false, repair: 'check-failure' as const, outcome: 'failed' as const, endedAt: T1 }
    ]
    // the repair Dispatches already existed before this write (unchanged in prev/next) — this test
    // is about the task transition, not about deriving dispatch events for them
    const prev = { ...withRun(run(), [task({ status: 'validating' })]), dispatches: repairs }
    const next = { ...withRun(run(), [task({ status: 'blocked' })]), gates: [gate], dispatches: repairs }
    const ev = deriveEvents(prev, next, NOW)
    expect(ev.map((e) => e.type)).toEqual(['TASK_CHECK_FAILED', 'TASK_CONVERGENCE_EXHAUSTED', 'TASK_WAITING_INPUT'])
    // Facts, not the prose `question` alone (design §12): how much of the repair/review budget this
    // Task used before the app gave up.
    const exhausted = ev.find((e) => e.type === 'TASK_CONVERGENCE_EXHAUSTED')!
    expect(exhausted.payload.repairs).toBe(2)
    expect(exhausted.payload.reviewRounds).toBe(0)
    expect(exhausted.payload.question).toBe('exhausted')
  })
  it('reviewing → blocked exhausted 도 같은 모양이다(검토 라운드 소진)', () => {
    const gate = { id: 'g1', runId: 'run_1', taskId: 'tsk_1', question: 'review exhausted', status: 'open' as const, createdAt: NOW, kind: 'convergence-exhausted' as const, options: ['retry-once', 'mark-failed'] }
    const issues = [{ id: 'r1', severity: 'high' as const, blocking: true, title: 'race', description: 'd' }]
    const prev = withRun(run(), [task({ status: 'reviewing' })])
    const next = { ...withRun(run(), [task({ status: 'blocked', reviewIssues: issues })]), gates: [gate] }
    const ev = deriveEvents(prev, next, NOW)
    expect(ev.map((e) => e.type)).toEqual(['TASK_REVIEW_CHANGES_REQUESTED', 'TASK_CONVERGENCE_EXHAUSTED', 'TASK_WAITING_INPUT'])
    expect(ev[0].payload.issues).toEqual([{ severity: 'high', title: 'race', blocking: true }])
    expect(ev.find((e) => e.type === 'TASK_CONVERGENCE_EXHAUSTED')!.payload.reviewRounds).toBe(0)
  })
  it("'convergence-blocked' Gate 도 검증/검토의 판정이다(소진 이벤트만 없다) — 사람이 껐거나, Run 이 멈췄거나, repair 를 열 수 없었을 때", () => {
    const blockedGate = (question: string) => ({ id: 'g1', runId: 'run_1', taskId: 'tsk_1', question, status: 'open' as const, createdAt: NOW, kind: 'convergence-blocked' as const })
    const fromValidating = deriveEvents(
      withRun(run(), [task({ status: 'validating' })]),
      { ...withRun(run(), [task({ status: 'blocked', checks })]), gates: [blockedGate('stopped')] },
      NOW
    )
    expect(fromValidating.map((e) => e.type)).toEqual(['TASK_CHECK_FAILED', 'TASK_WAITING_INPUT'])
    expect(fromValidating[0].payload.checks).toEqual([{ configId: 'c1', status: 'failed', exitCode: 1 }])
    const issues = [{ id: 'r1', severity: 'high' as const, blocking: true, title: 'race', description: 'd' }]
    const fromReviewing = deriveEvents(
      withRun(run(), [task({ status: 'reviewing' })]),
      { ...withRun(run(), [task({ status: 'blocked', reviewIssues: issues })]), gates: [blockedGate('paused')] },
      NOW
    )
    expect(fromReviewing.map((e) => e.type)).toEqual(['TASK_REVIEW_CHANGES_REQUESTED', 'TASK_WAITING_INPUT'])
    expect(fromReviewing[0].payload.issues).toEqual([{ severity: 'high', title: 'race', blocking: true }])
  })
  it('Gate 없는 interrupted block 은 판정이 아니라 이전 라운드의 checks 를 새것처럼 싣지 않는다', () => {
    // A second-round Task still carries round 1's checks (the field is overwritten only when a new
    // round finishes) when blockForValidation interrupts round 2 before any check ran — no Gate kind,
    // because this isn't a verdict.
    const prev = withRun(run(), [task({ status: 'validating', checks })])
    const next = { ...withRun(run(), [task({ status: 'blocked', checks })]), gates: [{ id: 'g1', runId: 'run_1', taskId: 'tsk_1', question: 'cwd missing', status: 'open' as const, createdAt: NOW }] }
    const ev = deriveEvents(prev, next, NOW)
    expect(ev.map((e) => e.type)).toEqual(['TASK_WAITING_INPUT'])
    expect(ev[0].payload.checks).toBeUndefined()
  })
  it('repair Dispatch 의 ATTEMPT_START_REQUESTED 는 repair 를 싣고, JOB_RUN_STARTED 는 convergence 를 싣는다', () => {
    const d = { id: 'dsp_2', taskId: 'tsk_1', provider: 'claude' as const, accountId: 'a', sessionId: 'sess1', cwd: 'D:/p', specPath: '', startedAt: NOW, workerState: 'ready' as const, retained: false, repair: 'check-failure' as const, retryOf: 'dsp_1' }
    const prev = withRun(run({ convergence: {} }), [task({ status: 'validating' })])
    const next = { ...withRun(run({ convergence: {} }), [task({ status: 'dispatched' })]), dispatches: [d] }
    const ev = deriveEvents(prev, next, NOW)
    expect(ev.find((e) => e.type === 'ATTEMPT_START_REQUESTED')?.payload.repair).toBe('check-failure')
    const started = deriveEvents(emptyState(), withRun(run({ convergence: { maxFixAttempts: 2 } })), NOW)[0]
    expect(started.payload.convergence).toEqual({ maxFixAttempts: 2 })
  })
  it('one-shot 키(dispatch id로 끝난다)는 다른 now 에 다시 관찰해도 그대로다; repeatable 키(now 로 끝난다)는 아니다', () => {
    // This is what the journal's `OR IGNORE` insert actually depends on (design §5 "Dedupe"), not
    // "the same call twice returns the same thing" (true of any pure function, and proves nothing).
    const LATER = '2026-09-08T11:00:00.000Z'
    // repeatable: a task transition's key ends in `now` — re-deriving the *same* diff as though it
    // were observed at a different write time is, by the key's own design, a different observation.
    const prev = withRun(run(), [task({ status: 'reviewing' })])
    const next = withRun(run(), [task({ status: 'dispatched' })])
    const repeatableAt = (now: string) => deriveEvents(prev, next, now).find((e) => e.type === 'TASK_STARTED')!.idempotencyKey
    expect(repeatableAt(NOW)).not.toBe(repeatableAt(LATER))
    // one-shot: an attempt event's key ends in the dispatch id — a boot sweep re-deriving this same
    // repair Dispatch at whatever wall-clock time it happens to run must still dedupe against the
    // row the first derivation (at NOW) already inserted.
    const d = { id: 'dsp_2', taskId: 'tsk_1', provider: 'claude' as const, accountId: 'a', sessionId: 'pending:abcd', cwd: 'D:/p', specPath: '', startedAt: NOW, workerState: 'ready' as const, retained: false, repair: 'check-failure' as const }
    const withDispatch = { ...withRun(run(), [task({ status: 'dispatched' })]), dispatches: [d] }
    const oneShotAt = (now: string) =>
      deriveEvents(withRun(run(), [task({ status: 'ready' })]), withDispatch, now).find((e) => e.type === 'ATTEMPT_START_REQUESTED')!.idempotencyKey
    expect(oneShotAt(NOW)).toBe(oneShotAt(LATER))
  })
})

describe('deriveEvents — questions (Host journal J5, P3)', () => {
  const open = { id: 'g1', runId: 'run_1', taskId: 'tsk_1', question: 'Which db?', status: 'open' as const, createdAt: T1 }
  const answered = { ...open, status: 'resolved' as const, resolution: 'sqlite', resolvedAt: NOW }

  it('an answer is its own row, after the Task rows, keyed on the Gate', () => {
    const before: OrchState = { ...withRun(run(), [task({ status: 'blocked' })]), gates: [open] }
    const after: OrchState = { ...withRun(run(), [task({ status: 'pending', updatedAt: NOW })]), gates: [answered] }
    const ev = deriveEvents(before, after, NOW)
    expect(ev.map((e) => e.type)).toEqual(['TASK_STATE_CHANGED', 'GATE_RESOLVED'])
    expect(ev[1]).toMatchObject({
      runId: 'run_1', taskId: 'tsk_1', at: NOW, idempotencyKey: 'GATE_RESOLVED:g1',
      payload: { gateId: 'g1', kind: null, question: 'Which db?', resolution: 'sqlite' }
    })
  })

  it('an answer that moves no Task still records itself', () => {
    const before: OrchState = { ...withRun(run(), [task({ status: 'dispatched' })]), gates: [open] }
    const after: OrchState = { ...withRun(run(), [task({ status: 'dispatched' })]), gates: [answered] }
    expect(deriveEvents(before, after, NOW).map((e) => e.type)).toEqual(['GATE_RESOLVED'])
  })

  it('a Gate made and answered in one write counts; one already answered says nothing again', () => {
    const base = withRun(run(), [task({ status: 'dispatched' })])
    expect(deriveEvents(base, { ...base, gates: [answered] }, NOW).map((e) => e.type)).toEqual(['GATE_RESOLVED'])
    expect(deriveEvents({ ...base, gates: [answered] }, { ...base, gates: [answered] }, NOW)).toEqual([])
  })
})

describe('deriveEvents — keys (Host journal J6, P2)', () => {
  it('a repeatable row ends in the stamp when one is given, and in now otherwise; at stays now', () => {
    const on = withRun(run())
    const paused = withRun(run({ paused: true }))
    expect(deriveEvents(on, paused, NOW)[0].idempotencyKey).toBe(`JOB_RUN_PAUSED:run_1:${NOW}`)
    expect(deriveEvents(on, paused, NOW, 'h#7')[0]).toMatchObject({ at: NOW, idempotencyKey: 'JOB_RUN_PAUSED:run_1:h#7' })
    const t = deriveEvents(withRun(run(), [task({ status: 'ready' })]), withRun(run(), [task({ status: 'blocked' })]), NOW, 'h#8')
    expect(t[0].idempotencyKey).toBe('TASK_WAITING_INPUT:tsk_1:ready->blocked:h#8')
  })

  it('knows every event type by name, and nothing else', () => {
    expect(isContinuityEventType('GATE_RESOLVED')).toBe(true)
    expect(isContinuityEventType('RECOVERY_FAILED')).toBe(true)
    expect(isContinuityEventType('toString')).toBe(false)
    expect(isContinuityEventType('TASK_EXPLODED')).toBe(false)
  })
})
