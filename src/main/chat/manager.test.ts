import { describe, it, expect } from 'vitest'
import path from 'node:path'
import type { Account, ScheduleConfig, SessionInfo } from '../../core/types'
import type { Provider } from '../../core/providers/meta'
import type { ProcFactory, ProcLike, ProcSpawnOptions } from '../../core/sessions/proc'
import { makeDescriptors } from '../../core/providers/descriptor'
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatState } from '../../core/chat/types'
import { claudeLaunchArgs } from '../../core/chat/claudeProtocol'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../core/sessions/pty'
import type { AdapterMode } from './codexAdapter'
import { ChatSessionManager, type ChatManagerDeps } from './manager'

class FakeProc implements ProcLike {
  pid = 111
  written: string[] = []
  notes: Record<string, unknown>[] = []
  killed = false
  outlivesApp?: boolean
  private lineCb: (l: string) => void = () => {}
  private exitCb: (e: { exitCode: number }) => void = () => {}
  onLine(cb: (l: string) => void): void {
    this.lineCb = cb
  }
  onExit(cb: (e: { exitCode: number }) => void): void {
    this.exitCb = cb
  }
  write(line: string): void {
    this.written.push(line)
  }
  kill(): void {
    this.killed = true
  }
  remember(patch: Record<string, unknown>): void {
    this.notes.push(patch)
  }
  feed(line: string): void {
    this.lineCb(line)
  }
  exit(code: number): void {
    this.exitCb({ exitCode: code })
  }
}

interface FakeAdapterHandle {
  mode: AdapterMode
  provider: Provider
  startCalls: Array<{ cwd: string; resumeThreadId?: string; bypass: boolean }>
  killCalls: number
  sent: string[]
  emit(e: ChatEvent): void
}

/** A fake adapter factory: one FakeAdapterHandle per session, in spawn/adopt call order.
 *  `startRejects` makes every adapter's start() reject, which is what a refused handshake looks like
 *  to the manager. `sendRejects` makes every adapter's send() reject, which is what Codex's
 *  "no active thread" refusal looks like before its handshake has settled. */
/** `startRejectsOnce` rejects only the *first* handle's `start()` (matching what a real adapter does
 *  when a process dies before its handshake completes — `doStart`'s own catch rejects the outer
 *  promise) while later handles (a bypass retry) resolve normally — for tests that need attempt 0 to
 *  genuinely fail its handshake without also failing the retry that follows it. */
function makeAdapterFactory(startRejects = false, sendRejects = false, startRejectsOnce = false): {
  createAdapter: NonNullable<ChatManagerDeps['createAdapter']>
  handles: FakeAdapterHandle[]
} {
  const handles: FakeAdapterHandle[] = []
  const createAdapter: NonNullable<ChatManagerDeps['createAdapter']> = (a) => {
    const listeners: Array<(e: ChatEvent) => void> = []
    const handleIndex = handles.length
    const handle: FakeAdapterHandle = {
      mode: a.mode,
      provider: a.provider,
      startCalls: [],
      killCalls: 0,
      sent: [],
      emit: (e) => {
        for (const fn of listeners) fn(e)
      }
    }
    handles.push(handle)
    // Every real adapter subscribes to the proc's one line at construction (codexAdapter.ts,
    // claudeAdapter.ts both call `proc.onLine(handleLine)` up front) — this is what `watchFirstLine`'s
    // wrapper actually counts through. A fake that skipped this would leave `sawLine()` permanently
    // false, which is a different lie than the one any of these tests are about.
    a.proc.onLine(() => {})
    const adapter: ChatAdapter = {
      start: (o) => {
        handle.startCalls.push(o)
        const rejects = startRejects || (startRejectsOnce && handleIndex === 0)
        return rejects ? Promise.reject(new Error('too old')) : Promise.resolve()
      },
      send: (text) => {
        handle.sent.push(text)
        return sendRejects ? Promise.reject(new Error('no active thread')) : Promise.resolve()
      },
      interrupt: () => Promise.resolve(),
      answer: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      setPermissionMode: () => Promise.resolve(),
      listPermissionModes: () => Promise.resolve([]),
      listModels: () => Promise.resolve([]),
      state: (): ChatState => ({
        status: 'idle',
        request: null,
        model: { model: null, effort: null, permissionMode: 'default' },
        error: null,
        exitCode: null,
        errorDetail: null,
        outlivesApp: a.proc.outlivesApp === true,
        truncated: a.mode.mode === 'adopt' ? a.mode.truncated : false,
        provider: a.provider
      }),
      on: (fn) => {
        listeners.push(fn)
        return () => {
          const i = listeners.indexOf(fn)
          if (i >= 0) listeners.splice(i, 1)
        }
      },
      kill: () => {
        handle.killCalls++
      }
    }
    return adapter
  }
  return { createAdapter, handles }
}

const codexAccount: Account = {
  id: 'acc-cx',
  label: 'codex',
  configDir: 'C:\\Users\\tester\\.codex-accounts\\work',
  color: '#fff',
  createdAt: '2026-07-29T00:00:00Z',
  provider: 'codex'
}

// A non-ambient configDir, like codexAccount's own — the isolation env var (CLAUDE_CONFIG_DIR) is only
// injected off the home default, so a fixture at the ambient path would silently drop it from every
// assertion below. provider is left unset on purpose: providerOf's own default (absent means 'claude')
// is what a chat account built before Task 2 looks like, and spawn must still route it here.
const claudeAccount: Account = {
  id: 'acc-cl',
  label: 'claude',
  configDir: 'C:\\Users\\tester\\.claude-accounts\\work',
  color: '#fff',
  createdAt: '2026-07-29T00:00:00Z'
}

/** `throwOnSpawnCall` makes the factory throw synchronously on its Nth call (1-based) instead of
 *  spawning — for testing that a broken `respawnWithBypass` (the factory or `makeAdapter` throwing)
 *  falls through to reporting the exit it was about to swallow, rather than losing it. */
function setup(
  platform: NodeJS.Platform = 'win32',
  startRejects = false,
  sendRejects = false,
  throwOnSpawnCall?: number,
  startRejectsOnce = false
) {
  const spawned: Array<{ file: string; args: string[]; opts: ProcSpawnOptions; proc: FakeProc }> = []
  const factory: ProcFactory = (file, args, opts) => {
    if (throwOnSpawnCall !== undefined && spawned.length + 1 === throwOnSpawnCall) {
      throw new Error('factory exploded')
    }
    const proc = new FakeProc()
    spawned.push({ file, args, opts, proc })
    return proc
  }
  const { createAdapter, handles } = makeAdapterFactory(startRejects, sendRejects, startRejectsOnce)
  const descriptors = makeDescriptors(platform)
  const logged: string[] = []
  const manager = new ChatSessionManager({
    factory,
    descriptors,
    homeDir: 'C:\\Users\\tester',
    platform,
    version: '1.0.0',
    log: (m) => logged.push(m),
    createAdapter
  })
  return { spawned, manager, handles, logged }
}

/** Waits out the microtask chain behind a `void adapter.start(...).then(...).catch(...)` fire-and-forget
 *  call, without a fake timer — there is no macrotask in that chain to advance, only promises to settle. */
async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('ChatSessionManager.spawn', () => {
  it('spawns codex over app-server, wires env and meta, and starts the adapter', () => {
    const { spawned, manager, handles } = setup('win32')
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })

    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('cmd.exe')
    expect(spawned[0].args).toEqual(['/c', 'codex', 'app-server'])
    expect(spawned[0].opts.env.CODEX_HOME).toBe(codexAccount.configDir)
    expect(spawned[0].opts.meta).toEqual({
      kind: 'chat',
      id: info.id,
      restore: {
        accountId: codexAccount.id,
        cwd: 'D:/proj',
        title: 'proj',
        provider: 'codex',
        bypassPermissions: false
      }
    })

    expect(handles).toHaveLength(1)
    expect(handles[0].mode).toEqual({ mode: 'fresh' })
    expect(handles[0].provider).toBe('codex')
    expect(handles[0].startCalls).toEqual([{ cwd: 'D:/proj', resumeThreadId: undefined, bypass: false }])

    expect(info.kind).toBe('chat')
    expect(info.status).toBe('running')
    expect(info.title).toBe('proj')
    expect(manager.list().map((s) => s.id)).toContain(info.id)
    expect(manager.state(info.id)?.provider).toBe('codex')
  })

  it('spawns a claude account over the claude CLI, wires env and meta, and reaches the adapter as claude', () => {
    const { spawned, manager, handles } = setup('win32')
    const info = manager.spawn({ account: claudeAccount, cwd: 'D:/proj' })

    expect(spawned).toHaveLength(1)
    expect(spawned[0].file).toBe('cmd.exe')
    expect(spawned[0].args).toEqual(['/c', 'claude', ...claudeLaunchArgs({ resumeSessionId: undefined, bypass: false })])
    expect(spawned[0].opts.env.CLAUDE_CONFIG_DIR).toBe(claudeAccount.configDir)
    expect(spawned[0].opts.meta).toEqual({
      kind: 'chat',
      id: info.id,
      restore: {
        accountId: claudeAccount.id,
        cwd: 'D:/proj',
        title: 'proj',
        provider: 'claude',
        bypassPermissions: false
      }
    })

    expect(handles).toHaveLength(1)
    expect(handles[0].mode).toEqual({ mode: 'fresh' })
    expect(handles[0].provider).toBe('claude')

    expect(info.kind).toBe('chat')
    expect(info.status).toBe('running')
    expect(manager.state(info.id)?.provider).toBe('claude')
  })

  // A model the person picked is argv for Claude — there is no protocol call that outlives the process,
  // so a session started without it comes up on the CLI's own default. That is what a roll used to do:
  // pick Opus, roll to the next account, and the new process launches with no --model and reports the
  // default back. Reported as "I picked Opus and it turned into Fable partway through".
  it('launches with the model it is given, so a roll can carry the one that was picked', () => {
    const { spawned, manager } = setup('win32')
    manager.spawn({ account: claudeAccount, cwd: 'D:/proj', model: 'opus' })
    expect(spawned[0].args).toEqual([
      '/c',
      'claude',
      ...claudeLaunchArgs({ resumeSessionId: undefined, bypass: false, model: 'opus' })
    ])
  })

  // What the roll reads when it respawns. It is the person's choice, not the model in use: the CLI can
  // move off a model by itself (a limit reached mid-session), and carrying that onto a fresh account
  // would pin the fallback on an account that never hit anything.
  it('remembers the model the person picked, across a pick and a spawn', async () => {
    const { manager } = setup('win32')
    const seeded = manager.spawn({ account: claudeAccount, cwd: 'D:/proj', model: 'opus' })
    expect(manager.chosenModelOf(seeded.id)).toBe('opus')

    const fresh = manager.spawn({ account: claudeAccount, cwd: 'D:/proj' })
    expect(manager.chosenModelOf(fresh.id)).toBeNull()
    await manager.setModel(fresh.id, 'sonnet', null)
    expect(manager.chosenModelOf(fresh.id)).toBe('sonnet')
    expect(manager.chosenModelOf('nobody')).toBeNull()
  })

  it('carries resumeThreadId and bypassPermissions through to info, meta and adapter.start', () => {
    const { spawned, manager, handles } = setup('win32')
    const info = manager.spawn({
      account: codexAccount,
      cwd: 'D:/proj',
      resumeThreadId: 'th-resume',
      bypassPermissions: true,
      title: 'My chat'
    })
    expect(info.threadId).toBe('th-resume')
    expect(info.resumeSessionId).toBe('th-resume')
    expect(info.bypassPermissions).toBe(true)
    expect(info.title).toBe('My chat')
    expect(spawned[0].opts.meta).toMatchObject({
      restore: { title: 'My chat', bypassPermissions: true, threadId: 'th-resume' }
    })
    expect(handles[0].startCalls).toEqual([{ cwd: 'D:/proj', resumeThreadId: 'th-resume', bypass: true }])
  })

  it('a handshake that never completes is logged, not thrown at the caller', async () => {
    const { manager, logged } = setup('win32', true)
    let info: SessionInfo | null = null
    expect(() => {
      info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    }).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(info).not.toBeNull()
    expect(logged.some((m) => m.includes('chat adapter start failed') && m.includes('too old'))).toBe(true)
  })

  it('carries schedule, slackNotify, rollAccountIds and rollPrompt onto info, and all but schedule onto the note', () => {
    const { spawned, manager } = setup('win32')
    const schedule: ScheduleConfig = { rule: { kind: 'interval', minutes: 5 }, command: 'status' }
    const info = manager.spawn({
      account: codexAccount,
      cwd: 'D:/p',
      schedule,
      slackNotify: true,
      rollAccountIds: ['a1', 'a2'],
      rollPrompt: 'carry on'
    })
    expect(info.schedule).toEqual(schedule)
    expect(info.slackNotify).toBe(true)
    expect(info.rollAccountIds).toEqual(['a1', 'a2'])
    expect(info.rollPrompt).toBe('carry on')
    const meta = spawned[0].opts.meta!
    expect(meta.restore).toMatchObject({ slackNotify: true, rollAccountIds: ['a1', 'a2'], rollPrompt: 'carry on' })
    expect(meta.restore).not.toHaveProperty('schedule')
  })

  it('spawn without the feature fields writes none of them to info or the note', () => {
    const { spawned, manager } = setup('win32')
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/p' })
    expect(info).not.toHaveProperty('schedule')
    expect(info).not.toHaveProperty('slackNotify')
    expect(info).not.toHaveProperty('rollAccountIds')
    expect(spawned[0].opts.meta!.restore).not.toHaveProperty('slackNotify')
  })
})

describe('ChatSessionManager.spawn — initialPrompt', () => {
  it('initialPrompt is sent as the first turn after start() resolves, once', async () => {
    const { manager, handles } = setup()
    manager.spawn({ account: codexAccount, cwd: 'D:/p', initialPrompt: 'carry on' })
    await flushPromises()
    expect(handles[0].sent).toEqual(['carry on'])
  })

  it('a rejected initial prompt is logged, not thrown, and nothing else changes', async () => {
    const { manager, handles, logged } = setup('win32', false, true)
    expect(() => {
      manager.spawn({ account: codexAccount, cwd: 'D:/p', initialPrompt: 'carry on' })
    }).not.toThrow()
    await flushPromises()
    expect(handles[0].sent).toEqual(['carry on'])
    expect(logged.some((m) => m.includes('chat initial prompt failed') && m.includes('no active thread'))).toBe(true)
  })

  it('no initialPrompt means nothing is sent, and the note carries no prompt', async () => {
    const { manager, handles, spawned } = setup()
    manager.spawn({ account: codexAccount, cwd: 'D:/p' })
    await flushPromises()
    expect(handles[0].sent).toEqual([])
    expect(spawned[0].opts.meta!.restore).not.toHaveProperty('initialPrompt')
  })
})

describe('event wiring', () => {
  it('ready sets threadId/resumeSessionId; exit marks exited and fires onExit; subscribe sees both in order', () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    const exits: Array<{ sessionId: string; exitCode: number }> = []
    manager.onExit = (e) => exits.push(e)
    const seen: Array<[string, ChatEvent]> = []
    manager.subscribe((sessionId, e) => seen.push([sessionId, e]))

    handles[0].emit({ type: 'ready', threadId: 'th-1', rolloutPath: null })
    expect(manager.info(info.id)?.threadId).toBe('th-1')
    // A second ready with another id is a claude session whose `/clear` started a new one, and the
    // session's identity has to move with it — everything keyed by the id reads it from here.
    handles[0].emit({ type: 'ready', threadId: 'th-2', rolloutPath: null })
    // A line first, so this plain exit is not read as the silent, line-less death Task 7's bypass
    // retry is for — this test is about ready/exit bookkeeping, not that.
    spawned[0].proc.feed('{"jsonrpc":"2.0"}')
    handles[0].emit({ type: 'exit', code: 7, errorDetail: null })

    const after = manager.info(info.id)
    expect(after?.threadId).toBe('th-2')
    expect(after?.resumeSessionId).toBe('th-2')
    expect(after?.status).toBe('exited')
    expect(after?.exitCode).toBe(7)
    expect(exits).toEqual([{ sessionId: info.id, exitCode: 7 }])
    expect(seen).toEqual([
      [info.id, { type: 'ready', threadId: 'th-1', rolloutPath: null }],
      [info.id, { type: 'ready', threadId: 'th-2', rolloutPath: null }],
      [info.id, { type: 'exit', code: 7, errorDetail: null }]
    ])
  })

  it('subscribers no longer hear anything after unsubscribing', () => {
    const { manager, handles } = setup()
    manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    const seen: ChatEvent[] = []
    const unsubscribe = manager.subscribe((_id, e) => seen.push(e))
    unsubscribe()
    handles[0].emit({ type: 'status', status: 'working' })
    expect(seen).toEqual([])
  })
})

// Task 7 (design F5): a project's package.json has nothing to do with whether the CLI starts, but a
// toolchain manager on PATH ties the two together and refuses to run anything it cannot version-pick.
// One bypass retry, only after a death that shows the CLI never ran — never on the first attempt (S7).
describe('ChatSessionManager — toolchain 우회 재시도', () => {
  it('말없이 즉사하면 우회를 얹어 한 번 다시 띄운다', async () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })

    // 두 번째 spawn 이 우회 env 를 지고 나간다 — 첫 번째는 그대로 둔다(S7: 항상 켜지는 않는다)
    expect(spawned).toHaveLength(2)
    expect(spawned[0].opts.env.VOLTA_BYPASS).toBeUndefined()
    expect(spawned[1].opts.env.VOLTA_BYPASS).toBe('1')
    // 같은 cwd·meta·provider 로, 같은 세션 id 에 다시 건다 — 새 id 를 만들면 탭·스케줄러·Slack·
    // 롤 체인이 전부 고아가 된다
    expect(spawned[1].opts.cwd).toBe(spawned[0].opts.cwd)
    expect(spawned[1].opts.meta).toEqual(spawned[0].opts.meta)
    expect(handles[1].provider).toBe(handles[0].provider)
    expect(handles[1].startCalls).toEqual(handles[0].startCalls)

    // 첫 exit 은 구독자에게 닿지 않는다 — 죽었다가 되살아난 게 아니라 뜨는 데 한 순간 더 걸린 것이다
    expect(seen).toEqual([])
    expect(manager.info(info.id)?.status).toBe('running')

    await flushPromises()
    // 재시도가 성공했다는 것은 반드시 말한다 — 우회가 사용자가 핀해 둔 것과 다른 버전을 띄웠을 수
    // 있어서다. error 가 아니라 그 자신의 이벤트로: 종료 배너가 이것을 사유로 오해하면 안 된다
    expect(seen).toEqual([{ type: 'notice', key: 'bypassed' }])
  })

  // 한 줄이라도 말했으면 실행은 된 것이다. 그 뒤의 죽음은 CLI 자신의 사정이고 우회가 고칠 것이 아니다
  it('한 줄이라도 말한 뒤 죽으면 다시 띄우지 않는다', () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    spawned[0].proc.feed('{"jsonrpc":"2.0"}')

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })

    expect(spawned).toHaveLength(1)
    expect(manager.info(info.id)?.status).toBe('exited')
  })

  it('재시도도 죽으면 두 번째는 없다', async () => {
    // startRejects: true — 두 시도 모두 handshake 가 끝내 완성되지 않는다. false 로 두면 가짜
    // adapter 의 start() 가 (실제와 달리) exit 과 무관하게 성공해 버려 재시도가 "성공했다" 는 알림까지
    // 동시에 나가는, 이 테스트가 보이려는 것과 다른 모양이 된다.
    const { manager, handles, spawned } = setup('win32', true)
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    const exits: Array<{ sessionId: string; exitCode: number }> = []
    manager.onExit = (e) => exits.push(e)
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: 'first attempt tail' })
    expect(spawned).toHaveLength(2) // the one retry

    handles[1].emit({ type: 'exit', code: 9, errorDetail: 'second attempt tail' })
    expect(spawned).toHaveLength(2) // and no third spawn

    expect(manager.info(info.id)?.status).toBe('exited')
    expect(manager.info(info.id)?.exitCode).toBe(9)
    expect(exits).toEqual([{ sessionId: info.id, exitCode: 9 }])
    // 재시도도 실패하면 두 시도의 stderr 를 함께 보여준다(design F5) — 라벨을 붙여서, 둘 다: 라벨이
    // 없으면 한쪽의 말이 다른 쪽의 마지막 말인 것처럼 보인다(fix round 1, C 리뷰)
    expect(seen).toEqual([
      {
        type: 'exit',
        code: 9,
        errorDetail: '[attempt 1, no bypass] first attempt tail\n---\n[attempt 2, with bypass] second attempt tail'
      }
    ])
  })

  // fix round 1: 한쪽이 비어 있어도 라벨은 둘 다 붙는다 — "관리자가 거절, 맨 실행은 조용히 죽음" 이
  // 흔한 모양인데, 예전 방식(둘 다 있을 때만 이어붙임)은 이때 한쪽의 말을 다른 쪽 것처럼 보이게 했다.
  it('한쪽 stderr 가 없어도 라벨은 둘 다 붙는다', () => {
    const { manager, handles, spawned } = setup('win32', true)
    manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: 'volta: could not parse package.json' })
    expect(spawned).toHaveLength(2)
    handles[1].emit({ type: 'exit', code: 1, errorDetail: null })

    expect(seen).toEqual([
      {
        type: 'exit',
        code: 1,
        errorDetail: '[attempt 1, no bypass] volta: could not parse package.json\n---\n[attempt 2, with bypass] (no output)'
      }
    ])
  })

  // fix round 1: 둘 다 4000자 가까이 길면, 통째로 뒤에서 자르는 방식은 2차 라벨까지 통째로 날려버릴
  // 수 있다(계산해 보면 둘 다 4000자일 때 정확히 그렇게 된다) — 그래서 절반씩(2000자) 나눠 갖는다.
  it('둘 다 길면 각자 절반(2000자)만 남고, 라벨은 둘 다 살아남는다', () => {
    const { manager, handles, spawned } = setup('win32', true)
    manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: 'a'.repeat(5000) })
    expect(spawned).toHaveLength(2)
    handles[1].emit({ type: 'exit', code: 1, errorDetail: 'b'.repeat(5000) })

    const detail = (seen[0] as { errorDetail: string }).errorDetail
    expect(detail).toContain('[attempt 1, no bypass]')
    expect(detail).toContain('[attempt 2, with bypass]')
    // STDERR_TAIL_MAX(4000) 하나를 둘로 나눈 것 — 새 숫자를 만들지 않는다(설계 S3)
    expect(detail).toContain('a'.repeat(2000))
    expect(detail).not.toContain('a'.repeat(2001))
    // 각 쪽에서도 꼬리(더 최근 것)가 남는다 — createStderrTail 과 같은 방향
    expect(detail.endsWith('b'.repeat(2000))).toBe(true)
  })

  // C1: rolling.ts / codexRolling.ts 는 채팅 세션엔 자기 auto-prompt 를 안 보낸다 — "spawn 이 실어
  // 준다" 고 믿기 때문이다. 1차 시도의 adapter.start() 는 reject 되므로(핸드셰이크가 못 끝났으니) 그
  // .then() 은 끝내 안 돈다 — initialPrompt 를 보낼 자리 자체가 없다. 재시도가 유일한 전달 채널이다.
  it('말없이 즉사해도 재시도가 성공하면 initialPrompt 를 그 재시도가 보낸다', async () => {
    const { manager, handles, spawned } = setup('win32', false, false, undefined, true)
    manager.spawn({ account: codexAccount, cwd: 'D:/proj', initialPrompt: 'carry on' })

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    expect(spawned).toHaveLength(2)

    await flushPromises()
    expect(handles[0].sent).toEqual([]) // 죽은 1차는 보낸 적이 없다 — "아직 필요 없음"이 아니라 파괴된 것
    expect(handles[1].sent).toEqual(['carry on']) // 재시도가 유일한 전달 채널
  })

  // C2: 재시도가 성공하고 한참 지나 평범하게(예: 코드 0, stderr 없이) 끝나는 죽음까지도
  // firstFailure 를 들고 있으면 그 평범한 종료의 사유를 옛 toolchain 거절로 오염시킨다(설계 D2/T4
  // 배너가 그것을 사유로 오해한다).
  it('재시도가 성공하면 firstFailure 가 지워져 다음 종료를 오염시키지 않는다', async () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: 'volta: could not parse package.json' })
    expect(spawned).toHaveLength(2)
    await flushPromises() // 재시도의 start() 가 리졸브 — notice 가 나가고 firstFailure 가 지워진다
    expect(seen).toEqual([{ type: 'notice', key: 'bypassed' }])

    // 두 시간 뒤, 이 세션은 평범하게 끝난다 — 옛 실패와는 무관하다
    handles[1].emit({ type: 'exit', code: 0, errorDetail: null })
    expect(manager.info(info.id)?.exitCode).toBe(0)
    expect(seen.at(-1)).toEqual({ type: 'exit', code: 0, errorDetail: null }) // 병합되지 않은 그대로
  })

  // C3: 뜨는 데 시간이 걸리는 탭을 그 오 초 창 안에서 닫으면(kill), 그 죽음은 거절이 아니라 요청한
  // 것이다 — 재시도가 걸리면 닫힌 탭 뒤에서 우회를 얹은 새 CLI 가 조용히 떠 버린다.
  it('kill() 로 인한 죽음은 그 창 안이어도 재시도하지 않는다', () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })

    manager.kill(info.id)
    expect(handles[0].killCalls).toBe(1)
    handles[0].emit({ type: 'exit', code: 8, errorDetail: null }) // kill() 이 부른 그 죽음

    expect(spawned).toHaveLength(1) // 재시도 없음
    expect(manager.info(info.id)?.status).toBe('exited')
    expect(manager.info(info.id)?.exitCode).toBe(8)
  })

  // 중요: PTY_LOST_SIGHT_EXIT_CODE 는 "이 앱이 그 프로세스를 놓쳤다"이지 "그 프로세스가 끝났다"가
  // 아니다(procFactory.ts) — Host 재연결 창 안에서 이 코드를 즉사로 읽으면, 첫 프로세스가 아직 살아
  // 있는 채로 같은 id 아래 두 번째 CLI 가 뜬다.
  it('PTY_LOST_SIGHT_EXIT_CODE 는 즉사로 읽지 않는다', () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })

    handles[0].emit({ type: 'exit', code: PTY_LOST_SIGHT_EXIT_CODE, errorDetail: null })

    expect(spawned).toHaveLength(1) // 재시도 없음
    expect(manager.info(info.id)?.status).toBe('exited')
    expect(manager.info(info.id)?.exitCode).toBe(PTY_LOST_SIGHT_EXIT_CODE)
  })

  // 중요: factory 나 makeAdapter 가 던지면, 이미 삼키기로 한 1차 exit 을 대신할 것이 없어진다 —
  // 세션은 죽은 프로세스를 붙들고 'running'에 영영 머문다. respawnWithBypass 호출을 감싸서, 던지면
  // 삼키려던 그 원래 exit 을 그대로 보고한다.
  it('재시도 자체가 던지면 삼키려던 원래 exit 을 그대로 보고한다', () => {
    const { manager, handles, spawned, logged } = setup('win32', false, false, 2) // 2번째 spawn(재시도)이 던진다
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    const exits: Array<{ sessionId: string; exitCode: number }> = []
    manager.onExit = (e) => exits.push(e)
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    expect(() => handles[0].emit({ type: 'exit', code: 8, errorDetail: 'first tail' })).not.toThrow()

    expect(spawned).toHaveLength(1) // 재시도 spawn 은 던졌으니 배열에 없다
    expect(manager.info(info.id)?.status).toBe('exited')
    expect(manager.info(info.id)?.exitCode).toBe(8)
    expect(exits).toEqual([{ sessionId: info.id, exitCode: 8 }])
    expect(seen).toEqual([{ type: 'exit', code: 8, errorDetail: 'first tail' }])
    expect(logged.some((m) => m.includes('bypass retry failed to start'))).toBe(true)
  })

  // C4: 1차 어댑터의 doStart 는 진짜로는 exit 이 삼켜진 뒤 한 틱 늦게 core.fail() 을 부른다
  // (codexAdapter.ts / claudeAdapter.ts 의 doStart catch). 구독을 끊지 않으면 그 늦은 error 가 재시도
  // 세션 밑에서 나온다 — chatBannerFor 는 error 를 notice 보다 위에 두므로, 멀쩡히 뜬 세션이 "턴이
  // 실패했습니다"를 보인다.
  it('1차 어댑터가 죽은 뒤 늦게 emit 해도 재시도 세션으로 새지 않는다', async () => {
    const { manager, handles, spawned } = setup()
    manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    expect(spawned).toHaveLength(2)

    await Promise.resolve() // doStart 의 catch 가 실제로 core.fail() 을 부르는 그 한 틱 늦은 시점처럼
    handles[0].emit({ type: 'error', message: 'stale: process ended' }) // 죽은 1차 어댑터의 뒤늦은 말

    expect(seen.some((e) => e.type === 'error')).toBe(false) // 구독이 끊겨 아무 데도 안 닿는다

    // 그 사이 재시도(handles[1]) 자신의 이벤트는 여전히 정상적으로 닿는다 — 끊은 건 1차뿐이다
    handles[1].emit({ type: 'status', status: 'working' })
    expect(seen.some((e) => e.type === 'status')).toBe(true)
  })

  // "말했다는 것"을 알려면 pane 이 열려 있어야 하는데, 롤링 재시작에서는 main 이 알림을 낼 때
  // renderer 가 아직 탭을 만드는 중이다 — 이벤트 스트림만으론 늦게 뜬 pane 이 못 본다. state() 가
  // 그 알림을 들고 있어야 한다(adapterCore.fail() 이 세우는 것과 같은 규칙: 알리는 게 아니라 기억).
  it('알림은 state() 에도 남아 늦게 뜬 pane 에도 닿는다', async () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    expect(spawned).toHaveLength(2)
    await flushPromises()

    expect(manager.state(info.id)?.notice).toBe('bypassed')

    // 다음 턴이 시작되면(send) 알림도 error 와 같은 자리에서 걷힌다
    await manager.send(info.id, 'hi')
    expect(manager.state(info.id)?.notice).toBeNull()
  })
})

describe('ChatSessionManager.adopt', () => {
  it('a good note gives a running info and an adapter in adopt mode', () => {
    const { manager, handles } = setup()
    const proc = new FakeProc()
    proc.outlivesApp = true
    const info = manager.adopt({
      id: 'sess-1',
      proc,
      restore: {
        accountId: codexAccount.id,
        cwd: 'D:/proj',
        title: 'proj',
        threadId: 'th-2',
        rolloutPath: 'D:/r.jsonl',
        bypassPermissions: true,
        answered: ['req-1', 'req-2']
      },
      truncated: true
    })
    expect(info).toMatchObject({
      id: 'sess-1',
      accountId: codexAccount.id,
      cwd: 'D:/proj',
      status: 'running',
      title: 'proj',
      kind: 'chat',
      threadId: 'th-2',
      // Both come straight out of the note: the bypass box the session was started with, and the
      // codex-side id the scheduler and the rollout watcher key on.
      bypassPermissions: true,
      resumeSessionId: 'th-2'
    })
    expect(handles.at(-1)?.mode).toEqual({
      mode: 'adopt',
      threadId: 'th-2',
      rolloutPath: 'D:/r.jsonl',
      truncated: true,
      // The requests the previous app answered, for the Claude adapter's replay guard (ruling S3-7).
      answered: ['req-1', 'req-2']
    })
    expect(manager.list().map((s) => s.id)).toContain('sess-1')
    // No provider in the note (a pre-Task-4 restart) — falls back to codex.
    expect(handles.at(-1)?.provider).toBe('codex')
    expect(manager.state('sess-1')?.provider).toBe('codex')
  })

  it('a note with provider: claude adopts as claude', () => {
    const { manager, handles } = setup()
    const info = manager.adopt({
      id: 'sess-4',
      proc: new FakeProc(),
      restore: {
        accountId: claudeAccount.id,
        cwd: 'D:/proj',
        title: 'proj',
        provider: 'claude',
        threadId: 'th-9'
      },
      truncated: false
    })
    expect(info).toMatchObject({ id: 'sess-4', accountId: claudeAccount.id })
    expect(handles.at(-1)?.provider).toBe('claude')
    expect(manager.state('sess-4')?.provider).toBe('claude')
  })

  it('an answered list that is not a list of ids is read as none, rather than handed on as it stands', () => {
    const { manager, handles } = setup()
    manager.adopt({
      id: 'sess-5',
      proc: new FakeProc(),
      restore: { accountId: claudeAccount.id, cwd: 'D:/proj', title: 'proj', provider: 'claude', answered: 'req-1' },
      truncated: false
    })
    expect(handles.at(-1)?.mode).toMatchObject({ answered: [] })
    manager.adopt({
      id: 'sess-6',
      proc: new FakeProc(),
      restore: { accountId: claudeAccount.id, cwd: 'D:/proj', title: 'proj', provider: 'claude', answered: ['req-1', 7] },
      truncated: false
    })
    expect(handles.at(-1)?.mode).toMatchObject({ answered: ['req-1'] })
  })

  it('a note with neither flag leaves them unset rather than guessing', () => {
    const { manager } = setup()
    const info = manager.adopt({
      id: 'sess-3',
      proc: new FakeProc(),
      restore: { accountId: codexAccount.id, cwd: 'D:/proj', title: 'proj' },
      truncated: false
    })
    expect(info?.bypassPermissions).toBeUndefined()
    expect(info?.resumeSessionId).toBeUndefined()
  })

  it('a note without cwd gives null', () => {
    const { manager } = setup()
    const proc = new FakeProc()
    const info = manager.adopt({
      id: 'sess-2',
      proc,
      restore: { accountId: codexAccount.id, title: 'proj' },
      truncated: false
    })
    expect(info).toBeNull()
    expect(manager.has('sess-2')).toBe(false)
  })

  it('a note without accountId or title also gives null', () => {
    const { manager } = setup()
    expect(manager.adopt({ id: 'x', proc: new FakeProc(), restore: { cwd: 'D:/p', title: 't' }, truncated: false })).toBeNull()
    expect(manager.adopt({ id: 'y', proc: new FakeProc(), restore: { accountId: 'a', cwd: 'D:/p' }, truncated: false })).toBeNull()
  })

  it('adopt restores slackNotify, rollAccountIds and rollPrompt from the note, and ignores malformed ones', () => {
    const { manager } = setup()
    const info = manager.adopt({
      id: 'x',
      proc: new FakeProc(),
      truncated: false,
      restore: { accountId: 'acc', cwd: 'D:/p', title: 't', provider: 'codex', slackNotify: true, rollAccountIds: ['a1', 7], rollPrompt: 'go' }
    })!
    expect(info.slackNotify).toBe(true)
    expect(info.rollPrompt).toBe('go')
    expect(info).not.toHaveProperty('rollAccountIds') // one non-string element: the whole chain is dropped, never guessed
    const clean = manager.adopt({
      id: 'y',
      proc: new FakeProc(),
      truncated: false,
      restore: { accountId: 'acc', cwd: 'D:/p', title: 't', provider: 'codex', rollAccountIds: ['a1', 'a2'] }
    })!
    expect(clean.rollAccountIds).toEqual(['a1', 'a2'])
    expect(clean).not.toHaveProperty('slackNotify')
  })
})

describe('runningAppOwned / runningOutlivingApp', () => {
  it('splits running sessions by proc.outlivesApp', () => {
    const { manager, spawned } = setup()
    const a = manager.spawn({ account: codexAccount, cwd: 'D:/a' })
    const b = manager.spawn({ account: codexAccount, cwd: 'D:/b' })
    spawned[0].proc.outlivesApp = true
    spawned[1].proc.outlivesApp = false
    expect(manager.runningOutlivingApp().map((s) => s.id)).toEqual([a.id])
    expect(manager.runningAppOwned().map((s) => s.id)).toEqual([b.id])
  })

  it('excludes exited sessions from both', () => {
    const { manager, handles, spawned } = setup()
    const a = manager.spawn({ account: codexAccount, cwd: 'D:/a' })
    // A line first — a line-less exit this fast is the death Task 7's bypass retry is for, and this
    // test is about running/exited bookkeeping, not that.
    spawned[0].proc.feed('{"jsonrpc":"2.0"}')
    handles[0].emit({ type: 'exit', code: 0, errorDetail: null })
    expect(manager.runningAppOwned().map((s) => s.id)).not.toContain(a.id)
    expect(manager.runningOutlivingApp().map((s) => s.id)).not.toContain(a.id)
  })
})

describe('rename / state / has / kill', () => {
  it('rename writes the note and returns the title', () => {
    const { manager, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    expect(manager.rename(info.id, 'New title')).toBe('New title')
    expect(spawned[0].proc.notes).toEqual([{ title: 'New title' }])
    expect(manager.info(info.id)?.title).toBe('New title')
  })

  it('rename on an unknown id returns null', () => {
    const { manager } = setup()
    expect(manager.rename('nope', 'x')).toBeNull()
  })

  it('state(id) reports outlivesApp from the proc, live', () => {
    const { manager, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    expect(manager.state(info.id)?.outlivesApp).toBe(false)
    spawned[0].proc.outlivesApp = true
    expect(manager.state(info.id)?.outlivesApp).toBe(true)
  })

  it('state(id) on an unknown id is null', () => {
    const { manager } = setup()
    expect(manager.state('nope')).toBeNull()
  })

  it('has(id) reflects whether the session exists', () => {
    const { manager } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    expect(manager.has(info.id)).toBe(true)
    expect(manager.has('nope')).toBe(false)
  })

  it('kill delegates to adapter.kill(); unknown id is a no-op', () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    manager.kill(info.id)
    expect(handles[0].killCalls).toBe(1)
    expect(() => manager.kill('nope')).not.toThrow()
  })
})

describe('command delegation', () => {
  it('send/interrupt/answer/setModel/setPlanMode/listModels reach the adapter for a known id', async () => {
    const { manager } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    await expect(manager.send(info.id, 'hi')).resolves.toBeUndefined()
    await expect(manager.interrupt(info.id)).resolves.toBeUndefined()
    const answer: ChatAnswer = { kind: 'approval', decision: 'accept' }
    await expect(manager.answer(info.id, 'req-1', answer)).resolves.toBeUndefined()
    await expect(manager.setModel(info.id, 'gpt-5', null)).resolves.toBeUndefined()
    await expect(manager.setPermissionMode(info.id, 'plan')).resolves.toBeUndefined()
    await expect(manager.listPermissionModes(info.id)).resolves.toEqual([])
    await expect(manager.listModels(info.id)).resolves.toEqual([])
  })

  it('command methods no-op for an unknown id rather than throw', async () => {
    const { manager } = setup()
    await expect(manager.send('nope', 'hi')).resolves.toBeUndefined()
    await expect(manager.interrupt('nope')).resolves.toBeUndefined()
    await expect(manager.listModels('nope')).resolves.toEqual([])
  })
})
