import { describe, it, expect, vi } from 'vitest'
import { createResumeSweep } from './resumeSweep'
import { emptyState, type OrchState } from '../state'
import type { Dispatch, Task } from '../types'

const NOW = '2026-09-22T00:00:00.000Z'

const task = (over: Partial<Task> & Pick<Task, 'id' | 'status'>): Task => ({
  runId: 'run_1',
  jobId: 'job_1',
  title: 't',
  spec: 's',
  deps: [],
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})

const dispatch = (over: Partial<Dispatch> & Pick<Dispatch, 'id' | 'taskId'>): Dispatch => ({
  provider: 'codex',
  accountId: 'acc1',
  sessionId: `sess_${over.id}`,
  cwd: 'D:/wt',
  specPath: 'D:/p/orch/specs/s.md',
  startedAt: NOW,
  workerState: 'ready',
  retained: false,
  ...over
})

/** 수렴 정책이 있는 Job 한 개와 회차 한 개 — 그래야 interruptStalledTask 가 Gate 대신 resume 을 낸다 */
const stateWith = (tasks: Task[], dispatches: Dispatch[]): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: NOW, convergence: {} }],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW }],
  tasks,
  dispatches
})

const interrupted = (): OrchState =>
  stateWith(
    [task({ id: 'tsk_v', status: 'validating' }), task({ id: 'tsk_r', status: 'reviewing' })],
    [
      dispatch({ id: 'dsp_v', taskId: 'tsk_v', endedAt: NOW, outcome: 'succeeded' }),
      dispatch({ id: 'dsp_r', taskId: 'tsk_r', endedAt: NOW, outcome: 'succeeded' })
    ]
  )

const sweepOver = (
  getState: () => OrchState | null
): {
  run: (why: string) => void
  startValidation: ReturnType<typeof vi.fn>
  startReview: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
} => {
  const startValidation = vi.fn()
  const startReview = vi.fn()
  const log = vi.fn()
  const sweep = createResumeSweep({
    getState,
    startValidation,
    startReview,
    now: () => NOW,
    log
  })
  return { run: sweep.run, startValidation, startReview, log }
}

describe('createResumeSweep', () => {
  it('재시작에 끊긴 검증과 검토를 다시 돌린다', () => {
    const s = interrupted()
    const { run, startValidation, startReview } = sweepOver(() => s)
    run('테스트')
    expect(startValidation).toHaveBeenCalledWith({ taskId: 'tsk_v', cwd: 'D:/wt' })
    expect(startReview).toHaveBeenCalledWith({ taskId: 'tsk_r' })
  })

  // 이것이 이 sweep 의 값이다: Host 가 살아남은 재시작에서는 boot 가 null 이라 아무도 이 Task 들을
  // 다시 찾지 않았다.
  it('상태만 보고 찾는다 — Host 의 boot 발견 목록을 받지 않는다', () => {
    const s = interrupted()
    const { run, startValidation } = sweepOver(() => s)
    run('첫 붙음')
    expect(startValidation).toHaveBeenCalledTimes(1)
  })

  // **다시 돌린 검토가 Dispatch 를 열고 나면 상태 자체가 그 Task 를 뺀다.** 이것이 이 sweep 의
  // 멱등성이고, 기억을 들고 있지 않은 이유다 — 커밋 전의 좁은 창은 reviewGate.onOpenRefused 가
  // 받는다(ruling F37, reviewGate.test.ts).
  it('열린 Dispatch 가 생긴 Task 는 다음 sweep 의 후보가 아니다', () => {
    let s = interrupted()
    const { run, startReview } = sweepOver(() => s)
    run('첫 붙음')
    s = { ...s, dispatches: [...s.dispatches, dispatch({ id: 'dsp_r2', taskId: 'tsk_r', review: true })] }
    run('다시 붙음')
    expect(startReview).toHaveBeenCalledTimes(1)
  })

  // 거울이 비어 있다는 것은 Host 가 아직 상태를 밀지 않았다는 뜻이다 — 빈 상태로 판정하면
  // "끊긴 것이 없다" 는 거짓말이 된다.
  it('거울이 아직 비어 있으면 아무것도 하지 않는다', () => {
    const { run, startValidation, startReview } = sweepOver(() => null)
    run('첫 붙음')
    expect(startValidation).not.toHaveBeenCalled()
    expect(startReview).not.toHaveBeenCalled()
  })

  it('다시 돌릴 것이 없으면 로그도 남기지 않는다', () => {
    const { run, log } = sweepOver(() => stateWith([task({ id: 'tsk_c', status: 'completed' })], []))
    run('첫 붙음')
    expect(log).not.toHaveBeenCalled()
  })
})
