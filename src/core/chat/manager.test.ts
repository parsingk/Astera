import { describe, it, expect } from 'vitest'
import path from 'node:path'
import type { Account, ScheduleConfig, SessionInfo } from '../types'
import type { Provider } from '../providers/meta'
import type { ProcFactory, ProcLike, ProcSpawnOptions } from '../sessions/proc'
import { makeDescriptors } from '../providers/descriptor'
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatState } from './types'
import { claudeLaunchArgs } from './claudeProtocol'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../sessions/pty'
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
 *  genuinely fail its handshake without also failing the retry that follows it.
 *
 *  `throwOnAdapterCall` throws synchronously on the Nth call (1-based) instead of building a handle —
 *  the counterpart to `setup`'s `throwOnSpawnCall`, but for `makeAdapter` throwing *after* the
 *  factory already spawned a real child (finding 4: the bypass retry's factory call succeeds, then
 *  `makeAdapter` throws, and the already-spawned child must not be left with no handle to kill it). */
function makeAdapterFactory(
  startRejects = false,
  sendRejects = false,
  startRejectsOnce = false,
  throwOnAdapterCall?: number
): {
  createAdapter: NonNullable<ChatManagerDeps['createAdapter']>
  handles: FakeAdapterHandle[]
} {
  const handles: FakeAdapterHandle[] = []
  const createAdapter: NonNullable<ChatManagerDeps['createAdapter']> = (a) => {
    if (throwOnAdapterCall !== undefined && handles.length + 1 === throwOnAdapterCall) {
      throw new Error('adapter blew up')
    }
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
  startRejectsOnce = false,
  throwOnAdapterCall?: number
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
  const { createAdapter, handles } = makeAdapterFactory(startRejects, sendRejects, startRejectsOnce, throwOnAdapterCall)
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

  // fix round 1 / Important 3: a roll respawn whose chain was already granted the toolchain bypass
  // (index.ts's own read of bypassedOf before the kill) inherits it here — never on a fresh, first
  // spawn (S7 still holds for that case; no test above passes startWithBypass and none of them get
  // VOLTA_BYPASS in their env).
  it('startWithBypass 가 있으면 첫 spawn 부터 BYPASS_ENV 를 얹고, note 와 durable 마크 둘 다 선다', () => {
    const { spawned, manager } = setup('win32')
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', startWithBypass: true })
    expect(spawned[0].opts.env.VOLTA_BYPASS).toBe('1')
    expect(spawned[0].opts.meta).toMatchObject({ restore: { bypassedToolchain: true } })
    expect(manager.state(info.id)?.bypassed).toBe(true)
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

// design F5: the automatic retry above is gone. The app no longer bypasses a toolchain manager on its
// own — S7 named the harm (the bypass variable rides every command the session ever spawns) and the
// automatic retry did the exact thing S7 forbade, one door over: it always set the variable on the
// second attempt, no matter what actually killed the first. What remains is narrower: the manager
// decides only whether the death *looks like* a refusal a person could choose to retry past, and the
// respawn itself never runs until they press the button and confirm (`retryWithBypass`, only ever
// called from ipc.ts's own handler for the renderer's confirmed click).
describe('ChatSessionManager — bypassOffer (design F5)', () => {
  // 두 조건이 모두 참일 때만 선다: 죽은 모양이 거절처럼 보이고(말없이 즉사), 우회할 관리자가 실제로
  // 있다는 증거가 있다(main 이 spawn 전에 확인해 넘긴 bypassSignal).
  it('말없이 즉사 + 관리자 탐지 → bypassOffer 가 서고, exit 이벤트에도 실린다', () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: 'error: Could not parse project manifest' })

    expect(manager.info(info.id)?.status).toBe('exited')
    expect(seen).toEqual([
      {
        type: 'exit',
        code: 8,
        errorDetail: 'error: Could not parse project manifest',
        bypassOffer: true,
        bypassSignal: 'path'
      }
    ])
    // state() 를 다시 불러도 — 탭을 전환해 pane 이 remount 되는 것과 같은 모양 — 같은 판정이 있다
    expect(manager.state(info.id)?.bypassOffer).toBe(true)
    expect(manager.state(info.id)?.bypassSignal).toBe('path')
  })

  // fix round 1 / Important 4: VOLTA_HOME 만 맞았을 때는 신호가 다르다 — 확신에 찬 문구를 쓸 근거가
  // 아니라는 것을 화면이 알아야 한다
  it('VOLTA_HOME 신호는 signal 을 voltaHome 으로 남긴다', () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'voltaHome' })
    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    expect(manager.state(info.id)?.bypassSignal).toBe('voltaHome')
  })

  // 근거 없이 짐작하지 않는다 — 죽은 모양이 같아도 관리자를 못 찾았으면 버튼을 내지 않는다. 눌러도
  // 아무 일도 안 나는 버튼을, 확신에 찬 문구와 함께 내는 것이 이 조건이 막는 것이다.
  it('죽은 모양은 같아도 관리자를 못 찾았으면 버튼을 내지 않는다', () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' }) // bypassSignal 없음
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })

    expect(seen).toEqual([{ type: 'exit', code: 8, errorDetail: null }]) // bypassOffer 칸 자체가 없다
    expect(manager.state(info.id)?.bypassOffer).toBeUndefined()
  })

  // 한 줄이라도 말했으면 실행은 된 것이다 — 관리자가 있어도 그 뒤의 죽음은 CLI 자신의 사정이다
  it('한 줄이라도 말한 뒤 죽으면 관리자가 있어도 버튼을 내지 않는다', () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })
    spawned[0].proc.feed('{"jsonrpc":"2.0"}')

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })

    expect(manager.state(info.id)?.bypassOffer).toBeUndefined()
  })

  // C3 의 이유가 여전히 맞다: 사람이 닫은 탭은 거절이 아니다 — 버튼을 내밀 이유가 없다
  it('kill() 로 인한 죽음은 관리자가 있어도 버튼을 내지 않는다', () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })

    manager.kill(info.id)
    handles[0].emit({ type: 'exit', code: 8, errorDetail: null }) // kill() 이 부른 그 죽음

    expect(manager.info(info.id)?.status).toBe('exited')
    expect(manager.state(info.id)?.bypassOffer).toBeUndefined()
  })

  // PTY_LOST_SIGHT_EXIT_CODE 는 "이 앱이 그 프로세스를 놓쳤다"이지 "그 프로세스가 끝났다"가 아니다
  // (procFactory.ts) — 버튼을 눌러 다시 띄우면 아직 살아 있을 수도 있는 첫 프로세스 옆에 두 번째가 뜬다
  it('PTY_LOST_SIGHT_EXIT_CODE 는 관리자가 있어도 버튼을 내지 않는다', () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })

    handles[0].emit({ type: 'exit', code: PTY_LOST_SIGHT_EXIT_CODE, errorDetail: null })

    expect(manager.state(info.id)?.bypassOffer).toBeUndefined()
  })

  // adopt() 된 세션은 다시 지을 재료(retry)가 없다 — 이미 떠 있던 프로세스를 이 앱이 나중에 찾은
  // 것뿐이라, 거절이라는 개념 자체가 성립하지 않는다
  it('adopt 된 세션은 죽은 모양이 같아도 버튼을 내지 않는다', () => {
    const { manager, handles } = setup()
    const info = manager.adopt({
      id: 'sess-adopted',
      proc: new FakeProc(),
      restore: { accountId: codexAccount.id, cwd: 'D:/proj', title: 'proj', provider: 'codex' },
      truncated: false
    })!

    handles.at(-1)!.emit({ type: 'exit', code: 8, errorDetail: null })

    expect(manager.state(info.id)?.bypassOffer).toBeUndefined()
  })

  // fix round 1 / Important 1: 우회를 얹고 뜬 시도가 또 말없이 즉사해도, 그 우회가 이미 고쳐주지
  // 못한 것이므로 같은 버튼을 다시 내면 안 된다 — 눌러도 이미 켜져 있는 것을 다시 켜는 것뿐이다.
  // 삭제한 '두 번은 없다' 테스트가 옛 attempt 카운터로 하던 일을 이제 이 durable bypassed 플래그가 한다.
  it('우회로 뜬 시도가 또 즉사해도 버튼을 다시 내지 않는다', () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })
    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    manager.retryWithBypass(info.id)

    // 재시도(handles[1]) 자신도 말없이 즉사한다
    handles[1].emit({ type: 'exit', code: 8, errorDetail: null })

    expect(manager.state(info.id)?.bypassOffer).toBeUndefined()
    // durable 마크는 이 실패에도 그대로 남는다 — 이 세션이 우회로 시작했다는 사실은 안 지워진다
    expect(manager.state(info.id)?.bypassed).toBe(true)
  })
})

// fix round 1 / Critical 2: notice 는 첫 status:'working' 에서 걷히지만, 이 durable 마크는 걷히지
// 않는다 — 세션이 사는 동안(그리고 죽은 뒤에도) 계속 남아, 나중에 이 세션의 결과를 읽는 사람에게
// "핀된 버전이 아니었다"를 계속 말한다.
describe('ChatSessionManager — durable bypassed 마크 (design F5 fix round 1 / Critical 2)', () => {
  it('우회로 뜬 시도는 spawn 되는 즉시 bypassed 가 서고, 턴이 지나도 지워지지 않는다', async () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })
    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    manager.retryWithBypass(info.id)

    // notice 가 오기도 전에 이미 서 있다 — respawnWithBypass 가 spawn 하는 순간 세운다
    expect(manager.state(info.id)?.bypassed).toBe(true)

    await flushPromises() // notice 가 오고, working 으로 넘어가도
    handles[1].emit({ type: 'status', status: 'working' })
    expect(manager.state(info.id)?.notice).toBeNull() // notice 는 걷혔지만
    expect(manager.state(info.id)?.bypassed).toBe(true) // durable 마크는 그대로다

    // 세션이 나중에 평범하게 끝나도(사유는 이 세션과 무관), 마크는 남는다 — 나중에 결과를 읽을 때
    // "이 세션은 핀된 버전이 아니었다"가 보여야 한다(design §4 F5)
    handles[1].emit({ type: 'exit', code: 0, errorDetail: null })
    expect(manager.state(info.id)?.bypassed).toBe(true)
  })

  // adopt() 는 재시작 뒤에도 이 사실을 note 에서 되읽는다 — 인메모리뿐 아니라 note 자체에도 적었기
  // 때문이다(respawnWithBypass 의 meta.restore.bypassedToolchain)
  it('재시작 뒤 adopt() 도 note 의 bypassedToolchain 을 읽어 되살린다', () => {
    const { manager } = setup()
    const info = manager.adopt({
      id: 'sess-1',
      proc: new FakeProc(),
      restore: { accountId: codexAccount.id, cwd: 'D:/proj', title: 'proj', provider: 'codex', bypassedToolchain: true },
      truncated: false
    })!
    expect(manager.state(info.id)?.bypassed).toBe(true)
  })

  it('note 에 bypassedToolchain 이 없으면(핀된 버전으로 뜬 평범한 세션) 마크도 없다', () => {
    const { manager } = setup()
    const info = manager.adopt({
      id: 'sess-2',
      proc: new FakeProc(),
      restore: { accountId: codexAccount.id, cwd: 'D:/proj', title: 'proj', provider: 'codex' },
      truncated: false
    })!
    expect(manager.state(info.id)?.bypassed).toBeUndefined()
  })
})

describe('ChatSessionManager.retryWithBypass (design F5)', () => {
  // 확인 창을 지나 사람이 누른 뒤에야 돈다 — 같은 세션 id 아래, 우회 env 를 얹어 다시 띄운다
  it('버튼이 서 있는 세션에서 부르면, 같은 id·cwd·meta·provider 로 우회 env 를 얹어 다시 띄운다', async () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: 'error: Could not parse project manifest' })
    expect(manager.info(info.id)?.status).toBe('exited')

    const retried = manager.retryWithBypass(info.id)

    expect(spawned).toHaveLength(2)
    expect(spawned[0].opts.env.VOLTA_BYPASS).toBeUndefined() // 첫 시도는 그대로 둔다 (S7)
    expect(spawned[1].opts.env.VOLTA_BYPASS).toBe('1')
    expect(spawned[1].opts.cwd).toBe(spawned[0].opts.cwd)
    // 같은 id — 탭·스케줄러·Slack·롤이 고아가 안 된다. meta 자체는 같지 않다: fix round 1 / Critical 2
    // 가 note 에 bypassedToolchain: true 를 얹는다(재시작 뒤 adopt() 가 다시 읽을 수 있도록) — 그
    // 한 칸만 다르고 나머지(id, restore 의 다른 필드)는 그대로다.
    expect(spawned[1].opts.meta).toEqual({ ...spawned[0].opts.meta, restore: { ...spawned[0].opts.meta!.restore, bypassedToolchain: true } })
    expect(handles[1].provider).toBe(handles[0].provider)

    // 세션은 다시 산다 — 탭이 옛 종료 배너를 계속 보이면 안 된다
    expect(retried?.status).toBe('running')
    expect(retried).not.toHaveProperty('exitCode')
    expect(manager.info(info.id)?.status).toBe('running')
    expect(manager.state(info.id)?.bypassOffer).toBeUndefined() // 새 시도엔 아직 아무 판정도 없다
    // fix round 1 / Critical 2: durable 마크는 재시도가 뜨는 즉시 선다 — notice 가 오기도 전이다
    expect(manager.state(info.id)?.bypassed).toBe(true)

    await flushPromises()
    // 재시도가 성공했다는 것은 반드시 말한다 — 우회가 사용자가 핀해 둔 것과 다른 버전을 띄웠을 수
    // 있어서다. error 가 아니라 그 자신의 이벤트로: 종료 배너가 이것을 사유로 오해하면 안 된다
    expect(seen.at(-1)).toEqual({ type: 'notice', key: 'bypassed' })
  })

  it('말없이 즉사해도 재시도가 성공하면 initialPrompt 를 그 재시도가 보낸다', async () => {
    // startRejectsOnce: 첫 시도의 handshake 가 끝내 완성되지 않는다 — 실제로 거절당한 CLI 의 모양과
    // 같다. false 로 두면 가짜 adapter 의 start() 가 (실제와 달리) exit 과 무관하게 성공해 버려
    // spawn() 자신의 이어달리기가 첫 시도에도 initialPrompt 를 보내 버린다.
    const { manager, handles, spawned } = setup('win32', false, false, undefined, true)
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path', initialPrompt: 'carry on' })

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    manager.retryWithBypass(info.id)
    expect(spawned).toHaveLength(2)

    await flushPromises()
    expect(handles[0].sent).toEqual([]) // 죽은 시도는 보낸 적이 없다
    expect(handles[1].sent).toEqual(['carry on']) // 재시도가 유일한 전달 채널
  })

  // 버튼이 서 있지 않은 세션(평범한 종료, 아직 exit 이 없는 세션, 모르는 id)에 부르면 아무 일도
  // 안 한다 — 확인 창을 지나지 않은 클릭이나 이미 재시도된 세션에 두 번째 우회를 얹으면 안 된다
  it('버튼이 서 있지 않으면 아무 일도 하지 않는다', () => {
    const { manager, handles, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' }) // 관리자 미탐지
    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })

    expect(manager.retryWithBypass(info.id)).toBeNull()
    expect(spawned).toHaveLength(1) // 재시도 spawn 없음
  })

  it('모르는 id 에는 아무 일도 하지 않는다', () => {
    const { manager, spawned } = setup()
    expect(manager.retryWithBypass('nope')).toBeNull()
    expect(spawned).toHaveLength(0)
  })

  // 성공한 재시도는 자신의 판정을 처음부터 다시 시작한다 — 재시도를 시작한 것 자체로 이미 새 시도가
  // 열렸고, 그 시도가 어떻게 죽을지는 아직 아무도 모른다
  it('재시도 자체는 즉시 bypassOffer 를 다시 false 로 돌린다', () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })
    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    expect(manager.state(info.id)?.bypassOffer).toBe(true)

    manager.retryWithBypass(info.id)
    expect(manager.state(info.id)?.bypassOffer).toBeUndefined()
  })

  // 재시도 자체가 던지면(factory 가 실패하면), 이미 보고된 원래 exit 을 대신할 것이 필요 없다 — F1/F2
  // 가 그 죽음을 즉시, 온전히 보고했으므로, 남는 일은 이 시도 자신의 실패를 로그하는 것뿐이다
  it('재시도의 factory 가 던지면 로그만 하고 세션은 exited 로 남는다', () => {
    const { manager, handles, spawned, logged } = setup('win32', false, false, 2) // 2번째 spawn(재시도)이 던진다
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })
    handles[0].emit({ type: 'exit', code: 8, errorDetail: 'first tail' })

    expect(manager.retryWithBypass(info.id)).toBeNull()
    expect(spawned).toHaveLength(1) // 재시도 spawn 은 던졌으니 배열에 없다
    expect(manager.info(info.id)?.status).toBe('exited')
    expect(manager.info(info.id)?.exitCode).toBe(8)
    expect(logged.some((m) => m.includes('chat bypass retry failed to start'))).toBe(true)
  })

  // Finding 4 (final review, carried over): factory 호출은 실제로 자식을 띄운 뒤에 makeAdapter 가
  // 던진다 — 그 자식이 맵에도 핸들에도 닿지 않는 고아로 남으면 안 된다
  it('재시도의 makeAdapter 가 던지면, 이미 뜬 우회 자식이 고아로 남지 않는다', () => {
    const { manager, handles, spawned, logged } = setup('win32', false, false, undefined, false, 2) // 2번째 adapter(재시도)가 던진다
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })
    handles[0].emit({ type: 'exit', code: 8, errorDetail: 'first tail' })

    expect(manager.retryWithBypass(info.id)).toBeNull()
    expect(spawned).toHaveLength(2) // 재시도의 factory 호출은 실제로 자식을 띄웠다
    expect(spawned[1].proc.killed).toBe(true) // ...하지만 makeAdapter 가 던졌으니 죽여서 고아로 안 남긴다
    expect(manager.info(info.id)?.status).toBe('exited')
    expect(logged.some((m) => m.includes('chat bypass retry failed to start'))).toBe(true)
  })

  // 죽은 시도의 구독을 끊지 않으면, 그 시도의 늦은(한 틱 뒤) emit 이 재시도 세션 아래에서 나온다 —
  // 실제 어댑터의 doStart catch 가 하는 일이 바로 이 모양이다(codexAdapter.ts / claudeAdapter.ts)
  it('재시도 뒤에는 죽은 시도의 늦은 emit 이 새 세션으로 새지 않는다', async () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })
    const seen: ChatEvent[] = []
    manager.subscribe((_id, e) => seen.push(e))

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    manager.retryWithBypass(info.id)

    await Promise.resolve() // 죽은 어댑터의 doStart catch 가 실제로 core.fail() 을 부르는 그 한 틱 늦은 시점처럼
    handles[0].emit({ type: 'error', message: 'stale: process ended' }) // 죽은 시도의 뒤늦은 말

    expect(seen.some((e) => e.type === 'error')).toBe(false) // 구독이 끊겨 아무 데도 안 닿는다

    // 그 사이 재시도(handles[1]) 자신의 이벤트는 여전히 정상적으로 닿는다 — 끊은 건 죽은 시도뿐이다
    handles[1].emit({ type: 'status', status: 'working' })
    expect(seen.some((e) => e.type === 'status')).toBe(true)
  })

  // "말했다는 것"을 알려면 pane 이 열려 있어야 하는데, 롤링 재시작에서는 main 이 알림을 낼 때 renderer
  // 가 아직 탭을 만드는 중이다 — 이벤트 스트림만으론 늦게 뜬 pane 이 못 본다. state() 가 그 알림을
  // 들고 있어야 한다(adapterCore.fail() 이 세우는 것과 같은 규칙: 알리는 게 아니라 기억).
  it('알림은 state() 에도 남아 늦게 뜬 pane 에도 닿는다', async () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    manager.retryWithBypass(info.id)
    await flushPromises()

    expect(manager.state(info.id)?.notice).toBe('bypassed')

    // 다음 턴이 시작되면(send) 알림도 error 와 같은 자리에서 걷힌다
    await manager.send(info.id, 'hi')
    expect(manager.state(info.id)?.notice).toBeNull()
  })

  // Finding 7 (final review, carried over): 재시도의 첫 프롬프트는 respawnWithBypass 가 adapter.send 를
  // 직접 부른다 — manager.send() 를 거치지 않는다. 그 경로에서 시작된 턴이 working 으로 넘어가는 것은
  // CLI 자신의 status 이벤트로 오므로, manager.send() 가 하는 것과 같은 지움을 handleEvent 자신이
  // status:'working' 에서 해야 한다 — 렌더러의 foldChatEvent 가 하는 것과 같은 규칙.
  it('working 상태가 되면(send() 를 거치지 않고도) 알림이 걷힌다', async () => {
    const { manager, handles } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj', bypassSignal: 'path' })

    handles[0].emit({ type: 'exit', code: 8, errorDetail: null })
    manager.retryWithBypass(info.id)
    await flushPromises()
    expect(manager.state(info.id)?.notice).toBe('bypassed')

    // manager.send() 가 아니라, CLI 자신이 낸 status 이벤트가 여기 온다 — respawnWithBypass 의
    // initialPrompt 전송이 바로 이 모양이다(adapter.send 를 직접 부른다)
    handles[1].emit({ type: 'status', status: 'working' })
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
