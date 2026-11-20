import { describe, expect, it } from 'vitest'
import { createWatchClient } from './kubeWatchClient'
import type { WatchMessage, WatchSpec } from '../../../core/kube/cluster/types'

const spec: WatchSpec = { context: 'c1', namespace: 'api', namespaced: true, resource: 'pods' }
const event = (watchId: string, name: string): WatchMessage => ({
  watchId,
  kind: 'event',
  event: { type: 'ADDED', object: { apiVersion: 'v1', kind: 'Pod', metadata: { name } } }
})

/** A stand-in for window.api: an emitter for 'kube:watch', and watch answers chosen per test. */
function fakeApi(answer: { ok: true } | { ok: false; reason: 'limit' } = { ok: true }) {
  const listeners = new Set<(m: WatchMessage) => void>()
  const watched: string[] = []
  const unwatched: string[] = []
  let beforeAnswer: (() => void) | null = null
  return {
    api: {
      async watch(id: string) {
        watched.push(id)
        beforeAnswer?.()
        return answer
      },
      async unwatch(id: string) {
        unwatched.push(id)
      },
      on(cb: (m: WatchMessage) => void) {
        listeners.add(cb)
        return () => void listeners.delete(cb)
      }
    },
    emit: (m: WatchMessage) => [...listeners].forEach((cb) => cb(m)),
    listeners,
    watched,
    unwatched,
    onWatch: (fn: () => void) => void (beforeAnswer = fn)
  }
}

const ids = (...list: string[]) => {
  let i = 0
  return () => list[i++]
}

describe('createWatchClient', () => {
  it('routes messages by id and drops them after stop', async () => {
    const f = fakeApi()
    const client = createWatchClient(f.api, ids('A', 'B'))
    const gotA: WatchMessage[] = []
    const gotB: WatchMessage[] = []
    const a = await client.subscribe(spec, (m) => gotA.push(m))
    const b = await client.subscribe({ ...spec, name: 'web-1' }, (m) => gotB.push(m))
    expect(a.ok && b.ok).toBe(true)
    expect(f.watched).toEqual(['A', 'B'])

    f.emit(event('A', 'a1'))
    f.emit(event('B', 'b1'))
    f.emit(event('other', 'x'))
    expect(gotA).toEqual([event('A', 'a1')])
    expect(gotB).toEqual([event('B', 'b1')])

    if (a.ok) a.stop()
    expect(f.unwatched).toEqual(['A'])
    f.emit(event('A', 'late'))
    f.emit({ watchId: 'A', kind: 'error', message: 'late' })
    f.emit(event('B', 'b2'))
    expect(gotA).toEqual([event('A', 'a1')])
    expect(gotB).toEqual([event('B', 'b1'), event('B', 'b2')])

    if (a.ok) a.stop()
    expect(f.unwatched).toEqual(['A'])
  })

  it('passes a limit refusal through', async () => {
    const f = fakeApi({ ok: false, reason: 'limit' })
    const client = createWatchClient(f.api, ids('A'))
    const got: WatchMessage[] = []
    expect(await client.subscribe(spec, (m) => got.push(m))).toEqual({ ok: false, reason: 'limit' })
    f.emit(event('A', 'a1'))
    expect(got).toEqual([])
    expect(f.unwatched).toEqual([])
    expect(f.listeners.size).toBe(0)
  })

  it('delivers messages that come before the watch answers', async () => {
    const f = fakeApi()
    const client = createWatchClient(f.api, ids('A'))
    const got: WatchMessage[] = []
    f.onWatch(() => f.emit(event('A', 'early')))
    await client.subscribe(spec, (m) => got.push(m))
    expect(got).toEqual([event('A', 'early')])
  })

  it('listens only while something is subscribed', async () => {
    const f = fakeApi()
    const client = createWatchClient(f.api, ids('A', 'B'))
    expect(f.listeners.size).toBe(0)
    const a = await client.subscribe(spec, () => {})
    const b = await client.subscribe(spec, () => {})
    expect(f.listeners.size).toBe(1)
    if (a.ok) a.stop()
    expect(f.listeners.size).toBe(1)
    if (b.ok) b.stop()
    expect(f.listeners.size).toBe(0)
  })
})
