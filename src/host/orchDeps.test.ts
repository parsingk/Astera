import { describe, it, expect, vi } from 'vitest'
import { hostOrchDeps } from './orchDeps'
import { AppUnreachable } from '../core/host/orchProtocol'

const base = (over: Partial<Parameters<typeof hostOrchDeps>[0]> = {}): Parameters<typeof hostOrchDeps>[0] => ({
  getState: () => ({}) as never,
  setState: async () => {},
  now: () => 'T',
  runningSessions: () => 0,
  appVersion: () => '0.0.0',
  backup: async () => {},
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
    const act = vi.fn().mockResolvedValue([])
    const deps = hostOrchDeps(base({ act }))
    await deps.listAccounts()
    expect(act).toHaveBeenCalledWith('listAccounts', [])
  })

  // 파일은 Host 의 것이다. 앱이 대신 복사하면 CLI 가 방금 쓴 것보다 한 커밋 옛 상태가 담길 수 있다.
  it('reset 의 백업은 앱에 묻지 않는다', async () => {
    const act = vi.fn()
    const backup = vi.fn().mockResolvedValue(undefined)
    const deps = hostOrchDeps(base({ act, backup, hasApp: () => false }))
    await deps.backup?.()
    expect(backup).toHaveBeenCalled()
    expect(act).not.toHaveBeenCalled()
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

  /**
   * === 무엇이 "움직였다" 인가 (요청 영수증 설계 §3) ===
   *
   * 영수증은 명령이 커밋했거나, **상태 밖의 무언가를 바꾸는 의존을 불렀을 때** 남는다. 뒤의 절반이
   * 여기서 정해진다 — 세 래퍼가 모두 하나의 `act` 깔때기로 모이므로, 의존이 전달되면서 이 줄을 지나지
   * 않을 방법이 없다.
   */
  describe('상태 밖을 바꾸는 의존', () => {
    const marked = (over: Partial<Parameters<typeof hostOrchDeps>[0]> = {}): { deps: ReturnType<typeof hostOrchDeps>; acted: () => number } => {
      let n = 0
      return { deps: hostOrchDeps(base({ onEffect: () => n++, ...over })), acted: () => n }
    }

    it('세션을 띄우는 의존은 움직인 것으로 센다', async () => {
      const m = marked({ act: vi.fn().mockResolvedValue({ sessionId: 's', cwd: 'c', specPath: 'p' }) })
      await m.deps.startWorker({ dispatchId: 'd1' } as never)
      expect(m.acted()).toBe(1)
    })

    // **명령 이름으로 목록을 짰다면 놓쳤을 자리다.** run-merge 는 git 병합을 돌리고 setState 는 한
    // 번도 부르지 않는다.
    it('커밋하지 않고 디스크를 건드리는 의존도 움직인 것으로 센다', async () => {
      const m = marked({ act: vi.fn().mockResolvedValue({ ok: true, merged: [], uncommitted: 0 }) })
      await m.deps.mergeWorktrees?.('D:/p', ['D:/wt'])
      expect(m.acted()).toBe(1)
    })

    // 읽기와 토글은 두 번 물어도 세상이 달라지지 않는다 — 여기에 영수증을 남기면 그 뒤의 읽기가
    // 모두 낡은 답을 받는다.
    it('읽기·탐침·토글은 움직인 것이 아니다', async () => {
      const m = marked({ act: vi.fn().mockResolvedValue([]) })
      await m.deps.listAccounts()
      await m.deps.readWorker({ dispatchId: 'd1' })
      await m.deps.listRunConfigs?.('D:/p')
      await m.deps.probeLimit?.({} as never)
      await m.deps.resolveProjectRoot?.('D:/p')
      await m.deps.trackingEnabled?.()
      await m.deps.repairTargetFor?.('t1')
      expect(m.acted()).toBe(0)
    })

    // 결과를 아무도 안 받는다고 공짜인 것은 아니다 — 이 넷은 모두 무언가를 시작하거나 끝낸다.
    it('결과를 안 받는 의존도 움직인 것으로 센다', () => {
      const m = marked({ act: vi.fn().mockResolvedValue(undefined) })
      m.deps.startValidation?.({ taskId: 't1', cwd: 'D:/p' })
      m.deps.unregisterRolling?.('ses1')
      expect(m.acted()).toBe(2)
    })

    // 점 찍힌 이름도 같은 깔때기를 지난다 — 그룹 단위로 선언한 것이 실제로 나가는 이름에 닿아야 한다.
    it('점 찍힌 이름도 같은 깔때기를 지난다', async () => {
      const m = marked({ act: vi.fn().mockResolvedValue({ ok: true, savedAt: 'T' }) })
      await m.deps.handoffs?.save('ses1', {} as never)
      await m.deps.sessionTasks?.start('ses1', '무언가')
      expect(m.acted()).toBe(2)
    })

    // **앱이 없으면 깔때기에 닿기도 전에 거절된다** — 물어보지 못한 것은 일어나지 않은 것이고, 그
    // 호출은 영수증을 남기지 않아야 한다.
    it('앱이 없어 거절된 전달은 움직인 것이 아니다', async () => {
      const m = marked({ hasApp: () => false })
      await expect(m.deps.startWorker({} as never)).rejects.toThrow(/APP_REQUIRED/)
      expect(m.acted()).toBe(0)
    })

    // **묻고 답을 못 들은 것은 안 일어난 것이 아니다.** 앱이 도중에 사라지거나 마감을 넘겼을 때,
    // 그 행동은 이미 일어났을 수 있다 — 일어났을 수 있는 요청은 일어난 것으로 읽어야 한다.
    it('앱이 답하지 못해도 이미 물어본 것은 움직인 것으로 센다', async () => {
      const m = marked({ act: vi.fn().mockRejectedValue(new AppUnreachable('APP_REQUIRED: gone')) })
      await expect(m.deps.startWorker({} as never)).rejects.toThrow()
      expect(m.acted()).toBe(1)
    })

    // 영수증을 남기지 않는 호출자는 이 기구를 아예 지나가지 않는다 — 함수가 없으면 아무 일도 없다.
    it('onEffect 를 주지 않으면 아무것도 달라지지 않는다', async () => {
      const act = vi.fn().mockResolvedValue({ sessionId: 's', cwd: 'c', specPath: 'p' })
      const deps = hostOrchDeps(base({ act }))
      await deps.startWorker({ dispatchId: 'd1' } as never)
      expect(act).toHaveBeenCalledWith('startWorker', [{ dispatchId: 'd1' }])
    })
  })
})
