import { describe, it, expect } from 'vitest'
import { findConsoleLinks, joinWrappedLine, bufferRangeAt } from './consoleLinks'

const only = (line: string) => {
  const links = findConsoleLinks(line)
  expect(links).toHaveLength(1)
  return links[0]
}

describe('findConsoleLinks — paths', () => {
  it('a relative path with line and column', () => {
    expect(only('  at src/core/run/instances.ts:42:7')).toEqual({
      kind: 'path', start: 5, end: 35, target: 'src/core/run/instances.ts', line: 42, col: 7
    })
  })

  it('a backslash path with a line only', () => {
    expect(only('error in src\\a.ts:12')).toEqual({ kind: 'path', start: 9, end: 20, target: 'src\\a.ts', line: 12 })
  })

  // A drive letter is part of the path, not a `:line` suffix on `D`
  it('a Windows drive path, with and without a position', () => {
    expect(only('D:\\p\\a.ts:12:5')).toEqual({ kind: 'path', start: 0, end: 14, target: 'D:\\p\\a.ts', line: 12, col: 5 })
    expect(only('D:/p/a.ts')).toEqual({ kind: 'path', start: 0, end: 9, target: 'D:/p/a.ts' })
  })

  // Node's stack frame — the parentheses are not part of the link
  it('a stack frame keeps the parentheses out of the range', () => {
    const line = '    at run (D:\\p\\a.ts:12:5)'
    const l = only(line)
    expect(l).toEqual({ kind: 'path', start: 12, end: 26, target: 'D:\\p\\a.ts', line: 12, col: 5 })
    expect(line.slice(l.start, l.end)).toBe('D:\\p\\a.ts:12:5')
  })

  // TypeScript's diagnostic form
  it("TypeScript's path(line,col) form, followed by a colon", () => {
    expect(only('src/a.ts(12,5): error TS2322')).toEqual({ kind: 'path', start: 0, end: 14, target: 'src/a.ts', line: 12, col: 5 })
  })

  it('a file:// URL is a path without the scheme, the range covering the whole token', () => {
    expect(only('see file:///D:/p/a.ts')).toEqual({ kind: 'path', start: 4, end: 21, target: 'D:/p/a.ts' })
  })

  it('a path with an extension and a line but no separator is still a link', () => {
    expect(only('a.ts:12')).toEqual({ kind: 'path', start: 0, end: 7, target: 'a.ts', line: 12 })
  })

  it('trailing punctuation is not part of the link', () => {
    expect(only('failed: src/a.ts:3.')).toEqual({ kind: 'path', start: 8, end: 18, target: 'src/a.ts', line: 3 })
  })
})

describe('findConsoleLinks — URLs', () => {
  it('an http URL', () => {
    expect(only('  ➜  Local:   http://localhost:5173/')).toEqual({ kind: 'url', start: 14, end: 36, url: 'http://localhost:5173/' })
  })

  it('a URL in parentheses and one followed by a period lose the closing punctuation', () => {
    expect(only('(https://vite.dev/config/)')).toEqual({ kind: 'url', start: 1, end: 25, url: 'https://vite.dev/config/' })
    expect(only('see https://vite.dev.')).toEqual({ kind: 'url', start: 4, end: 20, url: 'https://vite.dev' })
  })

  // A URL contains slashes; it must not also be reported as a path
  it('a URL is reported once, as a URL', () => {
    expect(findConsoleLinks('https://example.com/a/b.ts')).toEqual([
      { kind: 'url', start: 0, end: 26, url: 'https://example.com/a/b.ts' }
    ])
  })
})

describe('findConsoleLinks — not links', () => {
  it.each(['12:30', '1:2:3', 'word', '--flag=a:b', 'D:', 'ready in 431 ms', 'exit code 1'])('%s', (line) => {
    expect(findConsoleLinks(line)).toEqual([])
  })
})

describe('findConsoleLinks — several in one line', () => {
  it('reports every link in order with non-overlapping ranges', () => {
    const line = 'a/b.ts:1 and c/d.ts:2 see http://x.y/'
    const links = findConsoleLinks(line)
    expect(links.map((l) => l.kind)).toEqual(['path', 'path', 'url'])
    for (let i = 1; i < links.length; i++) expect(links[i].start).toBeGreaterThanOrEqual(links[i - 1].end)
    expect(links.map((l) => line.slice(l.start, l.end))).toEqual(['a/b.ts:1', 'c/d.ts:2', 'http://x.y/'])
  })
})

describe('joinWrappedLine', () => {
  // Row 1 and 2 are continuations of row 0; row 3 starts a new logical line
  const rows = [
    { text: 'AAAA', isWrapped: false },
    { text: 'BBBB', isWrapped: true },
    { text: 'CC  ', isWrapped: true },
    { text: 'DDDD', isWrapped: false }
  ]
  const getLine = (y: number) => rows[y]

  it.each([0, 1, 2])('asked about row %i of a wrapped line, returns the whole line from its first row', (y) => {
    expect(joinWrappedLine(getLine, y)).toEqual({ text: 'AAAABBBBCC  ', startY: 0 })
  })

  it('an unwrapped line is itself', () => {
    expect(joinWrappedLine(getLine, 3)).toEqual({ text: 'DDDD', startY: 3 })
  })

  it("the buffer's edge ends the walk", () => {
    expect(joinWrappedLine(() => undefined, 5)).toEqual({ text: '', startY: 5 })
  })
})

describe('bufferRangeAt', () => {
  // One entry per character of the joined text — the provider builds it from the real cells, so a
  // wide glyph occupies one entry and two columns
  const cells = [
    { x: 1, y: 11 },
    { x: 2, y: 11 },
    { x: 4, y: 11 }, // the character at index 1 was two columns wide
    { x: 1, y: 12 }, // the line wrapped here
    { x: 2, y: 12 }
  ]

  it('maps a range inside one row', () => {
    expect(bufferRangeAt(cells, 0, 2)).toEqual({ start: { x: 1, y: 11 }, end: { x: 2, y: 11 } })
  })

  it('maps a range that wraps onto the next row', () => {
    expect(bufferRangeAt(cells, 2, 5)).toEqual({ start: { x: 4, y: 11 }, end: { x: 2, y: 12 } })
  })

  it('a single character is one cell', () => {
    expect(bufferRangeAt(cells, 2, 3)).toEqual({ start: { x: 4, y: 11 }, end: { x: 4, y: 11 } })
  })

  // Defensive: the text and the table should never disagree, but a dead provider would be worse
  it('an out-of-range offset clamps to the last cell', () => {
    expect(bufferRangeAt(cells, 9, 12)).toEqual({ start: { x: 2, y: 12 }, end: { x: 2, y: 12 } })
  })

  it('an empty table is the first cell', () => {
    expect(bufferRangeAt([], 0, 3)).toEqual({ start: { x: 1, y: 1 }, end: { x: 1, y: 1 } })
  })
})
