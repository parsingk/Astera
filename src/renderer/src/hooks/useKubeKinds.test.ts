import { describe, it, expect } from 'vitest'
import {
  applyKubeResults,
  beginKubeRequest,
  chunkPaths,
  failKubeRequest,
  newTracker,
  planKubeRequests,
  pruneKubeKinds
} from './useKubeKinds'

describe('applyKubeResults', () => {
  it('a newer result wins over a late older one for the same path', () => {
    const t = newTracker()
    const slow = beginKubeRequest(t, ['/a.yaml', '/b.yaml'])
    const fresh = beginKubeRequest(t, ['/a.yaml'])
    let kinds = applyKubeResults({}, { '/a.yaml': 'plain' }, fresh, t)
    kinds = applyKubeResults(kinds, { '/a.yaml': 'manifest', '/b.yaml': 'manifest' }, slow, t)
    expect(kinds).toEqual({ '/a.yaml': 'plain', '/b.yaml': 'manifest' })
  })

  it('ignores results from an old generation', () => {
    const old = newTracker(1)
    const req = beginKubeRequest(old, ['/a.yaml'])
    const current = newTracker(2)
    const kinds = {}
    expect(applyKubeResults(kinds, { '/a.yaml': 'manifest' }, req, current)).toBe(kinds)
  })

  it('a rejection leaves the state unchanged and frees the path', () => {
    const t = newTracker()
    const req = beginKubeRequest(t, ['/a.yaml'])
    failKubeRequest(t, req)
    expect(t.pending.size).toBe(0)
    expect(planKubeRequests(['/a.yaml'], t)).toEqual(['/a.yaml'])
  })

  it('a path missing from the answer is dropped', () => {
    const t = newTracker()
    const req = beginKubeRequest(t, ['/a.yaml'])
    expect(applyKubeResults({ '/a.yaml': 'manifest' }, {}, req, t)).toEqual({})
  })
})

describe('request planning', () => {
  it('does not re-request answered or in-flight paths on a row-list change', () => {
    const t = newTracker()
    const first = beginKubeRequest(t, ['/a.yaml', '/b.yaml'])
    expect(planKubeRequests(['/a.yaml', '/b.yaml', '/c.yaml'], t)).toEqual(['/c.yaml'])
    applyKubeResults({}, { '/a.yaml': 'manifest' }, first, t)
    expect(planKubeRequests(['/a.yaml', '/b.yaml', '/c.yaml'], t)).toEqual(['/c.yaml'])
  })

  it('chunks more than 200 paths', () => {
    const paths = Array.from({ length: 450 }, (_, i) => `/p/${i}.yaml`)
    expect(chunkPaths(paths).map((c) => c.length)).toEqual([200, 200, 50])
  })

  it('prunes paths that are no longer listed', () => {
    const t = newTracker()
    t.asked.add('/a.yaml')
    t.asked.add('/b.yaml')
    const next = pruneKubeKinds({ '/a.yaml': 'manifest', '/b.yaml': 'plain' }, new Set(['/a.yaml']), t)
    expect(next).toEqual({ '/a.yaml': 'manifest' })
    expect([...t.asked]).toEqual(['/a.yaml'])
  })
})
