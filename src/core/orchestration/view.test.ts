import { describe, it, expect } from 'vitest'
import { runsForProject, progressOf, snapshotFor, sameSnapshot } from './view'
import { emptyState } from './state'
import type { OrchState } from './state'
import type { Dispatch, Gate, Run, Task } from './types'
import { absPath } from '../testPaths'

const run = (id: string, cwd: string, status: Run['status'] = 'open'): Run => ({
  id, objective: `objective ${id}`, cwd, status, createdAt: '2026-08-18T00:00:00.000Z'
})
const task = (id: string, runId: string, status: Task['status']): Task => ({
  id, runId, title: `task ${id}`, spec: '', deps: [], status,
  consecutiveFailures: 0, createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z'
})
const withRuns = (runs: Run[], tasks: Task[] = []): OrchState => ({ ...emptyState(), runs, tasks })
const dispatch = (id: string, taskId: string, sessionId: string, startedAt: string): Dispatch => ({
  id, taskId, sessionId, startedAt, provider: 'claude', accountId: 'acc',
  cwd: absPath('p'), specPath: '', workerState: 'ready', retained: false
})
const gate = (
  id: string, taskId: string, question: string, createdAt: string, status: Gate['status'] = 'open'
): Gate => ({ id, runId: 'r1', taskId, question, status, createdAt })
/** 세션 소유는 main 의 것이라 주입된다 — 접기 규칙만 보는 테스트에서는 전부 살아 있다고 본다 */
const anySession = (): boolean => true

describe('runsForProject', () => {
  it('그 프로젝트의 Run 만 고른다', () => {
    const s = withRuns([run('r1', absPath('proj')), run('r2', absPath('other'))])
    expect(runsForProject(s, absPath('proj')).map((r) => r.id)).toEqual(['r1'])
  })

  // orchestration.json 은 앱 전역 저장소라 --cwd 에 제약이 없다. cwd 가 프로젝트 루트 아래(중첩
  // 저장소)인 Run 은 그 중첩 프로젝트의 것이지 이 프로젝트의 것이 아니다 — "포함"이 아니라 "동일"이어야 한다
  it('프로젝트 루트 아래(중첩 디렉터리)의 Run 은 고르지 않는다', () => {
    const s = withRuns([run('r1', absPath('proj', 'nested'))])
    expect(runsForProject(s, absPath('proj')).map((r) => r.id)).toEqual([])
  })

  // Run.cwd 는 프로젝트 루트지만, 같은 경로가 대소문자만 달리 도착할 수 있다(win32).
  // 문자열 === 로 비교하면 그 Run 이 목록에서 사라진다
  it.runIf(process.platform === 'win32')('win32 에서는 대소문자 차이를 무시한다', () => {
    const s = withRuns([run('r1', 'D:\\Proj')])
    expect(runsForProject(s, 'd:\\proj').map((r) => r.id)).toEqual(['r1'])
  })

  it('열린 Run 이 먼저, 그 안에서 최신순', () => {
    const older = { ...run('a', absPath('p')), createdAt: '2026-08-01T00:00:00.000Z' }
    const newer = { ...run('b', absPath('p')), createdAt: '2026-08-18T00:00:00.000Z' }
    const closed = { ...run('c', absPath('p'), 'closed' as const), createdAt: '2026-08-19T00:00:00.000Z' }
    expect(runsForProject(withRuns([older, closed, newer]), absPath('p')).map((r) => r.id))
      .toEqual(['b', 'a', 'c'])
  })
})

describe('progressOf', () => {
  it('완료 수와 전체 수를 센다', () => {
    const s = withRuns([run('r1', absPath('p'))], [
      task('t1', 'r1', 'completed'), task('t2', 'r1', 'completed'), task('t3', 'r1', 'ready')
    ])
    expect(progressOf(s, 'r1')).toEqual({ done: 2, total: 3 })
  })

  // failed 를 완료로 세면 재시도가 남아 있는데도 진행률이 앞서 보이고, 재시도가 실패하면 되돌아간다
  it('failed 는 완료로 세지 않는다', () => {
    const s = withRuns([run('r1', absPath('p'))], [
      task('t1', 'r1', 'completed'), task('t2', 'r1', 'failed')
    ])
    expect(progressOf(s, 'r1')).toEqual({ done: 1, total: 2 })
  })

  it('Task 가 없으면 0/0 이다', () => {
    expect(progressOf(withRuns([run('r1', absPath('p'))]), 'r1')).toEqual({ done: 0, total: 0 })
  })

  it('다른 Run 의 Task 를 세지 않는다', () => {
    const s = withRuns([run('r1', absPath('p')), run('r2', absPath('p'))], [
      task('t1', 'r1', 'completed'), task('t2', 'r2', 'completed')
    ])
    expect(progressOf(s, 'r1')).toEqual({ done: 1, total: 1 })
  })
})

describe('snapshotFor', () => {
  it('그 프로젝트의 Run 을 진행률과 함께 접는다', () => {
    const s = withRuns([run('r1', absPath('p')), run('r2', absPath('other'))], [
      task('t1', 'r1', 'completed'), task('t2', 'r1', 'ready'), task('t3', 'r2', 'ready')
    ])
    expect(snapshotFor(s, absPath('p'), anySession).runs).toEqual([
      {
        id: 'r1', objective: 'objective r1', status: 'open', done: 1, total: 2,
        tasks: [
          { id: 't1', title: 'task t1', status: 'completed', sessionId: undefined, gateQuestion: undefined, openGates: 0 },
          { id: 't2', title: 'task t2', status: 'ready', sessionId: undefined, gateQuestion: undefined, openGates: 0 }
        ]
      }
    ])
  })

  // 오케스트레이터가 Task 를 선언한 순서 = 의존 사슬을 읽는 순서. deps 는 전순서가 아니라 정렬 기준이 못 된다
  it('Task 는 createdAt 오름차순이다', () => {
    const later = { ...task('t1', 'r1', 'ready'), createdAt: '2026-08-18T02:00:00.000Z' }
    const earlier = { ...task('t2', 'r1', 'ready'), createdAt: '2026-08-18T01:00:00.000Z' }
    const s = withRuns([run('r1', absPath('p'))], [later, earlier])
    expect(snapshotFor(s, absPath('p'), anySession).runs[0].tasks.map((t) => t.id)).toEqual(['t2', 't1'])
  })

  // 재시도는 같은 Task 에 새 Dispatch 를 연다 — 행이 가리켜야 하는 것은 마지막 워커의 세션이다
  it('sessionId 는 가장 최근 Dispatch 의 것이다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [
        dispatch('d2', 't1', 'sess-new', '2026-08-18T02:00:00.000Z'),
        dispatch('d1', 't1', 'sess-old', '2026-08-18T01:00:00.000Z')
      ]
    }
    expect(snapshotFor(s, absPath('p'), anySession).runs[0].tasks[0].sessionId).toBe('sess-new')
  })

  // 정리된 세션(worker-release)과 worker-start 가 잠시 커밋하는 `pending:` 자리표시자가 같이 걸러진다 —
  // 둘 다 렌더러가 열 탭이 없는 값이다
  it('알 수 없는 세션이면 sessionId 를 싣지 않는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [dispatch('d1', 't1', 'pending:ab12cd34', '2026-08-18T01:00:00.000Z')]
    }
    const known = (id: string): boolean => id === 'sess-1'
    expect(snapshotFor(s, absPath('p'), known).runs[0].tasks[0].sessionId).toBeUndefined()
  })

  it('Dispatch 가 없으면 sessionId 가 없다', () => {
    const s = withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'ready')])
    expect(snapshotFor(s, absPath('p'), anySession).runs[0].tasks[0].sessionId).toBeUndefined()
  })

  it('gateQuestion 은 열린 Gate 중 가장 이른 것이고 openGates 는 그 개수다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'blocked')]),
      gates: [
        gate('g2', 't1', '나중 질문', '2026-08-18T02:00:00.000Z'),
        gate('g1', 't1', '먼저 질문', '2026-08-18T01:00:00.000Z')
      ]
    }
    const t = snapshotFor(s, absPath('p'), anySession).runs[0].tasks[0]
    expect(t.gateQuestion).toBe('먼저 질문')
    expect(t.openGates).toBe(2)
  })

  it('resolved 된 Gate 는 세지 않는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'ready')]),
      gates: [gate('g1', 't1', '끝난 질문', '2026-08-18T01:00:00.000Z', 'resolved')]
    }
    const t = snapshotFor(s, absPath('p'), anySession).runs[0].tasks[0]
    expect(t.gateQuestion).toBeUndefined()
    expect(t.openGates).toBe(0)
  })

  it('다른 Task 의 Gate 를 가져오지 않는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'ready'), task('t2', 'r1', 'blocked')]),
      gates: [gate('g1', 't2', '질문', '2026-08-18T01:00:00.000Z')]
    }
    const [t1, t2] = snapshotFor(s, absPath('p'), anySession).runs[0].tasks
    expect(t1.openGates).toBe(0)
    expect(t2.gateQuestion).toBe('질문')
  })

  it('그 프로젝트에 Run 이 없으면 빈 목록이다', () => {
    const s = withRuns([run('r1', absPath('other'))])
    expect(snapshotFor(s, absPath('p'), anySession)).toEqual({ runs: [] })
  })
})

describe('sameSnapshot', () => {
  const base = (): OrchState => ({
    ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
    dispatches: [dispatch('d1', 't1', 'sess-1', '2026-08-18T01:00:00.000Z')]
  })
  const fold = (s: OrchState): ReturnType<typeof snapshotFor> =>
    snapshotFor(s, absPath('p'), anySession)

  // 하트비트·상태 메시지·Delivery 수령은 전부 상태를 커밋하지만 이 투영은 건드리지 않는다.
  // 그때마다 같은 페이로드를 다시 보내지 않는 것이 이 함수의 존재 이유다
  it('사이드바가 보는 것이 그대로면 같다고 본다', () => {
    const s = base()
    const noisy: OrchState = {
      ...s,
      messages: [{
        id: 'msg_1', runId: 'r1', type: 'heartbeat', subject: 's', body: 'b',
        answered: false, createdAt: '2026-08-18T03:00:00.000Z'
      }]
    }
    expect(sameSnapshot(fold(s), fold(noisy))).toBe(true)
  })

  it('Task 상태가 바뀌면 다르다고 본다', () => {
    const s = base()
    const moved: OrchState = { ...s, tasks: [task('t1', 'r1', 'completed')] }
    expect(sameSnapshot(fold(s), fold(moved))).toBe(false)
  })

  // 있던 값이 사라지는 방향 — 직렬화 비교가 키를 통째로 떨어뜨리는 자리라 따로 본다
  it('sessionId 가 사라지면 다르다고 본다', () => {
    const s = base()
    const gone = snapshotFor(s, absPath('p'), () => false)
    expect(sameSnapshot(fold(s), gone)).toBe(false)
  })

  it('Gate 가 열리면 다르다고 본다', () => {
    const s = base()
    const gated: OrchState = { ...s, gates: [gate('g1', 't1', '질문', '2026-08-18T02:00:00.000Z')] }
    expect(sameSnapshot(fold(s), fold(gated))).toBe(false)
  })

  it('Run 이 늘면 다르다고 본다', () => {
    const s = base()
    const more: OrchState = { ...s, runs: [...s.runs, run('r2', absPath('p'))] }
    expect(sameSnapshot(fold(s), fold(more))).toBe(false)
  })

  it('빈 스냅샷끼리는 같다고 본다', () => {
    expect(sameSnapshot({ runs: [] }, { runs: [] })).toBe(true)
  })
})
