import { describe, it, expect } from 'vitest'
import { jobsForProject, progressOf, outcomeOf, snapshotFor, sameSnapshot } from './view'
import { emptyState } from './state'
import { ensureProject } from './projects'
import type { OrchState } from './state'
import type { CheckResult, Dispatch, Gate, Message, ResumeEntry, Task } from './types'
import { stateFromLegacy } from './legacyState'
import type { LegacyRun } from './legacy'
import { FAILURE_LIMIT, MAX_REVIEW_ROUNDS } from './types'
import type { JobTask, WorktreeInfo } from '../types'
import { absPath } from '../testPaths'

const run = (id: string, cwd: string): LegacyRun => ({
  id, objective: `objective ${id}`, cwd, createdAt: '2026-08-18T00:00:00.000Z'
})
const task = (id: string, runId: string, status: Task['status']): Task => ({
  id, runId, title: `task ${id}`, spec: '', deps: [], status,
  consecutiveFailures: 0, createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z'
})
const withRuns = (runs: LegacyRun[], tasks: Task[] = []): OrchState => stateFromLegacy({ runs, tasks })
const dispatch = (id: string, taskId: string, sessionId: string, startedAt: string): Dispatch => ({
  id, taskId, sessionId, startedAt, provider: 'claude', accountId: 'acc',
  cwd: absPath('p'), specPath: '', workerState: 'ready', retained: false
})
const gate = (
  id: string, taskId: string, question: string, createdAt: string, status: Gate['status'] = 'open'
): Gate => ({ id, runId: 'r1', taskId, question, status, createdAt })
/** 세션 소유는 main 의 것이라 주입된다 — 접기 규칙만 보는 테스트에서는 전부 살아 있다고 본다 */
const anySession = (): boolean => true
/** 워크트리 레지스트리도 main 의 것이라 주입된다. 대부분의 규칙은 워크트리와 무관하다 */
const noWorktrees: WorktreeInfo[] = []
const wt = (repoPath: string, p: string): WorktreeInfo => ({
  id: p, repoPath, path: p, name: 'feature', branch: 'u/feature',
  baseRef: 'origin/main', createdAt: '2026-08-18T00:00:00.000Z'
})
/** 재시도가 소진된 실패 Task — 여기까지 와야 terminal 이다 */
const exhausted = (t: Task): Task => ({ ...t, consecutiveFailures: FAILURE_LIMIT })
const message = (id: string, runId: string, type: Message['type']): Message => ({
  id, runId, type, subject: `subject ${id}`, body: '', answered: false,
  createdAt: '2026-08-18T00:00:00.000Z'
})
/** 다음 발화 시각은 ticker 의 메모리에 있어 주입된다 — isKnownSession·noWorktrees 와 같은 갈래.
 *  접기 규칙만 보는 테스트에서는 무장이 없다고 본다 */
const noFires = (): number | null => null
/** 폴더가 다 있다고 보는 판정 — 사라진 폴더를 보는 테스트만 이것을 바꾼다 */
const allExist = (): boolean => true

describe('runsForProject', () => {
  it('그 프로젝트의 Run 만 고른다', () => {
    const s = withRuns([run('r1', absPath('proj')), run('r2', absPath('other'))])
    expect(jobsForProject(s, absPath('proj'), noWorktrees).map((r) => r.id)).toEqual(['job_r1'])
  })

  // orchestration.json 은 앱 전역 저장소라 --cwd 에 제약이 없다. cwd 가 프로젝트 루트 아래(중첩
  // 저장소)인 Run 은 그 중첩 프로젝트의 것이지 이 프로젝트의 것이 아니다 — "포함"이 아니라 "동일"이어야 한다
  it('프로젝트 루트 아래(중첩 디렉터리)의 Run 은 고르지 않는다', () => {
    const s = withRuns([run('r1', absPath('proj', 'nested'))])
    expect(jobsForProject(s, absPath('proj'), noWorktrees).map((r) => r.id)).toEqual([])
  })

  // 워크트리는 레지스트리 루트 아래, 저장소 밖에 있어서 저장 시점의 정규화가 닿지 않는다.
  // 되돌리지 않으면 그 Run 은 저장소 탭에서도 워크트리 탭에서도 보이지 않는다 —
  // 'orch.list' 가 렌더러의 경로에 거는 것과 같은 매핑을 r.cwd 에도 건다
  it('등록된 워크트리 안에서 만들어진 Run 은 그 저장소의 것으로 센다', () => {
    const s = withRuns([run('r1', absPath('wt', 'app', 'feature'))])
    const list = [wt(absPath('repos', 'app'), absPath('wt', 'app', 'feature'))]
    expect(jobsForProject(s, absPath('repos', 'app'), list).map((r) => r.id)).toEqual(['job_r1'])
  })

  // projectId 가 있으면 경로를 보지 않는다. 워크트리에서 만들어진 Run 이든 하위 디렉터리에서
  // 만들어진 Run 이든, 어느 프로젝트의 것인지는 이미 정해져 있다
  it('projectId 가 있으면 경로가 어긋나도 그 프로젝트의 것으로 센다', () => {
    const reg = ensureProject(emptyState(), { path: absPath('proj'), now: 'T0' })
    const r1 = { ...run('r1', absPath('somewhere', 'else')), projectId: reg.project.id }
    const s = { ...stateFromLegacy({ runs: [r1] }), projects: reg.state.projects }
    expect(jobsForProject(s, absPath('proj'), noWorktrees).map((r) => r.id)).toEqual(['job_r1'])
  })

  it('projectId 가 다른 프로젝트를 가리키면 경로가 맞아도 고르지 않는다', () => {
    const a = ensureProject(emptyState(), { path: absPath('proj'), now: 'T0' })
    const b = ensureProject(a.state, { path: absPath('other'), now: 'T1' })
    const r1 = { ...run('r1', absPath('proj')), projectId: b.project.id }
    const s = { ...stateFromLegacy({ runs: [r1] }), projects: b.state.projects }
    expect(jobsForProject(s, absPath('proj'), noWorktrees).map((r) => r.id)).toEqual([])
  })

  // **매달린 id 는 Job 을 숨기지 않는다.** 프로젝트 기록이 사라진 Run 은 경로 유도로 물러난다 —
  // 그것이 이 칸이 생기기 전 모든 Run 이 쓰던 답이고, 목록에서 사라지는 것보다 낫다
  it('projectId 가 없는 프로젝트를 가리키면 경로로 물러난다', () => {
    const r1 = { ...run('r1', absPath('proj')), projectId: 'proj_gone' }
    const s = withRuns([r1])
    expect(jobsForProject(s, absPath('proj'), noWorktrees).map((r) => r.id)).toEqual(['job_r1'])
  })

  // repoPathOf 는 등록되지 않은 경로를 그대로 통과시킨다 — 이 정규화가 소유 판정을 넓히지 않는다
  it('등록되지 않은 경로는 매핑하지 않는다', () => {
    const s = withRuns([run('r1', absPath('other'))])
    const list = [wt(absPath('repos', 'app'), absPath('wt', 'app', 'feature'))]
    expect(jobsForProject(s, absPath('repos', 'app'), list).map((r) => r.id)).toEqual([])
  })

  // Run.cwd 는 프로젝트 루트지만, 같은 경로가 대소문자만 달리 도착할 수 있다(win32).
  // 문자열 === 로 비교하면 그 Run 이 목록에서 사라진다
  it.runIf(process.platform === 'win32')('win32 에서는 대소문자 차이를 무시한다', () => {
    const s = withRuns([run('r1', 'D:\\Proj')])
    expect(jobsForProject(s, 'd:\\proj', noWorktrees).map((r) => r.id)).toEqual(['job_r1'])
  })

  it('최신순으로 정렬한다', () => {
    const older = { ...run('a', absPath('p')), createdAt: '2026-08-01T00:00:00.000Z' }
    const newer = { ...run('b', absPath('p')), createdAt: '2026-08-18T00:00:00.000Z' }
    expect(jobsForProject(withRuns([older, newer]), absPath('p'), noWorktrees).map((r) => r.id)).toEqual(['job_b', 'job_a'])
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

describe('outcomeOf', () => {
  const only = (statuses: Task['status'][]): OrchState =>
    withRuns(
      [run('r1', absPath('p'))],
      statuses.map((s, i) => task(`t${i}`, 'r1', s))
    )

  // Run 만 만들고 Task 를 아직 만들지 않은 상태가 정상적인 시작 지점이다. every 는 빈 배열에
  // 참이므로 이 가드가 없으면 새로 만든 Run 이 completed 로 보인다
  it('Task 가 없으면 running 이다', () => {
    expect(outcomeOf(only([]), 'r1')).toBe('running')
  })

  it('모두 completed 면 completed 다', () => {
    expect(outcomeOf(only(['completed', 'completed']), 'r1')).toBe('completed')
  })

  // 사람이 손봐야 하는 Run 을 목록에서 바로 찾을 수 있어야 한다
  it('종료되었지만 재시도가 소진된 failed 가 섞이면 failed 다', () => {
    const s = withRuns([run('r1', absPath('p'))], [
      task('t1', 'r1', 'completed'), exhausted(task('t2', 'r1', 'failed'))
    ])
    expect(outcomeOf(s, 'r1')).toBe('failed')
  })

  // 전이표(types.ts)의 failed: ['dispatched', 'blocked'] — 실패한 Task 는 FAILURE_LIMIT 까지
  // 재시도되고 그것이 정상 흐름이다. 재시도를 기다리는 Task 를 failed 로 적으면 다음 시도에서
  // 라벨이 사라진다 (progressOf 가 failed 를 완료로 세지 않는 것과 같은 이유)
  it('재시도가 남은 failed 는 running 이다', () => {
    const retrying = { ...task('t1', 'r1', 'failed'), consecutiveFailures: 1 }
    const s = withRuns([run('r1', absPath('p'))], [retrying])
    expect(outcomeOf(s, 'r1')).toBe('running')
  })

  it('같은 Task 라도 연속 실패가 FAILURE_LIMIT 이면 failed 다', () => {
    const s = withRuns([run('r1', absPath('p'))], [exhausted(task('t1', 'r1', 'failed'))])
    expect(outcomeOf(s, 'r1')).toBe('failed')
  })

  it('하나라도 종료되지 않았으면 running 이다', () => {
    expect(outcomeOf(only(['completed', 'dispatched']), 'r1')).toBe('running')
  })

  // validating 은 종료가 아니다 — 검증이 끝나야 결과가 정해진다
  it('validating 이 섞이면 running 이다', () => {
    expect(outcomeOf(only(['completed', 'validating']), 'r1')).toBe('running')
  })

  // blocked 는 terminal 이 아니다 — Gate 가 풀리면 다시 흐른다
  it('blocked 가 섞이면 running 이다', () => {
    expect(outcomeOf(only(['completed', 'blocked']), 'r1')).toBe('running')
  })

  it('pending 과 ready 도 종료가 아니다', () => {
    expect(outcomeOf(only(['pending']), 'r1')).toBe('running')
    expect(outcomeOf(only(['ready']), 'r1')).toBe('running')
  })

  it('다른 Run 의 Task 는 세지 않는다', () => {
    const s = withRuns(
      [run('r1', absPath('p')), run('r2', absPath('p'))],
      [task('t1', 'r1', 'completed'), task('t2', 'r2', 'dispatched')]
    )
    expect(outcomeOf(s, 'r1')).toBe('completed')
  })
})

describe('snapshotFor', () => {
  it('그 프로젝트의 Run 을 진행률과 함께 접는다', () => {
    const s = withRuns([run('r1', absPath('p')), run('r2', absPath('other'))], [
      task('t1', 'r1', 'completed'), task('t2', 'r1', 'ready'), task('t3', 'r2', 'ready')
    ])
    expect(snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs).toEqual([
      {
        // 줄의 id 는 계획의 것이고, fireOrdinal 은 그 줄이 보여 주는 회차의 번호다
        id: 'job_r1', fireOrdinal: 1, objective: 'objective r1', outcome: 'running', done: 1, total: 2, eventCount: 3,
        concurrency: undefined, sharesProjectFolder: false,
        tasks: [
          { id: 't1', title: 'task t1', status: 'completed', sessionId: undefined, gateQuestion: undefined, openGates: 0 },
          { id: 't2', title: 'task t2', status: 'ready', sessionId: undefined, gateQuestion: undefined, openGates: 0 }
        ]
      }
    ])
  })

  // 끝난 Run 이 아래로 간다 — 예전에는 저장된 status 로 판정했고, 이제는 Task 에서 파생한다.
  // 목록의 맨 위는 지금 도는 작업의 자리다
  it('도는 Run 이 먼저, 그 안에서 최신순', () => {
    const older = { ...run('a', absPath('p')), createdAt: '2026-08-01T00:00:00.000Z' }
    const newer = { ...run('b', absPath('p')), createdAt: '2026-08-18T00:00:00.000Z' }
    const done = { ...run('c', absPath('p')), createdAt: '2026-08-19T00:00:00.000Z' }
    const s = withRuns([older, done, newer], [task('t1', 'c', 'completed')])
    expect(snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs.map((r) => r.id)).toEqual(['job_b', 'job_a', 'job_c'])
  })

  it('각 Run 에 outcome 을 실어 보낸다', () => {
    const s = withRuns(
      [run('r1', absPath('p')), run('r2', absPath('p'))],
      [task('t1', 'r1', 'completed'), exhausted(task('t2', 'r2', 'failed'))]
    )
    const byId = new Map(snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs.map((r) => [r.id, r.outcome]))
    expect(byId.get('job_r1')).toBe('completed')
    expect(byId.get('job_r2')).toBe('failed')
  })

  // 오케스트레이터가 Task 를 선언한 순서 = 의존 사슬을 읽는 순서. deps 는 전순서가 아니라 정렬 기준이 못 된다
  it('Task 는 createdAt 오름차순이다', () => {
    const later = { ...task('t1', 'r1', 'ready'), createdAt: '2026-08-18T02:00:00.000Z' }
    const earlier = { ...task('t2', 'r1', 'ready'), createdAt: '2026-08-18T01:00:00.000Z' }
    const s = withRuns([run('r1', absPath('p'))], [later, earlier])
    expect(snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks.map((t) => t.id)).toEqual(['t2', 't1'])
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
    expect(snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0].sessionId).toBe('sess-new')
  })

  // 정리된 세션(worker-release)과 worker-start 가 잠시 커밋하는 `pending:` 자리표시자가 같이 걸러진다 —
  // 둘 다 렌더러가 열 탭이 없는 값이다
  it('알 수 없는 세션이면 sessionId 를 싣지 않는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [dispatch('d1', 't1', 'pending:ab12cd34', '2026-08-18T01:00:00.000Z')]
    }
    const known = (id: string): boolean => id === 'sess-1'
    expect(snapshotFor(s, absPath('p'), known, noWorktrees, noFires, allExist).runs[0].tasks[0].sessionId).toBeUndefined()
  })

  it('Dispatch 가 없으면 sessionId 가 없다', () => {
    const s = withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'ready')])
    expect(snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0].sessionId).toBeUndefined()
  })

  // provider·startedAt 은 "지금 도는 중"을 말하는 값이다 — 열린 Dispatch(끝나지 않은 것) 하나면 그대로 실린다
  it('열린 Dispatch 가 있으면 그 provider 와 startedAt 을 싣는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [dispatch('d1', 't1', 'sess-1', '2026-08-18T01:00:00.000Z')]
    }
    const t = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]
    expect(t.provider).toBe('claude')
    expect(t.startedAt).toBe('2026-08-18T01:00:00.000Z')
  })

  // outcome 과 endedAt 이 붙으면 그 Dispatch 는 더 이상 도는 것이 아니다. sessionId 는 그 워커의
  // 탭을 여전히 열어야 하므로 남지만, provider·startedAt 은 "지금 돈다"는 주장이라 남으면 거짓말이 된다
  it('Dispatch 가 끝났으면 둘 다 없다 — 도는 것이 아니기 때문이다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'completed')]),
      dispatches: [{
        ...dispatch('d1', 't1', 'sess-1', '2026-08-18T01:00:00.000Z'),
        outcome: 'succeeded', endedAt: '2026-08-18T02:00:00.000Z'
      }]
    }
    const t = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]
    expect(t.sessionId).toBe('sess-1')
    expect(t.provider).toBeUndefined()
    expect(t.startedAt).toBeUndefined()
  })

  // 첫 시도(d1)는 끝났고 재시도(d2)가 지금 돈다. sessionId 는 가장 최근 Dispatch(d2)의 것이고,
  // provider·startedAt 도 열린 Dispatch(d2)의 것이다 — 끝난 d1 의 provider('codex')는 새지 않는다
  it('재시도로 Dispatch 가 둘이면 열린 쪽을 쓴다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [
        {
          ...dispatch('d1', 't1', 'sess-old', '2026-08-18T01:00:00.000Z'),
          provider: 'codex', outcome: 'failed', endedAt: '2026-08-18T01:30:00.000Z'
        },
        dispatch('d2', 't1', 'sess-new', '2026-08-18T02:00:00.000Z')
      ]
    }
    const t = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]
    expect(t.sessionId).toBe('sess-new')
    expect(t.provider).toBe('claude')
    expect(t.startedAt).toBe('2026-08-18T02:00:00.000Z')
  })

  // 상세 창의 `띄우기` 가 스케줄러와 같은 계정을 고르려면 이 값이 투영에 실려야 한다 — 안 실리면
  // 그 버튼이 기본 계정으로 띄워, 같은 Task 가 누가 띄웠는지에 따라 다른 계정에서 돈다
  it('Task 에 지정된 계정을 순서대로 싣는다', () => {
    const t0 = task('t1', 'r1', 'ready')
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [{ ...t0, accountIds: ['acc_2', 'acc_1'] }])
    }
    const t = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]
    expect(t.accountIds).toEqual(['acc_2', 'acc_1'])
  })

  it('지정이 없으면 그 칸이 없다', () => {
    const s = withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'ready')])
    const t = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]
    expect('accountIds' in t).toBe(false)
  })

  it('gateQuestion 은 열린 Gate 중 가장 이른 것이고 openGates 는 그 개수다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'blocked')]),
      gates: [
        gate('g2', 't1', '나중 질문', '2026-08-18T02:00:00.000Z'),
        gate('g1', 't1', '먼저 질문', '2026-08-18T01:00:00.000Z')
      ]
    }
    const t = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]
    // **id 가 함께 실린다** — gate-resolve 가 그것을 요구하므로, 없으면 화면에서 답할 길이 없다.
    // 질문과 한 묶음인 이유: 셋 다 "가장 이른 열린 Gate" 하나를 가리키는데 따로 실으면 그중 하나만
    // 고쳐지는 날 화면이 A 의 질문을 보여 주고 B 를 푼다
    expect(t.gate).toEqual({ id: 'g1', question: '먼저 질문' })
    expect(t.openGates).toBe(2)
  })

  // gate-create --options 가 받는 값이다. 코디네이터가 고를 것을 줬는데 화면이 그것을 모르면
  // 사람은 자유 입력으로 그 낱말을 다시 쳐야 한다
  it('Gate 의 선택지도 함께 싣는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'blocked')]),
      gates: [
        { ...gate('g1', 't1', '어느 쪽으로 갈까요', '2026-08-18T01:00:00.000Z'), options: ['A', 'B'] }
      ]
    }
    const t = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]
    expect(t.gate).toEqual({ id: 'g1', question: '어느 쪽으로 갈까요', options: ['A', 'B'] })
  })

  it('resolved 된 Gate 는 세지 않는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'ready')]),
      gates: [gate('g1', 't1', '끝난 질문', '2026-08-18T01:00:00.000Z', 'resolved')]
    }
    const t = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]
    expect(t.gate).toBeUndefined()
    expect(t.openGates).toBe(0)
  })

  it('다른 Task 의 Gate 를 가져오지 않는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'ready'), task('t2', 'r1', 'blocked')]),
      gates: [gate('g1', 't2', '질문', '2026-08-18T01:00:00.000Z')]
    }
    const [t1, t2] = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks
    expect(t1.openGates).toBe(0)
    expect(t2.gate?.question).toBe('질문')
  })

  it('그 프로젝트에 Run 이 없으면 빈 목록이다', () => {
    const s = withRuns([run('r1', absPath('other'))])
    expect(snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist)).toEqual({
      runs: [],
      projectFolderBusy: false
    })
  })

  it('Run 마다 이벤트 개수를 싣는다', () => {
    const s = { ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'pending')]),
      messages: [message('m1', 'r1', 'status')] }
    // run-created + task-created + message
    expect(snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].eventCount).toBe(3)
  })

  // concurrency 는 Run 이 들고 있는 값을 그대로 옮긴 것이다 — 계산도 기본값도 여기서 넣지
  // 않는다(JobRow 의 주석과 같다). 기본값(DEFAULT_CONCURRENCY)을 적용하는 것은 이 값을 읽는
  // 렌더러의 일이다. **provider 는 이 자리에 없다** — Run 이 아니라 Task 의 계정이 정하므로
  // 한 Run 에 실을 하나의 값이 없다(JobRow 의 주석).
  it('Run 의 concurrency 를 그대로 싣는다', () => {
    const s = withRuns([{ ...run('r1', absPath('p')), concurrency: 2 }])
    const [r] = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs
    expect(r.concurrency).toBe(2)
  })

  it('Run 에 없으면 undefined 다 — 기본값을 여기서 채우지 않는다', () => {
    const s = withRuns([run('r1', absPath('p'))])
    const [r] = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs
    expect(r.concurrency).toBeUndefined()
  })

  // 관리자가 있어야 하는데 없다는 사실이 사이드바의 버튼 근거다 — 이 칸이 없으면 사람이
  // 코디네이터를 되돌릴 자리가 사라진다
  it('코디네이터 계정이 있는데 세션이 없으면 coordinatorMissing 이다', () => {
    const s = withRuns([{ ...run('r1', absPath('p')), coordinatorAccountId: 'acc1' }])
    const [r] = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs
    expect(r.coordinatorMissing).toBe(true)
  })

  it('세션이 붙어 있으면 그 칸이 없다', () => {
    const s = withRuns([
      { ...run('r1', absPath('p')), coordinatorAccountId: 'acc1', coordinatorSessionId: 'sess1' }
    ])
    const [r] = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs
    expect(r).not.toHaveProperty('coordinatorMissing')
  })

  // 계정 지정이 없는 Run(옛 Run·CLI Run)은 애초에 관리자를 기대하지 않는다
  it('코디네이터 계정이 없으면 그 칸이 없다', () => {
    const s = withRuns([run('r1', absPath('p'))])
    const [r] = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs
    expect(r).not.toHaveProperty('coordinatorMissing')
  })

  // Run 에서 provider 를 지운 변경이 이 뷰에도 닿았는지 — 칸이 남아 있으면 사이드바가 한 Run 을
  // 하나의 에이전트로 그리는 옛 화면으로 조용히 돌아간다
  it('JobRow 에 provider 칸이 없다', () => {
    const s = withRuns([run('r1', absPath('p'))])
    const [r] = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs
    expect('provider' in r).toBe(false)
  })
})

// 같은 프로젝트 폴더를 두 Run 이 나눠 쓰는 상태를 화면이 말하게 하는 두 값. **막지 않는다** —
// 파일을 안 건드리는 워커 여럿이 한 폴더에 있는 것은 안전할 수도 있고 앱은 그것을 알 수 없다.
// 상한 1 인 Run 을 둘 만들면 각 Run 이 1슬롯씩 받아 워커 둘이 그 폴더에서 동시에 일하는데,
// 그때 커밋 의무도 병합 단계도 붙지 않아 **앱의 어떤 기계도 알아채지 못한다.**
describe('스냅숏의 폴더 경합 표시', () => {
  const openIn = (id: string, taskId: string, cwd: string): Dispatch => ({
    ...dispatch(id, taskId, `sess-${id}`, '2026-08-18T01:00:00.000Z'),
    cwd
  })

  it('한 Run 만 프로젝트 폴더에서 일하면 폴더는 쓰이는 중이고 그 Run 은 나눠 쓰지 않는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [openIn('d1', 't1', absPath('p'))]
    }
    const snap = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist)
    expect(snap.projectFolderBusy).toBe(true)
    expect(snap.runs[0].sharesProjectFolder).toBe(false)
  })

  // 이 자리가 이 슬라이스의 이유다 — 상한 1 짜리 Run 둘이 같은 폴더에서 동시에 돈다
  it('두 Run 이 같은 폴더에서 일하면 둘 다 나눠 쓴다', () => {
    const s: OrchState = {
      ...withRuns(
        [run('r1', absPath('p')), run('r2', absPath('p'))],
        [task('t1', 'r1', 'dispatched'), task('t2', 'r2', 'dispatched')]
      ),
      dispatches: [openIn('d1', 't1', absPath('p')), openIn('d2', 't2', absPath('p'))]
    }
    const snap = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist)
    expect(snap.projectFolderBusy).toBe(true)
    expect(snap.runs.map((r) => r.sharesProjectFolder)).toEqual([true, true])
  })

  // 워크트리에서 도는 워커는 그 폴더를 나눠 쓰지 않는다. 동시 실행 2 이상이면 전부 그쪽이므로,
  // 그 흔한 경우에 이 표시가 뜨면 안 된다
  it('워크트리에서 도는 워커는 폴더를 쓰는 것이 아니다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [openIn('d1', 't1', absPath('wt', 'a'))]
    }
    const snap = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist)
    expect(snap.projectFolderBusy).toBe(false)
    expect(snap.runs[0].sharesProjectFolder).toBe(false)
  })

  it('도는 워커가 없으면 폴더는 비어 있다', () => {
    const s = withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'ready')])
    const snap = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist)
    expect(snap.projectFolderBusy).toBe(false)
    expect(snap.runs[0].sharesProjectFolder).toBe(false)
  })

  // 다른 프로젝트의 Run 이 자기 폴더에서 도는 것은 이 프로젝트와 상관없다
  it('다른 폴더의 Run 은 이 폴더를 쓰지 않는다', () => {
    const s: OrchState = {
      ...withRuns(
        [run('r1', absPath('p')), run('r2', absPath('other'))],
        [task('t1', 'r1', 'ready'), task('t2', 'r2', 'dispatched')]
      ),
      dispatches: [openIn('d2', 't2', absPath('other'))]
    }
    const snap = snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist)
    expect(snap.projectFolderBusy).toBe(false)
  })
})

describe('sameSnapshot', () => {
  const base = (): OrchState => ({
    ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
    dispatches: [dispatch('d1', 't1', 'sess-1', '2026-08-18T01:00:00.000Z')]
  })
  const fold = (s: OrchState): ReturnType<typeof snapshotFor> =>
    snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist)

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
    const gone = snapshotFor(s, absPath('p'), () => false, noWorktrees, noFires, allExist)
    expect(sameSnapshot(fold(s), gone)).toBe(false)
  })

  it('Gate 가 열리면 다르다고 본다', () => {
    const s = base()
    const gated: OrchState = { ...s, gates: [gate('g1', 't1', '질문', '2026-08-18T02:00:00.000Z')] }
    expect(sameSnapshot(fold(s), fold(gated))).toBe(false)
  })

  it('Run 이 늘면 다르다고 본다', () => {
    const s = base()
    const more: OrchState = stateFromLegacy({
      runs: [run('r1', absPath('p')), run('r2', absPath('p'))],
      tasks: s.tasks
    })
    expect(sameSnapshot(fold(s), fold(more))).toBe(false)
  })

  it('빈 스냅샷끼리는 같다고 본다', () => {
    const empty = { runs: [], projectFolderBusy: false }
    expect(sameSnapshot(empty, { ...empty })).toBe(true)
  })

  // 이 필드의 존재 이유가 이것이다. 질문 메시지는 Task 상태도 openGates 도 움직이지 않으므로
  // eventCount 가 없으면 sameSnapshot 이 같다고 판정해 푸시가 나가지 않는다 — 타임라인이 가장
  // 보고 싶어 하는 이벤트가 화면에 도착하지 못한다
  it('Task 상태를 움직이지 않는 메시지가 스냅샷을 바꾼다', () => {
    const before = withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')])
    const after = { ...before, messages: [message('m1', 'r1', 'question')] }
    expect(sameSnapshot(
      snapshotFor(before, absPath('p'), anySession, noWorktrees, noFires, allExist),
      snapshotFor(after, absPath('p'), anySession, noWorktrees, noFires, allExist)
    )).toBe(false)
  })

  // heartbeat 을 세면 이 필드가 푸시를 끊이지 않게 만든다 — 그것이 SKIP 의 이유다
  it('heartbeat 은 스냅샷을 바꾸지 않는다', () => {
    const before = withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')])
    const after = { ...before, messages: [message('m1', 'r1', 'heartbeat')] }
    expect(sameSnapshot(
      snapshotFor(before, absPath('p'), anySession, noWorktrees, noFires, allExist),
      snapshotFor(after, absPath('p'), anySession, noWorktrees, noFires, allExist)
    )).toBe(true)
  })
})

const scheduled = (id: string, cwd: string): LegacyRun => ({
  ...run(id, cwd),
  schedule: { kind: 'daily', time: '09:00' }
})
const child = (id: string, cwd: string, templateId: string): LegacyRun => ({
  ...run(id, cwd),
  templateId,
  createdAt: '2026-08-19T00:00:00.000Z'
})

describe('snapshotFor — 이 Run 이 쓴 워크트리', () => {
  it('워크트리 경로를 싣고, 없으면 칸도 없다', () => {
    const wtPath = absPath('wt', 'a')
    const s: OrchState = {
      ...withRuns([run('r1', absPath('proj')), run('r2', absPath('proj'))], [
        task('t1', 'r1', 'completed'),
        task('t2', 'r2', 'completed')
      ]),
      dispatches: [
        dispatch('d1', 't1', 'sess1', '2026-08-18T00:00:00.000Z'),
        dispatch('d2', 't2', 'sess2', '2026-08-18T00:00:00.000Z')
      ]
    }
    // d1 만 워크트리에서 돌았다고 만든다 — dispatch 헬퍼는 cwd 를 absPath('p') 로 준다
    s.dispatches[0] = { ...s.dispatches[0], cwd: wtPath }
    s.dispatches[1] = { ...s.dispatches[1], cwd: absPath('proj') }
    const snap = snapshotFor(s, absPath('proj'), anySession, noWorktrees, noFires, allExist)
    const byId = new Map(snap.runs.map((r) => [r.id, r]))
    expect(byId.get('job_r1')!.worktrees).toEqual([wtPath])
    expect('worktrees' in byId.get('job_r2')!).toBe(false)
  })

  // **이 테스트가 실제 결함을 고정한다.** Dispatch 의 cwd 는 워크트리를 지운 뒤에도 상태에 남으므로
  // runWorktrees 는 사라진 폴더를 계속 낸다. 걸러내지 않으면 삭제 확인 창이 "워크트리 3개" 라고
  // 말하면서 실제로는 두 개만 있는 일이 생긴다(그렇게 보고됐다).
  it('사라진 폴더는 싣지 않는다 — 확인 창의 수가 실제와 같아야 한다', () => {
    const gone = absPath('wt', 'gone')
    const alive = absPath('wt', 'alive')
    const s: OrchState = {
      ...withRuns([run('r1', absPath('proj'))], [
        task('t1', 'r1', 'completed'),
        task('t2', 'r1', 'completed')
      ]),
      dispatches: [
        dispatch('d1', 't1', 'sess1', '2026-08-18T00:00:00.000Z'),
        dispatch('d2', 't2', 'sess2', '2026-08-18T00:00:00.000Z')
      ]
    }
    s.dispatches[0] = { ...s.dispatches[0], cwd: gone }
    s.dispatches[1] = { ...s.dispatches[1], cwd: alive }
    const snap = snapshotFor(s, absPath('proj'), anySession, noWorktrees, noFires, (p) => p === alive)
    expect(snap.runs[0].worktrees).toEqual([alive])
  })

  it('하나도 남지 않았으면 칸이 아예 없다 — 병합 버튼과 체크박스가 뜨지 않아야 한다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('proj'))], [task('t1', 'r1', 'completed')]),
      dispatches: [dispatch('d1', 't1', 'sess1', '2026-08-18T00:00:00.000Z')]
    }
    s.dispatches[0] = { ...s.dispatches[0], cwd: absPath('wt', 'gone') }
    const snap = snapshotFor(s, absPath('proj'), anySession, noWorktrees, noFires, () => false)
    expect('worktrees' in snap.runs[0]).toBe(false)
  })
})

describe('snapshotFor — 실행 대기', () => {
  it('pendingStart 를 그대로 싣고, 없으면 칸도 없다', () => {
    const waiting = { ...run('r1', absPath('proj')), pendingStart: true }
    const going = run('r2', absPath('proj'))
    const snap = snapshotFor(
      withRuns([waiting, going]),
      absPath('proj'),
      anySession,
      noWorktrees,
      noFires,
      allExist
    )
    const byId = new Map(snap.runs.map((r) => [r.id, r]))
    expect(byId.get('job_r1')!.pendingStart).toBe(true)
    expect('pendingStart' in byId.get('job_r2')!).toBe(false)
  })
})

describe('snapshotFor — 예약 템플릿과 회차', () => {
  it('회차는 템플릿 밑으로 접히고 최상위에서 빠진다', () => {
    const s = withRuns([scheduled('t1', absPath('proj')), child('c1', absPath('proj'), 't1')])
    const snap = snapshotFor(s, absPath('proj'), anySession, noWorktrees, noFires, allExist)
    expect(snap.runs.map((r) => r.id)).toEqual(['job_t1'])
    expect(snap.runs[0].children?.map((r) => r.id)).toEqual(['c1'])
  })

  it('회차는 최신순이다', () => {
    const c1 = { ...child('c1', absPath('proj'), 't1'), createdAt: '2026-08-19T00:00:00.000Z' }
    const c2 = { ...child('c2', absPath('proj'), 't1'), createdAt: '2026-08-20T00:00:00.000Z' }
    const s = withRuns([scheduled('t1', absPath('proj')), c1, c2])
    const snap = snapshotFor(s, absPath('proj'), anySession, noWorktrees, noFires, allExist)
    expect(snap.runs[0].children?.map((r) => r.id)).toEqual(['c2', 'c1'])
  })

  // 사이드바가 "N회 실행" 으로 적는 값. 자식 개수가 아니라 이 값이어야 기록을 지워도 뒤로 가지 않는다
  it('템플릿의 fireCount 와 회차의 fireOrdinal 을 그대로 싣는다', () => {
    const t = { ...scheduled('t1', absPath('proj')), fireCount: 9 }
    const k = { ...child('c1', absPath('proj'), 't1'), fireOrdinal: 9 }
    const snap = snapshotFor(withRuns([t, k]), absPath('proj'), anySession, noWorktrees, noFires, allExist)
    expect(snap.runs[0].fireCount).toBe(9)
    expect(snap.runs[0].children?.[0].fireOrdinal).toBe(9)
  })

  it('값이 없으면 칸도 없다 — 이 필드가 생기기 전의 템플릿', () => {
    const snap = snapshotFor(
      withRuns([scheduled('t1', absPath('proj'))]),
      absPath('proj'),
      anySession,
      noWorktrees,
      noFires,
      allExist
    )
    expect('fireCount' in snap.runs[0]).toBe(false)
  })

  it('템플릿의 규칙을 그대로 싣는다', () => {
    const s = withRuns([scheduled('t1', absPath('proj'))])
    const snap = snapshotFor(s, absPath('proj'), anySession, noWorktrees, noFires, allExist)
    expect(snap.runs[0].schedule).toEqual({ kind: 'daily', time: '09:00' })
  })

  it('다음 발화 시각은 주입된 값이다', () => {
    const s = withRuns([scheduled('t1', absPath('proj'))])
    const snap = snapshotFor(
      s,
      absPath('proj'),
      anySession,
      noWorktrees,
      (id) => (id === 'job_t1' ? 1_800_000_000_000 : null),
      allExist
    )
    expect(snap.runs[0].nextFireAt).toBe(1_800_000_000_000)
  })

  // children: [] 이나 nextFireAt: null 도 이 자리를 통과한다 — 없어야 할 칸이 있는지는 'in' 으로만
  // 알 수 있다. toBeUndefined() 는 생략된 칸과 값이 undefined 인 칸을 구별하지 못한다
  it('회차가 아직 없고 무장도 없는 템플릿은 두 칸이 아예 없다', () => {
    const s = withRuns([scheduled('t1', absPath('proj'))])
    const snap = snapshotFor(s, absPath('proj'), anySession, noWorktrees, noFires, allExist)
    expect('children' in snap.runs[0]).toBe(false)
    expect('nextFireAt' in snap.runs[0]).toBe(false)
  })

  // 예약이 아닌 Run 에 빈 배열을 달면 sameSnapshot 의 문자열이 이유 없이 길어지고, 화면 쪽에서
  // "회차가 없는 템플릿"과 "템플릿이 아님"을 구별할 수 없다
  it('평범한 Run 에는 children 칸이 없다', () => {
    const s = withRuns([run('r1', absPath('proj'))])
    const snap = snapshotFor(s, absPath('proj'), anySession, noWorktrees, noFires, allExist)
    expect(snap.runs[0].children).toBeUndefined()
    expect(snap.runs[0].schedule).toBeUndefined()
  })

  // 부모가 다른 프로젝트에 있는 회차 — 손으로 고친 파일이나 템플릿의 cwd 를 바꾼 경우다.
  // 삼켜 버리면 목록에서 사라지므로 최상위에 남긴다
  it('이 프로젝트에 부모가 없는 회차는 최상위에 남는다', () => {
    const s = withRuns([child('c1', absPath('proj'), 'gone')])
    const snap = snapshotFor(s, absPath('proj'), anySession, noWorktrees, noFires, allExist)
    expect(snap.runs.map((r) => r.id)).toEqual(['job_c1'])
  })
})

describe('snapshotFor — 기다리는 중과 재개 횟수', () => {
  const openWith = (id: string, taskId: string, resumes: ResumeEntry[]): Dispatch => ({
    ...dispatch(id, taskId, `sess-${id}`, '2026-08-18T01:00:00.000Z'),
    resumes
  })
  const taskOf = (s: OrchState): JobTask =>
    snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]

  // running(열린 Dispatch)의 마지막 이력 항목에 resumedAt 이 없으면 지금 기다리는 중이다
  it('열린 항목이 있으면 기다리는 중으로 투영한다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [
        openWith('d1', 't1', [
          {
            stoppedAt: '2026-08-18T02:00:00.000Z',
            reason: 'waiting',
            resetsAt: '2026-08-19T00:00:00.000Z',
            fromAccountId: 'acc-1'
          }
        ])
      ]
    }
    expect(taskOf(s).waiting).toEqual({
      accountId: 'acc-1',
      reason: 'waiting',
      resetsAt: '2026-08-19T00:00:00.000Z'
    })
  })

  // 사유가 함께 가지 않으면 계정 전환이 "리셋 대기" 로 그려진다 — 기다리는 것이 아닌데도, 그리고
  // 전환이 실패해 항목이 끝내 닫히지 않으면 영구히
  it('계정을 바꾸는 정지는 사유와 함께 투영한다 — 리셋 시각은 없다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [
        openWith('d1', 't1', [
          { stoppedAt: '2026-08-18T02:00:00.000Z', reason: 'switching', fromAccountId: 'acc-1' }
        ])
      ]
    }
    expect(taskOf(s).waiting).toEqual({ accountId: 'acc-1', reason: 'switching' })
  })

  it('닫힌 항목만 있으면 기다리는 중이 아니고 횟수만 남는다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [
        openWith('d1', 't1', [
          {
            stoppedAt: '2026-08-18T02:00:00.000Z',
            reason: 'switching',
            fromAccountId: 'acc-1',
            resumedAt: '2026-08-18T03:00:00.000Z',
            toAccountId: 'acc-2'
          }
        ])
      ]
    }
    expect(taskOf(s).waiting).toBeUndefined()
    expect(taskOf(s).resumes).toBe(1)
  })

  // 재개 없이 끝난 에피소드가 앞에 남을 수 있다('stalled' 로 끝난 경우) — recordStopSnapshot 이
  // 그때도 새 항목을 쌓기 때문이다(state.ts). 살아 있는 것은 **마지막** 항목뿐이고, 횟수는 닫힌
  // 항목만 센다: 옛 열린 항목을 대기로 읽으면 도는 워커가 영원히 "기다리는 중"으로 그려진다
  it('앞에 열린 채 남은 항목이 있어도 마지막 항목이 닫혔으면 기다리는 중이 아니다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [
        openWith('d1', 't1', [
          { stoppedAt: '2026-08-18T02:00:00.000Z', reason: 'waiting', fromAccountId: 'acc-1' },
          {
            stoppedAt: '2026-08-18T05:00:00.000Z',
            reason: 'switching',
            fromAccountId: 'acc-1',
            resumedAt: '2026-08-18T05:00:30.000Z',
            toAccountId: 'acc-2'
          }
        ])
      ]
    }
    expect(taskOf(s).waiting).toBeUndefined()
    expect(taskOf(s).resumes).toBe(1) // 닫힌 것 하나만 센다
  })

  it('이력이 없으면 두 칸 다 없다 (조건부 전개 관례)', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'dispatched')]),
      dispatches: [dispatch('d1', 't1', 'sess-1', '2026-08-18T01:00:00.000Z')]
    }
    const t = taskOf(s)
    expect('waiting' in t).toBe(false)
    expect('resumes' in t).toBe(false)
  })

  // 앱이 꺼져 outcome_unknown 으로 닫힌 경우 — closeDispatch 는 endedAt 만 찍고 outcome 은 비워
  // 둔다(state.ts). 그 Dispatch 는 더 이상 running 이 아니므로, 열어 둔 채 남은 이력이 있어도
  // 아무도 그 리셋을 기다리지 않는다
  it('끝난 Dispatch 의 열린 항목은 기다리는 중이 아니다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'completed')]),
      dispatches: [
        {
          ...openWith('d1', 't1', [
            { stoppedAt: '2026-08-18T02:00:00.000Z', reason: 'waiting', fromAccountId: 'acc-1' }
          ]),
          endedAt: '2026-08-18T04:00:00.000Z'
        }
      ]
    }
    expect(taskOf(s).waiting).toBeUndefined()
  })
})

describe('snapshotFor — 검사 결과와 자동 수정 진행', () => {
  const taskOf = (s: OrchState): JobTask =>
    snapshotFor(s, absPath('p'), anySession, noWorktrees, noFires, allExist).runs[0].tasks[0]
  const checks: CheckResult[] = [
    { configId: 'c1', name: 'Typecheck', status: 'passed', exitCode: 0, startedAt: '2026-08-18T01:00:00.000Z', endedAt: '2026-08-18T01:00:18.000Z' },
    { configId: 'c2', name: 'Tests', status: 'failed', exitCode: 1, outputTail: '2 failed', startedAt: '2026-08-18T01:00:18.000Z', unstable: true }
  ]

  // 검사 결과는 정책이 없는 Run 에도 있다(U2). 칩이 그리는 것만 싣고 outputTail 은 싣지 않는다(U4) — 이 스냅숏은
  // 사이드바 푸시마다 나간다. 시간은 ISO 둘이 아니라 뺄셈 결과 하나로: 렌더러가 계산하면 테스트할 자리가 없다.
  it('checks 는 정책 없는 Run 에도 싣되 기호를 그릴 것만 — durationMs 는 둘 다 있을 때만', () => {
    const s = withRuns([run('r1', absPath('p'))], [{ ...task('t1', 'r1', 'failed'), checks }])
    expect(taskOf(s).checks).toEqual([
      { configId: 'c1', name: 'Typecheck', status: 'passed', exitCode: 0, durationMs: 18_000 },
      { configId: 'c2', name: 'Tests', status: 'failed', exitCode: 1, unstable: true }
    ])
    expect(taskOf(s).convergence).toBeUndefined()
  })

  it('checks 가 없는 Task 는 칸 자체가 없다', () => {
    const s = withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'completed')])
    expect(taskOf(s)).not.toHaveProperty('checks')
  })

  // policyOf 가 수렴 판정이다 — convergence: {} 도 켜진 것이고 기본값 셋이 채워진다(Plan 1 설계 §18: `!== undefined` 는 틀린 검사)
  it('convergence 는 정책 있는 Run 에만 — 기본값과 repair 수·검토 라운드를 센다', () => {
    const s: OrchState = {
      ...withRuns([{ ...run('r1', absPath('p')), convergence: {} }], [task('t1', 'r1', 'dispatched')]),
      dispatches: [
        { ...dispatch('d0', 't1', 's0', '2026-08-18T00:00:00.000Z'), endedAt: '2026-08-18T00:30:00.000Z', outcome: 'succeeded' },
        { ...dispatch('d1', 't1', 's1', '2026-08-18T01:00:00.000Z'), repair: 'check-failure', retryOf: 'd0' }
      ]
    }
    expect(taskOf(s).convergence).toEqual({
      repairs: 1, maxFixAttempts: FAILURE_LIMIT, reviewRound: 0, maxReviewRounds: MAX_REVIEW_ROUNDS,
      repairing: 'check-failure', stopped: false
    })
  })

  // repairCountOf 는 예산을 넘겨 셀 수 있다 — grantedExtra 로 연 여분의 repair, 혹은 크래시로 잃은 repair 와
  // 그 recovery 의 replacement 를 둘 다 세는 경우(repair.ts 의 repairSpec 주석과 같은 셈). 분모는 예산이므로
  // 화면은 "수정 4/3" 을 보이면 안 된다 — 클램프한다
  it('repairs 는 maxFixAttempts 를 넘지 않는다 — 예산을 넘겨 셀 수 있어도 클램프한다', () => {
    const s: OrchState = {
      ...withRuns([{ ...run('r1', absPath('p')), convergence: { maxFixAttempts: 3 } }], [task('t1', 'r1', 'dispatched')]),
      dispatches: [
        { ...dispatch('d1', 't1', 's1', '2026-08-18T01:00:00.000Z'), endedAt: '2026-08-18T01:10:00.000Z', outcome: 'failed', repair: 'check-failure' },
        { ...dispatch('d2', 't1', 's2', '2026-08-18T01:10:00.000Z'), endedAt: '2026-08-18T01:20:00.000Z', outcome: 'failed', repair: 'check-failure' },
        { ...dispatch('d3', 't1', 's3', '2026-08-18T01:20:00.000Z'), endedAt: '2026-08-18T01:30:00.000Z', outcome: 'failed', repair: 'check-failure' },
        { ...dispatch('d4', 't1', 's4', '2026-08-18T01:30:00.000Z'), repair: 'check-failure' }
      ]
    }
    expect(taskOf(s).convergence).toMatchObject({ repairs: 3, maxFixAttempts: 3 })
  })

  it('repair 가 아닌 Dispatch 가 도는 중이면 repairing 은 null, 사람이 껐으면 stopped', () => {
    const s: OrchState = {
      ...withRuns(
        [{ ...run('r1', absPath('p')), convergence: { maxFixAttempts: 1 } }],
        [{ ...task('t1', 'r1', 'dispatched'), convergenceOff: true }]
      ),
      dispatches: [dispatch('d1', 't1', 's1', '2026-08-18T01:00:00.000Z')]
    }
    expect(taskOf(s).convergence).toMatchObject({ repairing: null, stopped: true, maxFixAttempts: 1 })
  })

  // 보고를 낸 검토만 라운드다(reviewRoundOf) — 유실된 검토는 세지 않는다
  it('reviewRound 는 outcome 있는 검토 Dispatch 수다', () => {
    const s: OrchState = {
      ...withRuns([{ ...run('r1', absPath('p')), convergence: {} }], [task('t1', 'r1', 'reviewing')]),
      dispatches: [
        { ...dispatch('v1', 't1', 'sv1', '2026-08-18T01:00:00.000Z'), review: true, endedAt: '2026-08-18T01:10:00.000Z', outcome: 'failed' },
        { ...dispatch('v2', 't1', 'sv2', '2026-08-18T01:20:00.000Z'), review: true }
      ]
    }
    expect(taskOf(s).convergence?.reviewRound).toBe(1)
  })

  // 사이드바 "소진" 칩의 유일한 근거 — repairs >= maxFixAttempts 로 되짚으면 사람이 한 번 더 허락한
  // 수정(grantedExtra)이 그 셈을 깨뜨린다. 다음 조각의 retry-once/mark-failed 버튼도 이 값을 본다.
  it('gate.kind 를 그대로 옮긴다', () => {
    const s: OrchState = {
      ...withRuns([run('r1', absPath('p'))], [task('t1', 'r1', 'blocked')]),
      gates: [{ ...gate('g1', 't1', 'q', '2026-08-18T01:00:00.000Z'), kind: 'convergence-exhausted' }]
    }
    expect(taskOf(s).gate).toEqual({ id: 'g1', question: 'q', kind: 'convergence-exhausted' })
  })
})
