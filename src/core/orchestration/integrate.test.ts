import { describe, expect, it } from 'vitest'
import {
  buildIntegrationSpec,
  integrationTaskFor,
  isIntegrationTask,
  pendingMerges,
  runRootOf,
  runsWorkingIn,
  runWorktrees,
  workingInRunRoot,
  worktreeDepsOf
} from './integrate'
import { emptyState, type OrchState } from './state'
import type { Dispatch, Run, Task } from './types'

const RUN_CWD = '/p'
const WT_A = '/p-worktrees/a'
const WT_B = '/p-worktrees/b'

const run = (over: Partial<Run> = {}): Run => ({
  id: 'run_1',
  objective: 'o',
  cwd: RUN_CWD,
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

// 기본값은 **끝난** Dispatch 다. 이 판정이 답하는 질문("합칠 것이 있는가")에서 흔한 쪽이 그것이고,
// 열린 Dispatch 를 보는 테스트는 outcome·endedAt 을 지워서 만든다
const dispatch = (id: string, over: Partial<Dispatch> = {}): Dispatch => ({
  id,
  taskId: 't1',
  provider: 'claude',
  accountId: 'a',
  sessionId: 's',
  cwd: RUN_CWD,
  specPath: '/s',
  startedAt: '2026-08-19T00:00:00.000Z',
  endedAt: '2026-08-19T00:01:00.000Z',
  outcome: 'succeeded',
  workerState: 'stopped',
  retained: false,
  ...over
})

// **emptyState() 위에 얹는다** — schedule.test.ts 와 같은 이유로, OrchState 에 칸이 늘어도 이 헬퍼는
// 그대로 산다
const state = (over: Partial<OrchState> = {}): OrchState => ({
  ...emptyState(),
  runs: [run()],
  ...over
})

describe('pendingMerges', () => {
  it('의존이 프로젝트 폴더에서 돌았으면 합칠 것이 없다', () => {
    const s = state({
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [dispatch('dsp_1', { taskId: 't1', cwd: RUN_CWD })]
    })
    expect(pendingMerges(s, 't2')).toEqual([])
  })

  it('의존이 워크트리에서 돌았으면 그 cwd 를 돌려준다', () => {
    const s = state({
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [dispatch('dsp_1', { taskId: 't1', cwd: WT_A })]
    })
    expect(pendingMerges(s, 't2')).toEqual([WT_A])
  })

  it('의존이 여럿이면 deps 순서로 여럿을 돌려준다', () => {
    const s = state({
      tasks: [
        task('t1', { status: 'completed' }),
        task('t2', { status: 'completed' }),
        task('t3', { deps: ['t2', 't1'] })
      ],
      dispatches: [
        dispatch('dsp_1', { taskId: 't1', cwd: WT_A }),
        dispatch('dsp_2', { taskId: 't2', cwd: WT_B })
      ]
    })
    expect(pendingMerges(s, 't3')).toEqual([WT_B, WT_A])
  })

  it('같은 워크트리는 하나로 합친다 — 재시도 Dispatch 가 둘일 수 있다', () => {
    const s = state({
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [
        dispatch('dsp_1', { taskId: 't1', cwd: WT_A, outcome: 'failed' }),
        dispatch('dsp_2', { taskId: 't1', cwd: WT_A, retryOf: 'dsp_1' })
      ]
    })
    expect(pendingMerges(s, 't2')).toEqual([WT_A])
  })

  it('대소문자만 다른 cwd 는 같은 워크트리다 — 두 값은 따로 기록된다', () => {
    const s = state({
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [
        dispatch('dsp_1', { taskId: 't1', cwd: WT_A }),
        dispatch('dsp_2', { taskId: 't1', cwd: WT_A.toUpperCase() })
      ]
    })
    expect(pendingMerges(s, 't2')).toEqual([WT_A])
  })

  it('프로젝트 폴더를 대소문자만 다르게 적은 Dispatch 도 합칠 것이 없다', () => {
    const s = state({
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [dispatch('dsp_1', { taskId: 't1', cwd: RUN_CWD.toUpperCase() })]
    })
    expect(pendingMerges(s, 't2')).toEqual([])
  })

  it('끝나지 않은 Dispatch 는 세지 않는다 — 아직 합칠 것이 없다', () => {
    const s = state({
      tasks: [task('t1', { status: 'dispatched' }), task('t2', { deps: ['t1'] })],
      dispatches: [
        dispatch('dsp_1', {
          taskId: 't1',
          cwd: WT_A,
          outcome: undefined,
          endedAt: undefined,
          workerState: 'ready'
        })
      ]
    })
    expect(pendingMerges(s, 't2')).toEqual([])
  })

  it('실패로 끝난 Dispatch 도 센다 — 커밋은 보고와 무관하게 그 브랜치에 남는다', () => {
    const s = state({
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [dispatch('dsp_1', { taskId: 't1', cwd: WT_A, outcome: 'failed' })]
    })
    expect(pendingMerges(s, 't2')).toEqual([WT_A])
  })

  it('deps 가 없으면 빈 배열이다', () => {
    const s = state({
      tasks: [task('t1')],
      dispatches: [dispatch('dsp_1', { taskId: 't1', cwd: WT_A })]
    })
    expect(pendingMerges(s, 't1')).toEqual([])
  })

  it('모르는 Task 는 빈 배열이다', () => {
    expect(pendingMerges(state(), 'tsk_nope')).toEqual([])
  })

  it('Run 이 없는 Task 는 빈 배열이다 — 무엇과 비교할지 알 수 없다', () => {
    const s = state({
      runs: [],
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [dispatch('dsp_1', { taskId: 't1', cwd: WT_A })]
    })
    expect(pendingMerges(s, 't2')).toEqual([])
  })
})

describe('worktreeDepsOf', () => {
  it('워크트리를 남긴 의존 Task 의 id 만 돌려준다', () => {
    const s = state({
      tasks: [
        task('t1', { status: 'completed' }),
        task('t2', { status: 'completed' }),
        task('t3', { deps: ['t1', 't2'] })
      ],
      dispatches: [
        dispatch('dsp_1', { taskId: 't1', cwd: WT_A }),
        dispatch('dsp_2', { taskId: 't2', cwd: RUN_CWD })
      ]
    })
    expect(worktreeDepsOf(s, 't3')).toEqual(['t1'])
  })

  it('재시도로 Dispatch 가 둘이어도 id 는 하나다', () => {
    const s = state({
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [
        dispatch('dsp_1', { taskId: 't1', cwd: WT_A, outcome: 'failed' }),
        dispatch('dsp_2', { taskId: 't1', cwd: WT_B, retryOf: 'dsp_1' })
      ]
    })
    expect(worktreeDepsOf(s, 't2')).toEqual(['t1'])
    // 워크트리는 둘 다 합쳐야 한다 — 실패한 시도도 자기 브랜치에 커밋을 남길 수 있다
    expect(pendingMerges(s, 't2')).toEqual([WT_A, WT_B])
  })
})

describe('integrationTaskFor', () => {
  it('parentId 가 그 Task 를 가리키는 Task 를 찾는다', () => {
    const s = state({
      tasks: [task('t1'), task('t2', { parentId: 't1' })]
    })
    expect(integrationTaskFor(s, 't1')?.id).toBe('t2')
  })

  it('없으면 undefined — 그때 하나 만든다', () => {
    const s = state({ tasks: [task('t1'), task('t2')] })
    expect(integrationTaskFor(s, 't1')).toBeUndefined()
  })

  it('deps 가 같은 형제 Task 를 통합 Task 로 착각하지 않는다', () => {
    const s = state({
      tasks: [
        task('t1', { status: 'completed' }),
        task('t2', { deps: ['t1'] }),
        task('t3', { deps: ['t1'] })
      ]
    })
    expect(integrationTaskFor(s, 't2')).toBeUndefined()
  })
})

describe('isIntegrationTask', () => {
  it('parentId 가 있으면 통합 Task 다', () => {
    expect(isIntegrationTask(task('t2', { parentId: 't1' }))).toBe(true)
  })

  it('parentId 가 없으면 아니다', () => {
    expect(isIntegrationTask(task('t1'))).toBe(false)
  })
})

describe('runsWorkingIn', () => {
  // 열린 Dispatch 하나가 곧 "그 폴더에서 일하는 워커 하나"다. Run 을 돌려주는 이유는 부르는 쪽의
  // 질문이 둘로 갈리기 때문이다 — "이 폴더에 누가 있나"(집합이 비었나)와 "이 Run 이 남과 나눠
  // 쓰나"(내가 있고 크기가 2 이상인가). 술어를 둘로 나누면 같은 순회가 두 벌이 된다
  const open = (id: string, over = {}): Dispatch =>
    dispatch(id, { outcome: undefined, endedAt: undefined, workerState: 'ready', ...over })

  it('그 폴더에 열린 Dispatch 를 가진 Run 들을 낸다', () => {
    const s = state({
      runs: [run(), run({ id: 'run_2' })],
      tasks: [task('t1'), task('t2', { runId: 'run_2' })],
      dispatches: [open('dsp_1', { taskId: 't1' }), open('dsp_2', { taskId: 't2' })]
    })
    expect(runsWorkingIn(s, RUN_CWD)).toEqual(new Set(['run_1', 'run_2']))
  })

  it('끝난 Dispatch 는 세지 않는다', () => {
    const s = state({ tasks: [task('t1')], dispatches: [dispatch('dsp_1', { taskId: 't1' })] })
    expect(runsWorkingIn(s, RUN_CWD)).toEqual(new Set())
  })

  // 워크트리에서 도는 워커는 그 폴더를 나눠 쓰지 않는다 — 이 판정이 세는 것은 **한 작업 트리를
  // 함께 만지는** 워커뿐이다
  it('다른 폴더의 Dispatch 는 세지 않는다', () => {
    const s = state({ tasks: [task('t1')], dispatches: [open('dsp_1', { taskId: 't1', cwd: WT_A })] })
    expect(runsWorkingIn(s, RUN_CWD)).toEqual(new Set())
  })

  it('Task 가 없는 Dispatch 는 세지 않는다 — 어느 Run 것인지 알 수 없다', () => {
    const s = state({ tasks: [], dispatches: [open('dsp_1', { taskId: 'gone' })] })
    expect(runsWorkingIn(s, RUN_CWD)).toEqual(new Set())
  })

  it('한 Run 이 그 폴더에 워커 둘을 가져도 Run 하나다', () => {
    const s = state({
      tasks: [task('t1'), task('t2')],
      dispatches: [open('dsp_1', { taskId: 't1' }), open('dsp_2', { taskId: 't2' })]
    })
    expect(runsWorkingIn(s, RUN_CWD)).toEqual(new Set(['run_1']))
  })
})

describe('workingInRunRoot', () => {
  it('프로젝트 폴더에 열린 Dispatch 가 있으면 참이다', () => {
    const s = state({
      tasks: [task('t1', { status: 'dispatched' })],
      dispatches: [
        dispatch('dsp_1', {
          taskId: 't1',
          cwd: RUN_CWD,
          outcome: undefined,
          endedAt: undefined,
          workerState: 'ready'
        })
      ]
    })
    expect(workingInRunRoot(s, 'run_1')).toBe(true)
  })

  it('워크트리에 열린 Dispatch 는 거짓이다 — 병합을 막을 이유가 없다', () => {
    const s = state({
      tasks: [task('t1', { status: 'dispatched' })],
      dispatches: [
        dispatch('dsp_1', {
          taskId: 't1',
          cwd: WT_A,
          outcome: undefined,
          endedAt: undefined,
          workerState: 'ready'
        })
      ]
    })
    expect(workingInRunRoot(s, 'run_1')).toBe(false)
  })

  it('끝난 Dispatch 는 거짓이다', () => {
    const s = state({
      tasks: [task('t1', { status: 'completed' })],
      dispatches: [dispatch('dsp_1', { taskId: 't1', cwd: RUN_CWD })]
    })
    expect(workingInRunRoot(s, 'run_1')).toBe(false)
  })

  it('다른 Run 의 Dispatch 라도 같은 폴더에서 돌고 있으면 참이다', () => {
    const s = state({
      runs: [run(), run({ id: 'run_2' })],
      tasks: [task('t1', { runId: 'run_2', status: 'dispatched' })],
      dispatches: [
        dispatch('dsp_1', {
          taskId: 't1',
          cwd: RUN_CWD,
          outcome: undefined,
          endedAt: undefined,
          workerState: 'ready'
        })
      ]
    })
    expect(workingInRunRoot(s, 'run_1')).toBe(true)
  })

  it('모르는 Run 은 거짓이다', () => {
    expect(workingInRunRoot(state(), 'run_nope')).toBe(false)
  })
})

describe('buildIntegrationSpec', () => {
  const spec = (): string =>
    buildIntegrationSpec({
      mergeInto: RUN_CWD,
      reason: 'merge-tree reported a conflict',
      worktrees: [
        { path: WT_A, branch: 'me/a' },
        { path: WT_B, branch: null }
      ]
    })

  it('합칠 워크트리의 경로와 브랜치를 모두 적는다', () => {
    const out = spec()
    expect(out).toContain(WT_A)
    expect(out).toContain('me/a')
    expect(out).toContain(WT_B)
  })

  it('앱이 멈춘 이유와 저장소 경로를 적는다', () => {
    const out = spec()
    expect(out).toContain('merge-tree reported a conflict')
    expect(out).toContain(RUN_CWD)
  })

  it('되돌리지 말라고 적는다 — 앱은 "합쳤다"와 "포기했다"를 구별할 수 없다', () => {
    expect(spec()).toContain('git merge --abort')
    expect(spec()).toContain('git reset --hard')
  })
})

describe('runWorktrees', () => {
  // 삭제 모달이 "워크트리 N 개" 를 적고, 감추기 체크박스가 그 경로를 렌더러의 숨김 목록에 넣는다.
  // 판정은 pendingMerges 와 **같은 규칙**이다(dispatch.cwd 가 run.cwd 가 아니면 워크트리) — 두
  // 번째 정의를 만들면 모달이 세는 것과 앱이 합치는 것이 갈라진다
  it('이 Run 의 Dispatch 가 쓴 워크트리 경로를 중복 없이 돌려준다', () => {
    const s = state({
      tasks: [task('t1'), task('t2'), task('t3')],
      dispatches: [
        dispatch('dsp_1', { taskId: 't1', cwd: WT_A }),
        dispatch('dsp_2', { taskId: 't2', cwd: WT_B }),
        // 같은 워크트리의 두 번째 Dispatch(재시도·검토) — 한 번만 센다
        dispatch('dsp_3', { taskId: 't2', cwd: WT_B }),
        // 프로젝트 폴더에서 돈 것은 워크트리가 아니다
        dispatch('dsp_4', { taskId: 't3', cwd: RUN_CWD })
      ]
    })
    expect(runWorktrees(s, 'run_1')).toEqual([WT_A, WT_B])
  })

  it('워크트리를 쓰지 않은 Run 은 빈 배열이다', () => {
    const s = state({
      tasks: [task('t1')],
      dispatches: [dispatch('dsp_1', { taskId: 't1', cwd: RUN_CWD })]
    })
    expect(runWorktrees(s, 'run_1')).toEqual([])
  })

  it('없는 Run 은 빈 배열이다', () => {
    expect(runWorktrees(state(), 'run_nope')).toEqual([])
  })

  it('다른 Run 의 워크트리는 세지 않는다', () => {
    const s = state({
      runs: [run(), run({ id: 'run_2' })],
      tasks: [task('t1'), task('t2', { runId: 'run_2' })],
      dispatches: [
        dispatch('dsp_1', { taskId: 't1', cwd: WT_A }),
        dispatch('dsp_2', { taskId: 't2', cwd: WT_B })
      ]
    })
    expect(runWorktrees(s, 'run_1')).toEqual([WT_A])
  })
})

describe('runRootOf', () => {
  it('워크트리가 없으면 프로젝트 폴더다', () => {
    expect(runRootOf(run())).toBe(RUN_CWD)
  })

  it('워크트리가 있으면 그것이다', () => {
    expect(runRootOf(run({ worktree: WT_A }))).toBe(WT_A)
  })
})

// 이 묶음이 Task 2 의 요점이다. 순차 Run 은 Task 들이 **같은** 워크트리를 물려받으므로 합칠 것이
// 없다 — 기준을 run.cwd 로 두면 그 폴더가 run.cwd 와 달라서 매번 병합 대상으로 잡힌다.
describe('Run 워크트리 안에서의 병합 판정', () => {
  /** t1 → t2 로 이어지는 순차 Run. 둘 다 Run 워크트리(WT_A)에서 돌았다 */
  const sequential = (): OrchState => ({
    ...emptyState(),
    runs: [run({ worktree: WT_A, concurrency: 1 })],
    tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
    dispatches: [dispatch('d1', { taskId: 't1', cwd: WT_A })]
  })

  it('같은 Run 워크트리에서 돈 의존은 합칠 것이 없다', () => {
    expect(pendingMerges(sequential(), 't2')).toEqual([])
  })

  it('그래서 통합 Task 의 deps 도 비어 있다', () => {
    expect(worktreeDepsOf(sequential(), 't2')).toEqual([])
  })

  it('Task 별 워크트리는 Run 워크트리와 달라 여전히 합칠 대상이다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ worktree: WT_A, concurrency: 2 })],
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [dispatch('d1', { taskId: 't1', cwd: WT_B })]
    }
    expect(pendingMerges(s, 't2')).toEqual([WT_B])
  })

  it('프로젝트 폴더에서 돈 의존도 합칠 대상이다 — Run 뿌리가 아니다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ worktree: WT_A })],
      tasks: [task('t1', { status: 'completed' }), task('t2', { deps: ['t1'] })],
      dispatches: [dispatch('d1', { taskId: 't1', cwd: RUN_CWD })]
    }
    expect(pendingMerges(s, 't2')).toEqual([RUN_CWD])
  })
})

describe('workingInRunRoot', () => {
  const openIn = (cwd: string): OrchState => ({
    ...emptyState(),
    runs: [run({ worktree: WT_A })],
    tasks: [task('t1')],
    dispatches: [dispatch('d1', { cwd, outcome: undefined, endedAt: undefined })]
  })

  it('Run 워크트리에서 도는 워커를 본다', () => {
    expect(workingInRunRoot(openIn(WT_A), 'run_1')).toBe(true)
  })

  it('프로젝트 폴더에서 도는 워커는 이 Run 의 뿌리가 아니다', () => {
    expect(workingInRunRoot(openIn(RUN_CWD), 'run_1')).toBe(false)
  })

  it('워크트리가 없으면 프로젝트 폴더를 본다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run()],
      tasks: [task('t1')],
      dispatches: [dispatch('d1', { cwd: RUN_CWD, outcome: undefined, endedAt: undefined })]
    }
    expect(workingInRunRoot(s, 'run_1')).toBe(true)
  })
})

// runWorktrees 는 이 Task 에서 **바꾸지 않는다**. 그 판정이 Run 워크트리도 낸다는 사실에 Task 7 의
// 병합 버튼과 삭제 모달이 함께 기대므로, 바꾸지 않았다는 것을 여기서 고정한다.
describe('runWorktrees 와 Run 워크트리', () => {
  it('Run 워크트리도 이 Run 이 쓴 폴더다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ worktree: WT_A })],
      tasks: [task('t1')],
      dispatches: [dispatch('d1', { cwd: WT_A })]
    }
    expect(runWorktrees(s, 'run_1')).toEqual([WT_A])
  })

  // **이 테스트가 실제 결함을 고정한다.** 동시 실행 2 이상에서 접합점이 없으면 Run 워크트리에서 도는
  // 워커가 하나도 없다 — Dispatch 의 cwd 만 보면 그 폴더가 목록에서 빠지고, 삭제가 Task 워크트리만
  // 지우고 Run 워크트리를 남긴다. 로그에서 "만든 것과 지운 것이 매번 어긋난다"로 나타났다.
  it('Run 워크트리에서 돈 Dispatch 가 없어도 그 폴더는 이 Run 의 것이다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ worktree: WT_A, concurrency: 2 })],
      tasks: [task('t1')],
      dispatches: [dispatch('d1', { taskId: 't1', cwd: WT_B })]
    }
    expect(runWorktrees(s, 'run_1')).toEqual([WT_B, WT_A])
  })

  it('같은 폴더를 두 번 내지 않는다 — 동시 실행 1 은 Dispatch 가 그 안에서 돈다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ worktree: WT_A, concurrency: 1 })],
      tasks: [task('t1'), task('t2')],
      dispatches: [
        dispatch('d1', { taskId: 't1', cwd: WT_A }),
        dispatch('d2', { taskId: 't2', cwd: WT_A })
      ]
    }
    expect(runWorktrees(s, 'run_1')).toEqual([WT_A])
  })

  it('Run 워크트리가 프로젝트 폴더면 넣지 않는다 — 그 목록은 지울 폴더의 목록이다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ worktree: RUN_CWD })],
      tasks: [task('t1')],
      dispatches: [dispatch('d1', { taskId: 't1', cwd: RUN_CWD })]
    }
    expect(runWorktrees(s, 'run_1')).toEqual([])
  })

  it('Run 워크트리와 Task 워크트리가 함께 온다 — 병합이 둘 다 필요하다', () => {
    const s: OrchState = {
      ...emptyState(),
      runs: [run({ worktree: WT_A, concurrency: 2 })],
      tasks: [task('t1'), task('t2')],
      dispatches: [
        dispatch('d1', { taskId: 't1', cwd: WT_B }),
        dispatch('d2', { taskId: 't2', cwd: WT_A })
      ]
    }
    expect(runWorktrees(s, 'run_1')).toEqual([WT_B, WT_A])
  })
})
