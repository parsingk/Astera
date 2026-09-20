import { describe, it, expect } from 'vitest'
import path from 'node:path'
import type { Account, ScheduleConfig, SessionInfo } from '../../core/types'
import type { Provider } from '../../core/providers/meta'
import type { ProcFactory, ProcLike, ProcSpawnOptions } from '../../core/sessions/proc'
import { makeDescriptors } from '../../core/providers/descriptor'
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatState } from '../../core/chat/types'
import { claudeLaunchArgs } from '../../core/chat/claudeProtocol'
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
function makeAdapterFactory(startRejects = false, sendRejects = false): {
  createAdapter: NonNullable<ChatManagerDeps['createAdapter']>
  handles: FakeAdapterHandle[]
} {
  const handles: FakeAdapterHandle[] = []
  const createAdapter: NonNullable<ChatManagerDeps['createAdapter']> = (a) => {
    const listeners: Array<(e: ChatEvent) => void> = []
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
    const adapter: ChatAdapter = {
      start: (o) => {
        handle.startCalls.push(o)
        return startRejects ? Promise.reject(new Error('too old')) : Promise.resolve()
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

function setup(platform: NodeJS.Platform = 'win32', startRejects = false, sendRejects = false) {
  const spawned: Array<{ file: string; args: string[]; opts: ProcSpawnOptions; proc: FakeProc }> = []
  const factory: ProcFactory = (file, args, opts) => {
    const proc = new FakeProc()
    spawned.push({ file, args, opts, proc })
    return proc
  }
  const { createAdapter, handles } = makeAdapterFactory(startRejects, sendRejects)
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
    const { manager, handles } = setup()
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
    const { manager, handles } = setup()
    const a = manager.spawn({ account: codexAccount, cwd: 'D:/a' })
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
