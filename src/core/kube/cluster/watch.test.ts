import { describe, expect, it } from 'vitest'
import { createJsonSplitter, toWatchEvent } from './watch'

describe('kubectl watch output', () => {
  it('splits objects across chunks and ignores braces inside strings', () => {
    const sp = createJsonSplitter()
    expect(sp.push('{"type":"ADDED","object":{"kind":"Pod","metadata":{"name":"a","annotations":{"x":"{\\"}')).toEqual([])
    const out = sp.push('"}}}}\n{"type":"DELETED","object":{"kind":"Pod","metadata":{"name":"b"}}}\n')
    expect(out.map((r) => r.ok && (r.value as { type: string }).type)).toEqual(['ADDED', 'DELETED'])
  })
  it('reports a broken object and carries on', () => {
    const sp = createJsonSplitter()
    expect(sp.push('{"type": ADDED}\n{"type":"MODIFIED","object":{"kind":"Pod","metadata":{"name":"a"}}}')).toEqual([{ ok: false }, { ok: true, value: { type: 'MODIFIED', object: { kind: 'Pod', metadata: { name: 'a' } } } }])
  })
  it('ignores a value that is not a watch event', () => {
    expect(toWatchEvent({ kind: 'Status', status: 'Failure' })).toBeNull()
  })
})
