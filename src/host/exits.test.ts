import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { PtyRegistry, type RegistryPty } from './registry'
import { createHostExits, ENDED_WITHOUT_A_CODE, type HostExitsDeps } from './exits'
import { EXIT_DEFER_MS } from '../core/orchestration/exec/exitOwner'
import type { PtyMeta } from '../core/host/protocol'

/** A pty whose exit the test fires. */
function fakePty(): RegistryPty & { exit(code: number): void } {
  let onExit: (e: { exitCode: number }) => void = () => {}
  return {
    pid: 1,
    onData: () => {},
    onExit: (cb) => { onExit = cb },
    write: () => {},
    resize: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {},
    exit: (code) => onExit({ exitCode: code })
  }
}

const opts = { cwd: 'D:/p', cols: 80, rows: 24, env: {} }

/** A real registry over fake ptys, and the exit owner listening to it. */
const rig = (over: { sessionExited?: HostExitsDeps['sessionExited']; orphaned?: HostExitsDeps['orphanedSessions'] } = {}) => {
  const ptys = new Map<string, ReturnType<typeof fakePty>>()
  let opening = ''
  const registry = new PtyRegistry({
    spawn: () => {
      const p = fakePty()
      ptys.set(opening, p)
      return p
    },
    log: () => {}
  })
  const logs: string[] = []
  const exits = createHostExits({
    registry,
    sessionExited: over.sessionExited ?? (async () => {}),
    orphanedSessions: over.orphaned ?? (() => []),
    log: (m) => logs.push(m)
  })
  return {
    registry,
    exits,
    logs,
    open(id: string, meta: PtyMeta): void {
      opening = id
      const r = registry.open({ id, file: 'cmd.exe', args: [], opts, meta })
      if (!r.ok) throw new Error(r.error)
    },
    exit(id: string, code: number): void {
      ptys.get(id)!.exit(code)
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('createHostExits', () => {
  it('handles the exit of a session no app holds, after the defer', async () => {
    const exited: Array<{ sessionId: string; exitCode: number }> = []
    const h = rig({ sessionExited: async (e) => { exited.push(e) } })
    h.open('p1', { kind: 'session', id: 'ses_1', restore: {} })
    h.exit('p1', 1)
    expect(exited).toEqual([])
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(exited).toEqual([{ sessionId: 'ses_1', exitCode: 1 }])
  })

  it('leaves the exit of a session an app holds to that app', async () => {
    const exited: unknown[] = []
    const h = rig({ sessionExited: async (e) => { exited.push(e) } })
    h.open('p1', { kind: 'session', id: 'ses_1', restore: {} })
    h.exits.heldBy('p1', 7)
    h.exit('p1', 0)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS * 2)
    expect(exited).toEqual([])
  })

  it('ignores ptys that are not agent sessions', async () => {
    const exited: unknown[] = []
    const h = rig({ sessionExited: async (e) => { exited.push(e) } })
    h.open('p1', { kind: 'run', id: 'run_1', restore: {} })
    h.open('p2', { kind: 'terminal', id: 'trm_1', restore: {} })
    h.exit('p1', 1)
    h.exit('p2', 1)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS * 2)
    expect(exited).toEqual([])
  })

  // Review of Task 11, I3: a worker the Host spawned for a CLI call while the app is open is held by
  // nobody, because the app never sent a pty-spawn or pty-attach for it. The owner is whoever spawned
  // it, so the Host handles its exit even with an app attached.
  it('handles the exit of a session the Host spawned while an app is attached and holds others', async () => {
    const exited: unknown[] = []
    const h = rig({ sessionExited: async (e) => { exited.push(e) } })
    h.open('p_app', { kind: 'session', id: 'ses_app', restore: {} })
    h.exits.heldBy('p_app', 7)
    h.open('p_host', { kind: 'session', id: 'ses_host', restore: {} })
    h.exit('p_host', 2)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(exited).toEqual([{ sessionId: 'ses_host', exitCode: 2 }])
  })

  // §2.6: the exit that lands while the app is quitting inside its own defer.
  it('closes, at handover, a Dispatch whose session died while the app held it', async () => {
    const exited: unknown[] = []
    const h = rig({
      sessionExited: async (e) => { exited.push(e) },
      orphaned: (alive) => ['ses_1', 'ses_live', 'ses_never'].filter((s) => !alive(s))
    })
    h.open('p1', { kind: 'session', id: 'ses_1', restore: {} }); h.exits.heldBy('p1', 7)
    h.open('p2', { kind: 'session', id: 'ses_live', restore: {} }); h.exits.heldBy('p2', 7)
    h.exit('p1', 3) // held: the app should have handled it, and quit instead
    h.exits.appGone(7)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(exited).toEqual([{ sessionId: 'ses_1', exitCode: 3 }])
    expect(h.logs.join('\n')).toMatch(/ses_never/) // R3: never held here, skipped and said
  })

  // M1 of Tasks 6-8: a pty that ended with no code has ended. The handover closes it, and only a
  // session the registry never held is skipped.
  it('closes, at handover, a session whose pty ended with no code', async () => {
    const exited: unknown[] = []
    const h = rig({ sessionExited: async (e) => { exited.push(e) }, orphaned: (alive) => ['ses_1'].filter((s) => !alive(s)) })
    h.open('p1', { kind: 'session', id: 'ses_1', restore: {} }); h.exits.heldBy('p1', 7)
    h.exit('p1', undefined as unknown as number)
    h.exits.appGone(7)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(exited).toEqual([{ sessionId: 'ses_1', exitCode: ENDED_WITHOUT_A_CODE }])
  })

  it('hands on a pty with no code as the same ended-without-a-code value', async () => {
    const exited: unknown[] = []
    const h = rig({ sessionExited: async (e) => { exited.push(e) } })
    h.open('p1', { kind: 'session', id: 'ses_1', restore: {} })
    h.exit('p1', undefined as unknown as number)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(exited).toEqual([{ sessionId: 'ses_1', exitCode: ENDED_WITHOUT_A_CODE }])
  })

  it('keeps another app socket\'s marks when one app socket closes', async () => {
    const exited: unknown[] = []
    const h = rig({ sessionExited: async (e) => { exited.push(e) } })
    h.open('p1', { kind: 'session', id: 'ses_1', restore: {} }); h.exits.heldBy('p1', 7)
    h.open('p2', { kind: 'session', id: 'ses_2', restore: {} }); h.exits.heldBy('p2', 8)
    h.exits.appGone(7)
    h.exit('p2', 1)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS * 2)
    expect(exited).toEqual([])
  })

  // The CLI connects once per command, and its socket held nothing to hand over.
  it('runs no handover for a socket that never held a pty', async () => {
    const asked: number[] = []
    const h = rig({ orphaned: () => { asked.push(1); return [] } })
    h.exits.appGone(9)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(asked).toEqual([])
    h.open('p1', { kind: 'session', id: 'ses_1', restore: {} }); h.exits.heldBy('p1', 7)
    h.exits.appGone(7)
    h.exits.appGone(7) // a second close of the same socket number has nothing left to hand over
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(asked).toEqual([1])
  })

  it('handles a later exit of a session whose app socket has gone', async () => {
    const exited: unknown[] = []
    const h = rig({ sessionExited: async (e) => { exited.push(e) } })
    h.open('p1', { kind: 'session', id: 'ses_1', restore: {} }); h.exits.heldBy('p1', 7)
    h.exits.appGone(7)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    h.exit('p1', 1)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(exited).toEqual([{ sessionId: 'ses_1', exitCode: 1 }])
  })

  // Carried from Tasks 6-8: the deferred callbacks run outside any caller's try/catch, so a throw in
  // them would reach the event loop and take the Host down with every pty it holds.
  it('lets nothing thrown or rejected inside a deferred callback escape, and says so', async () => {
    const h = rig({
      sessionExited: () => { throw new Error('exit broke') },
      orphaned: () => { throw new Error('sweep broke') }
    })
    h.open('p1', { kind: 'session', id: 'ses_1', restore: {} })
    h.exit('p1', 1)
    h.open('p2', { kind: 'session', id: 'ses_2', restore: {} }); h.exits.heldBy('p2', 7)
    h.exits.appGone(7)
    await expect(vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)).resolves.not.toThrow()
    const rejecting = rig({ sessionExited: async () => { throw new Error('exit rejected') } })
    rejecting.open('p1', { kind: 'session', id: 'ses_1', restore: {} })
    rejecting.exit('p1', 1)
    await vi.advanceTimersByTimeAsync(EXIT_DEFER_MS)
    expect(h.logs.join('\n')).toMatch(/exit broke/)
    expect(h.logs.join('\n')).toMatch(/sweep broke/)
    expect(rejecting.logs.join('\n')).toMatch(/exit rejected/)
  })
})
