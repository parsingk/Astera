import { describe, it, expect } from 'vitest'
import path from 'node:path'
import type { Account } from '../../core/types'
import type { ProcFactory, ProcLike, ProcSpawnOptions } from '../../core/sessions/proc'
import { makeDescriptors } from '../../core/providers/descriptor'
import type { ChatAdapter, ChatAnswer, ChatEvent, ChatState } from '../../core/chat/types'
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
  startCalls: Array<{ cwd: string; resumeThreadId?: string; bypass: boolean }>
  killCalls: number
  emit(e: ChatEvent): void
}

/** A fake adapter factory: one FakeAdapterHandle per session, in spawn/adopt call order. */
function makeAdapterFactory(): {
  createAdapter: NonNullable<ChatManagerDeps['createAdapter']>
  handles: FakeAdapterHandle[]
} {
  const handles: FakeAdapterHandle[] = []
  const createAdapter: NonNullable<ChatManagerDeps['createAdapter']> = (a) => {
    const listeners: Array<(e: ChatEvent) => void> = []
    const handle: FakeAdapterHandle = {
      mode: a.mode,
      startCalls: [],
      killCalls: 0,
      emit: (e) => {
        for (const fn of listeners) fn(e)
      }
    }
    handles.push(handle)
    const adapter: ChatAdapter = {
      start: (o) => {
        handle.startCalls.push(o)
        return Promise.resolve()
      },
      send: () => Promise.resolve(),
      interrupt: () => Promise.resolve(),
      answer: () => Promise.resolve(),
      setModel: () => Promise.resolve(),
      setPlanMode: () => Promise.resolve(),
      listModels: () => Promise.resolve([]),
      state: (): ChatState => ({
        status: 'idle',
        request: null,
        model: { model: null, effort: null, planMode: false },
        error: null,
        outlivesApp: a.proc.outlivesApp === true,
        truncated: a.mode.mode === 'adopt' ? a.mode.truncated : false
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

const claudeAccount: Account = {
  id: 'acc-cl',
  label: 'claude',
  configDir: 'C:\\Users\\tester\\.claude',
  color: '#fff',
  createdAt: '2026-07-29T00:00:00Z'
}

function setup(platform: NodeJS.Platform = 'win32') {
  const spawned: Array<{ file: string; args: string[]; opts: ProcSpawnOptions; proc: FakeProc }> = []
  const factory: ProcFactory = (file, args, opts) => {
    const proc = new FakeProc()
    spawned.push({ file, args, opts, proc })
    return proc
  }
  const { createAdapter, handles } = makeAdapterFactory()
  const descriptors = makeDescriptors(platform)
  const manager = new ChatSessionManager({
    factory,
    descriptors,
    homeDir: 'C:\\Users\\tester',
    platform,
    version: '1.0.0',
    log: () => {},
    createAdapter
  })
  return { spawned, manager, handles }
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
        bypassPermissions: false
      }
    })

    expect(handles).toHaveLength(1)
    expect(handles[0].mode).toEqual({ mode: 'fresh' })
    expect(handles[0].startCalls).toEqual([{ cwd: 'D:/proj', resumeThreadId: undefined, bypass: false }])

    expect(info.kind).toBe('chat')
    expect(info.status).toBe('running')
    expect(info.title).toBe('proj')
    expect(manager.list().map((s) => s.id)).toContain(info.id)
  })

  it('throws for a non-codex account', () => {
    const { manager } = setup()
    expect(() => manager.spawn({ account: claudeAccount, cwd: 'D:/proj' })).toThrow()
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
    handles[0].emit({ type: 'exit', code: 7 })

    const after = manager.info(info.id)
    expect(after?.threadId).toBe('th-1')
    expect(after?.resumeSessionId).toBe('th-1')
    expect(after?.status).toBe('exited')
    expect(after?.exitCode).toBe(7)
    expect(exits).toEqual([{ sessionId: info.id, exitCode: 7 }])
    expect(seen).toEqual([
      [info.id, { type: 'ready', threadId: 'th-1', rolloutPath: null }],
      [info.id, { type: 'exit', code: 7 }]
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
        rolloutPath: 'D:/r.jsonl'
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
      threadId: 'th-2'
    })
    expect(handles.at(-1)?.mode).toEqual({
      mode: 'adopt',
      threadId: 'th-2',
      rolloutPath: 'D:/r.jsonl',
      truncated: true
    })
    expect(manager.list().map((s) => s.id)).toContain('sess-1')
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
    handles[0].emit({ type: 'exit', code: 0 })
    expect(manager.runningAppOwned().map((s) => s.id)).not.toContain(a.id)
    expect(manager.runningOutlivingApp().map((s) => s.id)).not.toContain(a.id)
  })
})

describe('rename / remember / state / has / kill', () => {
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

  it('remember passes a patch to the proc', () => {
    const { manager, spawned } = setup()
    const info = manager.spawn({ account: codexAccount, cwd: 'D:/proj' })
    manager.remember(info.id, { rolloutPath: 'D:/r.jsonl' })
    expect(spawned[0].proc.notes).toEqual([{ rolloutPath: 'D:/r.jsonl' }])
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
    await expect(manager.setPlanMode(info.id, true)).resolves.toBeUndefined()
    await expect(manager.listModels(info.id)).resolves.toEqual([])
  })

  it('command methods no-op for an unknown id rather than throw', async () => {
    const { manager } = setup()
    await expect(manager.send('nope', 'hi')).resolves.toBeUndefined()
    await expect(manager.interrupt('nope')).resolves.toBeUndefined()
    await expect(manager.listModels('nope')).resolves.toEqual([])
  })
})
