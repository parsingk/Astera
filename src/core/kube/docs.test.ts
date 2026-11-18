import { describe, expect, it } from 'vitest'
import { parseManifestDocs } from './docs'

const TWO = `apiVersion: v1
kind: ConfigMap
metadata:
  name: cfg
  namespace: web
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
`

describe('parseManifestDocs', () => {
  it('returns one entry per document with name and namespace', () => {
    expect(parseManifestDocs(TWO)).toEqual([
      { index: 0, apiVersion: 'v1', kind: 'ConfigMap', name: 'cfg', namespace: 'web' },
      { index: 1, apiVersion: 'apps/v1', kind: 'Deployment', name: 'api', namespace: null },
    ])
  })

  it('gives the same result for CRLF line endings and a BOM', () => {
    const text = String.fromCharCode(0xfeff) + TWO.replace(/\n/g, '\r\n')
    expect(parseManifestDocs(text)).toEqual(parseManifestDocs(TWO))
  })

  it('returns a List as one document of kind List', () => {
    const text = 'apiVersion: v1\nkind: List\nitems:\n  - apiVersion: v1\n    kind: Pod\n    metadata:\n      name: a\n'
    expect(parseManifestDocs(text)).toEqual([
      { index: 0, apiVersion: 'v1', kind: 'List', name: null, namespace: null },
    ])
  })

  it('skips documents without apiVersion or kind and keeps their index slot', () => {
    const text = 'foo: bar\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n'
    expect(parseManifestDocs(text)).toEqual([
      { index: 1, apiVersion: 'v1', kind: 'Namespace', name: 'x', namespace: null },
    ])
  })

  it('keeps the first document when the second one is broken', () => {
    const text = 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: a\n---\nkind: [unclosed\n  : : :\n'
    const docs = parseManifestDocs(text)
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ index: 0, kind: 'Pod', name: 'a' })
  })

  it('never throws on garbage', () => {
    expect(parseManifestDocs('')).toEqual([])
    expect(() => parseManifestDocs('{{{ \u0000 ]]]')).not.toThrow()
  })
})
