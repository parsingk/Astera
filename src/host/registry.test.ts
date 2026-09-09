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

  // The brief's requirement is that an exited session stops accepting commands, which is a different
  // branch from an id that was never here — and the one a careless simplification of `live` would
  // quietly drop.
  it('refuses commands for a session it still lists but that has exited', () => {
    const p = fakePty()
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.exit(0)
    p.sent.length = 0
    p.sizes.length = 0
    h.r.write('p1', 'too late')
    h.r.resize('p1', 10, 10)
    h.r.pause('p1')
    h.r.resume('p1')
    expect([p.sent, p.sizes, p.paused]).toEqual([[], [], 0])
    expect(h.r.list()).toHaveLength(1)
  })

  // The note is written at spawn and the app learns things about a session afterwards — its new
  // title, the rollout file a codex session turned out to write to. Merged, never replaced: each
  // caller knows one key and must not erase the ones the others wrote.
  it('merges a note into what it remembers, leaving the keys the patch does not name alone', () => {
    const h = registry()
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ kind: 'session', id: 'sess_1', restore: { accountId: 'acc_1', title: 'old' } }) })
    h.r.note('p1', { title: 'new' })
    h.r.note('p1', { rolloutPath: 'D:/r/one.jsonl' })
    expect(h.r.list()[0].meta).toEqual({
      kind: 'session',
      id: 'sess_1',
      restore: { accountId: 'acc_1', title: 'new', rolloutPath: 'D:/r/one.jsonl' }
    })
  })

  // The note the app already holds must not change under it: `list` hands out the meta object itself.
  it('does not rewrite a note it has already handed out', () => {
    const h = registry()
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ restore: { title: 'old' } }) })
    const before = h.r.list()[0].meta
    h.r.note('p1', { title: 'new' })
    expect(before?.restore).toEqual({ title: 'old' })
  })

  it('ignores a note for an id it does not have', () => {
    const h = registry()
    expect(() => h.r.note('nope', { title: 'new' })).not.toThrow()
    expect(h.r.list()).toEqual([])
  })

  // Same rule as every other message that names a pty. Nothing reads a dead entry's note either:
  // reattachSessions skips an entry that is not alive before it ever looks at one.
  it('ignores a note for a session it still lists but that has exited', () => {
    const p = fakePty()
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ restore: { title: 'old' } }) })
    p.exit(0)
    h.r.note('p1', { title: 'new' })
    expect(h.r.list()[0].meta?.restore).toEqual({ title: 'old' })
  })

  // Only the three managers spawn, and all three pass a note — but a patch cannot invent the kind and
  // the id a note needs, so with nothing to merge into there is nothing to do.
  it('ignores a note for a pty opened without one', () => {
    const h = registry()
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts })
    h.r.note('p1', { title: 'new' })
    expect(h.r.list()[0].meta).toBeNull()
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

  // The Host outlives the app, and a Run finishing every minute would otherwise leave a quarter of a
  // million characters behind each time. Nothing reads a dead session's scrollback: an app that was
  // attached already has the output, and one that was not is forbidden to attach to a dead entry.
  it('lets go of the scrollback when a session ends, but still lists it as gone', () => {
    const p = fakePty()
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('a lot of output')
    expect(h.r.buffer('p1')).not.toBe('')
    p.exit(0)
    expect(h.r.buffer('p1')).toBe('')
    expect(h.r.list()).toEqual([{ id: 'p1', pid: p.pid, meta: meta(), alive: false }])
  })

  // Measured on win32: node-pty's ConPTY kill runs a helper process to enumerate the console's
  // processes, and that helper fails with "AttachConsole failed" under ELECTRON_RUN_AS_NODE. The throw
  // reaches here. Before this guard it ended the loop, so the Host kept the rest of its sessions alive
  // and never reached the exit that follows killAll.
  it('kills the rest when one session refuses to die', () => {
    const bad = fakePty(1)
    bad.kill = () => {
      throw new Error('AttachConsole failed')
    }
    const good = fakePty(2)
    const queue = [bad, good]
    const logs: string[] = []
    const r = new PtyRegistry({ spawn: () => queue.shift() as RegistryPty, log: (m) => logs.push(m) })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    r.open({ id: 'p2', file: 'cmd.exe', args: [], opts, meta: meta() })
    expect(() => r.killAll()).not.toThrow()
    expect(good.killed).toBe(true)
    expect(logs.some((m) => m.includes('p1') && m.includes('AttachConsole'))).toBe(true)
  })

  it('a scrollback of zero keeps almost nothing, rather than turning the cap off', () => {
    const p = fakePty()
    const h = registry({ pty: p, scrollback: 0 })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('0123456789')
    expect(h.r.buffer('p1').length).toBeLessThanOrEqual(1)
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

  // The entry outlives the process, so the app can tell a session that ended while it was away from one
  // that was never here. What it does not outlive is the scrollback — see the release test below.
  it('keeps an exited session listed, not alive, and out of the live count', () => {
    const p = fakePty(77)
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ id: 'trm_9' }) })
    p.emit('goodbye')
    p.exit(0)
    expect(h.r.liveCount()).toBe(0)
    expect(h.r.list()).toEqual([{ id: 'p1', pid: 77, meta: meta({ id: 'trm_9' }), alive: false }])
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

  // node-pty's two argument forms are not interchangeable on win32 (the string form is a verbatim
  // command line that skips argv quoting; see core/run/shell.ts's shellSpawn) — so the registry must
  // pass whichever one it was given straight to spawn rather than converting between them.
  it('passes a string args — node-pty\'s verbatim command line form — to spawn unchanged', () => {
    let received: string[] | string | undefined
    const r = new PtyRegistry({
      spawn: (file, args) => {
        received = args
        return fakePty()
      },
      log: () => {}
    })
    r.open({ id: 'p1', file: 'cmd.exe', args: '/s /c "npm run build"', opts, meta: meta() })
    expect(received).toBe('/s /c "npm run build"')
  })
})
