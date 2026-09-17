import { describe, it, expect } from 'vitest'
import { ProcRegistry, PROC_BUFFER_CHARS, type RegistryProc } from './procRegistry'
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
