import { describe, it, expect } from 'vitest'
import { encodeLine, createLineReader } from './framing'

const collect = (): { seen: unknown[]; bad: string[]; feed: (c: string) => void } => {
  const seen: unknown[] = []
  const bad: string[] = []
  const feed = createLineReader({
    onMessage: (v) => seen.push(v),
    onBadLine: (raw) => bad.push(raw),
    onHandlerError: () => {}
  })
  return { seen, bad, feed }
}

describe('framing', () => {
  it('encodes one object per line', () => {
    expect(encodeLine({ t: 'hello' })).toBe('{"t":"hello"}\n')
  })

  it('reads two messages out of one chunk', () => {
    const c = collect()
    c.feed(encodeLine({ n: 1 }) + encodeLine({ n: 2 }))
    expect(c.seen).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('waits for the rest of a message split across chunks', () => {
    const c = collect()
    const line = encodeLine({ t: 'hello', app: '1.2.3' })
    c.feed(line.slice(0, 9))
    expect(c.seen).toEqual([])
    c.feed(line.slice(9))
    expect(c.seen).toEqual([{ t: 'hello', app: '1.2.3' }])
  })

  // A line that is not JSON must not take the connection down with it: the next line still arrives.
  it('reports a line that is not JSON and keeps reading', () => {
    const c = collect()
    c.feed('this is not json\n' + encodeLine({ n: 3 }))
    expect(c.bad).toEqual(['this is not json'])
    expect(c.seen).toEqual([{ n: 3 }])
  })

  // A handler that threw is not a malformed line. The Host is a detached process whose log is the
  // only window into it, so the two must not read the same there.
  it('separates a handler that threw from a line that is not JSON', () => {
    const seen: unknown[] = []
    const bad: string[] = []
    const threw: Array<[unknown, string]> = []
    const feed = createLineReader({
      onMessage: (v) => {
        if ((v as { boom?: boolean }).boom === true) throw new Error('pty is gone')
        seen.push(v)
      },
      onBadLine: (raw) => bad.push(raw),
      onHandlerError: (v, err) => threw.push([v, String(err)])
    })
    feed(encodeLine({ boom: true }) + encodeLine({ n: 5 }))
    expect(bad).toEqual([])
    expect(threw).toEqual([[{ boom: true }, 'Error: pty is gone']])
    expect(seen).toEqual([{ n: 5 }])
  })

  it('ignores an empty line', () => {
    const c = collect()
    c.feed('\n\n' + encodeLine({ n: 4 }))
    expect(c.bad).toEqual([])
    expect(c.seen).toEqual([{ n: 4 }])
  })

  // A sender that never ends its line would otherwise grow the buffer without bound (remote runtime
  // design §3.1): past the cap the reader gives up on the connection, once, and reads nothing more.
  describe('with a line cap', () => {
    const capped = (maxLine: number) => {
      const seen: unknown[] = []
      let overflows = 0
      const feed = createLineReader({ onMessage: (v) => seen.push(v), onBadLine: () => {}, onHandlerError: () => {}, maxLine, onOverflow: () => overflows++ })
      return { seen, feed, overflows: () => overflows }
    }
    it('gives up on an unfinished line longer than the cap, once', () => {
      const c = capped(10)
      c.feed('x'.repeat(6))
      expect(c.overflows()).toBe(0)
      c.feed('x'.repeat(6))
      c.feed(encodeLine({ n: 1 }))
      expect(c.overflows()).toBe(1)
      expect(c.seen).toEqual([])
    })
    it('refuses a finished line longer than the cap that arrived in one chunk', () => {
      const c = capped(10)
      c.feed(encodeLine({ s: '0123456789' }))
      expect(c.overflows()).toBe(1)
      expect(c.seen).toEqual([])
    })
    it('reads a line exactly at the cap', () => {
      const line = encodeLine({ s: '012' }) // {"s":"012"} is 11 characters before the newline
      const c = capped(11)
      c.feed(line)
      expect(c.overflows()).toBe(0)
      expect(c.seen).toEqual([{ s: '012' }])
    })
  })
})

// Second pass C2-5: each chunk was appended to the held text and the whole of it searched again for a newline, so one
// long line (a large state or a relayed read) cost time quadratic in its length: 858 ms for 20 MB measured.
describe('createLineReader on a long line', () => {
  it('reads a 40 MB line in 64 KB chunks in linear time', () => {
    const got: unknown[] = []
    const feed = createLineReader({ onMessage: (v) => got.push(v), onBadLine: () => {}, onHandlerError: () => {} })
    const body = JSON.stringify({ pad: 'x'.repeat(40 * 1024 * 1024) }) + '\n'
    const t0 = performance.now()
    for (let i = 0; i < body.length; i += 64 * 1024) feed(body.slice(i, i + 64 * 1024))
    expect(performance.now() - t0).toBeLessThan(1500)
    expect(got).toHaveLength(1)
  })

  it('still finds every line, in order, when chunks split them anywhere', () => {
    const got: unknown[] = []
    const feed = createLineReader({ onMessage: (v) => got.push(v), onBadLine: () => {}, onHandlerError: () => {} })
    const text = [1, 2, 3, 4].map((n) => JSON.stringify({ n })).join('\n') + '\n'
    for (const c of text) feed(c)
    feed('{"n":5}\n{"n"')
    feed(':6}\n')
    expect(got).toEqual([1, 2, 3, 4, 5, 6].map((n) => ({ n })))
  })
})
