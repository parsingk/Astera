import { describe, it, expect } from 'vitest'
import { LSP_MAX_MESSAGE, createMessageReader, encodeMessage } from './framing'

// Phase 3 Part 3: the Content-Length framing language servers speak on stdio
const read = (maxBytes = LSP_MAX_MESSAGE) => {
  const got: unknown[] = []
  const errors: string[] = []
  const feed = createMessageReader({ maxBytes, onMessage: (m) => got.push(m), onError: (e) => errors.push(e.message) })
  return { got, errors, feed }
}

describe('framing', () => {
  it('reads messages split across chunks and several in one chunk', () => {
    const both = Buffer.concat([encodeMessage({ id: 1, result: 'a' }), encodeMessage({ method: 'n', params: { x: [1, 2] } })])
    for (let cut = 1; cut < both.length; cut++) {
      const r = read()
      r.feed(both.subarray(0, cut))
      r.feed(both.subarray(cut))
      expect(r.got, `cut at ${cut}`).toEqual([{ id: 1, result: 'a' }, { method: 'n', params: { x: [1, 2] } }])
      expect(r.errors).toEqual([])
    }
  })

  it('counts Content-Length in bytes, not characters', () => {
    const m = encodeMessage({ message: '한국어 메시지 😀' })
    const header = m.subarray(0, m.indexOf('\r\n\r\n')).toString('ascii')
    const length = Number(/Content-Length: (\d+)/.exec(header)?.[1])
    expect(length).toBe(m.length - header.length - 4)
    const r = read()
    r.feed(m)
    expect(r.got).toEqual([{ message: '한국어 메시지 😀' }])
  })

  it('reports a message over the bound and reads nothing after it', () => {
    const r = read(1024)
    r.feed(Buffer.from(`Content-Length: ${65 * 1024 * 1024}\r\n\r\n`, 'ascii'))
    r.feed(encodeMessage({ id: 2 }))
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/longer than/)
    expect(r.got).toEqual([])
  })

  it('reports a header without Content-Length', () => {
    const r = read()
    r.feed(Buffer.from('Content-Type: application/vscode-jsonrpc\r\n\r\n{}', 'ascii'))
    expect(r.errors).toHaveLength(1)
    expect(r.got).toEqual([])
  })

  it('reads the header name in any case, and reports a body that is not JSON', () => {
    const r = read()
    r.feed(Buffer.from('content-length: 2\r\n\r\n{}', 'ascii'))
    r.feed(Buffer.from('Content-Length: 3\r\n\r\n{x}', 'ascii'))
    expect(r.got).toEqual([{}])
    expect(r.errors).toHaveLength(1)
  })

  // Final review M10: a large message read in small chunks is copied once, not once per chunk
  it('reads a 60 MB message in 16 KB chunks without copying it per chunk', () => {
    const r = read()
    const m = encodeMessage({ big: 'x'.repeat(60 * 1024 * 1024) })
    const started = Date.now()
    for (let i = 0; i < m.length; i += 16 * 1024) r.feed(m.subarray(i, i + 16 * 1024))
    expect(r.got).toHaveLength(1)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
