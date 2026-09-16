import { describe, it, expect } from 'vitest'
import { createHostProcFactory } from './procFactory'
import type { HostPtyTransport } from './ptyFactory'
import type { ClientMessage, HostMessage } from '../../core/host/protocol'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../core/sessions/pty'

const transport = (): HostPtyTransport & { sent: ClientMessage[]; connected: boolean; logs: string[]; deliver(m: HostMessage): void; hostGone(): void } => {
  const subs = new Set<(m: HostMessage) => void>()
  const gone = new Set<() => void>()
  return {
    sent: [],
    connected: true,
    logs: [],
    send(m) {
      if (!this.connected) return false
      this.sent.push(m)
      return true
    },
    onHostMessage(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    onHostGone(cb) {
      gone.add(cb)
      return () => gone.delete(cb)
    },
    log(m) {
      this.logs.push(m)
    },
    deliver: (m) => { for (const cb of [...subs]) cb(m) },
    hostGone: () => { for (const cb of [...gone]) cb() }
  }
}

const opts = { cwd: 'D:/p', env: {}, meta: { kind: 'chat' as const, id: 'chat_1', restore: {} } }
const spawnedId = (t: ReturnType<typeof transport>): string => (t.sent.find((m) => m.t === 'proc-spawn') as { id: string }).id

describe('createHostProcFactory', () => {
  it('asks the Host to spawn, with the note, and hands back a handle at once with pid 0', () => {
    const t = transport()
    const p = createHostProcFactory(t).factory('codex', ['app-server'], opts)
    expect(p.pid).toBe(0)
    expect(t.sent[0]).toMatchObject({ t: 'proc-spawn', file: 'codex', args: ['app-server'], opts: { cwd: 'D:/p', env: {} }, meta: opts.meta })
  })
  it('queues writes until proc-spawned, then flushes them in order and takes the pid', () => {
    const t = transport()
    const p = createHostProcFactory(t).factory('codex', [], opts)
    p.write('one')
    p.write('two')
    expect(t.sent.filter((m) => m.t === 'proc-write')).toEqual([])
    t.deliver({ t: 'proc-spawned', id: spawnedId(t), pid: 77 })
    expect(p.pid).toBe(77)
    expect(t.sent.filter((m) => m.t === 'proc-write')).toEqual([
      { t: 'proc-write', id: spawnedId(t), line: 'one' },
      { t: 'proc-write', id: spawnedId(t), line: 'two' }
    ])
    p.write('three')
    expect(t.sent.at(-1)).toEqual({ t: 'proc-write', id: spawnedId(t), line: 'three' })
  })
  it('delivers lines for its own id only and ends on proc-exit', () => {
    const t = transport()
    const p = createHostProcFactory(t).factory('codex', [], opts)
    const lines: string[] = []
    let exit: number | null = null
    p.onLine((l) => lines.push(l))
    p.onExit((e) => { exit = e.exitCode })
    const id = spawnedId(t)
    t.deliver({ t: 'proc-spawned', id, pid: 1 })
    t.deliver({ t: 'proc-line', id, seq: 1, line: 'a' })
    t.deliver({ t: 'proc-line', id: 'other', seq: 1, line: 'b' })
    t.deliver({ t: 'proc-exit', id, exitCode: 4 })
    expect(lines).toEqual(['a'])
    expect(exit).toBe(4)
    p.write('after')
    expect(t.sent.some((m) => m.t === 'proc-write' && m.line === 'after')).toBe(false)
  })
  it('a refused spawn ends the handle with code 1', () => {
    const t = transport()
    const p = createHostProcFactory(t).factory('codex', [], opts)
    let exit: number | null = null
    p.onExit((e) => { exit = e.exitCode })
    t.deliver({ t: 'proc-failed', id: spawnedId(t), error: 'nope' })
    expect(exit).toBe(1)
  })
  it('a spawn that never left the app ends on the next microtask with code 1', async () => {
    const t = transport()
    t.connected = false
    const p = createHostProcFactory(t).factory('codex', [], opts)
    let exit: number | null = null
    p.onExit((e) => { exit = e.exitCode })
    await Promise.resolve()
    expect(exit).toBe(1)
  })
  it('the connection going away ends a live handle with the lost-sight code', () => {
    const t = transport()
    const p = createHostProcFactory(t).factory('codex', [], opts)
    let exit: number | null = null
    p.onExit((e) => { exit = e.exitCode })
    t.deliver({ t: 'proc-spawned', id: spawnedId(t), pid: 1 })
    t.hostGone()
    expect(exit).toBe(PTY_LOST_SIGHT_EXIT_CODE)
  })
  it('kill and remember go out at once, even while pending, and not after exit', () => {
    const t = transport()
    const p = createHostProcFactory(t).factory('codex', [], opts)
    const id = spawnedId(t)
    p.remember?.({ threadId: 't1' })
    p.kill()
    expect(t.sent.slice(1)).toEqual([{ t: 'proc-note', id, patch: { threadId: 't1' } }, { t: 'proc-kill', id }])
    t.deliver({ t: 'proc-exit', id, exitCode: 0 })
    p.kill()
    expect(t.sent.filter((m) => m.t === 'proc-kill')).toHaveLength(1)
  })
  it('a spawned handle drops a line whose seq it has already delivered', () => {
    const t = transport()
    const p = createHostProcFactory(t).factory('codex', [], opts)
    const id = spawnedId(t)
    const got: string[] = []
    p.onLine((l) => got.push(l))
    t.deliver({ t: 'proc-spawned', id, pid: 7 })
    t.deliver({ t: 'proc-line', id, seq: 1, line: 'a' })
    t.deliver({ t: 'proc-line', id, seq: 1, line: 'a' })
    t.deliver({ t: 'proc-line', id, seq: 2, line: 'b' })
    expect(got).toEqual(['a', 'b'])
  })
  it('an attached handle holds live lines until proc-attached, then delivers the replay, then the held lines it has not seen, in seq order', () => {
    const t = transport()
    const p = createHostProcFactory(t).attach({ id: 'p9', pid: 7 })
    const got: string[] = []
    p.onLine((l) => got.push(l))
    t.deliver({ t: 'proc-line', id: 'p9', seq: 3, line: 'c-live' }) // landed between our proc-attach and the Host reading it
    t.deliver({ t: 'proc-line', id: 'p9', seq: 4, line: 'd-live' })
    expect(got).toEqual([])
    t.deliver({ t: 'proc-attached', id: 'p9', lines: [{ seq: 1, line: 'a' }, { seq: 2, line: 'b' }, { seq: 3, line: 'c-live' }] })
    expect(got).toEqual(['a', 'b', 'c-live', 'd-live'])
    t.deliver({ t: 'proc-line', id: 'p9', seq: 4, line: 'd-live' })
    t.deliver({ t: 'proc-line', id: 'p9', seq: 5, line: 'e' })
    expect(got).toEqual(['a', 'b', 'c-live', 'd-live', 'e'])
  })
  it('an attached handle whose process exits before the replay lands ignores the late replay', () => {
    const t = transport()
    const p = createHostProcFactory(t).attach({ id: 'p9', pid: 7 })
    const got: string[] = []
    let exit = -1
    p.onLine((l) => got.push(l))
    p.onExit((e) => { exit = e.exitCode })
    t.deliver({ t: 'proc-exit', id: 'p9', exitCode: 0 })
    expect(exit).toBe(0)
    t.deliver({ t: 'proc-attached', id: 'p9', lines: [{ seq: 1, line: 'a' }] })
    expect(got).toEqual([]) // an exited handle delivers nothing more — the buffer went with the process anyway
  })
  it('attach hands back a live handle with the given pid, marked as outliving the app', () => {
    const t = transport()
    const p = createHostProcFactory(t).attach({ id: 'p9', pid: 9 })
    expect(p.pid).toBe(9)
    expect(p.outlivesApp).toBe(true)
    p.write('x')
    expect(t.sent).toEqual([{ t: 'proc-write', id: 'p9', line: 'x' }])
  })
})
