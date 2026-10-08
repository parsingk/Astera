// The pty ring (remote runtime design §3.7, N1, X1-10): every event gets a seq, the ring keeps a bounded run of the
// newest ones with a per-event cost, and a long chunk is split where a replay can join it back.
import { describe, it, expect } from 'vitest'
import { RING_CHUNK_MAX, RING_EVENT_COST, createPtyRing } from './ptyRing'

describe('createPtyRing', () => {
  it('gives every event the next seq, whatever its kind', () => {
    const r = createPtyRing()
    expect(r.lastSeq()).toBe(0)
    const made = [...r.push({ kind: 'data', data: 'a' }), ...r.push({ kind: 'resize', cols: 100, rows: 30 }), ...r.push({ kind: 'exit', code: 0 })]
    expect(made.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(r.lastSeq()).toBe(3)
    expect(r.firstSeq()).toBe(1)
  })

  it('answers the run from a held seq, nothing past the end, and null for one it no longer holds or never had', () => {
    const r = createPtyRing({ bound: 3 * (1 + RING_EVENT_COST) })
    for (const d of ['a', 'b', 'c', 'd', 'e']) r.push({ kind: 'data', data: d })
    expect(r.firstSeq()).toBe(3)
    expect(r.since(4)?.map((e) => e.seq)).toEqual([4, 5])
    expect(r.since(6)).toEqual([])
    expect(r.since(2)).toBeNull()
    expect(r.since(7)).toBeNull()
  })

  it('many tiny events never take it past its bound (X1-10)', () => {
    const bound = 10_000
    const r = createPtyRing({ bound })
    for (let i = 0; i < 100_000; i++) r.push({ kind: 'data', data: 'x' })
    expect(r.cost()).toBeLessThanOrEqual(bound)
    expect(r.lastSeq()).toBe(100_000)
  })

  it('splits a long chunk into ordered pieces that join back', () => {
    const r = createPtyRing({ bound: 1_000_000 })
    const big = 'y'.repeat(RING_CHUNK_MAX * 3 + 10)
    const made = r.push({ kind: 'data', data: big })
    expect(made).toHaveLength(4)
    expect(made.map((e) => (e.kind === 'data' ? e.data : '')).join('')).toBe(big)
    expect(made.every((e) => e.kind === 'data' && e.data.length <= RING_CHUNK_MAX)).toBe(true)
  })

  it('never splits inside a surrogate pair', () => {
    const r = createPtyRing({ bound: 1_000_000 })
    const big = 'a' + '😀'.repeat(RING_CHUNK_MAX)
    const made = r.push({ kind: 'data', data: big })
    for (const e of made) {
      if (e.kind !== 'data') continue
      const last = e.data.charCodeAt(e.data.length - 1)
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
    }
    expect(made.map((e) => (e.kind === 'data' ? e.data : '')).join('')).toBe(big)
  })

  it('text is the data events only, in order: the attach replay', () => {
    const r = createPtyRing()
    r.push({ kind: 'data', data: 'he' })
    r.push({ kind: 'resize', cols: 10, rows: 5 })
    r.push({ kind: 'data', data: 'llo' })
    r.push({ kind: 'exit', code: 1 })
    expect(r.text()).toBe('hello')
  })

  it('keeps the newest event even when it alone is over the bound', () => {
    const r = createPtyRing({ bound: 10 })
    r.push({ kind: 'data', data: 'zzzzzzzzzzzzzzzzzzzz' })
    expect(r.since(1)?.length).toBe(1)
  })
})
