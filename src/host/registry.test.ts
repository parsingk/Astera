import { describe, it, expect, vi } from 'vitest'
import { PtyRegistry, SCROLLBACK_CHARS, DEAD_ENTRIES_KEPT, EXITED_RETAIN_MS, EXITED_RINGS_MAX, EXITED_RING_BYTES_MAX, EXITED_TERMINAL_BYTES, type RegistryPty } from './registry'
import type { PtyMeta } from '../core/host/protocol'
import { RING_EVENT_COST } from './ptyRing'

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

  // `sessions read` renders the scrollback at the size the tab has — spawn says it, resize changes it.
  it('remembers the size a pty was opened at and the last size it was resized to', () => {
    const h = registry()
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    expect(h.r.size('p1')).toEqual({ cols: 80, rows: 24 })
    h.r.resize('p1', 100, 40)
    expect(h.r.size('p1')).toEqual({ cols: 100, rows: 40 })
    expect(h.r.size('nope')).toBe(null)
  })

  // `sessions list` judges a hook event against it (host/sessions.ts): input written after the event
  // is something the event cannot account for. Resizing is not input.
  it('remembers when a pty was last written to, and only for a write that reached it', () => {
    let clock = 1000
    const r = new PtyRegistry({ spawn: () => fakePty(), log: () => {}, now: () => clock })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    expect(r.lastWrite('p1')).toBe(null)
    r.write('p1', 'x')
    expect(r.lastWrite('p1')).toBe(1000)
    clock = 2000
    r.resize('p1', 100, 40)
    expect(r.lastWrite('p1')).toBe(1000)
    r.write('p1', '\r')
    expect(r.lastWrite('p1')).toBe(2000)
    r.write('nope', 'x')
    expect(r.lastWrite('nope')).toBe(null)
  })

  // The app's xterm writes its own reports into the pty — a focus change, the answer to a query the
  // agent's TUI sent. They reach the pty (the TUI asked for them), but nobody typed them.
  it('a write of only terminal reports reaches the pty but is not input; a keystroke is', () => {
    const esc = String.fromCharCode(27)
    let clock = 1000
    const p = fakePty()
    const r = new PtyRegistry({ spawn: () => p, log: () => {}, now: () => clock })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    r.write('p1', `${esc}[O`)
    r.write('p1', `${esc}[?12;40R`)
    expect(p.sent).toEqual([`${esc}[O`, `${esc}[?12;40R`])
    expect(r.lastWrite('p1')).toBe(null)
    r.write('p1', `${esc}[A`)
    expect(r.lastWrite('p1')).toBe(1000)
    clock = 2000
    r.write('p1', esc)
    expect(r.lastWrite('p1')).toBe(2000)
    clock = 3000
    r.write('p1', `${esc}[I`)
    expect(r.lastWrite('p1')).toBe(2000)
  })

  // 2026-10-02: a finished Run's sessions end once nobody has typed into them for a while
  // (dispatchLoop.ts, FINISHED_RUN_GRACE_MS). The Host's own writes (a nudge, a spawn's or a roll's
  // prompt) are input to the pty but not a person's, so only a write marked `person` moves this.
  it('only a write marked as a person’s moves lastPersonWrite, and terminal reports never do', () => {
    const esc = String.fromCharCode(27)
    let clock = 1000
    const r = new PtyRegistry({ spawn: () => fakePty(), log: () => {}, now: () => clock })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    r.write('p1', 'nudge\r')
    expect(r.lastWrite('p1')).toBe(1000)
    expect(r.lastPersonWrite('p1')).toBe(null)
    clock = 2000
    r.write('p1', 'x', { person: true })
    expect(r.lastPersonWrite('p1')).toBe(2000)
    clock = 3000
    r.write('p1', `${esc}[I`, { person: true })
    r.write('p1', 'prompt\r')
    expect(r.lastPersonWrite('p1')).toBe(2000)
    expect(r.lastPersonWrite('nope')).toBe(null)
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

  // The ring replaced the tail (remote runtime design §3.7): it keeps whole events, each costing its text plus
  // RING_EVENT_COST, and drops the oldest once over the bound.
  it('keeps the newest output and drops the oldest once the buffer is full', () => {
    const p = fakePty()
    const h = registry({ pty: p, scrollback: 2 * (7 + RING_EVENT_COST) - 1 })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('abcdefg')
    p.emit('hijklmn')
    expect(h.r.buffer('p1')).toBe('hijklmn')
    const q = fakePty()
    const roomy = registry({ pty: q, scrollback: 2 * (7 + RING_EVENT_COST) })
    roomy.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    q.emit('abcdefg')
    q.emit('hijklmn')
    expect(roomy.r.buffer('p1')).toBe('abcdefghijklmn')
  })

  it('keeps a single chunk larger than the whole buffer whole: output nobody has seen is not cut', () => {
    const p = fakePty()
    const h = registry({ pty: p, scrollback: 5 })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('0123456789')
    expect(h.r.buffer('p1')).toBe('0123456789')
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

  // ConPTY can deliver output after the exit. An ended entry is kept (a session for good), so output
  // that landed in its buffer then would be kept for the rest of the Host's life, with no reader.
  it('keeps no output that arrives after the exit, and still hands it to the listeners', () => {
    const p = fakePty()
    const h = registry({ pty: p })
    const heard: string[] = []
    h.r.onData((_, d) => heard.push(d))
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ kind: 'session', id: 'ses_1', restore: {} }) })
    p.emit('before')
    p.exit(0)
    p.emit('after')
    expect(h.r.buffer('p1')).toBe('')
    expect(heard).toEqual(['before', 'after'])
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

  it('a scrollback of zero keeps only the newest event, rather than turning the cap off', () => {
    const p = fakePty()
    const h = registry({ pty: p, scrollback: 0 })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('01234')
    p.emit('56789')
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

  // Measured on win32 (2026-10-01): node-pty 1.1.0's ConPTY kill calls ClosePseudoConsole on the same
  // handle every time it is called, and a second call on a pty still alive ended the Host with
  // STATUS_HEAP_CORRUPTION (0xC0000374), no log line, and every session it held with it. `runs stop`
  // reached it: its stop marks the slot pending, and the driving loop resent the stop 12 ms later.
  it('sends a live pty one kill, however often it is asked, and logs the repeats', () => {
    const p = fakePty()
    let kills = 0
    p.kill = () => { kills += 1 }
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    h.r.kill('p1')
    h.r.kill('p1')
    h.r.killAll()
    expect(kills).toBe(1)
    expect(h.logs.some((m) => m.includes('p1') && m.includes('already'))).toBe(true)
  })

  // A repeat means the one kill has not ended it. The process tree is ended instead (taskkill /T /F on
  // win32), which never touches the ConPTY handle; once, and never another pty kill.
  it('a repeat kill on a live pty ends its process tree once, and never sends the pty kill again', async () => {
    const p = fakePty(4321)
    let kills = 0
    p.kill = () => { kills += 1 }
    const trees: number[] = []
    const logs: string[] = []
    const r = new PtyRegistry({ spawn: () => p, log: (m) => logs.push(m), killTree: async (pid) => { trees.push(pid) } })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    r.kill('p1')
    expect(trees).toEqual([])
    r.kill('p1')
    r.kill('p1')
    await Promise.resolve()
    expect(kills).toBe(1)
    expect(trees).toEqual([4321])
    expect(logs.some((m) => m.includes('p1') && m.includes('4321') && m.includes('process tree'))).toBe(true)
  })

  it('a tree kill that fails is logged, not thrown', async () => {
    const p = fakePty(4321)
    const logs: string[] = []
    const r = new PtyRegistry({ spawn: () => p, log: (m) => logs.push(m), killTree: async () => { throw new Error('access denied') } })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    r.kill('p1')
    expect(() => r.kill('p1')).not.toThrow()
    await new Promise((res) => setTimeout(res, 0))
    expect(logs.some((m) => m.includes('p1') && m.includes('access denied'))).toBe(true)
  })

  it('a repeat kill on a pty that has exited does nothing', () => {
    const p = fakePty(4321)
    const trees: number[] = []
    const r = new PtyRegistry({ spawn: () => p, log: () => {}, killTree: async (pid) => { trees.push(pid) } })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    r.kill('p1')
    p.exit(1)
    r.kill('p1')
    expect(trees).toEqual([])
  })

  it('killAll kills a fresh pty exactly once and leaves one already sent its kill alone', () => {
    const a = fakePty(1)
    const b = fakePty(2)
    const kills = { a: 0, b: 0 }
    a.kill = () => { kills.a += 1 }
    b.kill = () => { kills.b += 1 }
    const trees: number[] = []
    const made = [a, b]
    let i = 0
    const r = new PtyRegistry({ spawn: () => made[i++], log: () => {}, killTree: async (pid) => { trees.push(pid) } })
    r.open({ id: 'p1', file: 'x', args: [], opts, meta: meta() })
    r.open({ id: 'p2', file: 'x', args: [], opts, meta: meta() })
    r.kill('p1')
    r.killAll()
    expect(kills).toEqual({ a: 1, b: 1 })
    expect(trees).toEqual([])
  })

  it('a kill that threw is not sent again either', () => {
    const p = fakePty()
    let kills = 0
    p.kill = () => {
      kills += 1
      throw new Error('AttachConsole failed')
    }
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    expect(() => h.r.kill('p1')).toThrow('AttachConsole failed')
    h.r.kill('p1')
    expect(kills).toBe(1)
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

// A worker that died a second after it started left nothing but a timestamp and an exit code the pty
// layer could not even supply, because the buffer is cleared on the next line and the Host is the
// only place it existed. The last screen is the difference between "it ended" and knowing why.
describe('the last screen of a session that ended badly', () => {
  it('logs the tail, stripped of escapes and on one line', () => {
    const p = fakePty()
    const { r, logs } = registry({ pty: p })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit("\u001b[31m'codex' is not recognized\u001b[0m\nas a command\n")
    p.exit(1)
    const line = logs.find((l) => l.includes('last screen'))
    expect(line).toBeDefined()
    expect(line).toContain("'codex' is not recognized")
    expect(line).not.toContain('\u001b')
    expect(line).not.toContain('\n')
  })

  // A session someone closed is the ordinary end of a session, and its screen is theirs, not the log's.
  it('says nothing for a clean exit', () => {
    const p = fakePty()
    const { r, logs } = registry({ pty: p })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('all done\n')
    p.exit(0)
    expect(logs.some((l) => l.includes('last screen'))).toBe(false)
  })

  it('says so when the session ended badly with nothing on screen', () => {
    const p = fakePty()
    const { r, logs } = registry({ pty: p })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.exit(1)
    expect(logs.some((l) => l.includes('last screen: (nothing)'))).toBe(true)
  })

  // F4: the Host's spawner subscribes beside attachPtyHost, and the second subscriber must not
  // silently disconnect the first.
  it('tells every subscriber, not only the last one', () => {
    const p = fakePty()
    const h = registry({ pty: p })
    const a: string[] = []; const b: string[] = []
    h.r.onData((_id, d) => a.push(d)); h.r.onData((_id, d) => b.push(d))
    const ea: number[] = []; const eb: number[] = []
    h.r.onExit((_id, c) => ea.push(c)); h.r.onExit((_id, c) => eb.push(c))
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    p.emit('x'); p.exit(2)
    expect([a, b, ea, eb]).toEqual([['x'], ['x'], [2], [2]])
  })
  it('finds a live session pty by the app id in its note', () => {
    const p = fakePty()
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ kind: 'session', id: 'ses_1', restore: {} }) })
    expect(h.r.sessionPty('ses_1')).toBe('p1')
    expect(h.r.sessionPty('ses_2')).toBeNull()
    expect(h.r.metaOf('p1')?.id).toBe('ses_1')
    p.exit(7)
    expect(h.r.sessionPty('ses_1')).toBeNull()
    expect(h.r.sessionExitCode('ses_1')).toEqual({ code: 7 })
  })
  it('does not answer a session lookup with a pty of another kind', () => {
    const h = registry()
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ kind: 'terminal', id: 'ses_1' }) })
    expect(h.r.sessionPty('ses_1')).toBeNull()
  })
  it('has no exit code for a session that is alive or was never here', () => {
    const h = registry()
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ kind: 'session', id: 'ses_1', restore: {} }) })
    expect(h.r.sessionExitCode('ses_1')).toBeNull()
    expect(h.r.sessionExitCode('nope')).toBeNull()
  })

  // I1: a listener that throws must not starve the ones after it, and must not escape into node-pty's
  // own event handler, where nothing catches it and the Host would exit with every pty it holds.
  it('keeps calling the other listeners when one throws, and lets nothing escape', () => {
    const p = fakePty()
    const h = registry({ pty: p })
    h.r.onData(() => { throw new Error('tap broke') })
    h.r.onExit(() => { throw new Error('exit tap broke') })
    const data: string[] = []; const exits: number[] = []
    h.r.onData((_id, d) => data.push(d))
    h.r.onExit((_id, c) => exits.push(c))
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta() })
    expect(() => { p.emit('x'); p.emit('y'); p.exit(2) }).not.toThrow()
    expect([data, exits]).toEqual([['x', 'y'], [2]])
    // Once per listener per kind: a tap that throws on every chunk must not flood the log.
    const dataLogs = h.logs.filter((l) => l.includes('tap broke') && !l.includes('exit tap'))
    const exitLogs = h.logs.filter((l) => l.includes('exit tap broke'))
    expect(dataLogs).toHaveLength(1)
    expect(exitLogs).toHaveLength(1)
    expect(dataLogs[0]).toContain('p1')
  })

  // I3: during a roll that keeps the session id the old pty can still be alive (a slow ConPTY kill)
  // when the new one opens. A command for the session belongs to the new one.
  it('answers a session lookup with the last-opened live pty', () => {
    const made = [fakePty(1), fakePty(2)]
    let i = 0
    const r = new PtyRegistry({ spawn: () => made[i++], log: () => {} })
    r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ kind: 'session', id: 'ses_1', restore: {} }) })
    r.open({ id: 'p2', file: 'cmd.exe', args: [], opts, meta: meta({ kind: 'session', id: 'ses_1', restore: {} }) })
    expect(r.sessionPty('ses_1')).toBe('p2')
    made[1].exit(0)
    expect(r.sessionPty('ses_1')).toBe('p1')
  })
  // M1: node-pty can deliver an exit with no code (the `exited undefined` lines). That session has
  // ended, and the answer must say so: the Host's handover closes an ended session and skips one it
  // never held (R3), so "ended with no code" cannot read like "never here".
  it('answers an ended session with no code as ended, not as never here', () => {
    const p = fakePty()
    const h = registry({ pty: p })
    h.r.open({ id: 'p1', file: 'cmd.exe', args: [], opts, meta: meta({ kind: 'session', id: 'ses_1', restore: {} }) })
    p.exit(undefined as unknown as number)
    expect(h.r.sessionExitCode('ses_1')).toEqual({ code: null })
    expect(h.r.sessionExitCode('nope')).toBeNull()
  })
})

// Host S3 R8 and the M4 carry: the Host judges "is this folder in use" from what its live ptys were
// opened in, and a Host that outlives many builds must not keep every one of them.
describe('what each live pty runs in, and how many ended ones are kept', () => {
  /** A registry whose ptys the test ends by id. */
  const rig = (): { reg: PtyRegistry; exit(id: string, code: number): void } => {
    const ptys = new Map<string, ReturnType<typeof fakePty>>()
    let opening = ''
    const reg = new PtyRegistry({
      spawn: () => {
        const p = fakePty()
        ptys.set(opening, p)
        return p
      },
      log: () => {}
    })
    const open = reg.open.bind(reg)
    reg.open = (a) => {
      opening = a.id
      return open(a)
    }
    return { reg, exit: (id, code) => ptys.get(id)!.exit(code) }
  }

  it('names the folder each live pty was opened in, and forgets it once it ends', () => {
    const { reg, exit } = rig()
    reg.open({ id: 'p1', file: 'x', args: [], opts: { cwd: 'D:/wt/a', cols: 80, rows: 24, env: {} }, meta: { kind: 'run', id: 'r1', restore: { configName: 'dev' } } })
    reg.open({ id: 'p2', file: 'x', args: [], opts: { cwd: 'D:/p', cols: 80, rows: 24, env: {} } })
    expect(reg.liveEntries()).toEqual([
      { id: 'p1', cwd: 'D:/wt/a', meta: { kind: 'run', id: 'r1', restore: { configName: 'dev' } } },
      { id: 'p2', cwd: 'D:/p', meta: null }
    ])
    exit('p1', 0)
    expect(reg.liveEntries().map((e) => e.id)).toEqual(['p2'])
  })

  // M4: a project that runs a build every minute must not grow the Host for the rest of its life.
  it('keeps only the newest ended entries that are not sessions, and every ended session', () => {
    const { reg, exit } = rig()
    const open = (id: string, kind: 'run' | 'session'): void => {
      reg.open({ id, file: 'x', args: [], opts: { cwd: 'D:/p', cols: 80, rows: 24, env: {} }, meta: { kind, id: `m_${id}`, restore: {} } })
    }
    open('s0', 'session')
    exit('s0', 1)
    // Live and older than every ended one: age alone never evicts.
    open('first', 'run')
    for (let i = 0; i < DEAD_ENTRIES_KEPT + 6; i++) {
      open(`r${i}`, 'run')
      exit(`r${i}`, 0)
    }
    open('live', 'run')
    const ids = reg.list().map((e) => e.id)
    expect(ids).toContain('s0')
    expect(ids).toContain('first')
    expect(ids).toContain('live')
    expect(ids.filter((id) => /^r\d+$/.test(id))).toHaveLength(DEAD_ENTRIES_KEPT)
    expect(ids).not.toContain('r0')
    expect(ids).not.toContain('r5')
    expect(ids).toContain('r6')
    expect(reg.sessionExitCode('m_s0')).toEqual({ code: 1 })
    // The pty that just ended is the newest ended one, so a late attach still hears its exit.
    expect(reg.exitCodeOf(`r${DEAD_ENTRIES_KEPT + 5}`)).toEqual({ code: 0 })
  })

  // Opening order is not ending order: a dev server opened at the Host's start that ends after a day
  // of builds is the newest ended entry, and a late pty-attach for it must still hear its exit.
  it('drops the entry that ended longest ago, not the one opened first', () => {
    const { reg, exit } = rig()
    const open = (id: string): void => {
      reg.open({ id, file: 'x', args: [], opts: { cwd: 'D:/p', cols: 80, rows: 24, env: {} }, meta: { kind: 'run', id: `m_${id}`, restore: {} } })
    }
    open('server')
    for (let i = 0; i < DEAD_ENTRIES_KEPT; i++) {
      open(`r${i}`)
      exit(`r${i}`, 0)
    }
    exit('server', 1)
    expect(reg.exitCodeOf('server')).toEqual({ code: 1 })
    expect(reg.exitCodeOf('r0')).toBeNull()
    expect(reg.list()).toHaveLength(DEAD_ENTRIES_KEPT)
  })

  it('keeps the cap the design fixed', () => {
    expect(DEAD_ENTRIES_KEPT).toBe(64)
  })
})

describe('PtyRegistry.onMeta (Slack in the Host, P7)', () => {
  it('tells a note at open and after each merge, and nothing for a pty with no note', () => {
    const { r } = registry()
    const heard: Array<[string, string, unknown]> = []
    r.onMeta((id, m, why) => heard.push([id, why, m.restore.title]))
    r.open({ id: 'p1', file: 'x', args: [], opts, meta: meta({ kind: 'session', id: 's1', restore: { title: 'a' } }) })
    r.open({ id: 'p2', file: 'x', args: [], opts })
    r.note('p1', { title: 'b' })
    r.note('p2', { title: 'c' })
    expect(heard).toEqual([['p1', 'open', 'a'], ['p1', 'note', 'b']])
  })
  it('isolates a listener that throws, logs it once, and unsubscribes', () => {
    const { r, logs } = registry()
    const heard: string[] = []
    r.onMeta(() => { throw new Error('boom') })
    const off = r.onMeta((id) => heard.push(id))
    r.open({ id: 'p1', file: 'x', args: [], opts, meta: meta() })
    r.note('p1', { x: 1 })
    expect(heard).toEqual(['p1', 'p1'])
    expect(logs.filter((l) => /a meta listener threw/.test(l))).toHaveLength(1)
    off()
    r.note('p1', { x: 2 })
    expect(heard).toEqual(['p1', 'p1'])
  })
})

// Remote runtime design §3.7 (N1, X1-02): every pty keeps a ring of seq'd events and a live terminal, and an exited one
// is still readable for 10 minutes within the exited budget.
describe('PtyRegistry ring, live terminal and replay (Phase 8)', () => {
  const made = (o: { now?: () => number; bootId?: string; exitedBudget?: { rings: number; bytes: number; terminal?: number } } = {}) => {
    const ptys: Array<ReturnType<typeof fakePty>> = []
    const r = new PtyRegistry({
      spawn: () => {
        const p = fakePty()
        ptys.push(p)
        return p
      },
      log: () => {},
      now: o.now,
      bootId: o.bootId ?? 'boot-a',
      ...(o.exitedBudget ? { exitedBudget: o.exitedBudget } : {})
    })
    return { r, ptys, open: (id: string) => (r.open({ id, file: 'sh', args: [], opts }), ptys[ptys.length - 1]) }
  }

  it('output, resize and exit are ring events in order, and onEvent hears each', () => {
    const { r, open } = made()
    const heard: string[] = []
    r.onEvent((id, e) => heard.push(`${id}:${e.seq}:${e.kind}`))
    const p = open('a')
    p.emit('hi')
    r.resize('a', 100, 30)
    p.exit(0)
    expect(heard).toEqual(['a:1:data', 'a:2:resize', 'a:3:exit'])
  })

  it('buffer keeps its meaning: the output while alive, empty once ended', () => {
    const { r, open } = made()
    const p = open('a')
    p.emit('hello ')
    p.emit('world')
    expect(r.buffer('a')).toBe('hello world')
    p.exit(0)
    expect(r.buffer('a')).toBe('')
  })

  it('a held fromSeq on the same boot replays the events and no gap', async () => {
    const { r, open } = made()
    const p = open('a')
    p.emit('one')
    p.emit('two')
    const got = await r.replayFrom('a', { fromSeq: 2, bootId: 'boot-a' })
    expect(got?.gap).toBeNull()
    expect(got?.checkpoint).toBeNull()
    expect(got?.events.map((e) => e.seq)).toEqual([2])
  })

  it('no fromSeq, an evicted one, or another boot gives a gap, a checkpoint and the events after its watermark', async () => {
    const { r, open } = made()
    const p = open('a')
    p.emit('one')
    p.emit('two')
    for (const ask of [{}, { fromSeq: 1, bootId: 'boot-b' }, { fromSeq: 99, bootId: 'boot-a' }]) {
      const got = await r.replayFrom('a', ask)
      expect(got?.gap).not.toBeNull()
      expect(got?.checkpoint?.watermark).toBe(2)
      expect(got?.events).toEqual([])
    }
  })

  it('output after the exit is still a ring event', () => {
    const { r, open } = made()
    const heard: string[] = []
    r.onEvent((_id, e) => heard.push(e.kind))
    const p = open('a')
    p.exit(1)
    p.emit('late')
    expect(heard).toEqual(['exit', 'data'])
  })

  it('an exited pty answers for 10 minutes, then is cleared', async () => {
    let t = 0
    const { r, open } = made({ now: () => t })
    const p = open('a')
    p.emit('bye')
    p.exit(0)
    t = EXITED_RETAIN_MS - 1
    r.sweepExited()
    expect(await r.replayFrom('a', {})).not.toBeNull()
    expect((await r.readScreen('a', 10))?.screen).toEqual(['bye'])
    t = EXITED_RETAIN_MS + 1
    r.sweepExited()
    expect(await r.replayFrom('a', {})).toBeNull()
    expect(await r.readScreen('a', 10)).toBeNull()
  })

  it('more exited rings than the budget allows clears the oldest first', async () => {
    let t = 0
    // Terminals counted at nothing here, so the count decides (the bytes are the next test's).
    const { r, open } = made({ now: () => t, exitedBudget: { rings: EXITED_RINGS_MAX, bytes: EXITED_RING_BYTES_MAX, terminal: 0 } })
    for (let i = 0; i <= EXITED_RINGS_MAX; i++) {
      t = i
      const p = open(`p${i}`)
      p.emit('x')
      p.exit(0)
    }
    expect(await r.replayFrom('p0', {})).toBeNull()
    expect(await r.replayFrom('p1', {})).not.toBeNull()
  })

  it('exited rings over the byte budget clear the oldest first', async () => {
    let t = 0
    // A small byte budget and a large count budget, so the bytes decide (EXITED_RING_BYTES_MAX in production).
    const ptys: Array<ReturnType<typeof fakePty>> = []
    const r = new PtyRegistry({ spawn: () => (ptys.push(fakePty()), ptys[ptys.length - 1]), log: () => {}, now: () => t, exitedBudget: { rings: 1000, bytes: 1_000_000, terminal: 0 } })
    const open = (id: string) => (r.open({ id, file: 'sh', args: [], opts }), ptys[ptys.length - 1])
    expect(EXITED_RING_BYTES_MAX).toBe(64 << 20)
    const big = 'z'.repeat(200_000)
    const n = Math.ceil(1_000_000 / (big.length * 2)) + 1
    for (let i = 0; i < n; i++) {
      t = i
      const p = open(`b${i}`)
      p.emit(big)
      p.exit(0)
    }
    expect(await r.replayFrom('b0', {})).toBeNull()
    expect(await r.replayFrom(`b${n - 1}`, {})).not.toBeNull()
  })
})

// Phase 8 review I2: output faster than the Host parses never ends the Host: the live terminal that lost its place is
// built again from the ring, and replays and reads go on.
describe('PtyRegistry under an output flood', () => {
  it('a flood does not throw out of the pty callback, and the pty still replays and reads', async () => {
    const p = fakePty()
    const r = new PtyRegistry({ spawn: () => p, log: () => {}, bootId: 'b' })
    r.open({ id: 'p1', file: 'sh', args: [], opts })
    const piece = 'x'.repeat(65_536)
    expect(() => {
      for (let i = 0; i < 800; i++) p.emit(piece)
    }).not.toThrow()
    p.emit('end of the flood')
    const replay = await r.replayFrom('p1', {})
    expect(replay?.checkpoint).not.toBeNull()
    const screen = await r.readScreen('p1', 10)
    expect(screen?.screen.join('')).toContain('end of the flood')
  }, 120_000)
})

// Phase 8 review I6: an exited pty keeps its live terminal (about 3.2 MiB, O5), so the exited budget counts it, and an
// idle Host clears exited ptys on time without anyone asking.
describe('PtyRegistry exited budget counts terminals, and clears on its own', () => {
  it('a terminal counts EXITED_TERMINAL_BYTES against the exited byte budget', async () => {
    let t = 0
    const ptys: Array<ReturnType<typeof fakePty>> = []
    const r = new PtyRegistry({ spawn: () => (ptys.push(fakePty()), ptys[ptys.length - 1]), log: () => {}, now: () => t })
    // Each exited pty: its terminal's estimate and its ring (the exit event, RING_EVENT_COST units of two bytes).
    const keep = Math.floor(EXITED_RING_BYTES_MAX / (EXITED_TERMINAL_BYTES + RING_EVENT_COST * 2))
    for (let i = 0; i < keep + 4; i++) {
      t = i
      r.open({ id: `p${i}`, file: 'sh', args: [], opts })
      ptys[ptys.length - 1].exit(0)
    }
    expect(r.exitedHeld()).toBe(keep)
    r.stopSweeping()
  })

  it('an idle Host clears an exited pty after EXITED_RETAIN_MS, and keeps no timer once none is held', async () => {
    vi.useFakeTimers()
    try {
      const p = fakePty()
      const r = new PtyRegistry({ spawn: () => p, log: () => {} })
      r.open({ id: 'p1', file: 'sh', args: [], opts })
      expect(vi.getTimerCount()).toBe(0)
      p.exit(0)
      expect(r.exitedHeld()).toBe(1)
      await vi.advanceTimersByTimeAsync(EXITED_RETAIN_MS + 60_000)
      expect(r.exitedHeld()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
