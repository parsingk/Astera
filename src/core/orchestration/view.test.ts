import { describe, it, expect } from 'vitest'
import { runsForProject, progressOf } from './view'
import { emptyState } from './state'
import type { OrchState } from './state'
import type { Run, Task } from './types'
import { absPath } from '../testPaths'

const run = (id: string, cwd: string, status: Run['status'] = 'open'): Run => ({
  id, objective: `objective ${id}`, cwd, status, createdAt: '2026-08-18T00:00:00.000Z'
})
const task = (id: string, runId: string, status: Task['status']): Task => ({
  id, runId, title: `task ${id}`, spec: '', deps: [], status,
  consecutiveFailures: 0, createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z'
})
const withRuns = (runs: Run[], tasks: Task[] = []): OrchState => ({ ...emptyState(), runs, tasks })

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
