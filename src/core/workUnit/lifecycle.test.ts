import { describe, it, expect } from 'vitest'
import { startedTask, completedTask, cancelledTask, interruptedTask } from './lifecycle'
import type { SessionWorkUnit } from './types'

const active = (): SessionWorkUnit => ({
  id: 'u1',
  sessionId: 's1',
  projectPath: 'D:/p',
  objective: '로또 번호 뽑는 기능 만들기',
  status: 'active',
  startedAt: '2026-08-31T05:00:00.000Z',
  git: { startHead: 'abc', observedChangedFiles: ['src/a.ts'] },
  encounteredExternalGitChangeIds: []
})

describe('startedTask', () => {
  it('사람이 적은 목표를 그대로 든다', () => {
    const u = startedTask({
      id: 'u9',
      sessionId: 's1',
      projectPath: 'D:/p',
      objective: '  로그인 에러 고치기  ',
      at: '2026-08-31T05:00:00.000Z',
      startHead: 'abc',
      baselineDirtyFiles: ['src/dirty.ts']
    })
    expect(u.objective).toBe('로그인 에러 고치기')
    expect(u.status).toBe('active')
    expect(u.git).toEqual({
      startHead: 'abc',
      baselineDirtyFiles: ['src/dirty.ts'],
      observedChangedFiles: []
    })
  })
})

describe('completedTask', () => {
  it('누가 끝냈는지를 남긴다', () => {
    const u = completedTask(active(), { source: 'agent', at: '2026-08-31T05:30:00.000Z' })
    expect(u.status).toBe('completed')
    expect(u.completion).toEqual({ source: 'agent', at: '2026-08-31T05:30:00.000Z' })
    expect(u.endedAt).toBe('2026-08-31T05:30:00.000Z')
  })

  it('중단된 것도 사람이 완료로 닫을 수 있다', () => {
    const u = completedTask(
      { ...active(), status: 'interrupted', reason: 'a new session task started' },
      { source: 'user', at: '2026-08-31T06:00:00.000Z' }
    )
    expect(u.status).toBe('completed')
    expect(u.completion?.source).toBe('user')
  })

  it('보고된 검사와 요약을 싣는다', () => {
    const u = completedTask(active(), {
      source: 'agent',
      at: '2026-08-31T05:30:00.000Z',
      checks: [{ name: 'tests', status: 'passed' }],
      summary: '6개 번호를 오름차순으로 출력한다'
    })
    expect(u.checks).toEqual([{ name: 'tests', status: 'passed' }])
    expect(u.resultSummary).toBe('6개 번호를 오름차순으로 출력한다')
  })

  // Reopening is ruled out by the spec: further work is a new session task
  it('이미 끝난 것은 다시 닫지 않는다', () => {
    const done = completedTask(active(), { source: 'agent', at: '2026-08-31T05:30:00.000Z' })
    const again = completedTask(done, { source: 'user', at: '2026-08-31T07:00:00.000Z' })
    expect(again.completion?.at).toBe('2026-08-31T05:30:00.000Z')
  })
})

describe('cancelledTask', () => {
  it('사유를 남기고 완료 출처는 남기지 않는다', () => {
    const u = cancelledTask(active(), { at: '2026-08-31T05:10:00.000Z', reason: '방향을 바꿨다' })
    expect(u.status).toBe('cancelled')
    expect(u.reason).toBe('방향을 바꿨다')
    expect(u.completion).toBeUndefined()
  })
})

describe('interruptedTask', () => {
  it('사유를 남기고, 완료 출처는 아직 없다', () => {
    const u = interruptedTask(active(), {
      at: '2026-08-31T05:10:00.000Z',
      reason: 'a new session task started'
    })
    expect(u.status).toBe('interrupted')
    expect(u.reason).toBe('a new session task started')
    expect(u.completion).toBeUndefined()
    expect(u.endedAt).toBe('2026-08-31T05:10:00.000Z')
  })

  it('끝난 것은 중단으로 되돌리지 않는다 — 앱 재시작이 완료를 지우면 안 된다', () => {
    const done = completedTask(active(), { source: 'agent', at: '2026-08-31T05:30:00.000Z' })
    expect(interruptedTask(done, { at: '2026-08-31T09:00:00.000Z', reason: 'app restart' })).toBe(
      done
    )
  })
})
