import { describe, it, expect, vi } from 'vitest'
import { reattachSessions } from './reattach'
import { PtyRegistry, type RegistryPty } from '../../host/registry'
import { createHostExits, ptyHeldBy } from '../../host/exits'
import { EXIT_DEFER_MS } from '../../core/orchestration/exec/exitOwner'
import type { PtyEntry } from '../../core/host/protocol'
import type { PtyLike } from '../../core/sessions/pty'
import type { ProcLike } from '../../core/sessions/proc'

const pty = (): PtyLike => ({ pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {} })
const proc = (): ProcLike => ({ pid: 1, onLine: () => {}, onExit: () => {}, write: () => {}, kill: () => {} })

const entry = (over: Partial<PtyEntry> = {}): PtyEntry => ({
  id: 'p1',
  pid: 10,
  meta: { kind: 'terminal', id: 'trm_1', restore: { projectPath: 'D:/p' } },
  alive: true,
  ...over
})

const procEntry = (over: Partial<PtyEntry> = {}): PtyEntry => ({
  id: 'p1',
  pid: 10,
  meta: { kind: 'chat', id: 'chat_1', restore: { accountId: 'a1' } },
  alive: true,
  ...over
})

const deps = (over: Partial<Parameters<typeof reattachSessions>[0]> = {}) => {
  const adopted: Array<[string, Record<string, unknown>]> = []
  const attached: string[] = []
  const killed: string[] = []
  const logs: string[] = []
  const attachedProcs: string[] = []
  const killedProcs: string[] = []
  const adoptedChats: Array<Record<string, unknown>> = []
  return {
    adopted, attached, killed, logs, attachedProcs, killedProcs, adoptedChats,
    d: {
      list: async () => [entry()],
      attach: (a: { id: string; pid: number }) => { attached.push(a.id); return pty() },
      sendAttach: (id: string) => { attached.push(`sent:${id}`) },
      kill: (id: string) => killed.push(id),
      listProcs: async () => [] as PtyEntry[],
      attachProc: (a: { id: string; pid: number }) => { attachedProcs.push(a.id); return proc() },
      sendAttachProc: (id: string) => { attachedProcs.push(`sent:${id}`) },
      killProc: (id: string) => killedProcs.push(id),
      adopters: {
        session: (a: { restore: Record<string, unknown> }) => { adopted.push(['session', a.restore]); return true },
        run: (a: { restore: Record<string, unknown> }) => { adopted.push(['run', a.restore]); return true },
        terminal: (a: { restore: Record<string, unknown> }) => { adopted.push(['terminal', a.restore]); return true },
        chat: (a: { restore: Record<string, unknown> }) => { adoptedChats.push(a.restore); return true }
      },
      heldLive: () => false,
      log: (m: string) => logs.push(m),
      ...over
    }
  }
}

describe('reattachSessions', () => {
  it('hands each entry to the manager its kind names, and asks the Host to replay', async () => {
    const h = deps()
    const res = await reattachSessions(h.d as never)
    expect(res).toEqual({
      adopted: 1,
      refused: 0,
      sessions: [],
      chats: []
    })
    // chatsUnknown is the caller's to set (ipc's sweep does it); reattachSessions itself never
    // produces one, so the shape here is pinned as undefined.
    expect(res.chatsUnknown).toBeUndefined()
    expect(h.adopted).toEqual([['terminal', { projectPath: 'D:/p' }]])
    expect(h.attached).toEqual(['p1', 'sent:p1'])
  })

  // The id survives the restart untouched (design §10, and Task 6's reversal of the fresh-id plan) —
  // Task 8 matches a Dispatch's stored sessionId straight against this list to tell a live
  // orchestration worker from a lost one.
  it('reports the id of every session it adopted', async () => {
    const h = deps({
      list: async () => [entry({ id: 'p9', meta: { kind: 'session', id: 'sess-old', restore: { accountId: 'a', cwd: 'D:/p', title: 't' } } })],
      adopters: {
        session: () => true,
        run: () => false,
        terminal: () => false
      }
    })
    const res = await reattachSessions(h.d as never)
    expect(res.sessions).toEqual(['sess-old'])
  })

  it('leaves a pty that has already exited alone', async () => {
    const h = deps({ list: async () => [entry({ alive: false })] })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 0, sessions: [], chats: [] })
    expect(h.adopted).toEqual([])
    expect(h.killed).toEqual([])
  })

  // A note this build cannot read leaves a process nobody owns. Killing it is the honest end.
  it('kills a pty whose note no manager can read', async () => {
    const h = deps({
      list: async () => [entry()],
      adopters: {
        session: () => false,
        run: () => false,
        terminal: () => false
      }
    })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 1, sessions: [], chats: [] })
    expect(h.killed).toEqual(['p1'])
    expect(h.logs.some((l) => l.includes('p1'))).toBe(true)
  })

  it('kills a pty with no note at all', async () => {
    const h = deps({ list: async () => [entry({ meta: null })] })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 1, sessions: [], chats: [] })
    expect(h.killed).toEqual(['p1'])
  })

  it('one refusal does not stop the rest', async () => {
    const h = deps({
      list: async () => [entry({ id: 'bad', meta: null }), entry({ id: 'good' })]
    })
    expect((await reattachSessions(h.d as never)).refused).toBe(1)
    expect(h.killed).toEqual(['bad'])
  })

  // The real adopters dereference `restore` unchecked — an entry whose note is present but malformed
  // throws instead of returning false, and that must not abort every entry after it in the list.
  it('contains a throw from one entry to a single refusal, and keeps adopting the rest', async () => {
    const h = deps({
      list: async () => [
        entry({ id: 'a' }),
        entry({ id: 'bad', meta: { kind: 'terminal', id: 'trm_bad', restore: {} } }),
        entry({ id: 'c' })
      ],
      adopters: {
        session: () => true,
        run: () => true,
        terminal: (a: { restore: Record<string, unknown> }) => {
          if (typeof a.restore.projectPath !== 'string') throw new TypeError('restore.projectPath is not a string')
          return true
        }
      }
    })
    const res = await reattachSessions(h.d as never)
    expect(res).toEqual({ adopted: 2, refused: 1, sessions: [], chats: [] })
    expect(h.killed).toEqual(['bad'])
  })

  // The wire is JSON that crossed a process boundary; a kind this build's union does not name (an
  // older or newer Host) must refuse the same as an unreadable note, not throw.
  it('kills a pty whose note names a kind no adopter recognizes', async () => {
    const h = deps({
      list: async () => [entry({ meta: { kind: 'bogus' as never, id: 'x', restore: {} } })]
    })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 1, sessions: [], chats: [] })
    expect(h.killed).toEqual(['p1'])
  })

  it('does not ask the Host to replay a refused entry, though it did attach a handle to try', async () => {
    const h = deps({
      list: async () => [entry()],
      adopters: {
        session: () => false,
        run: () => false,
        terminal: () => false
      }
    })
    await reattachSessions(h.d as never)
    expect(h.attached).toEqual(['p1'])
  })

  // A pty the app spawned between the handshake and the `pty-list` reply is in that reply, and the app
  // already has a live record and a working handle for it. Adopting it again would put a second handle
  // on one pty: every byte delivered twice, and two records racing to write to it.
  it('leaves alone a pty the app already holds live, without adopting or killing it', async () => {
    const h = deps({
      list: async () => [entry({ id: 'p2', meta: { kind: 'terminal', id: 'trm_new', restore: { projectPath: 'D:/p' } } })],
      heldLive: (a: { kind: string; id: string }) => a.id === 'trm_new'
    })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 0, sessions: [], chats: [] })
    expect(h.adopted).toEqual([])
    expect(h.killed).toEqual([])
    expect(h.attached).toEqual([]) // no second handle was even built
  })

  // Skipped is not lost. The boot cleanup reads this list to tell a live orchestration worker from one
  // it should write off, and a session the app is already running is as live as one it just took back.
  it('still reports a session it skipped as live', async () => {
    const h = deps({
      list: async () => [entry({ id: 'p3', meta: { kind: 'session', id: 'sess_mine', restore: { accountId: 'a', cwd: 'D:/p', title: 't' } } })],
      heldLive: () => true
    })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 0, sessions: ['sess_mine'], chats: [] })
  })
})

describe('reattachSessions — line processes', () => {
  it('adopts a chat note through the chat adopter, then asks for its replay, and lists it', async () => {
    const h = deps({ list: async () => [], listProcs: async () => [procEntry()] })
    const res = await reattachSessions(h.d as never)
    expect(h.adoptedChats).toEqual([{ accountId: 'a1' }])
    expect(h.attachedProcs).toEqual(['p1', 'sent:p1'])
    expect(res).toEqual({ adopted: 1, refused: 0, sessions: [], chats: ['chat_1'] })
  })
  it('kills a process with no note, or with a note that is not a chat, and counts the refusal', async () => {
    const h = deps({ list: async () => [], listProcs: async () => [procEntry({ meta: null }), procEntry({ id: 'p2', meta: { kind: 'session', id: 's', restore: {} } })] })
    const res = await reattachSessions(h.d as never)
    expect(h.killedProcs).toEqual(['p1', 'p2'])
    expect(res.refused).toBe(2)
  })
  it('a chat the app already holds live is left alone and still listed', async () => {
    const h = deps({ list: async () => [], listProcs: async () => [procEntry()], heldLive: (a: { kind: string; id: string }) => a.kind === 'chat' })
    const res = await reattachSessions(h.d as never)
    expect(h.attachedProcs).toEqual([])
    expect(res.chats).toEqual(['chat_1'])
  })
  it('an adopter that refuses, or throws, kills the process', async () => {
    const h = deps({ list: async () => [], listProcs: async () => [procEntry()] })
    h.d.adopters.chat = () => false
    expect((await reattachSessions(h.d as never)).refused).toBe(1)
    expect(h.killedProcs).toEqual(['p1'])

    const h2 = deps({ list: async () => [], listProcs: async () => [procEntry()] })
    h2.d.adopters.chat = () => {
      throw new Error('bad note')
    }
    expect((await reattachSessions(h2.d as never)).refused).toBe(1)
    expect(h2.killedProcs).toEqual(['p1'])
  })
  it('an exited process is neither adopted nor refused', async () => {
    const h = deps({ list: async () => [], listProcs: async () => [procEntry({ alive: false })] })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 0, sessions: [], chats: [] })
  })
  // Review Focus 2.
  it('defers a chat proc the Host is still starting: neither adopted nor killed, and counted as live', async () => {
    const chat = vi.fn(() => true)
    const h = deps({
      list: async () => [],
      listProcs: async () => [{ id: 'p9', pid: 1, alive: true, meta: { kind: 'chat', id: 'c9', restore: { hostStarting: true } } }],
      deferProc: (e: PtyEntry) => e.meta?.restore.hostStarting === true
    })
    h.d.adopters.chat = chat
    const r = await reattachSessions(h.d as never)
    expect(chat).not.toHaveBeenCalled()
    expect(h.killedProcs).toEqual([])
    expect(h.attachedProcs).toEqual([]) // no proc-attach: the Host stays the writer through its handshake
    expect(r.chats).toEqual(['c9'])
    expect(r.refused).toBe(0)
  })
  it('onlyProc takes back that one line process and lists no pty', async () => {
    const list = vi.fn(async () => [entry()])
    const chat = vi.fn((_a: { id: string }) => true)
    const h = deps({
      list,
      listProcs: async () => [
        { id: 'p1', pid: 1, alive: true, meta: { kind: 'chat', id: 'c1', restore: {} } },
        { id: 'p2', pid: 2, alive: true, meta: { kind: 'chat', id: 'c2', restore: {} } },
        { id: 'p3', pid: 3, alive: true, meta: null }
      ],
      onlyProc: 'p2'
    })
    h.d.adopters.chat = chat
    const r = await reattachSessions(h.d as never)
    expect(list).not.toHaveBeenCalled()
    expect(chat.mock.calls.map((c) => c[0].id)).toEqual(['c2'])
    expect(h.killedProcs).toEqual([]) // p3 is not this sweep's
    expect(r).toEqual({ adopted: 1, refused: 0, sessions: [], chats: ['c2'] })
  })
  it('without listProcs there is no proc sweep', async () => {
    const h = deps({ list: async () => [] })
    delete (h.d as { listProcs?: unknown }).listProcs
    expect((await reattachSessions(h.d as never)).chats).toEqual([])
  })
})

// Host S2 design §2.3: a `pty-opened` names one entry, and the sweep it starts takes back that one.
describe('reattachSessions — only the entry a pty-opened named', () => {
  const sessionEntry = (id: string, sessionId: string, over: Partial<PtyEntry> = {}): PtyEntry =>
    entry({ id, meta: { kind: 'session', id: sessionId, restore: { accountId: 'a', cwd: 'D:/p', title: 't' } }, ...over })

  it('with `only`, adopts that one entry and leaves every other entry alone', async () => {
    const adopted: string[] = []
    const h = deps({
      list: async () => [sessionEntry('p1', 'ses_1'), sessionEntry('p2', 'ses_2'), { id: 'p3', pid: 3, meta: null, alive: true }],
      only: 'p2',
      adopters: { ...deps().d.adopters, session: (a: { id: string }) => { adopted.push(a.id); return true } }
    })
    const r = await reattachSessions(h.d as never)
    expect(adopted).toEqual(['ses_2'])
    expect(h.killed).toEqual([]) // p3 has no note and is still not killed: it is not this sweep's
    expect(h.attached).toEqual(['p2', 'sent:p2'])
    expect(r).toEqual({ adopted: 1, refused: 0, sessions: ['ses_2'], chats: [] })
  })
  // §2.3: a pty-opened arriving while a sweep already adopted the same pty.
  it('with `only`, does not adopt again an entry the app already holds live', async () => {
    const adopted: string[] = []
    const h = deps({
      list: async () => [sessionEntry('p1', 'ses_1')],
      only: 'p1',
      heldLive: () => true,
      adopters: { ...deps().d.adopters, session: (a: { id: string }) => { adopted.push(a.id); return true } }
    })
    await reattachSessions(h.d as never)
    expect(adopted).toEqual([])
    expect(h.attached).toEqual([])
  })
  it('with `only`, skips an entry that has already exited', async () => {
    const h = deps({ list: async () => [sessionEntry('p1', 'ses_1', { alive: false })], only: 'p1' })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 0, sessions: [], chats: [] })
    expect(h.adopted).toEqual([])
    expect(h.killed).toEqual([])
  })
  it('with `only`, does not list line processes', async () => {
    const listProcs = vi.fn(async () => [procEntry()])
    const h = deps({ list: async () => [sessionEntry('p1', 'ses_1')], only: 'p1', listProcs })
    const r = await reattachSessions(h.d as never)
    expect(listProcs).not.toHaveBeenCalled()
    expect(r.chats).toEqual([])
  })
})

// Task 14, carried from Task 12's rules: after the app adopts a Host-spawned session, exactly one side
// handles its exit. The Host's exit owner and the app's sweep are wired to each other here the way
// the socket wires them: every `pty-attach` the sweep sends reaches `heldBy` through `ptyHeldBy`.
describe('reattachSessions — who handles the exit of a session the Host opened', () => {
  const hostWithOneSession = () => {
    let exitPty: (code: number) => void = () => {}
    const registry = new PtyRegistry({
      spawn: (): RegistryPty => ({
        pid: 7, onData: () => {}, onExit: (cb) => { exitPty = (code) => cb({ exitCode: code }) },
        write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {}
      }),
      log: () => {}
    })
    const hostHandled: string[] = []
    const exits = createHostExits({
      registry,
      sessionExited: async (e) => { hostHandled.push(e.sessionId) },
      orphanedSessions: () => [],
      log: () => {}
    })
    const r = registry.open({ id: 'p_host', file: 'claude', args: [], opts: { cwd: 'D:/p', cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: 'ses_host', restore: {} } })
    if (!r.ok) throw new Error(r.error)
    const APP_SOCKET = 3
    /** The app's sweep limited to the pty the push named, over the Host's real list. */
    const adopt = (onAppExit: (code: number) => void) =>
      reattachSessions({
        ...deps().d,
        list: async () => registry.list(),
        only: 'p_host',
        attach: () => ({ ...pty(), onExit: (cb: (e: { exitCode: number }) => void) => { const prev = exitPty; exitPty = (code) => { prev(code); cb({ exitCode: code }) } } }),
        sendAttach: (id: string) => {
          const held = ptyHeldBy({ t: 'pty-attach', id }, { greeted: true })
          if (held !== null) exits.heldBy(held, APP_SOCKET)
        },
        adopters: { ...deps().d.adopters, session: (a: { pty: PtyLike }) => { a.pty.onExit((e) => onAppExit(e.exitCode)); return true } }
      })
    return { exits, hostHandled, adopt, exit: (code: number) => exitPty(code) }
  }

  it("after adoption the exit is the app's alone: the Host leaves it", async () => {
    vi.useFakeTimers()
    try {
      const h = hostWithOneSession()
      const appHandled: number[] = []
      await h.adopt((code) => appHandled.push(code))
      h.exit(1)
      await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
      expect(appHandled).toEqual([1])
      expect(h.hostHandled).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
  it("an exit before adoption is the Host's alone: the sweep then finds it ended and adopts nothing", async () => {
    vi.useFakeTimers()
    try {
      const h = hostWithOneSession()
      h.exit(1)
      const appHandled: number[] = []
      const r = await h.adopt((code) => appHandled.push(code))
      await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
      expect(r.adopted).toBe(0)
      expect(appHandled).toEqual([])
      expect(h.hostHandled).toEqual(['ses_host'])
    } finally {
      vi.useRealTimers()
    }
  })
})
