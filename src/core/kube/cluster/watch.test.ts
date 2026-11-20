import { describe, expect, it } from 'vitest'
import { applyWatch, createJsonSplitter, toWatchEvent } from './watch'

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
  it('applies events and resync clears the list', () => {
    const a = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'a', uid: '1' } }
    let l = applyWatch(new Map(), { type: 'ADDED', object: a })
    l = applyWatch(l, { type: 'MODIFIED', object: { ...a, status: { phase: 'Running' } } })
    expect([...l.values()][0].status).toEqual({ phase: 'Running' })
    expect(applyWatch(l, { type: 'DELETED', object: a }).size).toBe(0)
    expect(applyWatch(l, 'resync').size).toBe(0)
  })
  it('ignores a value that is not a watch event', () => {
    expect(toWatchEvent({ kind: 'Status', status: 'Failure' })).toBeNull()
  })
})
