import { describe, it, expect, vi } from 'vitest'
import { createResumeSweep } from './resumeSweep'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Dispatch, Task } from '../../core/orchestration/types'

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
  getState: () => OrchState | null,
  over: { enabled?: boolean } = {}
): {
  run: (why: string) => void
  markDriven: (taskId: string) => void
  startValidation: ReturnType<typeof vi.fn>
  startReview: ReturnType<typeof vi.fn>
  log: ReturnType<typeof vi.fn>
} => {
  const startValidation = vi.fn()
  const startReview = vi.fn()
  const log = vi.fn()
  const sweep = createResumeSweep({
    getState,
    enabled: () => over.enabled !== false,
    startValidation,
    startReview,
    now: () => NOW,
    log
  })
  return { run: sweep.run, markDriven: sweep.markDriven, startValidation, startReview, log }
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

  // **두 번 불러도 Dispatch 는 하나다.** 상태 판정만으로는 부족하다 — 다시 돌린 검토가 자기
  // Dispatch 를 커밋하기까지는 몇 번의 await 가 있고, 그 창에 두 번째 sweep 이 들어오면 상태는
  // 첫 번째가 본 것과 똑같이 보인다.
  it('두 번 돌려도 같은 Task 를 두 번 시작하지 않는다', () => {
    const s = interrupted()
    const { run, startValidation, startReview } = sweepOver(() => s)
    run('첫 붙음')
    run('다시 붙음')
    expect(startValidation).toHaveBeenCalledTimes(1)
    expect(startReview).toHaveBeenCalledTimes(1)
  })

  // 검토가 Dispatch 를 열고 나면 상태 자체가 그 Task 를 빼 준다 — 기억에 기대지 않는 두 번째 방벽.
  it('열린 Dispatch 가 생긴 Task 는 다음 sweep 의 후보가 아니다', () => {
    let s = interrupted()
    const { run, startReview } = sweepOver(() => s)
    run('첫 붙음')
    s = { ...s, dispatches: [...s.dispatches, dispatch({ id: 'dsp_r2', taskId: 'tsk_r', review: true })] }
    run('다시 붙음')
    expect(startReview).toHaveBeenCalledTimes(1)
  })

  // 기억이 영원하면 앱 수명 동안 자라기만 하고, 한 바퀴 돌아 다시 끊긴 Task 를 영영 못 살린다.
  it('상태가 더 이상 그 Task 를 말하지 않으면 기억을 잊는다', () => {
    let s = interrupted()
    const { run, startValidation } = sweepOver(() => s)
    run('첫 붙음')
    s = { ...s, tasks: s.tasks.map((t) => (t.id === 'tsk_v' ? { ...t, status: 'ready' as const } : t)) }
    run('검증이 끝난 뒤')
    s = { ...s, tasks: s.tasks.map((t) => (t.id === 'tsk_v' ? { ...t, status: 'validating' as const } : t)) }
    run('다시 끊긴 뒤')
    expect(startValidation).toHaveBeenCalledTimes(2)
  })

  // 보고를 받아 막 검토를 띄운 Task 는 상태만 보면 끊긴 Task 와 똑같이 보인다(reviewing, 아직
  // 열린 Dispatch 없음). 그 창에 sweep 이 들어와 한 번 더 띄우면 openReviewDispatch 가 둘째를
  // 거절하고, 그 거절을 받은 startReview 가 첫째의 Dispatch 를 지우고 Task 를 막아 버린다.
  it('앱이 이미 띄운 Task 는 sweep 이 다시 띄우지 않는다', () => {
    const s = interrupted()
    const { run, markDriven, startReview } = sweepOver(() => s)
    markDriven('tsk_r')
    run('첫 붙음')
    expect(startReview).not.toHaveBeenCalled()
  })

  // 거울이 비어 있다는 것은 Host 가 아직 상태를 밀지 않았다는 뜻이다 — 빈 상태로 판정하면
  // "끊긴 것이 없다" 는 거짓말이 된다.
  it('거울이 아직 비어 있으면 아무것도 하지 않는다', () => {
    const { run, startValidation, startReview } = sweepOver(() => null)
    run('첫 붙음')
    expect(startValidation).not.toHaveBeenCalled()
    expect(startReview).not.toHaveBeenCalled()
  })

  // orchestration 이 꺼져 있으면 서버가 모든 보고를 409 로 거절하므로 시작해도 끝을 볼 수 없다.
  // 조용히 버리지 않고 그 사실을 남긴다.
  it('orchestration 이 꺼져 있으면 시작하지 않고 그 사실을 로그로 남긴다', () => {
    const s = interrupted()
    const { run, startValidation, startReview, log } = sweepOver(() => s, { enabled: false })
    run('첫 붙음')
    expect(startValidation).not.toHaveBeenCalled()
    expect(startReview).not.toHaveBeenCalled()
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/orchestration is off/)
  })

  it('다시 돌릴 것이 없으면 로그도 남기지 않는다', () => {
    const { run, log } = sweepOver(() => stateWith([task({ id: 'tsk_c', status: 'completed' })], []))
    run('첫 붙음')
    expect(log).not.toHaveBeenCalled()
  })
})
