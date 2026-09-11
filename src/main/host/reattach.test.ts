import { describe, it, expect } from 'vitest'
import { reattachSessions } from './reattach'
import type { PtyEntry } from '../../core/host/protocol'
import type { PtyLike } from '../../core/sessions/pty'

const pty = (): PtyLike => ({ pid: 1, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {}, pause: () => {}, resume: () => {} })

const entry = (over: Partial<PtyEntry> = {}): PtyEntry => ({
  id: 'p1',
  pid: 10,
  meta: { kind: 'terminal', id: 'trm_1', restore: { projectPath: 'D:/p' } },
  alive: true,
  ...over
})

const deps = (over: Partial<Parameters<typeof reattachSessions>[0]> = {}) => {
  const adopted: Array<[string, Record<string, unknown>]> = []
  const attached: string[] = []
  const killed: string[] = []
  const logs: string[] = []
  return {
    adopted, attached, killed, logs,
    d: {
      list: async () => [entry()],
      attach: (a: { id: string; pid: number }) => { attached.push(a.id); return pty() },
      sendAttach: (id: string) => { attached.push(`sent:${id}`) },
      kill: (id: string) => killed.push(id),
      adopters: {
        session: (a: { restore: Record<string, unknown> }) => { adopted.push(['session', a.restore]); return true },
        run: (a: { restore: Record<string, unknown> }) => { adopted.push(['run', a.restore]); return true },
        terminal: (a: { restore: Record<string, unknown> }) => { adopted.push(['terminal', a.restore]); return true }
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
    expect(await reattachSessions(h.d as never)).toEqual({
      adopted: 1,
      refused: 0,
      sessions: []
    })
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
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 0, sessions: [] })
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
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 1, sessions: [] })
    expect(h.killed).toEqual(['p1'])
    expect(h.logs.some((l) => l.includes('p1'))).toBe(true)
  })

  it('kills a pty with no note at all', async () => {
    const h = deps({ list: async () => [entry({ meta: null })] })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 1, sessions: [] })
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
    expect(res).toEqual({ adopted: 2, refused: 1, sessions: [] })
    expect(h.killed).toEqual(['bad'])
  })

  // The wire is JSON that crossed a process boundary; a kind this build's union does not name (an
  // older or newer Host) must refuse the same as an unreadable note, not throw.
  it('kills a pty whose note names a kind no adopter recognizes', async () => {
    const h = deps({
      list: async () => [entry({ meta: { kind: 'bogus' as never, id: 'x', restore: {} } })]
    })
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 1, sessions: [] })
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
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 0, sessions: [] })
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
    expect(await reattachSessions(h.d as never)).toEqual({ adopted: 0, refused: 0, sessions: ['sess_mine'] })
  })
})
