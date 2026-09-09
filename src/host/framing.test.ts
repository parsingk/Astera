import { describe, it, expect } from 'vitest'
import { encodeLine, createLineReader } from './framing'

const collect = (): { seen: unknown[]; bad: string[]; feed: (c: string) => void } => {
  const seen: unknown[] = []
  const bad: string[] = []
  const feed = createLineReader({ onMessage: (v) => seen.push(v), onBadLine: (raw) => bad.push(raw) })
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

  it('ignores an empty line', () => {
    const c = collect()
    c.feed('\n\n' + encodeLine({ n: 4 }))
    expect(c.bad).toEqual([])
    expect(c.seen).toEqual([{ n: 4 }])
  })
})
