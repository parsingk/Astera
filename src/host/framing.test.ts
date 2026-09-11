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
})
