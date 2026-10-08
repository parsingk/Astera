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
