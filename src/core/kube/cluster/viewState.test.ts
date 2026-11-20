import { describe, expect, it } from 'vitest'
import { applyPending, contextMissing, initialView, noPending, queueWatch, readMemory, withContext, withSort } from './viewState'
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
