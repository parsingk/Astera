import { describe, it, expect, vi } from 'vitest'
import { hostOrchDeps } from './orchDeps'
import { AppUnreachable } from '../core/host/orchProtocol'

const base = (over: Partial<Parameters<typeof hostOrchDeps>[0]> = {}): Parameters<typeof hostOrchDeps>[0] => ({
  getState: () => ({}) as never,
  setState: async () => {},
  now: () => 'T',
  runningSessions: () => 0,
  appVersion: () => '0.0.0',
  act: vi.fn(),
  hasApp: () => true,
  log: () => {},
  onAppRequired: () => {},
  ...over
})

describe('hostOrchDeps', () => {
  // 상태는 Host 안에서 끝나고, 행동은 앱으로 나간다.
  it('행동 의존은 앱으로 나가는 호출이다', async () => {
    const act = vi.fn().mockResolvedValue({ sessionId: 's1', cwd: 'D:/p', specPath: 'D:/p/s.md' })
    const deps = hostOrchDeps(base({ act }))
    await deps.startWorker({ dispatchId: 'd1' } as never)
    // 인자는 언제나 배열째 간다 — 받는 쪽은 언제나 펼친다(F21).
    expect(act).toHaveBeenCalledWith('startWorker', [{ dispatchId: 'd1' }])
  })

  // 앱이 없으면 그 자리에서 거절해야 한다. 기다리게 두면 워커가 영영 멈춘다.
  it('앱이 없으면 APP_REQUIRED 로 거절한다', async () => {
    const deps = hostOrchDeps(base({ hasApp: () => false }))
    await expect(deps.startWorker({} as never)).rejects.toThrow(/APP_REQUIRED/)
  })

  // Host 가 스스로 아는 것은 나가지 않는다 — `status` 와 `version` 은 앱이 없어도 답해야 하고,
  // 그것이 사람이 가장 먼저 해 보는 일이다.
  it('세션 수와 버전은 앱에 묻지 않는다', async () => {
    const act = vi.fn()
    const deps = hostOrchDeps(base({ act, hasApp: () => false, runningSessions: () => 3, appVersion: () => '1.2.3' }))
    expect(deps.runningSessions?.()).toBe(3)
    expect(deps.appVersion?.()).toBe('1.2.3')
    expect(deps.enabled()).toBe(true)
    expect(act).not.toHaveBeenCalled()
  })

  /**
   * **인자는 하나여도 배열로 간다**(F21). "하나면 그것만" 규칙은 `removeWorktrees(paths)` 처럼
   * 인자 하나가 그 자체로 배열인 경우를 두 인자짜리 호출과 바이트 단위로 같게 만든다 — 받는 쪽이
   * 둘을 구별할 방법이 없다. 규칙 하나, 이름별 표 없음.
   */
  it('인자 하나가 배열이어도 두 인자와 섞이지 않는다', async () => {
    const act = vi.fn().mockResolvedValue({ failed: [] })
    const deps = hostOrchDeps(base({ act }))
    await deps.removeWorktrees?.(['D:/wt1', 'D:/wt2'])
    expect(act).toHaveBeenCalledWith('removeWorktrees', [['D:/wt1', 'D:/wt2']])
    await deps.mergeWorktrees?.('D:/p', ['D:/wt1'])
    expect(act).toHaveBeenLastCalledWith('mergeWorktrees', ['D:/p', ['D:/wt1']])
  })

  it('인자가 없는 의존은 빈 배열로 간다', async () => {
    const act = vi.fn().mockResolvedValue(undefined)
    const deps = hostOrchDeps(base({ act }))
    await deps.backup?.()
    expect(act).toHaveBeenCalledWith('backup', [])
  })

  /**
   * **아무도 안 받는 거절을 남기지 않는다.**
   *
   * `unregisterRolling` 은 `(sessionId): void` 이고 호출부 둘 다 결과를 버린다(command.ts 의
   * dispatch-abandon, 그리고 worker_done 두 경로의 dropRollingChain). 이것을 async 로 감싸면 앱이
   * 없을 때 아무도 붙잡지 않은 거부 약속이 남고, Host 에는 unhandledRejection 처리기가 없어서
   * Node 의 기본 동작이 프로세스를 — 그 Host 가 들고 있는 모든 터미널과 함께 — 내린다.
   */
  it('결과를 안 받는 의존은 앱이 없어도 약속을 남기지 않는다', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const logs: string[] = []
      const deps = hostOrchDeps(base({ hasApp: () => false, log: (m) => logs.push(m) }))
      // 반환값 자체가 약속이면 이미 틀렸다 — 호출부는 그것을 버린다.
      expect(deps.unregisterRolling?.('s1')).toBeUndefined()
      await new Promise((r) => setTimeout(r, 30))
      expect(unhandled).toEqual([])
      // 삼키되 말은 남긴다 — 앱이 없으면 걷을 롤링 등록도 없지만, 조용히 넘어가면 안 된다.
      expect(logs.some((l) => l.includes('unregisterRolling') && l.includes('APP_REQUIRED'))).toBe(true)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('결과를 안 받는 의존은 앱이 실패로 답해도 약속을 남기지 않는다', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown): void => {
      unhandled.push(e)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const logs: string[] = []
      const deps = hostOrchDeps(
        base({ act: vi.fn().mockRejectedValue(new Error('the app went away')), log: (m) => logs.push(m) })
      )
      expect(deps.unregisterRolling?.('s1')).toBeUndefined()
      await new Promise((r) => setTimeout(r, 30))
      expect(unhandled).toEqual([])
      expect(logs.some((l) => l.includes('unregisterRolling') && l.includes('the app went away'))).toBe(true)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  // 앱이 없어 거절한 것과, 앱이 답을 안 해 거절한 것은 같은 사실이다 — 둘 다 "지금은 못 한다".
  it('앱이 도중에 닿지 않게 되면 그것도 앱 문제로 알린다', async () => {
    const refused: string[] = []
    const deps = hostOrchDeps(
      base({
        act: vi.fn().mockRejectedValue(new AppUnreachable('did not answer in time')),
        onAppRequired: (name) => refused.push(name)
      })
    )
    await expect(deps.readWorker({ dispatchId: 'd1' })).rejects.toThrow(/did not answer/)
    expect(refused).toEqual(['readWorker'])
  })

  // 앱이 답한 실패는 그 행동의 실패다 — 채널 문제가 아니므로 CONFLICT 로 바뀌면 안 된다.
  it('앱이 답한 실패는 앱 문제로 세지 않는다', async () => {
    const refused: string[] = []
    const deps = hostOrchDeps(
      base({ act: vi.fn().mockRejectedValue(new Error('no account')), onAppRequired: (name) => refused.push(name) })
    )
    await expect(deps.readWorker({ dispatchId: 'd1' })).rejects.toThrow(/no account/)
    expect(refused).toEqual([])
  })

  // 명령 층이 이미 쓰고 있는 deps.log 가 Host 의 로그로 나간다 — 안 이으면 한도 탐침이 못 돈 것
  // 같은 성능 저하가 아무 흔적 없이 지나간다.
  it('명령 층의 로그가 Host 로 이어진다', () => {
    const logs: string[] = []
    hostOrchDeps(base({ log: (m) => logs.push(m) })).log?.('무언가')
    expect(logs).toEqual(['무언가'])
  })

  /**
   * **세 갈래가 한 분류다.** 어느 의존이 상태 코드를 정하는지는 그 거절을 명령 층이 어떻게
   * 다루느냐로 갈린다 — 삼키는 것이 답을 정하면, 그 뒤에 제 이유로 실패한 명령이 "앱이 없다"로
   * 둔갑한다(F25).
   */
  describe('거절이 답을 정하는가', () => {
    it('전달되는 의존의 거절만 앱 문제로 표시된다', async () => {
      const refused: string[] = []
      const deps = hostOrchDeps(base({ hasApp: () => false, onAppRequired: (n) => refused.push(n) }))
      await expect(deps.startWorker({} as never)).rejects.toThrow(/APP_REQUIRED/)
      await expect(deps.listRunConfigs?.('D:/p')).rejects.toThrow(/APP_REQUIRED/)
      expect(refused).toEqual(['startWorker', 'listRunConfigs'])
    })

    it('명령 층이 삼키는 의존은 거절해도 앱 문제로 표시하지 않는다', async () => {
      const refused: string[] = []
      const deps = hostOrchDeps(base({ hasApp: () => false, onAppRequired: (n) => refused.push(n) }))
      // 셋 다 거절은 한다 — 그 거절을 부르는 쪽이 잡아 로그하고 계속 간다.
      await expect(deps.probeLimit?.({} as never)).rejects.toThrow(/APP_REQUIRED/)
      await expect(deps.resolveProjectRoot?.('D:/p')).rejects.toThrow(/APP_REQUIRED/)
      await expect(deps.readReviewFile?.('D:/p/s.md.review.json')).rejects.toThrow(/APP_REQUIRED/)
      expect(refused).toEqual([])
    })

    // 거절하면 검토자의 판정이 아무 데도 안 남는다. null 은 이 의존이 이미 가진 말이고, 그때
    // 순수 층이 Gate 를 연다는 것도 선언에 적혀 있다(F28).
    it('물어볼 수 없는 repair 대상은 null 로 내려앉는다 — 던지지 않는다', async () => {
      const refused: string[] = []
      const logs: string[] = []
      const deps = hostOrchDeps(
        base({ hasApp: () => false, onAppRequired: (n) => refused.push(n), log: (m) => logs.push(m) })
      )
      await expect(deps.repairTargetFor?.('t1')).resolves.toBeNull()
      expect(refused).toEqual([])
      expect(logs.some((l) => l.includes('repairTargetFor') && l.includes('APP_REQUIRED'))).toBe(true)
    })

    // gate-resolve 는 Gate 해제를 먼저 커밋한 뒤에 이것을 부른다 — 거절하면 이미 일어난 일이
    // 실패로 보고된다. 이 의존은 실패를 값으로 말할 줄 알고, 그 값에 이유가 실린다(F29).
    it('물어볼 수 없는 retry-once 는 이유를 실은 실패 값으로 내려앉는다', async () => {
      const refused: string[] = []
      const logs: string[] = []
      const deps = hostOrchDeps(
        base({ hasApp: () => false, onAppRequired: (n) => refused.push(n), log: (m) => logs.push(m) })
      )
      await expect(deps.repairOnce?.({ taskId: 't1' })).resolves.toEqual({
        ok: false,
        error: 'APP_REQUIRED: repairOnce needs the Astera app running'
      })
      expect(refused).toEqual([])
      expect(logs.some((l) => l.includes('repairOnce') && l.includes('APP_REQUIRED'))).toBe(true)
    })

    // 앱이 없는 것과 앱이 답을 안 하는 것은 부르는 쪽에게 같은 사실이다 — 하나의 조건이다.
    it('앱이 답하지 못해도 같은 값으로 내려앉는다', async () => {
      const logs: string[] = []
      const deps = hostOrchDeps(
        base({ act: vi.fn().mockRejectedValue(new AppUnreachable('did not answer in time')), log: (m) => logs.push(m) })
      )
      await expect(deps.repairTargetFor?.('t1')).resolves.toBeNull()
      expect(logs.some((l) => l.includes('did not answer in time'))).toBe(true)
    })

    // 앱이 **답한** 실패는 물어보지 못한 것이 아니다 — 그것까지 삼키면 진짜 고장이 조용해진다.
    it('앱이 답한 실패는 내려앉지 않고 그대로 던진다', async () => {
      const deps = hostOrchDeps(base({ act: vi.fn().mockRejectedValue(new Error('repair.ts threw')) }))
      await expect(deps.repairTargetFor?.('t1')).rejects.toThrow(/repair.ts threw/)
    })

    it('결과를 안 받는 의존은 던지지도, 앱 문제로 표시하지도 않는다', () => {
      const refused: string[] = []
      const logs: string[] = []
      const deps = hostOrchDeps(
        base({ hasApp: () => false, onAppRequired: (n) => refused.push(n), log: (m) => logs.push(m) })
      )
      expect(deps.startValidation?.({ taskId: 't1', cwd: 'D:/p' })).toBeUndefined()
      expect(deps.startReview?.({ taskId: 't1' })).toBeUndefined()
      expect(deps.startRepair?.({ dispatchId: 'd1' })).toBeUndefined()
      expect(deps.onDispatchLost?.({ dispatchId: 'd1' })).toBeUndefined()
      expect(refused).toEqual([])
      expect(logs).toHaveLength(4)
    })

    // 이 넷이 **있다는 것 자체**가 applyWorkerDone 의 canValidate·canReview 를 참으로 만든다
    // (command.ts 의 `!!deps.startValidation`). 없으면 Task 는 검증도 검토도 없이 completed 로
    // 간다 — Host 로 돈 Job 이 수렴하지 않던 이유다.
    it('검증·검토·수리 의존이 실제로 주입된다', () => {
      const deps = hostOrchDeps(base())
      for (const name of ['startValidation', 'startReview', 'startRepair', 'onDispatchLost', 'repairTargetFor'] as const)
        expect(typeof deps[name]).toBe('function')
    })
  })
})
