import { describe, it, expect, vi } from 'vitest'
import { hostOrchDeps } from './orchDeps'
import type { HostLocal } from './spawner'
import { RepairNeeded } from '../core/settings/repairNeeded'
import { HostRetiring } from '../core/host/hostRetiring'
import { AppUnreachable } from '../core/host/orchProtocol'
import os from 'node:os'
import path from 'node:path'
import { PtyRegistry } from './registry'
import { ProcRegistry } from './procRegistry'
import { registrySessions } from './sessions'
import { encodeUserTurn } from '../core/chat/claudeProtocol'

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
  readAccounts: vi.fn().mockResolvedValue([]),
  readRunConfigs: vi.fn().mockResolvedValue([]),
  sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() },
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

  /**
   * **계정 목록은 앱이 없으면 프로필의 accounts.json 이 답한다**(CLI phase C, 수정 1회차). 앱만이
   * 그 파일을 쓰므로 앱이 없으면 쓰는 쪽이 없고, 파일이 앱이 마지막으로 남긴 말이다. 앱이 있으면
   * 앱의 메모리가 정본이다 — 잠깐 디스크보다 앞설 수 있다.
   */
  describe('listAccounts — 앱이 없으면 파일', () => {
    const acc = [{ id: 'acc1', label: '일', provider: 'claude' as const }]

    it('앱이 없으면 파일을 읽고, 앱 문제로 표시하지 않는다', async () => {
      const refused: string[] = []
      const act = vi.fn()
      const readAccounts = vi.fn().mockResolvedValue(acc)
      const deps = hostOrchDeps(
        base({ hasApp: () => false, act, readAccounts, onAppRequired: (n) => refused.push(n) })
      )
      expect(await deps.listAccounts('claude')).toEqual(acc)
      expect(readAccounts).toHaveBeenCalledWith('claude')
      expect(act).not.toHaveBeenCalled()
      expect(refused).toEqual([])
    })

    it('앱이 있으면 앱에 묻고 파일은 읽지 않는다', async () => {
      const act = vi.fn().mockResolvedValue(acc)
      const readAccounts = vi.fn()
      const deps = hostOrchDeps(base({ act, readAccounts }))
      expect(await deps.listAccounts()).toEqual(acc)
      expect(act).toHaveBeenCalledWith('listAccounts', [])
      expect(readAccounts).not.toHaveBeenCalled()
    })

    // 못 묻는 것은 한 조건이다 — 앱이 없는 것과 도중에 답하지 않는 것은 같은 사실이다.
    it('앱이 도중에 닿지 않으면 파일로 답하고 로그를 남긴다', async () => {
      const logs: string[] = []
      const refused: string[] = []
      const readAccounts = vi.fn().mockResolvedValue(acc)
      const deps = hostOrchDeps(
        base({
          act: vi.fn().mockRejectedValue(new AppUnreachable('did not answer in time')),
          readAccounts,
          log: (m) => logs.push(m),
          onAppRequired: (n) => refused.push(n)
        })
      )
      expect(await deps.listAccounts('codex')).toEqual(acc)
      expect(readAccounts).toHaveBeenCalledWith('codex')
      expect(refused).toEqual([])
      expect(logs.some((l) => l.includes('listAccounts') && l.includes('accounts.json'))).toBe(true)
    })

    // 앱이 답한 실패는 그 행동의 실패다 — 파일로 덮지 않는다.
    it('앱이 답한 실패는 파일로 덮지 않는다', async () => {
      const readAccounts = vi.fn()
      const deps = hostOrchDeps(base({ act: vi.fn().mockRejectedValue(new Error('boom')), readAccounts }))
      await expect(deps.listAccounts()).rejects.toThrow(/boom/)
      expect(readAccounts).not.toHaveBeenCalled()
    })

    // 파일이 깨졌으면 "지금은 못 한다" 가 참이다 — 6 으로, 고치는 방법을 말하며.
    it('파일을 못 읽으면 앱 문제로 표시하고 고치는 말을 싣는다', async () => {
      const refused: string[] = []
      const deps = hostOrchDeps(
        base({
          hasApp: () => false,
          readAccounts: vi.fn().mockRejectedValue(new Error('accounts.json could not be read; open Astera to repair it')),
          onAppRequired: (n) => refused.push(n)
        })
      )
      const err = await Promise.resolve(deps.listAccounts()).then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(AppUnreachable)
      expect(String(err)).toMatch(/open Astera to repair it/)
      expect(refused).toEqual(['listAccounts'])
    })
  })

  /**
   * **실행 구성도 앱이 없으면 프로필의 run-configs.json 과 그 폴더가 답한다**(CLI phase D). 계정과
   * 같은 갈래다: 앱이 있으면 앱이 정본이고, 없으면 파일이 앱이 마지막으로 남긴 말이다.
   */
  describe('listRunConfigs — 앱이 없으면 파일', () => {
    const cfgs = [{ id: 'cfg1', name: 'test', type: 'npm' }]

    it('앱이 없으면 파일을 읽고, 앱 문제로 표시하지 않는다', async () => {
      const refused: string[] = []
      const logs: string[] = []
      const act = vi.fn()
      const readRunConfigs = vi.fn().mockResolvedValue(cfgs)
      const deps = hostOrchDeps(
        base({ hasApp: () => false, act, readRunConfigs, log: (m) => logs.push(m), onAppRequired: (n) => refused.push(n) })
      )
      expect(await deps.listRunConfigs?.('D:/p')).toEqual(cfgs)
      expect(readRunConfigs).toHaveBeenCalledWith('D:/p')
      expect(act).not.toHaveBeenCalled()
      expect(refused).toEqual([])
      expect(logs.some((l) => l.includes('listRunConfigs') && l.includes('run-configs.json'))).toBe(true)
    })

    it('앱이 있으면 앱에 묻고 파일은 읽지 않는다', async () => {
      const act = vi.fn().mockResolvedValue(cfgs)
      const readRunConfigs = vi.fn()
      const deps = hostOrchDeps(base({ act, readRunConfigs }))
      expect(await deps.listRunConfigs?.('D:/p')).toEqual(cfgs)
      expect(act).toHaveBeenCalledWith('listRunConfigs', ['D:/p'])
      expect(readRunConfigs).not.toHaveBeenCalled()
    })

    it('파일을 못 읽으면 앱 문제로 표시하고 고치는 말을 싣는다', async () => {
      const refused: string[] = []
      const deps = hostOrchDeps(
        base({
          hasApp: () => false,
          readRunConfigs: vi.fn().mockRejectedValue(new Error('run-configs.json is not valid JSON; open Astera to repair it')),
          onAppRequired: (n) => refused.push(n)
        })
      )
      const err = await Promise.resolve(deps.listRunConfigs?.('D:/p')).then(
        () => null,
        (e: unknown) => e
      )
      expect(err).toBeInstanceOf(AppUnreachable)
      expect(String(err)).toMatch(/run-configs\.json .*open Astera to repair it/)
      expect(refused).toEqual(['listRunConfigs'])
    })
  })

  /**
   * **세션은 Host 가 제 레지스트리로 답한다 — 앱이 붙어 있어도**(CLI phase C, `astera sessions`).
   * pty 를 쥐고 있는 것이 Host 이므로 앱에 물을 까닭이 없고, 앱이 닫혀 있어도 답해야 한다.
   * 다만 `sendSession` 은 세션에 글자를 친다 — 두 번 치면 두 번 쳐진다. 그래서 영수증의 "움직였다"
   * 표시를 남긴다(onEffect), 앱으로 나가는 행동이 act 깔때기에서 남기는 것과 같은 표시다.
   */
  describe('sessions — Host 가 스스로 답한다', () => {
    const fake = () => ({
      listSessions: vi.fn(async () => [
        { id: 's1', kind: 'terminal' as const, title: 't', accountId: 'a', cwd: 'D:/p', alive: true, state: 'waiting' as const }
      ]),
      readSession: vi.fn(async () => ({ cols: 80, rows: 24, screen: ['screen'], scrollback: [] })),
      sendSession: vi.fn(async () => {}),
      readChat: vi.fn(async () => []),
      sendChat: vi.fn(async () => {}),
      serial: <T,>(_id: string, run: () => Promise<T>) => run()
    })

    it('앱이 없어도 앱에 묻지 않고 답하며, 앱 문제로 표시하지 않는다', async () => {
      const sessions = fake()
      const act = vi.fn()
      const refused: string[] = []
      const deps = hostOrchDeps(base({ sessions, act, hasApp: () => false, onAppRequired: (n) => refused.push(n) }))
      expect(await deps.listSessions?.()).toEqual([
        { id: 's1', kind: 'terminal', title: 't', accountId: 'a', cwd: 'D:/p', alive: true, state: 'waiting' }
      ])
      expect((await deps.readSession?.('s1', 200))?.screen).toEqual(['screen'])
      await deps.sendSession?.('s1', 'echo hi', true)
      expect(sessions.sendSession).toHaveBeenCalledWith('s1', 'echo hi', true)
      expect(act).not.toHaveBeenCalled()
      expect(refused).toEqual([])
    })

    it('앱이 있어도 앱에 묻지 않는다', async () => {
      const sessions = fake()
      const act = vi.fn()
      const deps = hostOrchDeps(base({ sessions, act }))
      await deps.listSessions?.()
      await deps.readSession?.('s1', 200)
      await deps.sendSession?.('s1', 'x', true)
      expect(act).not.toHaveBeenCalled()
    })

    it('치는 것만 움직인 것으로 센다 — 읽기와 목록은 아니다', async () => {
      let n = 0
      const deps = hostOrchDeps(base({ sessions: fake(), onEffect: () => n++ }))
      await deps.listSessions?.()
      await deps.readSession?.('s1', 200)
      expect(n).toBe(0)
      await deps.sendSession?.('s1', 'x', true)
      expect(n).toBe(1)
    })
  })

  /**
   * **대화 세션은 둘로 갈린다**(CLI phase D4). 읽기는 Host 가 파일에서 한다 — 앱이 있어도. 열린 카드는
   * 앱만 알고, 물을 수 없으면 모른다고(undefined) 답한다. 치기는 앱이 있으면 앱의 세션 드라이버로,
   * 없으면 Host 가 어댑터의 바이트를 직접 쓴다. 두 길 모두 "움직였다" 이고, 세션마다 한 번에 하나다.
   *
   * 진짜 레지스트리 위에서 — 가짜 줄 프로세스가 받은 줄을 센다.
   */
  describe('대화 세션 — 읽기는 Host, 카드는 앱, 치기는 앱이 있으면 앱', () => {
    const chatHost = (restore: Record<string, unknown> = { provider: 'claude', threadId: 'th' }) => {
      const written: string[] = []
      const procs = new ProcRegistry({
        spawn: () => ({
          pid: 7,
          onData: () => {},
          onExit: () => {},
          write: (d: string) => {
            written.push(d)
          },
          kill: () => {}
        }),
        log: () => {}
      })
      procs.open({
        id: 'proc-1',
        file: 'claude',
        args: [],
        opts: { cwd: 'D:/p', env: {} },
        meta: { kind: 'chat', id: 'chat-1', restore: { accountId: 'acc', cwd: 'D:/p', ...restore } }
      })
      const ptys = new PtyRegistry({ spawn: () => { throw new Error('no ptys') }, log: () => {} })
      const sessions = registrySessions({ ptys, procs, hookEventsDir: path.join(os.tmpdir(), 'astera-orchdeps-no-hooks'), accounts: async () => [] })
      return { written, sessions }
    }

    it('카드는 앱이 있으면 앱에 묻고, 없으면 모른다(undefined) — 앱 문제로 표시하지 않는다', async () => {
      const act = vi.fn().mockResolvedValue({ kind: 'approval', summary: 'Bash: npm test' })
      const refused: string[] = []
      const withApp = hostOrchDeps(base({ act, onAppRequired: (n) => refused.push(n) }))
      expect(await withApp.chatPending?.('chat-1')).toEqual({ kind: 'approval', summary: 'Bash: npm test' })
      expect(act).toHaveBeenCalledWith('chatPending', ['chat-1'])
      const act2 = vi.fn()
      const noApp = hostOrchDeps(base({ act: act2, hasApp: () => false, onAppRequired: (n) => refused.push(n) }))
      expect(await noApp.chatPending?.('chat-1')).toBeUndefined()
      expect(act2).not.toHaveBeenCalled()
      const gone = hostOrchDeps(base({ act: vi.fn().mockRejectedValue(new AppUnreachable('APP_REQUIRED: gone')) }))
      expect(await gone.chatPending?.('chat-1')).toBeUndefined()
      expect(refused).toEqual([])
    })

    it('읽기는 앱이 있어도 Host 가 한다', async () => {
      const act = vi.fn()
      const readChat = vi.fn(async () => [{ role: 'user' as const, text: 'hi', tools: [] }])
      const deps = hostOrchDeps(base({ act, sessions: { ...base().sessions, readChat } }))
      expect(await deps.readChat?.('chat-1', 20)).toEqual([{ role: 'user', text: 'hi', tools: [] }])
      expect(readChat).toHaveBeenCalledWith('chat-1', 20)
      expect(act).not.toHaveBeenCalled()
    })

    /** 앱의 두 답을 이름으로 가른다: 카드(chatPending)와 치기(chatSend). */
    const appAnswers = (pending: unknown, sent: unknown = { sent: true }) =>
      vi.fn(async (name: string) => (name === 'chatPending' ? pending : sent))

    it('앱이 있으면 치기는 앱으로 간다 — 카드를 먼저 묻고, Host 는 아무것도 쓰지 않는다', async () => {
      const { written, sessions } = chatHost()
      const act = appAnswers(null)
      let acted = 0
      const deps = hostOrchDeps(base({ act, sessions, onEffect: () => acted++ }))
      expect(await deps.chatSend?.('chat-1', '다음')).toEqual({ sent: true })
      expect(act.mock.calls).toEqual([
        ['chatPending', ['chat-1']],
        ['chatSend', ['chat-1', '다음']]
      ])
      expect(written).toEqual([])
      expect(acted).toBe(1)
    })

    // **거절은 움직인 것이 아니다**(I1). 카드는 치기 전에 물으므로, 카드 때문에 돌아선 호출은 영수증을
    // 남기지 않는다 — 카드에 답한 뒤 같은 요청 id 로 다시 치면 이번엔 간다.
    it('카드가 열려 있으면 치기를 묻지도 않고 돌아선다 — 움직인 것이 아니다', async () => {
      const { written, sessions } = chatHost()
      const act = appAnswers({ kind: 'question', summary: '어느 쪽?' })
      let acted = 0
      const deps = hostOrchDeps(base({ act, sessions, onEffect: () => acted++ }))
      expect(await deps.chatSend?.('chat-1', 'x')).toEqual({ sent: false, pending: { kind: 'question', summary: '어느 쪽?' } })
      expect(act.mock.calls).toEqual([['chatPending', ['chat-1']]])
      expect(written).toEqual([])
      expect(acted).toBe(0)
    })

    // 앱이 붙어 있는데 그 세션을 아직 쥐지 않았다(되찾는 중) — 카드를 모른다(undefined). 치지 않고,
    // 움직인 것도 아니다(M2). Host 도 쓰지 않는다: 앱이 붙어 있는 동안 쓰는 것은 앱뿐이다.
    it('앱이 그 세션을 모르면 치지 않고 돌아선다 — 움직인 것도, Host 가 쓰는 것도 아니다', async () => {
      const { written, sessions } = chatHost()
      const act = appAnswers(undefined)
      let acted = 0
      const deps = hostOrchDeps(base({ act, sessions, onEffect: () => acted++ }))
      expect(await deps.chatSend?.('chat-1', 'x')).toEqual({ sent: false, reason: 'not-held' })
      expect(act.mock.calls).toEqual([['chatPending', ['chat-1']]])
      expect([written, acted]).toEqual([[], 0])
    })

    // 카드를 묻다 앱이 사라졌다 — 아무것도 보내지 않았으므로 역시 움직인 것이 아니다.
    it('카드를 묻지 못했으면 치지 않고 돌아선다', async () => {
      const { written, sessions } = chatHost()
      let acted = 0
      const deps = hostOrchDeps(
        base({ act: vi.fn().mockRejectedValue(new AppUnreachable('APP_REQUIRED: gone')), sessions, onEffect: () => acted++ })
      )
      expect(await deps.chatSend?.('chat-1', 'x')).toEqual({ sent: false, reason: 'not-held' })
      expect([written, acted]).toEqual([[], 0])
    })

    // 드물게 두 호출 사이에 카드가 열리면 앱의 처리기가 막는다(뒷받침). 그때는 이미 물었으므로 움직인
    // 것으로 센다 — 검토가 받아들인 경합이다.
    it('앱이 치기 자리에서 카드로 거절한 답도 그대로 돌아온다', async () => {
      const { written, sessions } = chatHost()
      const refusal = { sent: false, pending: { kind: 'question', summary: '어느 쪽?' } }
      const deps = hostOrchDeps(base({ act: appAnswers(null, refusal), sessions }))
      expect(await deps.chatSend?.('chat-1', 'x')).toEqual(refusal)
      expect(written).toEqual([])
    })

    it('앱이 없으면 Host 가 어댑터의 바이트를 쓴다 — Claude 는 encodeUserTurn 한 줄', async () => {
      const { written, sessions } = chatHost()
      const act = vi.fn()
      let acted = 0
      const refused: string[] = []
      const deps = hostOrchDeps(base({ act, sessions, hasApp: () => false, onEffect: () => acted++, onAppRequired: (n) => refused.push(n) }))
      expect(await deps.chatSend?.('chat-1', '다음')).toEqual({ sent: true })
      expect(written).toEqual([encodeUserTurn('다음') + '\n'])
      expect(act).not.toHaveBeenCalled()
      expect(acted).toBe(1)
      expect(refused).toEqual([])
    })

    // 스레드가 아직 없는 Codex 는 Host 가 turn/start 를 쓸 곳이 없다 — 앱이 있어야 한다는 거절이다.
    it('앱이 없는데 Host 도 쓸 수 없으면 앱이 필요하다는 거절이다', async () => {
      const { written, sessions } = chatHost({ provider: 'codex' })
      const refused: string[] = []
      const deps = hostOrchDeps(base({ sessions, hasApp: () => false, onAppRequired: (n) => refused.push(n) }))
      const err = await deps.chatSend?.('chat-1', 'x').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AppUnreachable)
      expect(String(err)).toMatch(/no Codex thread yet/)
      expect(refused).toEqual(['chatSend'])
      expect(written).toEqual([])
    })

    // 스레드가 없어 Host 가 쓰지 못한 것은 움직인 것이 아니다(I1) — 스레드가 생긴 뒤 같은 id 로 다시 치면 간다.
    it('Host 가 쓰지 못한 거절은 움직인 것이 아니다', async () => {
      const { sessions } = chatHost({ provider: 'codex' })
      let acted = 0
      const deps = hostOrchDeps(base({ sessions, hasApp: () => false, onEffect: () => acted++ }))
      await expect(deps.chatSend?.('chat-1', 'x')).rejects.toThrow(/no Codex thread yet/)
      expect(acted).toBe(0)
    })

    // **앱이 도중에 사라진 것은 "앱이 없다" 와 다르다.** 앱이 이미 보냈을 수 있다 — Host 가 이어서 쓰면
    // 같은 턴이 두 번 간다. 그래서 거절하고, 쓰지 않는다.
    it('앱이 치기에 답하지 못했으면 Host 가 대신 쓰지 않고 거절한다', async () => {
      const { written, sessions } = chatHost()
      const refused: string[] = []
      let acted = 0
      const act = vi.fn(async (name: string) => {
        if (name === 'chatPending') return null
        throw new AppUnreachable('APP_REQUIRED: gone')
      })
      const deps = hostOrchDeps(base({ act, sessions, onEffect: () => acted++, onAppRequired: (n) => refused.push(n) }))
      await expect(deps.chatSend?.('chat-1', 'x')).rejects.toBeInstanceOf(AppUnreachable)
      expect(written).toEqual([])
      expect(refused).toEqual(['chatSend'])
      expect(acted).toBe(1)
    })

    // 세션마다 한 번에 하나 — 앱으로 가는 길도. 먼저 친 것이 끝나야 다음 것을 묻는다.
    it('세션마다 차례대로 — 앞의 것이 끝나야 다음 것이 앱에 간다', async () => {
      const { sessions } = chatHost()
      let release: () => void = () => {}
      let held = false
      const act = vi.fn(async (name: string) => {
        if (name === 'chatPending') return null
        if (!held) {
          held = true
          return new Promise((r) => (release = () => r({ sent: true })))
        }
        return { sent: true }
      })
      const deps = hostOrchDeps(base({ act, sessions }))
      const a = deps.chatSend?.('chat-1', 'a')
      const b = deps.chatSend?.('chat-1', 'b')
      await new Promise((r) => setTimeout(r, 10))
      expect(act.mock.calls.filter((c) => c[0] === 'chatSend')).toEqual([['chatSend', ['chat-1', 'a']]])
      release()
      await Promise.all([a, b])
      expect(act.mock.calls.filter((c) => c[0] === 'chatSend')).toEqual([
        ['chatSend', ['chat-1', 'a']],
        ['chatSend', ['chat-1', 'b']]
      ])
    })

    // 앱이 없을 때 카드를 모르는 것은 평소 일이다 — 읽을 때마다 로그에 남기지 않는다(M1). 앱이 붙어 있는데
    // 답을 못 한 것만 남긴다.
    it('앱이 없어 카드를 못 묻는 것은 로그에 남기지 않는다 — 앱이 답하지 못한 것만 남긴다', async () => {
      const logs: string[] = []
      await hostOrchDeps(base({ hasApp: () => false, log: (m) => logs.push(m) })).chatPending?.('chat-1')
      expect(logs).toEqual([])
      await hostOrchDeps(
        base({ act: vi.fn().mockRejectedValue(new AppUnreachable('APP_REQUIRED: gone')), log: (m) => logs.push(m) })
      ).chatPending?.('chat-1')
      expect(logs).toHaveLength(1)
      expect(logs[0]).toMatch(/chatPending could not be asked/)
    })

    it('앱이 없을 때도 차례대로 쓴다', async () => {
      const { written, sessions } = chatHost()
      const deps = hostOrchDeps(base({ sessions, hasApp: () => false }))
      await Promise.all([deps.chatSend?.('chat-1', 'a'), deps.chatSend?.('chat-1', 'b'), deps.chatSend?.('chat-1', 'c')])
      expect(written).toEqual(['a', 'b', 'c'].map((t) => encodeUserTurn(t) + '\n'))
    })
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
      await expect(deps.readWorker({ dispatchId: 'd1' })).rejects.toThrow(/APP_REQUIRED/)
      expect(refused).toEqual(['startWorker', 'readWorker'])
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

const fakeLocal = (over: Partial<HostLocal> = {}): HostLocal => ({
  owns: () => true,
  startWorker: vi.fn().mockResolvedValue({ sessionId: 'ses_h', cwd: 'D:/p', specPath: 'D:/s.md' }),
  startCoordinator: vi.fn().mockResolvedValue({ sessionId: 'ses_c' }),
  releaseWorker: vi.fn().mockResolvedValue(undefined),
  readWorker: vi.fn().mockResolvedValue('tail'),
  probeLimit: vi.fn().mockResolvedValue(null),
  readReviewFile: vi.fn().mockResolvedValue(null),
  ...over
})
describe('HOST_LOCAL (S2)', () => {
  it('is answered by the Host and never asked of the app, with or without one', async () => {
    for (const hasApp of [true, false]) {
      const act = vi.fn(); const local = fakeLocal()
      const deps = hostOrchDeps(base({ act, hasApp: () => hasApp, local }))
      expect(await deps.startWorker({ dispatchId: 'd1', worktree: 'current' } as never)).toMatchObject({ sessionId: 'ses_h' })
      await deps.releaseWorker({ dispatchId: 'd1' })
      expect(await deps.readWorker({ dispatchId: 'd1' })).toBe('tail')
      expect(await deps.startCoordinator!({ runId: 'r', cwd: 'D:/p', accountId: 'a', brief: 'b' })).toEqual({ sessionId: 'ses_c' })
      expect(act).not.toHaveBeenCalled()
    }
  })
  it('marks an effectful local call before it runs, and a read not at all', async () => {
    const order: string[] = []
    const local = fakeLocal({ startWorker: vi.fn(async () => { order.push('start'); return { sessionId: 's', cwd: 'c', specPath: 'p' } }), readWorker: vi.fn(async () => { order.push('read'); return '' }) })
    const deps = hostOrchDeps(base({ local, onEffect: () => order.push('effect') }))
    await deps.startWorker({} as never); await deps.readWorker({ dispatchId: 'd' })
    expect(order).toEqual(['effect', 'start', 'read'])
  })
  // R1: the S2-alone guard.
  it('sends a call the Host does not own the way it went before — refused with no app', async () => {
    const onAppRequired = vi.fn()
    const local = fakeLocal({ owns: (name, args) => !(name === 'startWorker' && (args[0] as { worktree?: string }).worktree === 'new') })
    const deps = hostOrchDeps(base({ hasApp: () => false, local, onAppRequired }))
    await expect(deps.startWorker({ worktree: 'new' } as never)).rejects.toThrow(/APP_REQUIRED/)
    expect(onAppRequired).toHaveBeenCalledWith('startWorker', expect.any(String))
    expect(local.startWorker).not.toHaveBeenCalled()
  })
  it('keeps probeLimit and readReviewFile swallowed when they fall back', async () => {
    const onAppRequired = vi.fn()
    const deps = hostOrchDeps(base({ hasApp: () => false, local: fakeLocal({ owns: () => false }), onAppRequired }))
    await expect(deps.probeLimit!({} as never)).rejects.toThrow(/APP_REQUIRED/)
    await expect(deps.readReviewFile!('D:/r.md')).rejects.toThrow(/APP_REQUIRED/)
    expect(onAppRequired).not.toHaveBeenCalled()
  })
  it('with no local, every one of the six travels to the app exactly as before', async () => {
    const act = vi.fn().mockResolvedValue({})
    const deps = hostOrchDeps(base({ act, local: null }))
    await deps.startWorker({ dispatchId: 'd1' } as never)
    expect(act).toHaveBeenCalledWith('startWorker', [{ dispatchId: 'd1' }])
  })
  // A forwarded fallback still goes through the funnel, so a keyed retry of it is not re-run either.
  it('marks a forwarded fallback as an effect, as it did before S2', async () => {
    const onEffect = vi.fn()
    const act = vi.fn().mockResolvedValue(undefined)
    const deps = hostOrchDeps(base({ act, onEffect, local: fakeLocal({ owns: () => false }) }))
    await deps.releaseWorker({ dispatchId: 'd1' })
    expect(act).toHaveBeenCalledWith('releaseWorker', [{ dispatchId: 'd1' }])
    expect(onEffect).toHaveBeenCalledTimes(1)
  })
  // I1/I2: a local refusal only the app can clear (a profile file it must repair) decides the command
  // the way an absent app does, and names the file. Any other local failure passes straight through.
  it('flags a local repair refusal with its file, and passes any other local failure straight through', async () => {
    const onAppRequired = vi.fn()
    const needsRepair = new RepairNeeded('accounts.json is not valid JSON; open Astera to repair it', 'accounts.json')
    const deps = hostOrchDeps(base({ onAppRequired, local: fakeLocal({ startWorker: vi.fn().mockRejectedValue(needsRepair), releaseWorker: vi.fn().mockRejectedValue(new Error('boom')) }) }))
    await expect(deps.startWorker({} as never)).rejects.toBe(needsRepair)
    expect(onAppRequired).toHaveBeenCalledWith('startWorker', needsRepair.message, { repair: 'accounts.json' })
    await expect(deps.releaseWorker({ dispatchId: 'd1' })).rejects.toThrow('boom')
    expect(onAppRequired).toHaveBeenCalledTimes(1)
  })
  // Fix round ruling (a): a spawn refused because the Host is leaving is a conflict the caller retries,
  // flagged the way a repair refusal is, with `retry` instead of a file.
  it('flags a local refusal from a retiring Host with retry, for the names that propagate', async () => {
    const onAppRequired = vi.fn()
    const retiring = new HostRetiring()
    const deps = hostOrchDeps(base({ onAppRequired, local: fakeLocal({ startWorker: vi.fn().mockRejectedValue(retiring), startCoordinator: vi.fn().mockRejectedValue(retiring) }) }))
    await expect(deps.startWorker({} as never)).rejects.toBe(retiring)
    expect(onAppRequired).toHaveBeenCalledWith('startWorker', retiring.message, { retry: 'host-retiring' })
    await expect(deps.startCoordinator!({} as never)).rejects.toBe(retiring)
    expect(onAppRequired).toHaveBeenCalledWith('startCoordinator', retiring.message, { retry: 'host-retiring' })
  })
  it('flags a file read that needs repair with its file, when the app is absent', async () => {
    const onAppRequired = vi.fn()
    const deps = hostOrchDeps(base({ hasApp: () => false, onAppRequired, readAccounts: vi.fn().mockRejectedValue(new RepairNeeded('accounts.json is not valid JSON; open Astera to repair it', 'accounts.json')) }))
    await expect(deps.listAccounts()).rejects.toThrow(/open Astera to repair it/)
    expect(onAppRequired).toHaveBeenCalledWith('listAccounts', expect.stringMatching(/open Astera/), { repair: 'accounts.json' })
  })
})
