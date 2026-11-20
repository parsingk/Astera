import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RELIST_MAX_MS,
  RELIST_SETTLE_MS,
  applyPending,
  contextMissing,
  createWatchBatcher,
  initialView,
  mergeCounts,
  noPending,
  queueWatch,
  readMemory,
  withContext,
  withSort,
  type PendingWatch
} from './viewState'
import type { K8sObject } from '../objects'
import type { KubeContexts } from '../types'

const contexts: KubeContexts = { current: 'kind-a', contexts: [{ name: 'kind-a', namespace: 'api', cluster: 'a', provider: null }] }
const pod = (uid: string, phase = 'Running'): K8sObject => ({ apiVersion: 'v1', kind: 'Pod', metadata: { name: `p-${uid}`, uid }, status: { phase } })

describe('cluster view state', () => {
  it('starts on the current context and its namespace', () => {
    expect(initialView(null, contexts)).toMatchObject({ context: 'kind-a', namespace: 'api', resource: 'pods', expanded: ['workloads'], detailTab: 'summary' })
  })
  it('starts on default when the current context names no namespace', () => {
    const bare: KubeContexts = { current: 'b', contexts: [{ name: 'b', namespace: null, cluster: 'b', provider: null }] }
    expect(initialView(null, bare)).toMatchObject({ context: 'b', namespace: 'default', sort: { by: 0, dir: 'asc' } })
  })
  it('a remembered context that is gone stays selected and is reported missing', () => {
    const s = initialView({ context: 'gone', namespace: null }, contexts)
    expect(s.context).toBe('gone')
    expect(contextMissing(s, contexts)).toBe(true)
    expect(contextMissing(initialView(null, contexts), contexts)).toBe(false)
  })
  it('reads memory tolerantly', () => {
    expect(readMemory('{"context":"x","namespace":null}')).toEqual({ context: 'x', namespace: null })
    expect(readMemory('{"context":"x","namespace":"api"}')).toEqual({ context: 'x', namespace: 'api' })
    expect(readMemory('nope')).toBeNull()
    expect(readMemory(null)).toBeNull()
    expect(readMemory('{"context":5,"namespace":null}')).toBeNull()
    expect(readMemory('{"context":"x","namespace":5}')).toBeNull()
    expect(readMemory('null')).toBeNull()
  })
  it('a picked context takes its own namespace and drops what belonged to the other cluster', () => {
    const other: KubeContexts = { ...contexts, contexts: [...contexts.contexts, { name: 'prod', namespace: null, cluster: 'p', provider: null }] }
    const s = { ...initialView(null, other), resource: 'widgets.example.com', selected: 'u1', sort: { by: 2, dir: 'desc' as const }, filter: 'web' }
    expect(withContext(s, 'prod', other)).toMatchObject({ context: 'prod', namespace: 'default', resource: 'pods', selected: null, sort: { by: 0, dir: 'asc' }, filter: 'web' })
    expect(withContext({ ...s, resource: 'services' }, 'kind-a', other)).toMatchObject({ namespace: 'api', resource: 'services' })
  })
  it('sorting the sorted column flips it, another column sorts ascending', () => {
    const s = initialView(null, contexts)
    expect(withSort(s, 0).sort).toEqual({ by: 0, dir: 'desc' })
    expect(withSort(withSort(s, 0), 0).sort).toEqual({ by: 0, dir: 'asc' })
    expect(withSort(withSort(s, 0), 3).sort).toEqual({ by: 3, dir: 'asc' })
  })
})

describe('watch bursts', () => {
  it('a burst gives what the events one by one give', () => {
    const start = new Map([['1', pod('1')], ['2', pod('2')]])
    const events = [
      { type: 'MODIFIED' as const, object: pod('1', 'Failed') },
      { type: 'ADDED' as const, object: pod('3') },
      { type: 'DELETED' as const, object: pod('2') },
      { type: 'MODIFIED' as const, object: pod('3', 'Pending') }
    ]
    const p = noPending()
    for (const e of events) queueWatch(p, e)
    expect([...applyPending(start, p)]).toEqual([['1', pod('1', 'Failed')], ['3', pod('3', 'Pending')]])
    expect(p.changes.size).toBe(3)
    expect(start.size).toBe(2)

    const again = [
      { type: 'ADDED' as const, object: pod('a') },
      { type: 'ADDED' as const, object: pod('b') },
      { type: 'MODIFIED' as const, object: pod('a', 'Failed') }
    ]
    const q = noPending()
    for (const e of again) queueWatch(q, e)
    expect([...applyPending(new Map(), q)]).toEqual([['a', pod('a', 'Failed')], ['b', pod('b')]])
  })
  it('a resync in a burst drops the list and what came before it', () => {
    const start = new Map([['1', pod('1')]])
    const p = noPending()
    queueWatch(p, { type: 'ADDED', object: pod('2') })
    queueWatch(p, 'resync')
    queueWatch(p, { type: 'ADDED', object: pod('3') })
    expect([...applyPending(start, p).keys()]).toEqual(['3'])
  })
})

// Final review I3: a relist (refresh, the view seen again, a watch restarted) arrives as many messages over several
// frames; applied as they came, a big namespace's table shrank to the first objects and filled up again.
describe('watch batcher', () => {
  afterEach(() => vi.useRealTimers())
  const ev = (uid: string) => ({ type: 'ADDED' as const, object: pod(uid) })
  function setup() {
    vi.useFakeTimers()
    const applied: PendingWatch[] = []
    const timer = (fn: () => void, ms: number): (() => void) => {
      const id = setTimeout(fn, ms)
      return () => clearTimeout(id)
    }
    const b = createWatchBatcher({ apply: (p) => void applied.push(p), frame: (fn) => timer(fn, 16), later: timer })
    return { b, applied }
  }

  it('applies live changes once per frame', () => {
    const { b, applied } = setup()
    b.push(ev('1'))
    b.push(ev('2'))
    expect(applied).toHaveLength(0)
    vi.advanceTimersByTime(16)
    expect(applied.map((p) => [p.reset, [...p.changes.keys()]])).toEqual([[false, ['1', '2']]])
  })

  it('keeps the old rows through a relist and swaps them in one step once it goes quiet', () => {
    const { b, applied } = setup()
    b.push('resync')
    vi.advanceTimersByTime(5_000) // kubectl starting up: nothing yet, and the old rows stay
    expect(applied).toHaveLength(0)
    for (const uid of ['1', '2', '3']) {
      b.push(ev(uid))
      vi.advanceTimersByTime(RELIST_SETTLE_MS - 50)
    }
    expect(applied).toHaveLength(0)
    vi.advanceTimersByTime(50)
    expect(applied.map((p) => [p.reset, [...p.changes.keys()]])).toEqual([[true, ['1', '2', '3']]])
    b.push(ev('4'))
    vi.advanceTimersByTime(16) // live again: once per frame
    expect(applied.map((p) => p.reset)).toEqual([true, false])
  })

  it('swaps a relist that never goes quiet after RELIST_MAX_MS', () => {
    const { b, applied } = setup()
    b.push('resync')
    for (let i = 0; i * 100 < RELIST_MAX_MS; i++) {
      b.push(ev(String(i)))
      vi.advanceTimersByTime(100)
    }
    expect(applied).toHaveLength(1)
    expect(applied[0].reset).toBe(true)
  })

  it('a resync drops a frame already scheduled, and stop drops everything', () => {
    const { b, applied } = setup()
    b.push(ev('1'))
    b.push('resync')
    vi.advanceTimersByTime(10_000)
    expect(applied).toHaveLength(0)
    b.push(ev('2'))
    b.stop()
    vi.advanceTimersByTime(10_000)
    expect(applied).toHaveLength(0)
  })
})

// Final review I1: a read that could not count a kind keeps the count last read, greyed, rather than a false 0 or a lost
// problem dot.
describe('counts across reads', () => {
  it('keeps the last count, greyed, for a kind the new read could not count', () => {
    const prev = { pods: { count: 3, attention: true }, secrets: { count: 1, attention: false } }
    expect(mergeCounts(prev, { pods: { count: null, attention: false }, secrets: { count: 2, attention: false } })).toEqual({
      pods: { count: 3, attention: true, stale: true },
      secrets: { count: 2, attention: false }
    })
    expect(mergeCounts({ pods: { count: 3, attention: true, stale: true } }, { pods: { count: null, attention: false } })).toEqual({
      pods: { count: 3, attention: true, stale: true }
    })
  })
  it('leaves a kind never counted unknown, and a Forbidden kind forbidden', () => {
    expect(mergeCounts(null, { pods: { count: null, attention: false } })).toEqual({ pods: { count: null, attention: false } })
    const forbidden = { count: null, attention: false, forbidden: 'secrets is forbidden' }
    expect(mergeCounts({ secrets: { count: 1, attention: false } }, { secrets: forbidden })).toEqual({ secrets: forbidden })
    expect(mergeCounts({ secrets: forbidden }, { secrets: { count: null, attention: false } })).toEqual({ secrets: { count: null, attention: false } })
  })
  it('holds only the kinds the new read asked for', () => {
    expect(mergeCounts({ 'widgets.a.io': { count: 2, attention: false } }, { pods: { count: 1, attention: false } })).toEqual({ pods: { count: 1, attention: false } })
  })
})
