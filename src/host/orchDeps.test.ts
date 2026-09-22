import { describe, it, expect, vi } from 'vitest'
import { hostOrchDeps } from './orchDeps'

describe('hostOrchDeps', () => {
  // 상태는 Host 안에서 끝나고, 행동은 앱으로 나간다.
  it('행동 의존은 앱으로 나가는 호출이다', async () => {
    const act = vi.fn().mockResolvedValue({ sessionId: 's1', cwd: 'D:/p', specPath: 'D:/p/s.md' })
    const deps = hostOrchDeps({
      getState: () => ({}) as never,
      setState: async () => {},
      now: () => 'T',
      runningSessions: () => 0,
      appVersion: () => '0.0.0',
      act,
      hasApp: () => true
    })
    await deps.startWorker({ dispatchId: 'd1' } as never)
    expect(act).toHaveBeenCalledWith('startWorker', { dispatchId: 'd1' })
  })

  // 앱이 없으면 그 자리에서 거절해야 한다. 기다리게 두면 워커가 영영 멈춘다.
  it('앱이 없으면 APP_REQUIRED 로 거절한다', async () => {
    const deps = hostOrchDeps({
      getState: () => ({}) as never,
      setState: async () => {},
      now: () => 'T',
      runningSessions: () => 0,
      appVersion: () => '0.0.0',
      act: vi.fn(),
      hasApp: () => false
    })
    await expect(deps.startWorker({} as never)).rejects.toThrow(/APP_REQUIRED/)
  })

  // Host 가 스스로 아는 것은 나가지 않는다 — `status` 와 `version` 은 앱이 없어도 답해야 하고,
  // 그것이 사람이 가장 먼저 해 보는 일이다.
  it('세션 수와 버전은 앱에 묻지 않는다', async () => {
    const act = vi.fn()
    const deps = hostOrchDeps({
      getState: () => ({}) as never,
      setState: async () => {},
      now: () => 'T',
      runningSessions: () => 3,
      appVersion: () => '1.2.3',
      act,
      hasApp: () => false
    })
    expect(deps.runningSessions?.()).toBe(3)
    expect(deps.appVersion?.()).toBe('1.2.3')
    expect(deps.enabled()).toBe(true)
    expect(act).not.toHaveBeenCalled()
  })

  // 두 인자를 받는 의존(mergeWorktrees·browserRun)이 둘째 인자를 잃지 않는다 — 잃으면 `run-merge`
  // 가 아무 워크트리도 합치지 않은 채 성공을 알린다.
  it('인자가 둘인 의존은 둘 다 넘긴다', async () => {
    const act = vi.fn().mockResolvedValue({ ok: true, merged: [], uncommitted: 0 })
    const deps = hostOrchDeps({
      getState: () => ({}) as never,
      setState: async () => {},
      now: () => 'T',
      runningSessions: () => 0,
      appVersion: () => '0.0.0',
      act,
      hasApp: () => true
    })
    await deps.mergeWorktrees?.('D:/p', ['D:/p/wt-1'])
    expect(act).toHaveBeenCalledWith('mergeWorktrees', ['D:/p', ['D:/p/wt-1']])
  })
})
