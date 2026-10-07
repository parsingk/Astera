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
