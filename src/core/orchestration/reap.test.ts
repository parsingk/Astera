import { describe, expect, it } from 'vitest'
import { reapableChildRuns } from './reap'
import { emptyState, type OrchState } from './state'
import type { Dispatch, Run, Task } from './types'

const WT = '/p-worktrees/a'

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  objective: 'o',
  cwd: '/p',
  createdAt: '2026-08-22T00:00:00.000Z',
  provider: 'claude',
  ...over
})

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  runId: 'run_1',
  title: id,
  spec: 's',
  deps: [],
  status: 'completed',
  consecutiveFailures: 0,
  createdAt: '2026-08-22T00:00:00.000Z',
  updatedAt: '2026-08-22T00:00:00.000Z',
  ...over
})

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'd1',
  taskId: 't1',
  provider: 'claude',
  accountId: 'a',
  sessionId: 's',
  cwd: WT,
  specPath: '/s',
  startedAt: '2026-08-22T00:00:00.000Z',
  endedAt: '2026-08-22T00:01:00.000Z',
  outcome: 'succeeded',
  workerState: 'stopped',
  retained: false,
  ...over
})

/** 완료된 회차 하나. 기본형이고, 아래 테스트들이 한 군데씩 바꿔 가며 거절을 확인한다 */
const completedChild = (over: Partial<Run> = {}): OrchState => ({
  ...emptyState(),
  runs: [run({ templateId: 'run_tmpl', worktree: WT, ...over })],
  tasks: [task('t1')],
  dispatches: [dispatch()]
})

/** 레지스트리에 다 있다고 보는 판정. 걷힌 뒤를 보는 테스트만 이것을 바꾼다 */
const always = (): boolean => true

describe('reapableChildRuns', () => {
  it('완료된 회차의 워크트리를 낸다', () => {
    expect(reapableChildRuns(completedChild(), always)).toEqual([
      { runId: 'run_1', worktrees: [WT] }
    ])
  })

  it('평범한 Run 은 걷지 않는다 — 사람이 결과를 보러 온다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ worktree: WT })],
      tasks: [task('t1')],
      dispatches: [dispatch()]
    }
    expect(reapableChildRuns(s, always)).toEqual([])
  })

  it('예약 템플릿 자신은 걷지 않는다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ schedule: { kind: 'daily', time: '09:00' }, worktree: WT })],
      tasks: [task('t1')],
      dispatches: [dispatch()]
    }
    expect(reapableChildRuns(s, always)).toEqual([])
  })

  it('실패한 회차의 폴더는 남긴다', () => {
    const s = completedChild()
    const failed: OrchState = { ...s, tasks: [task('t1', { status: 'failed' })] }
    expect(reapableChildRuns(failed, always)).toEqual([])
  })

  it('아직 도는 회차는 걷지 않는다', () => {
    const s = completedChild()
    const running: OrchState = { ...s, tasks: [task('t1', { status: 'dispatched' })] }
    expect(reapableChildRuns(running, always)).toEqual([])
  })

  it('열린 Dispatch 가 있으면 걷지 않는다', () => {
    const s = completedChild()
    const open: OrchState = {
      ...s,
      dispatches: [dispatch({ outcome: undefined, endedAt: undefined })]
    }
    expect(reapableChildRuns(open, always)).toEqual([])
  })

  it('이미 걷힌 폴더는 다시 내지 않는다 — 저장마다 로그가 쌓이는 것을 막는다', () => {
    expect(reapableChildRuns(completedChild(), () => false)).toEqual([])
  })

  it('레지스트리에 있는 것만 낸다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ templateId: 'run_tmpl', worktree: WT })],
      tasks: [task('t1'), task('t2')],
      dispatches: [dispatch({ cwd: WT }), dispatch({ id: 'd2', taskId: 't2', cwd: '/gone' })]
    }
    expect(reapableChildRuns(s, (p) => p === WT)).toEqual([{ runId: 'run_1', worktrees: [WT] }])
  })

  it('쓴 워크트리가 없으면 낼 것이 없다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ templateId: 'run_tmpl' })],
      tasks: [task('t1')],
      dispatches: [dispatch({ cwd: '/p' })]
    }
    expect(reapableChildRuns(s, always)).toEqual([])
  })
})
