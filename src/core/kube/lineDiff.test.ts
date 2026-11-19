import { describe, expect, it } from 'vitest'
import { lineDiff, MAX_DIFF_LINES } from './lineDiff'

describe('lineDiff', () => {
  it('gives only context rows for identical text', () => {
    const rows = lineDiff('a\nb\nc\n', 'a\nb\nc\n')
    expect(rows).toEqual([
      { kind: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'ctx', text: 'b', oldNo: 2, newNo: 2 },
      { kind: 'ctx', text: 'c', oldNo: 3, newNo: 3 }
    ])
  })

  it('gives one del and one add with the right numbers for a changed line', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { kind: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'del', text: 'b', oldNo: 2 },
      { kind: 'add', text: 'B', newNo: 2 },
      { kind: 'ctx', text: 'c', oldNo: 3, newNo: 3 }
    ])
  })

  it('numbers lines after an insertion on both sides', () => {
    expect(lineDiff('a\nc\n', 'a\nb\nc\n')).toEqual([
      { kind: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
      { kind: 'add', text: 'b', newNo: 2 },
      { kind: 'ctx', text: 'c', oldNo: 2, newNo: 3 }
    ])
  })

  it('treats an empty side as no lines', () => {
    expect(lineDiff('', 'x\n')).toEqual([{ kind: 'add', text: 'x', newNo: 1 }])
  })

  it('refuses above the limit on either side with counts', () => {
    const big = Array.from({ length: MAX_DIFF_LINES + 1 }, (_, i) => `l${i}`).join('\n')
    expect(lineDiff(big, 'x')).toEqual({ tooLarge: true, added: 1, removed: MAX_DIFF_LINES + 1 })
    expect(lineDiff('x', big)).toEqual({ tooLarge: true, added: MAX_DIFF_LINES + 1, removed: 1 })
  })

  it('accepts exactly the limit', () => {
    const edge = Array.from({ length: MAX_DIFF_LINES }, (_, i) => `l${i}`).join('\n')
    expect(Array.isArray(lineDiff(edge, edge.replace('l5\n', 'x\n')))).toBe(true)
  })

  it('treats CRLF like LF', () => {
    expect(lineDiff('a\r\nb\r\n', 'a\r\nB\r\n')).toEqual(lineDiff('a\nb\n', 'a\nB\n'))
  })
})
