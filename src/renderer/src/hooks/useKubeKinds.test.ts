import { describe, it, expect } from 'vitest'
import type { KubeFileKind } from '../../../core/kube/types'
import {
  acceptKubeResults,
  beginKubeRequest,
  chunkPaths,
  dropUnlistedKinds,
  failKubeRequest,
  mergeKubeKinds,
  newTracker,
  planKubeRequests,
  pruneKubeTracker,
  type KubeRequest,
  type KubeTracker
} from './useKubeKinds'

type Kinds = Record<string, KubeFileKind>
const all = (...p: string[]): Set<string> => new Set(p)

// What the hook does when an answer arrives: bookkeeping first, then a pure merge
const arrive = (kinds: Kinds, results: Kinds, req: KubeRequest, t: KubeTracker, listed: Set<string>): Kinds =>
  mergeKubeKinds(kinds, results, acceptKubeResults(req, t, listed))

describe('answer ordering', () => {
  it('a newer result wins over a late older one for the same path', () => {
    const t = newTracker()
    const listed = all('/a.yaml', '/b.yaml')
    const slow = beginKubeRequest(t, ['/a.yaml', '/b.yaml'])
    const fresh = beginKubeRequest(t, ['/a.yaml'])
    let kinds = arrive({}, { '/a.yaml': 'plain' }, fresh, t, listed)
    kinds = arrive(kinds, { '/a.yaml': 'manifest', '/b.yaml': 'manifest' }, slow, t, listed)
    expect(kinds).toEqual({ '/a.yaml': 'plain', '/b.yaml': 'manifest' })
  })

  it('ignores results from an old generation', () => {
    const old = newTracker(1)
    const req = beginKubeRequest(old, ['/a.yaml'])
    const current = newTracker(2)
    expect(acceptKubeResults(req, current, all('/a.yaml'))).toEqual([])
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
    expect(arrive({ '/a.yaml': 'manifest' }, {}, req, t, all('/a.yaml'))).toEqual({})
  })

  it('an answer for a path no longer listed is not applied', () => {
    const t = newTracker()
    const req = beginKubeRequest(t, ['/a.yaml', '/b.yaml'])
    const kinds = arrive({}, { '/a.yaml': 'manifest', '/b.yaml': 'manifest' }, req, t, all('/a.yaml'))
    expect(kinds).toEqual({ '/a.yaml': 'manifest' })
    expect(t.asked.has('/b.yaml')).toBe(false)
  })

  it('the state updater is pure: running it twice keeps the answer', () => {
    const t = newTracker()
    const req = beginKubeRequest(t, ['/a.yaml'])
    const accepted = acceptKubeResults(req, t, all('/a.yaml'))
    const updater = (prev: Kinds): Kinds => mergeKubeKinds(prev, { '/a.yaml': 'manifest' }, accepted)
    const first = updater({})
    expect(updater({})).toEqual(first)
    expect(updater(first)).toEqual({ '/a.yaml': 'manifest' })
    expect(t.asked.has('/a.yaml')).toBe(true)
  })
})

describe('request planning', () => {
  it('does not re-request answered or in-flight paths on a row-list change', () => {
    const t = newTracker()
    const listed = all('/a.yaml', '/b.yaml', '/c.yaml')
    const first = beginKubeRequest(t, ['/a.yaml', '/b.yaml'])
    expect(planKubeRequests(['/a.yaml', '/b.yaml', '/c.yaml'], t)).toEqual(['/c.yaml'])
    arrive({}, { '/a.yaml': 'manifest' }, first, t, listed)
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
    const keep = all('/a.yaml')
    pruneKubeTracker(t, keep)
    expect(dropUnlistedKinds({ '/a.yaml': 'manifest', '/b.yaml': 'plain' }, keep)).toEqual({ '/a.yaml': 'manifest' })
    expect([...t.asked]).toEqual(['/a.yaml'])
  })
})
