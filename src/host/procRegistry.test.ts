import { describe, it, expect } from 'vitest'
import { ProcRegistry, PROC_BUFFER_CHARS, DEAD_ENTRIES_KEPT, type RegistryProc } from './procRegistry'
import type { PtyMeta } from '../core/host/protocol'

const meta = (over: Partial<PtyMeta> = {}): PtyMeta => ({ kind: 'chat', id: 'chat_1', restore: { accountId: 'a1' }, ...over })

/** A process that records what it was told and lets the test drive its output and exit. */
function fakeProc(pid = 4242): RegistryProc & { sent: string[]; killed: boolean; emit(chunk: string): void; exit(code: number): void } {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  return {
    pid,
    sent: [],
    killed: false,
    onData: (cb) => { onData = cb },
    onExit: (cb) => { onExit = cb },
    write(d) { this.sent.push(d) },
    kill() { this.killed = true },
    emit: (d) => onData(d),
    exit: (code) => onExit({ exitCode: code })
  }
}

const harness = (over: { bufferChars?: number; spawnThrows?: boolean } = {}) => {
  const procs: ReturnType<typeof fakeProc>[] = []
  const logs: string[] = []
  const lines: Array<[string, number, string]> = []
  const exits: Array<[string, number]> = []
  const registry = new ProcRegistry({
    spawn: () => {
      if (over.spawnThrows) throw new Error('ENOENT')
      const p = fakeProc(100 + procs.length)
      procs.push(p)
      return p
    },
    log: (m) => logs.push(m),
    bufferChars: over.bufferChars
  })
  registry.onLine((id, seq, line) => lines.push([id, seq, line]))
  registry.onExit((id, code) => exits.push([id, code]))
  const open = (id = 'p1', m: PtyMeta | null = meta()) =>
    registry.open({ id, file: 'codex', args: ['app-server'], opts: { cwd: 'D:/p', env: {} }, meta: m ?? undefined })
  return { registry, procs, logs, lines, exits, open }
}

describe('ProcRegistry — open', () => {
  it('spawns, reports the pid, and lists the entry alive with its note', () => {
    const h = harness()
    expect(h.open()).toEqual({ ok: true, pid: 100 })
    expect(h.registry.list()).toEqual([{ id: 'p1', pid: 100, meta: meta(), alive: true, truncated: false }])
    expect(h.registry.liveCount()).toBe(1)
    expect(h.logs.some((l) => l.includes('proc p1 started, pid 100'))).toBe(true)
  })
  it('refuses a second open with the same id', () => {
    const h = harness()
    h.open()
    expect(h.open()).toEqual({ ok: false, error: 'a process with id p1 is already open' })
    expect(h.procs).toHaveLength(1)
  })
  it('reports a spawn that throws', () => {
    const h = harness({ spawnThrows: true })
    expect(h.open()).toEqual({ ok: false, error: 'Error: ENOENT' })
    expect(h.registry.list()).toEqual([])
  })
})

describe('ProcRegistry — lines', () => {
  it('delivers complete lines, keeps a partial one across chunks, strips \\r', () => {
    const h = harness()
    h.open()
    h.procs[0].emit('{"a":1}\r\n{"b"')
    h.procs[0].emit(':2}\n')
    expect(h.lines).toEqual([['p1', 1, '{"a":1}'], ['p1', 2, '{"b":2}']])
    expect(h.registry.buffer('p1')).toEqual([{ seq: 1, line: '{"a":1}' }, { seq: 2, line: '{"b":2}' }])
  })
  it('write appends exactly one newline', () => {
    const h = harness()
    h.open()
    h.registry.write('p1', '{"method":"initialize"}')
    expect(h.procs[0].sent).toEqual(['{"method":"initialize"}\n'])
  })
  it('a write to an unknown or exited id is a no-op', () => {
    const h = harness()
    h.open()
    h.procs[0].exit(0)
    h.registry.write('p1', 'x')
    h.registry.write('nope', 'x')
    expect(h.procs[0].sent).toEqual([])
  })
})

describe('ProcRegistry — the buffer', () => {
  it('keeps whole lines up to the cap, dropping the oldest, and says so', () => {
    const h = harness({ bufferChars: 12 })
    h.open()
    h.procs[0].emit('aaaa\nbbbb\n') // 5 + 5 = 10 ≤ 12
    expect(h.registry.buffer('p1')).toEqual([{ seq: 1, line: 'aaaa' }, { seq: 2, line: 'bbbb' }])
    expect(h.registry.list()[0].truncated).toBe(false)
    h.procs[0].emit('cccc\n') // 15 > 12 → drop 'aaaa'
    expect(h.registry.buffer('p1')).toEqual([{ seq: 2, line: 'bbbb' }, { seq: 3, line: 'cccc' }])
    expect(h.registry.list()[0].truncated).toBe(true)
  })
  it('stamps every line with a seq from 1 and keeps the seq with the line, also past a drop', () => {
    const h = harness({ bufferChars: 12 })
    h.registry.open({ id: 'p1', file: 'x', args: [], opts: { cwd: '.', env: {} } })
    h.procs[0].emit('aaaa\nbbbb\ncccc\n')
    expect(h.lines.map(([, seq, line]) => [seq, line])).toEqual([[1, 'aaaa'], [2, 'bbbb'], [3, 'cccc']])
    // 'aaaa' was dropped by the cap (5 + 5 + 5 > 12); the seqs of what stays are untouched.
    expect(h.registry.buffer('p1')).toEqual([{ seq: 2, line: 'bbbb' }, { seq: 3, line: 'cccc' }])
    expect(h.registry.list()[0].truncated).toBe(true)
  })
  it('never drops the only line, however long', () => {
    const h = harness({ bufferChars: 4 })
    h.open()
    h.procs[0].emit('a-very-long-line\n')
    expect(h.registry.buffer('p1')).toEqual([{ seq: 1, line: 'a-very-long-line' }])
  })
  it('the default cap is one million characters', () => {
    expect(PROC_BUFFER_CHARS).toBe(1_000_000)
  })
  it('buffer is empty for an unknown id', () => {
    expect(harness().registry.buffer('nope')).toEqual([])
  })
})

describe('ProcRegistry — exit', () => {
  it('flushes a last line without newline, marks the entry dead, drops the buffer, reports the code', () => {
    const h = harness()
    h.open()
    h.procs[0].emit('done\nlast')
    h.procs[0].exit(3)
    expect(h.lines).toEqual([['p1', 1, 'done'], ['p1', 2, 'last']])
    expect(h.exits).toEqual([['p1', 3]])
    expect(h.registry.list()[0].alive).toBe(false)
    expect(h.registry.buffer('p1')).toEqual([])
    expect(h.registry.liveCount()).toBe(0)
    expect(h.logs.some((l) => l.includes('proc p1 exited 3'))).toBe(true)
  })

  // The exit can come from the grace timer while a grandchild still holds stdout (nodeProc.ts), so
  // lines can keep arriving for an ended entry, and an ended chat is kept for good.
  it('keeps no line that arrives after the exit, and still reports it', () => {
    const h = harness()
    h.open()
    h.procs[0].exit(0)
    h.procs[0].emit(['late', 'later', ''].join(String.fromCharCode(10)))
    expect(h.registry.buffer('p1')).toEqual([])
    expect(h.lines).toEqual([['p1', 1, 'late'], ['p1', 2, 'later']])
  })
})

describe('ProcRegistry — notes, kill, killAll', () => {
  it('merges a note patch into a live entry and ignores one for an exited or noteless entry', () => {
    const h = harness()
    h.open()
    h.registry.note('p1', { threadId: 'thr_1' })
    expect(h.registry.list()[0].meta?.restore).toEqual({ accountId: 'a1', threadId: 'thr_1' })
    h.open('p2', null)
    h.registry.note('p2', { x: 1 })
    expect(h.registry.list()[1].meta).toBeNull()
    h.procs[0].exit(0)
    h.registry.note('p1', { late: true })
    expect(h.registry.list()[0].meta?.restore).toEqual({ accountId: 'a1', threadId: 'thr_1' })
  })
  it('kill reaches a live process only', () => {
    const h = harness()
    h.open()
    h.registry.kill('p1')
    expect(h.procs[0].killed).toBe(true)
    h.registry.kill('nope')
  })
  it('killAll kills every live process and survives one that throws', () => {
    const h = harness()
    h.open('p1')
    h.open('p2')
    h.procs[0].kill = () => { throw new Error('nope') }
    h.registry.killAll()
    expect(h.procs[1].killed).toBe(true)
    expect(h.logs.some((l) => l.includes('proc p1 could not be killed'))).toBe(true)
  })
})

// Host S3 R8 and the M4 carry, for line processes: the same two questions PtyRegistry answers.
describe('ProcRegistry — what each live process runs in, and how many ended ones are kept', () => {
  /** A registry whose processes the test ends by id. */
  const rig = (): { reg: ProcRegistry; exit(id: string, code: number): void } => {
    const procs = new Map<string, ReturnType<typeof fakeProc>>()
    let opening = ''
    const reg = new ProcRegistry({
      spawn: () => {
        const p = fakeProc()
        procs.set(opening, p)
        return p
      },
      log: () => {}
    })
    const open = reg.open.bind(reg)
    reg.open = (a) => {
      opening = a.id
      return open(a)
    }
    return { reg, exit: (id, code) => procs.get(id)!.exit(code) }
  }

  it('names the folder each live process was opened in, and forgets it once it ends', () => {
    const { reg, exit } = rig()
    reg.open({ id: 'p1', file: 'x', args: [], opts: { cwd: 'D:/wt/a', env: {} }, meta: { kind: 'chat', id: 'c1', restore: { title: 't' } } })
    reg.open({ id: 'p2', file: 'x', args: [], opts: { cwd: 'D:/p', env: {} } })
    expect(reg.liveEntries()).toEqual([
      { id: 'p1', cwd: 'D:/wt/a', meta: { kind: 'chat', id: 'c1', restore: { title: 't' } } },
      { id: 'p2', cwd: 'D:/p', meta: null }
    ])
    exit('p1', 0)
    expect(reg.liveEntries().map((e) => e.id)).toEqual(['p2'])
  })

  // An ended chat is read by its session id: `sessions list` shows it, and `sessions read` finds its
  // transcript through its note (host/sessions.ts `chatOf`). So a chat is kept the way a pty session
  // is, and only the other ended entries are capped.
  it('keeps only the newest ended entries that are not sessions, and every ended chat', () => {
    const { reg, exit } = rig()
    const open = (id: string, m: PtyMeta | undefined): void => {
      reg.open({ id, file: 'x', args: [], opts: { cwd: 'D:/p', env: {} }, meta: m })
    }
    open('c0', { kind: 'chat', id: 'm_c0', restore: {} })
    exit('c0', 1)
    open('first', undefined)
    for (let i = 0; i < DEAD_ENTRIES_KEPT + 6; i++) {
      open(`r${i}`, i % 2 === 0 ? undefined : { kind: 'run', id: `m_r${i}`, restore: {} })
      exit(`r${i}`, 0)
    }
    open('live', undefined)
    const ids = reg.list().map((e) => e.id)
    expect(ids).toContain('c0')
    expect(ids).toContain('first')
    expect(ids).toContain('live')
    expect(ids.filter((id) => /^r\d+$/.test(id))).toHaveLength(DEAD_ENTRIES_KEPT)
    expect(ids).not.toContain('r0')
    expect(ids).not.toContain('r5')
    expect(ids).toContain('r6')
  })

  it('drops the entry that ended longest ago, not the one opened first', () => {
    const { reg, exit } = rig()
    const open = (id: string): void => {
      reg.open({ id, file: 'x', args: [], opts: { cwd: 'D:/p', env: {} } })
    }
    open('long')
    for (let i = 0; i < DEAD_ENTRIES_KEPT; i++) {
      open(`r${i}`)
      exit(`r${i}`, 0)
    }
    exit('long', 1)
    const ids = reg.list().map((e) => e.id)
    expect(ids).toContain('long')
    expect(ids).not.toContain('r0')
    expect(ids).toHaveLength(DEAD_ENTRIES_KEPT)
  })
})

describe('ProcRegistry — listeners (chat takeover P13)', () => {
  it('every onLine and onExit listener hears, and one that throws costs the others nothing', () => {
    const h = harness()
    const seen: string[] = []
    h.registry.onLine(() => { throw new Error('boom') })
    const off = h.registry.onLine((id, _s, line) => seen.push(`${id} ${line}`))
    h.registry.onExit((id, code) => seen.push(`exit ${id} ${code}`))
    h.open()
    h.procs[0].emit('a\n')
    off()
    h.procs[0].emit('b\n')
    h.procs[0].exit(0)
    expect(seen).toEqual(['p1 a', 'exit p1 0'])
    expect(h.lines.map((l) => l[2])).toEqual(['a', 'b'])
    expect(h.logs.some((l) => l.includes('boom'))).toBe(true)
  })
})

describe('ProcRegistry.onMeta (Slack in the Host, P7)', () => {
  it('tells a note at open and after each merge, and nothing for a proc with no note', () => {
    const h = harness()
    const heard: Array<[string, string, unknown]> = []
    h.registry.onMeta((id, m, why) => heard.push([id, why, m.restore.title]))
    h.open('p1', meta({ restore: { title: 'a' } }))
    h.open('p2', null)
    h.registry.note('p1', { title: 'b' })
    h.registry.note('p2', { title: 'c' })
    expect(heard).toEqual([['p1', 'open', 'a'], ['p1', 'note', 'b']])
  })
  it('isolates a listener that throws, logs it once, and unsubscribes', () => {
    const h = harness()
    const heard: string[] = []
    h.registry.onMeta(() => { throw new Error('boom') })
    const off = h.registry.onMeta((id) => heard.push(id))
    h.open('p1')
    h.registry.note('p1', { x: 1 })
    expect(heard).toEqual(['p1', 'p1'])
    expect(h.logs.filter((l) => /a meta listener threw/.test(l))).toHaveLength(1)
    off()
    h.registry.note('p1', { x: 2 })
    expect(heard).toEqual(['p1', 'p1'])
  })
})
