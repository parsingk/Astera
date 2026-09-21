import { describe, it, expect } from 'vitest'
import { publicFor } from './cliPublic'
import type { Task } from './types'

describe('publicFor', () => {
  it('허용된 칸만 남긴다', () => {
    const job = { id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', secret: 'x' }
    expect(publicFor('jobs-get', job)).toEqual({
      id: 'job_1',
      objective: 'o',
      cwd: 'D:/p',
      createdAt: 'T'
    })
  })

  // 없는 것을 undefined 로 찍으면 JSON 에서 사라져 결과는 같지만, 있는데 비어 있는 것과
  // 아예 없는 것이 한 모양이 된다
  it('없는 칸을 만들지 않는다', () => {
    expect(publicFor('projects-get', { id: 'proj_1', path: 'D:/p' })).toEqual({
      id: 'proj_1',
      path: 'D:/p'
    })
  })

  it('목록은 하나씩 가린다', () => {
    const out = publicFor('runs-list', [
      { id: 'run_1', jobId: 'job_1', ordinal: 1, internal: 1 },
      { id: 'run_2', jobId: 'job_1', ordinal: 2, internal: 2 }
    ])
    expect(out).toEqual([
      { id: 'run_1', jobId: 'job_1', ordinal: 1 },
      { id: 'run_2', jobId: 'job_1', ordinal: 2 }
    ])
  })

  // **한 겹 안이라고 새면 가림막이 아니다.** jobs get 은 회차를 `run` 에 접어 싣는다(설계 §5)
  it('jobs get 이 접어 실은 회차도 가린다', () => {
    const out = publicFor('jobs-get', {
      id: 'job_1',
      objective: 'o',
      run: { id: 'run_1', jobId: 'job_1', ordinal: 1, internalNote: 'x' }
    }) as { run: Record<string, unknown> }
    expect(out.run).toEqual({ id: 'run_1', jobId: 'job_1', ordinal: 1 })
  })

  // 앱이 수렴을 굴리려고 적어 두는 장부다 — 내보내면 정책을 바꿀 때마다 남의 스크립트가 깨진다
  it('Task 의 수렴 장부는 내보내지 않는다', () => {
    const task: Partial<Task> = {
      id: 'task_1',
      title: 't',
      status: 'ready',
      checks: [],
      consecutiveFailures: 0,
      checkHistory: { c1: ['passed'] },
      policySnapshot: { key: 'k', capturedAt: 'T' },
      policyChanged: true,
      convergenceStartedAt: 'T',
      convergenceOff: true,
      suspiciousFiles: ['a.ts'],
      reviewRequested: true
    }
    const out = publicFor('tasks-list', [task]) as Record<string, unknown>[]
    expect(out[0]).toEqual({
      id: 'task_1',
      title: 't',
      status: 'ready',
      checks: [],
      consecutiveFailures: 0
    })
  })

  // 가이드가 코디네이터에게 읽으라고 말하는 칸들 — 가리면 오케스트레이션이 멈춘다
  it('가이드가 읽으라는 Task 칸은 남긴다', () => {
    const out = publicFor('tasks-list', [
      { id: 't1', parentId: 'p1', checks: [{ id: 'c' }], consecutiveFailures: 2, deps: ['t0'] }
    ]) as Record<string, unknown>[]
    expect(out[0]).toEqual({
      id: 't1',
      parentId: 'p1',
      checks: [{ id: 'c' }],
      consecutiveFailures: 2,
      deps: ['t0']
    })
  })

  // --brief 가 잘린 자리를 알리려고 만드는 칸이다. Task 에는 없으므로 따로 허용해야 한다
  it('tasks list --brief 가 덧붙이는 칸을 남긴다', () => {
    const out = publicFor('tasks-list', [
      { id: 't1', spec: '짧게', spec_truncated: true }
    ]) as Record<string, unknown>[]
    expect(out[0]).toEqual({ id: 't1', spec: '짧게', spec_truncated: true })
  })

  // **코디네이터 전용 명령은 이 계약의 약속 밖이다.** 가리려 들면 가이드가 시키는 것을 못 읽는다
  it('표에 없는 명령은 그대로 지나간다', () => {
    const body = { dispatchId: 'd1', anything: { nested: true } }
    expect(publicFor('dispatch-show', body)).toBe(body)
  })

  it('객체가 아닌 것은 그대로 둔다', () => {
    expect(publicFor('jobs-list', [])).toEqual([])
    expect(publicFor('questions-get', null)).toBe(null)
  })
})
