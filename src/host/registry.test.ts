import { describe, it, expect } from 'vitest'
import { PtyRegistry, SCROLLBACK_CHARS, type RegistryPty } from './registry'
import type { PtyMeta } from '../core/host/protocol'

const meta = (over: Partial<PtyMeta> = {}): PtyMeta => ({ kind: 'terminal', id: 'trm_1', restore: { projectPath: 'D:/p' }, ...over })

/** A pty that records what it was told and lets the test drive its callbacks. */
function fakePty(pid = 4242): RegistryPty & { sent: string[]; sizes: Array<[number, number]>; killed: boolean; paused: number; emit(d: string): void; exit(code: number): void } {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  return {
    pid,
    sent: [],
    sizes: [],
    killed: false,
    paused: 0,
    onData: (cb) => { onData = cb },
    onExit: (cb) => { onExit = cb },
    write(d) { this.sent.push(d) },
    resize(c, r) { this.sizes.push([c, r]) },
    kill() { this.killed = true },
    pause() { this.paused += 1 },
    resume() { this.paused -= 1 },
    emit: (d) => onData(d),
    exit: (code) => onExit({ exitCode: code })
  }
}

const registry = (over: { pty?: RegistryPty; scrollback?: number } = {}): { r: PtyRegistry; logs: string[]; made: RegistryPty[] } => {
  const logs: string[] = []
  const made: RegistryPty[] = []
  const r = new PtyRegistry({
    spawn: () => {
      const p = over.pty ?? fakePty()
      made.push(p)
      return p
    },
    log: (m) => logs.push(m),
    scrollback: over.scrollback
  })
  return { r, logs, made }
}

const opts = { cwd: 'D:/p', cols: 80, rows: 24, env: {} }

describe('PtyRegistry', () => {
  it('opens a session and reports the pid the pty gave it', () => {
    const h = registry()
    expect(h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })).toEqual({ ok: true, pid: 4242 })
    expect(h.r.liveCount()).toBe(1)
  })

  it('refuses a second open on the same id rather than losing the first pty', () => {
    const h = registry()
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    const again = h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    expect(again).toEqual({ ok: false, error: 'a session with id p1 is already open' })
    expect(h.made).toHaveLength(1)
  })

  it('turns a spawn that throws into a refusal', () => {
    const logs: string[] = []
    const r = new PtyRegistry({ spawn: () => { throw new Error('conpty said no') }, log: (m) => logs.push(m) })
    const res = r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    expect(res).toMatchObject({ ok: false })
    expect((res as { error: string }).error).toContain('conpty said no')
    expect(r.liveCount()).toBe(0)
  })

  it('forwards write, resize, kill, pause and resume to the pty', () => {
    const p = fakePty()
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    h.r.write('p1', 'ls\r')
    h.r.resize('p1', 100, 40)
    h.r.pause('p1')
    h.r.resume('p1')
    h.r.kill('p1')
    expect(p.sent).toEqual(['ls\r'])
    expect(p.sizes).toEqual([[100, 40]])
    expect(p.paused).toBe(0)
    expect(p.killed).toBe(true)
  })

  // A message for a session that has gone is ordinary, not exceptional: the app may have sent it
  // before it learned the pty exited.
  it('ignores every command for an id it does not have', () => {
    const h = registry()
    expect(() => {
      h.r.write('nope', 'x')
      h.r.resize('nope', 1, 1)
      h.r.pause('nope')
      h.r.resume('nope')
      h.r.kill('nope')
    }).not.toThrow()
    expect(h.r.buffer('nope')).toBe('')
  })

  it('keeps the newest output and drops the oldest once the buffer is full', () => {
    const p = fakePty()
    const h = registry({ pty: p, scrollback: 10 })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('abcdefg')
    p.emit('hijklmn')
    expect(h.r.buffer('p1')).toBe('efghijklmn')
    expect(h.r.buffer('p1')).toHaveLength(10)
  })

  it('survives a single chunk larger than the whole buffer', () => {
    const p = fakePty()
    const h = registry({ pty: p, scrollback: 5 })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('0123456789')
    expect(h.r.buffer('p1')).toBe('56789')
  })

  it('reports data and exit to its subscriber, with the id', () => {
    const p = fakePty(77)
    const h = registry({ pty: p })
    const data: Array<[string, string]> = []
    const exits: Array<[string, number]> = []
    h.r.onData((id, d) => data.push([id, d]))
    h.r.onExit((id, code) => exits.push([id, code]))
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('hello')
    p.exit(3)
    expect(data).toEqual([['p1', 'hello']])
    expect(exits).toEqual([['p1', 3]])
  })

  // The entry outlives the process so the app can still read the last output and see how it ended.
  it('keeps an exited session listed, not alive, with its buffer', () => {
    const p = fakePty(77)
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ id: 'trm_9' }) })
    p.emit('goodbye')
    p.exit(0)
    expect(h.r.liveCount()).toBe(0)
    expect(h.r.list()).toEqual([{ id: 'p1', pid: 77, meta: meta({ id: 'trm_9' }), alive: false }])
    expect(h.r.buffer('p1')).toBe('goodbye')
  })

  it('killAll ends every live pty', () => {
    const a = fakePty(1)
    const b = fakePty(2)
    const made = [a, b]
    let i = 0
    const r = new PtyRegistry({ spawn: () => made[i++], log: () => {} })
    r.open({ id: 'p1', file: 'x', args: [], opts, meta: meta() })
    r.open({ id: 'p2', file: 'x', args: [], opts, meta: meta() })
    r.killAll()
    expect([a.killed, b.killed]).toEqual([true, true])
  })

  it('the default scrollback is the one the design fixed', () => {
    expect(SCROLLBACK_CHARS).toBe(256_000)
  })
})
