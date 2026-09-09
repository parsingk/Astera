import { describe, it, expect } from 'vitest'
import { createHostPtyFactory, type HostPtyTransport } from './ptyFactory'
import type { ClientMessage, HostMessage } from '../../core/host/protocol'

/** A transport the test drives from both ends. */
const transport = (): HostPtyTransport & { sent: ClientMessage[]; deliver(m: HostMessage): void; hostGone(): void } => {
  const subs = new Set<(m: HostMessage) => void>()
  const gone = new Set<() => void>()
  return {
    sent: [],
    send(m) { this.sent.push(m) },
    onHostMessage(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    onHostGone(cb) {
      gone.add(cb)
      return () => gone.delete(cb)
    },
    deliver: (m) => { for (const cb of [...subs]) cb(m) },
    hostGone: () => { for (const cb of [...gone]) cb() }
  }
}

const opts = { cwd: 'D:/p', cols: 80, rows: 24, env: {} }
const spawned = (t: ReturnType<typeof transport>): string => (t.sent.find((m) => m.t === 'pty-spawn') as { id: string }).id

describe('createHostPtyFactory', () => {
  it('asks the Host to spawn and hands back a handle at once', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', ['/k'], opts)
    expect(p.pid).toBe(0)
    const msg = t.sent[0] as Extract<ClientMessage, { t: 'pty-spawn' }>
    expect(msg).toMatchObject({ t: 'pty-spawn', file: 'cmd.exe', args: ['/k'], opts })
    expect(msg.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('carries meta through when the caller gave one', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    factory('cmd.exe', [], { ...opts, meta: { kind: 'terminal', id: 'trm_1', restore: { projectPath: 'D:/p' } } })
    expect((t.sent[0] as Extract<ClientMessage, { t: 'pty-spawn' }>).meta).toEqual({
      kind: 'terminal',
      id: 'trm_1',
      restore: { projectPath: 'D:/p' }
    })
  })

  // pid is read in exactly one place in this repository, RunManager's tree-kill, long after the
  // spawn — which is what lets the factory stay synchronous (slice 2 design §3).
  it('fills the pid in when the Host answers', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    t.deliver({ t: 'pty-spawned', id: spawned(t), pid: 4321 })
    expect(p.pid).toBe(4321)
  })

  it('queues what was written before the Host answered, in order', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    p.write('one')
    p.resize(100, 40)
    p.write('two')
    expect(t.sent.filter((m) => m.t !== 'pty-spawn')).toEqual([])
    t.deliver({ t: 'pty-spawned', id: spawned(t), pid: 1 })
    expect(t.sent.slice(1)).toEqual([
      { t: 'pty-write', id: spawned(t), data: 'one' },
      { t: 'pty-resize', id: spawned(t), cols: 100, rows: 40 },
      { t: 'pty-write', id: spawned(t), data: 'two' }
    ])
  })

  it('sends straight through once the pty is live', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    t.deliver({ t: 'pty-spawned', id: spawned(t), pid: 1 })
    p.write('after')
    expect(t.sent.at(-1)).toEqual({ t: 'pty-write', id: spawned(t), data: 'after' })
  })

  it('passes data and exit to the handle, and only for its own id', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    const id = spawned(t)
    const data: string[] = []
    let exit: number | null = null
    p.onData((d) => data.push(d))
    p.onExit((e) => { exit = e.exitCode })
    t.deliver({ t: 'pty-spawned', id, pid: 1 })
    t.deliver({ t: 'pty-data', id: 'someone-else', data: 'not mine' })
    t.deliver({ t: 'pty-data', id, data: 'mine' })
    t.deliver({ t: 'pty-exit', id, exitCode: 7 })
    expect(data).toEqual(['mine'])
    expect(exit).toBe(7)
  })

  // A refused spawn has to look like a session that died immediately, because that is a shape every
  // caller already handles.
  it('turns a refused spawn into an exit', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    let exit: number | null = null
    p.onExit((e) => { exit = e.exitCode })
    t.deliver({ t: 'pty-failed', id: spawned(t), error: 'conpty said no' })
    expect(exit).toBe(1)
  })

  it('drops what is written after the pty exited rather than sending it', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    const id = spawned(t)
    t.deliver({ t: 'pty-spawned', id, pid: 1 })
    t.deliver({ t: 'pty-exit', id, exitCode: 0 })
    const before = t.sent.length
    p.write('too late')
    p.resize(1, 1)
    expect(t.sent).toHaveLength(before)
  })

  it('forwards pause and resume, which is how the app throttles a pty it no longer owns', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    const id = spawned(t)
    t.deliver({ t: 'pty-spawned', id, pid: 1 })
    p.pause()
    p.resume()
    expect(t.sent.slice(-2)).toEqual([
      { t: 'pty-pause', id },
      { t: 'pty-resume', id }
    ])
  })

  // Nothing says "your pty died" when the Host itself dies, so the handle has to say it. Otherwise
  // the session stays running in the app for as long as the app does.
  it('ends every handle when the Host goes away', () => {
    const t = transport()
    const { factory } = createHostPtyFactory(t)
    const p = factory('cmd.exe', [], opts)
    let exit: number | null = null
    p.onExit((e) => { exit = e.exitCode })
    t.deliver({ t: 'pty-spawned', id: spawned(t), pid: 1 })
    t.hostGone()
    expect(exit).toBe(-1)
    const before = t.sent.length
    p.write('nowhere to go')
    expect(t.sent).toHaveLength(before)
  })

  // Adoption after a restart: the pty is already there, so the handle starts live with its pid and
  // nothing queued.
  it('attach gives a live handle for a pty that already exists', () => {
    const t = transport()
    const { attach } = createHostPtyFactory(t)
    const p = attach({ id: 'p9', pid: 555 })
    expect(p.pid).toBe(555)
    p.write('hello')
    expect(t.sent).toEqual([{ t: 'pty-write', id: 'p9', data: 'hello' }])
  })
})
