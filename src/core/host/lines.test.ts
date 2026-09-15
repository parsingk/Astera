import { describe, it, expect } from 'vitest'
import { createLineSplitter } from './lines'

const collect = () => {
  const lines: string[] = []
  const s = createLineSplitter((l) => lines.push(l))
  return { lines, s }
}

describe('createLineSplitter', () => {
  it('delivers each complete line without its newline', () => {
    const { lines, s } = collect()
    s.push('{"a":1}\n{"b":2}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })
  it('holds a partial line across chunks', () => {
    const { lines, s } = collect()
    s.push('{"a":')
    expect(lines).toEqual([])
    s.push('1}\n{"b"')
    expect(lines).toEqual(['{"a":1}'])
    s.push(':2}\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })
  it('strips a carriage return before the newline', () => {
    const { lines, s } = collect()
    s.push('x\r\ny\n')
    expect(lines).toEqual(['x', 'y'])
  })
  it('flush delivers a trailing line that never got its newline, once', () => {
    const { lines, s } = collect()
    s.push('tail')
    s.flush()
    s.flush()
    expect(lines).toEqual(['tail'])
  })
  it('flush with nothing pending delivers nothing', () => {
    const { lines, s } = collect()
    s.push('a\n')
    s.flush()
    expect(lines).toEqual(['a'])
  })
})
