import { describe, expect, it } from 'vitest'
import { createJsonSplitter, toWatchEvents } from './watch'

const cm = (name: string): Record<string, unknown> => ({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, namespace: 'bulk' }, data: { index: name } })

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
    expect(toWatchEvents({ kind: 'Status', status: 'Failure' })).toEqual([])
  })
  it('keeps a watch event of one object as one event', () => {
    expect(toWatchEvents({ type: 'MODIFIED', object: cm('a') })).toEqual([{ type: 'MODIFIED', object: cm('a') }])
  })

  // Task 15 S1: kubectl prints each page (500 objects) of a big initial list as ONE event whose object is the page's
  // list, in this shape (kind v1.32, `get configmaps --watch -o json --output-watch-events`, 1,501 ConfigMaps).
  it('turns a page list into one event per item, of the same type, the items keeping their own kind', () => {
    const page = {
      type: 'ADDED',
      object: {
        apiVersion: 'v1',
        items: [cm('cm-0000'), cm('cm-0001')],
        kind: 'ConfigMapList',
        metadata: { continue: 'eyJ2IjoibWV0YS5rOHMuaW8vdjEifQ', remainingItemCount: 1001, resourceVersion: '5611' }
      }
    }
    expect(toWatchEvents(page)).toEqual([
      { type: 'ADDED', object: cm('cm-0000') },
      { type: 'ADDED', object: cm('cm-0001') }
    ])
  })
  it('expands a list of kind List and one without a kind, and invents no kind for an item without one', () => {
    const bare = { apiVersion: 'v1', metadata: { name: 'no-kind' } }
    expect(toWatchEvents({ type: 'ADDED', object: { apiVersion: 'v1', kind: 'List', items: [cm('a')] } })).toEqual([{ type: 'ADDED', object: cm('a') }])
    expect(toWatchEvents({ type: 'ADDED', object: { apiVersion: 'v1', items: [cm('b'), bare] } })).toEqual([
      { type: 'ADDED', object: cm('b') },
      { type: 'ADDED', object: bare }
    ])
  })
})
