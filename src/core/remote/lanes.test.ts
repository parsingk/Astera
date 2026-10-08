import { describe, it, expect } from 'vitest'
import { Writable } from 'node:stream'
import { createLaneWriter } from './lanes'

/** A Writable that takes what it is handed and finishes nothing until told to. */
const stalled = () => {
  const got: string[] = []
  const pending: Array<() => void> = []
  const out = new Writable({
    highWaterMark: 1,
    write(chunk: Buffer, _enc, cb) {
      got.push(chunk.toString())
      pending.push(cb)
    }
  })
  return { out, got, release: () => pending.splice(0).forEach((cb) => cb()) }
}

describe('createLaneWriter (remote runtime design §3.1)', () => {
  it('writes control before bulk, and keeps only the newest bulk line per key while the stream is full', async () => {
    const s = stalled()
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => {} })
    w.bulk('state', 'S1\n')
    w.bulk('state', 'S2\n')
    w.bulk('state', 'S3\n')
    w.control('C1\n')
    w.control('C2\n')
    // The first line went straight through; the rest wait for the stream.
    expect(s.got).toEqual(['S1\n'])
    for (let i = 0; i < 5; i++) {
      s.release()
      await new Promise((r) => setImmediate(r))
    }
    expect(s.got).toEqual(['S1\n', 'C1\n', 'C2\n', 'S3\n'])
  })
  it('calls onHardCap once when what it holds plus what the stream holds passes the cap (Review Focus 2)', () => {
    const s = stalled()
    let fired = 0
    const w = createLaneWriter(s.out, { hardCap: 100, onHardCap: () => fired++ })
    for (let i = 0; i < 20; i++) w.control(`${'x'.repeat(9)}\n`)
    expect(w.queued()).toBeGreaterThan(100)
    expect(fired).toBe(1)
  })
  it('writes nothing after destroy', () => {
    const s = stalled()
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => {} })
    w.control('a\n')
    w.destroy()
    w.control('b\n')
    expect(s.got).toEqual(['a\n'])
  })
})

// Remote runtime design §3.1 and §3.7 (Phase 8): pty output is a stream lane. Each stream keeps its order, control
// lines still go first, and a stream past its share is dropped and reported, never a reason to kill the link.
describe('createLaneWriter streams (Phase 8)', () => {
  const settle = async (s: ReturnType<typeof stalled>, n = 8): Promise<void> => {
    for (let i = 0; i < n; i++) {
      s.release()
      await new Promise((r) => setImmediate(r))
    }
  }
  it('keeps each stream in order, after control lines', async () => {
    const s = stalled()
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => {} })
    w.stream('a', 'a1\n', 1)
    w.stream('a', 'a2\n', 2)
    w.stream('b', 'b1\n', 1)
    w.control('C\n')
    await settle(s)
    expect(s.got[0]).toBe('a1\n')
    expect(s.got[1]).toBe('C\n')
    expect(s.got.filter((l) => l.startsWith('a'))).toEqual(['a1\n', 'a2\n'])
    expect(s.got).toContain('b1\n')
  })
  it('a stream past its share is dropped and reported with the seqs it lost; the others and control go on', async () => {
    const s = stalled()
    const over: Array<[string, { firstSeq: number; lastSeq: number }]> = []
    let capped = 0
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => capped++, streamPerKey: 30, streamTotal: 1000, onStreamOverflow: (k, lost) => over.push([k, lost]) })
    w.stream('b', 'b1\n', 1)
    for (let i = 1; i <= 5; i++) w.stream('a', `a${i}${'x'.repeat(8)}\n`, i)
    expect(over).toEqual([['a', { firstSeq: 1, lastSeq: 3 }]])
    w.stream('b', 'b2\n', 2)
    w.control('C\n')
    await settle(s)
    expect(s.got).toContain('b2\n')
    expect(s.got).toContain('C\n')
    expect(capped).toBe(0)
  })
  it('past the total every stream is dropped and reported', () => {
    const s = stalled()
    const over: string[] = []
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => {}, streamPerKey: 1000, streamTotal: 40, onStreamOverflow: (k) => over.push(k) })
    w.control('first\n')
    for (let i = 1; i <= 3; i++) {
      w.stream('a', `${'a'.repeat(9)}\n`, i)
      w.stream('b', `${'b'.repeat(9)}\n`, i)
    }
    expect(over.sort()).toEqual(['a', 'b'])
  })
  it('dropStream forgets a stream waiting to be written', async () => {
    const s = stalled()
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => {} })
    w.control('first\n')
    w.stream('a', 'a1\n', 1)
    w.dropStream('a')
    await settle(s)
    expect(s.got).not.toContain('a1\n')
  })
})

// Phase 8 review I3: a checkpoint goes on its stream's lane, admitted whole even when it alone is over the stream's
// share; what follows it is held to the share as usual.
describe('createLaneWriter admitted stream lines', () => {
  it('an admitted line over the share is kept; the next line past the share is not', () => {
    const s = stalled()
    const over: string[] = []
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => {}, streamPerKey: 30, streamTotal: 1000, onStreamOverflow: (k) => over.push(k) })
    w.control('first\n')
    w.stream('a', `${'c'.repeat(100)}\n`, 5, { admit: true })
    expect(over).toEqual([])
    w.stream('a', 'next\n', 6)
    expect(over).toEqual(['a'])
  })
})

// Security audit SEC-1: a chunked reply went on the control lane whole, so one reply of a few MiB, or the 32 replies of
// 400 KiB a connection may have in flight, passed the 8 MiB hard cap and the link was killed. Replies have a lane and a
// budget of their own: past the budget a reply is refused, never a reason to kill the link.
describe('createLaneWriter replies (SEC-1)', () => {
  const settle = async (s: ReturnType<typeof stalled>, n = 64): Promise<void> => {
    for (let i = 0; i < n; i++) {
      s.release()
      await new Promise((r) => setImmediate(r))
    }
  }
  it('a reply of many lines is not held to the hard cap, and arrives whole and in order', async () => {
    const s = stalled()
    let fired = 0
    const w = createLaneWriter(s.out, { hardCap: 100, onHardCap: () => fired++, replyCap: 1 << 20 })
    const lines = Array.from({ length: 20 }, (_, i) => `R${String(i).padStart(2, '0')}${'x'.repeat(20)}\n`)
    expect(w.reply(lines)).toBe(true)
    expect(fired).toBe(0)
    expect(w.queued()).toBeLessThan(100)
    expect(w.replyQueued()).toBeGreaterThan(100)
    await settle(s)
    expect(s.got).toEqual(lines)
    expect(w.replyQueued()).toBe(0)
  })
  it('a reply over its budget is refused and nothing of it is queued', () => {
    const s = stalled()
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => {}, replyCap: 50 })
    w.control('stalls the stream\n')
    expect(w.reply(['a'.repeat(30) + '\n'])).toBe(true)
    expect(w.reply(['b'.repeat(30) + '\n'])).toBe(false)
    expect(w.replyQueued()).toBe(31)
  })
  // Final review M-1: turns by line gave a stream one 3-byte line for every 700 KB reply line, so live output starved
  // while a large reply went out. Turns are by bytes.
  it('takes turns by bytes, so a stream is not starved by long reply lines', async () => {
    const s = stalled()
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => {}, replyCap: 1 << 20 })
    w.control('first\n')
    w.reply(['R'.repeat(39) + '\n', 'Q'.repeat(39) + '\n'])
    for (let i = 1; i <= 8; i++) w.stream('p', `S${i}xxxxxxx\n`, i)
    await settle(s)
    expect(s.got.slice(1).map((l) => l[0])).toEqual(['R', 'S', 'S', 'S', 'S', 'Q', 'S', 'S', 'S', 'S'])
  })
  it('control goes before a reply waiting, and stream lines go between reply lines', async () => {
    const s = stalled()
    const w = createLaneWriter(s.out, { hardCap: 1 << 20, onHardCap: () => {}, replyCap: 1 << 20 })
    w.control('first\n')
    w.reply(['R1\n', 'R2\n', 'R3\n'])
    w.stream('p', 'S1\n', 1)
    w.stream('p', 'S2\n', 2)
    w.control('C\n')
    await settle(s)
    expect(s.got).toEqual(['first\n', 'C\n', 'R1\n', 'S1\n', 'R2\n', 'S2\n', 'R3\n'])
  })
})
