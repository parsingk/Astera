import { describe, it, expect, vi } from 'vitest'
import { createReviewGate } from './reviewGate'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Dispatch, Task } from '../../core/orchestration/types'

const NOW = '2026-09-22T10:00:00.000Z'

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

/** 검토가 이미 돌고 있는 Task 하나 — reviewing 이고, 그 검토의 Dispatch 가 열려 있다. */
const reviewUnderWay = (): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: NOW }],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW }],
  tasks: [task({ id: 'tsk_1', status: 'reviewing' })],
  dispatches: [
    dispatch({ id: 'dsp_impl', taskId: 'tsk_1', endedAt: NOW, outcome: 'succeeded' }),
    dispatch({ id: 'dsp_rev', taskId: 'tsk_1', review: true })
  ]
})

const rig = (
  initial: OrchState
): {
  gate: ReturnType<typeof createReviewGate>
  state: () => OrchState
  log: ReturnType<typeof vi.fn>
} => {
  let state = initial
  const log = vi.fn()
  const gate = createReviewGate({
    getState: () => state,
    setState: async (next) => {
      state = next
    },
    now: () => NOW,
    log
  })
  return { gate, state: () => state, log }
}

describe('createReviewGate', () => {
  // **이것이 F37 이 고치라고 한 결함이다.** 두 번째 시도가 받는 `dispatch already open` 은 실패가
  // 아니라 경합이고, 그것을 Gate 로 보내면 지금 돌고 있는 검토의 Dispatch 가 지워지고 Task 가
  // 막힌다 — 두 번째가 첫 번째를 무너뜨린다.
  it('이미 열린 검토 Dispatch 가 있다는 거절은 그 검토를 그대로 둔다', async () => {
    const r = rig(reviewUnderWay())
    await r.gate.onOpenRefused({ taskId: 'tsk_1', error: 'dispatch already open: dsp_rev' })
    const rev = r.state().dispatches.find((d) => d.id === 'dsp_rev')
    expect(rev, '돌고 있는 검토의 Dispatch 가 지워졌다').toBeDefined()
    expect(rev?.endedAt).toBeUndefined()
    expect(r.state().tasks[0].status).toBe('reviewing')
    expect(r.state().gates).toHaveLength(0)
  })

  // 나머지 거절은 그대로 사람에게 간다 — 아무것도 돌고 있지 않고, 다음에 무엇을 할지는 사람이 정한다.
  it('그 밖의 거절은 여전히 Gate 로 간다', async () => {
    const r = rig(reviewUnderWay())
    await r.gate.onOpenRefused({ taskId: 'tsk_1', error: 'task is not reviewing: blocked' })
    expect(r.state().tasks[0].status).toBe('blocked')
    expect(r.state().gates).toHaveLength(1)
    expect(r.state().gates[0].question).toContain('task is not reviewing')
  })

  // 같은 머리말을 흉내 낸 다른 문장에 걸리지 않는다 — 판정은 openReviewDispatch 가 내는 그 모양이다.
  it('머리말만 닮은 문장은 경합으로 읽지 않는다', async () => {
    const r = rig(reviewUnderWay())
    await r.gate.onOpenRefused({
      taskId: 'tsk_1',
      error: 'sessionId already in use by an open dispatch: dsp_rev'
    })
    expect(r.state().tasks[0].status).toBe('blocked')
  })

  it('Gate 는 이 Task 의 열린 검토 Dispatch 를 먼저 지운다', async () => {
    const r = rig(reviewUnderWay())
    await r.gate.gate({ taskId: 'tsk_1', reason: 'no logged-in account' })
    expect(r.state().dispatches.map((d) => d.id)).toEqual(['dsp_impl'])
    expect(r.state().tasks[0].status).toBe('blocked')
  })

  // 전이가 막히면 그 사실만 남기고 아무것도 바꾸지 않는다 — 옛 gate() 의 갈래 그대로다.
  it('막을 수 없는 Task 는 로그만 남긴다', async () => {
    const s = reviewUnderWay()
    const r = rig({ ...s, tasks: [task({ id: 'tsk_1', status: 'completed' })] })
    await r.gate.gate({ taskId: 'tsk_1', reason: 'no logged-in account' })
    expect(r.state().gates).toHaveLength(0)
    expect(r.log.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/could not block task=tsk_1/)
  })
})
