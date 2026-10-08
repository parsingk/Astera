import { describe, it, expect } from 'vitest'
import { CHUNK_SIZE, chunksOf, createReassembler } from './chunks'
import { FRAME_CAP } from './frames'

describe('chunked replies (remote runtime design §3.1)', () => {
  // Security audit SEC-5: each ref was held to the cap alone, and 16 refs were open at once: a hostile Runtime could
  // make a controller hold about 1 GiB. Every open ref together is held to the total.
  it('holds every open ref together to the total; past it the ref being added fails and the others go on', () => {
    const r = createReassembler({ cap: 3 * CHUNK_SIZE, totalCap: 4 * CHUNK_SIZE })
    const a = chunksOf('a', 'a'.repeat(3 * CHUNK_SIZE))
    const b = chunksOf('b', 'b'.repeat(3 * CHUNK_SIZE))
    expect(r.add(a[0])).toBeNull()
    expect(r.add(a[1])).toBeNull()
    expect(r.add(b[0])).toBeNull()
    expect(r.add(b[1])).toBeNull()
    expect(r.add(a[2])).toEqual({ error: 'REMOTE_REPLY_TOO_LARGE' })
    expect(r.add(b[2])).toBe('b'.repeat(3 * CHUNK_SIZE))
  })
  it('splits a 1.5 MiB body into frames under the frame cap and puts it back together', () => {
    const body = JSON.stringify({ text: 'é'.repeat(800 * 1024) })
    const frames = chunksOf('r1', body)
    expect(frames.length).toBeGreaterThanOrEqual(3)
    for (const f of frames) expect(JSON.stringify(f).length).toBeLessThan(FRAME_CAP)
    const r = createReassembler()
    let out: unknown = null
    for (const f of frames) out = r.add(f)
    expect(out).toBe(body)
  })
  it('refuses a body that would reassemble over 64 MiB', () => {
    const r = createReassembler({ cap: 2 * CHUNK_SIZE })
    const frames = chunksOf('big', 'x'.repeat(3 * CHUNK_SIZE))
    let out: unknown = null
    for (const f of frames) {
      out = r.add(f)
      if (out && typeof out === 'object') break
    }
    expect(out).toEqual({ error: 'REMOTE_REPLY_TOO_LARGE' })
  })
  it('refuses chunks out of order or repeated', () => {
    const frames = chunksOf('r', 'y'.repeat(2 * CHUNK_SIZE + 1))
    const r = createReassembler()
    expect(r.add(frames[1])).toHaveProperty('error')
    const r2 = createReassembler()
    r2.add(frames[0])
    expect(r2.add(frames[0])).toHaveProperty('error')
  })

  // Performance audit H7: a reply whose remaining chunks never come (its connection closed, its stream dropped) must
  // not stay held for the life of the process. Past a while, or past a few held at once, the oldest goes.
  it('forgets a reply whose chunks stopped coming, after a while or past a few at once', () => {
    let now = 0
    const r = createReassembler({ now: () => now, staleMs: 60_000, maxOpen: 3 })
    const first = (ref: string) => ({ t: 'chunk' as const, ref, i: 0, n: 2, data: Buffer.from('x').toString('base64') })
    r.add(first('old'))
    expect(r.held()).toBe(1)
    now += 61_000
    r.add(first('new'))
    expect(r.held()).toBe(1)
    for (const ref of ['a', 'b', 'c', 'd']) r.add(first(ref))
    expect(r.held()).toBe(3)
  })
})

