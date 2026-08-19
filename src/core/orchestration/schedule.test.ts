import { describe, expect, it } from 'vitest'
import { pendingMerges } from './integrate'
import { slotsToFill } from './schedule'
import { emptyState, type OrchState } from './state'
import type { Run, Task } from './types'

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  objective: 'o',
  cwd: '/p',
  createdAt: '2026-08-19T00:00:00.000Z',
  provider: 'claude',
  autoDispatch: true,
  ...over
})

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  runId: 'run_1',
  title: id,
  spec: 's',
  deps: [],
  status: 'ready',
  consecutiveFailures: 0,
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
  ...over
})

// **emptyState() 위에 얹는다** — OrchState 에는 여기서 안 쓰는 칸도 있고(messages, deliveries,
// gates) 손으로 세면 하나 빠뜨려 타입체크가 깨진다. 칸이 늘어도 이 헬퍼는 그대로 산다
const state = (over: Partial<OrchState> = {}): OrchState => ({
  ...emptyState(),
  runs: [run()],
  ...over
})

describe('slotsToFill', () => {
  it('autoDispatch 가 아닌 Run 은 보지 않는다 — 코디네이터가 돌리는 Run 이다', () => {
    const s = state({ runs: [run({ autoDispatch: undefined })], tasks: [task('t1')] })
    expect(slotsToFill(s)).toEqual([])
  })

  it('provider 가 없는 Run 은 건너뛴다 — 명령으로는 못 만들지만 파일은 손으로 고쳐진다', () => {
    const s = state({ runs: [run({ provider: undefined })], tasks: [task('t1')] })
    expect(slotsToFill(s)).toEqual([])
  })

  it('ready 만 고른다', () => {
    const s = state({
      tasks: [task('t1', { status: 'pending' }), task('t2'), task('t3', { status: 'blocked' })]
    })
    expect(slotsToFill(s).map((x) => x.taskId)).toEqual(['t2'])
  })

  it('상한만큼만 돌려준다 — 기본값은 DEFAULT_CONCURRENCY(3)', () => {
    const s = state({ tasks: [task('t1'), task('t2'), task('t3'), task('t4')] })
    expect(slotsToFill(s)).toHaveLength(3)
  })

  it('열린 Dispatch 가 상한을 먹는다', () => {
    const s = state({
      runs: [run({ concurrency: 2 })],
      tasks: [task('t1', { status: 'dispatched' }), task('t2'), task('t3')],
      dispatches: [
        {
          id: 'dsp_1',
          taskId: 't1',
          provider: 'claude',
          accountId: 'a',
          sessionId: 's',
          cwd: '/p',
          specPath: '/s',
          startedAt: '2026-08-19T00:00:00.000Z',
          workerState: 'ready',
          retained: false
        }
      ]
    })
    expect(slotsToFill(s).map((x) => x.taskId)).toEqual(['t2'])
  })

  it('끝난 Dispatch 는 자리를 먹지 않는다', () => {
    const s = state({
      runs: [run({ concurrency: 1 })],
      tasks: [task('t1', { status: 'completed' }), task('t2')],
      dispatches: [
        {
          id: 'dsp_1',
          taskId: 't1',
          provider: 'claude',
          accountId: 'a',
          sessionId: 's',
          cwd: '/p',
          specPath: '/s',
          startedAt: '2026-08-19T00:00:00.000Z',
          endedAt: '2026-08-19T00:01:00.000Z',
          outcome: 'succeeded',
          workerState: 'stopped',
          retained: false
        }
      ]
    })
    expect(slotsToFill(s).map((x) => x.taskId)).toEqual(['t2'])
  })

  it('회로가 차단된 Task 는 고르지 않는다 — worker-start 가 어차피 거절한다', () => {
    const s = state({ tasks: [task('t1', { consecutiveFailures: 3 }), task('t2')] })
    expect(slotsToFill(s).map((x) => x.taskId)).toEqual(['t2'])
  })

  it('순서는 tasks 배열의 순서(생성 순서)다', () => {
    const s = state({
      runs: [run({ concurrency: 2 })],
      tasks: [task('t3'), task('t1'), task('t2')]
    })
    expect(slotsToFill(s).map((x) => x.taskId)).toEqual(['t3', 't1'])
  })

  it('Run 이 여럿이면 각자 자기 상한을 갖는다', () => {
    const s = state({
      runs: [run({ id: 'run_1', concurrency: 1 }), run({ id: 'run_2', concurrency: 1, provider: 'codex' })],
      tasks: [task('a1'), task('a2'), task('b1', { runId: 'run_2' })]
    })
    expect(slotsToFill(s)).toEqual([
      { runId: 'run_1', taskId: 'a1', provider: 'claude' },
      { runId: 'run_2', taskId: 'b1', provider: 'codex' }
    ])
  })

  it('ready 이면서 열린 Dispatch 를 가진 Task 는 이중으로 고르지 않는다 — 불변식이 깨져도 두 워커가 같은 Task 를 잡지 않는다', () => {
    const s = state({
      tasks: [task('t1'), task('t2')],
      dispatches: [
        {
          id: 'dsp_1',
          taskId: 't1',
          provider: 'claude',
          accountId: 'a',
          sessionId: 's',
          cwd: '/p',
          specPath: '/s',
          startedAt: '2026-08-19T00:00:00.000Z',
          workerState: 'ready',
          retained: false
        }
      ]
    })
    expect(slotsToFill(s).map((x) => x.taskId)).toEqual(['t2'])
  })

  // 판정과 배선의 경계를 못박는다. slotsToFill 은 순수해야 하고 워크트리를 모른다 — 그래서 **아직
  // 합쳐지지 않은 Task 도 슬롯으로는 나온다.** 거르는 것은 배선이다(ipc.ts 가 pendingMerges 를 보고
  // 직접 합치거나 통합 Task 를 만든다). 이것을 적어 두지 않으면 나중에 누군가 이 함수 안에 통합
  // 검사를 넣고, 그러면 이 함수가 git 을 알아야 하므로 이 파일의 테스트 전부가 저장소를 요구하게 된다.
  it('의존이 워크트리에서 돌아 아직 합쳐지지 않은 Task 도 슬롯으로 나온다 — 거르는 것은 배선이다', () => {
    const s = state({
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [
        {
          id: 'dsp_1',
          taskId: 't1',
          provider: 'claude',
          accountId: 'a',
          sessionId: 's',
          cwd: '/p-worktrees/t1', // run.cwd('/p')가 아니다 — 워크트리에서 돌았다
          specPath: '/s',
          startedAt: '2026-08-19T00:00:00.000Z',
          endedAt: '2026-08-19T00:01:00.000Z',
          outcome: 'succeeded',
          workerState: 'stopped',
          retained: false
        }
      ]
    })
    expect(pendingMerges(s, 't2')).toEqual(['/p-worktrees/t1']) // 합칠 것이 있는데도
    expect(slotsToFill(s).map((x) => x.taskId)).toEqual(['t2']) // 슬롯으로는 나온다
  })
})
