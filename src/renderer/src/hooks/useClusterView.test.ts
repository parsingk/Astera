import { afterEach, describe, expect, it, vi } from 'vitest'
import { REREAD_MS, createRereadThrottle, createSerialRead, customCountsKey, follow, listFailure, liveOf, objectsFor, type WatchState } from './useClusterView'
import type { WatchClient } from '../lib/kubeWatchClient'
import type { WatchMessage } from '../../../core/kube/cluster/types'
import type { K8sObject } from '../../../core/kube/objects'

afterEach(() => vi.useRealTimers())

const FORBIDDEN = 'Error from server (Forbidden): pods is forbidden: User "u" cannot list resource "pods" in API group "" in the namespace "api"'

// Final review M5 and spec 4.3: an object the person may not read never fails the view; its watch's failure is the
// detail's to show, and the tree and table stay as they are.
describe('liveOf', () => {
  it('leaves the view live when only the selected object\'s watch fails', () => {
    expect(liveOf('live', { error: 'Error from server (Forbidden): pods "w-1" is forbidden' })).toBe('live')
    expect(liveOf('live', 'limit')).toBe('limit')
    expect(liveOf('live', 'ended')).toBe('paused')
    expect(liveOf({ error: 'Unable to connect to the server' }, 'live')).toEqual({ error: 'Unable to connect to the server' })
  })

  // Re-review R1 and spec 4.3: a Forbidden kind never fails the view; the table says why it is empty instead.
  it('pauses rather than fails the view when the picked kind\'s list is Forbidden', () => {
    expect(liveOf({ error: FORBIDDEN, forbidden: true }, 'live')).toBe('paused')
  })
})

// Re-review R1: the counts stop while the cluster does not answer, but not for a kind the person may not list; else the
// first round is thrown away and the tree never learns which kinds are Forbidden.
describe('listFailure', () => {
  it('is the list watch\'s failure, except a Forbidden refusal', () => {
    expect(listFailure({ error: 'Unable to connect to the server' })).toEqual({ error: 'Unable to connect to the server' })
    expect(listFailure({ error: FORBIDDEN, forbidden: true })).toBeNull()
    expect(listFailure('live')).toBeNull()
    expect(listFailure('limit')).toBeNull()
  })
})

// Task 15 S2: right after a kind switch the old kind's rows were still drawn and clickable, and selecting one showed a
// Pod as "Deployment web-5968759884-5kdd6" with a false "deleted" banner. The list is kept with the list it belongs to.
describe('objectsFor', () => {
  const key = (resource: string, namespace: string | null = 'api'): string => JSON.stringify({ context: 'c', namespace, namespaced: true, resource })
  const pod: K8sObject = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'web-5968759884-5kdd6', namespace: 'api', uid: 'u-pod' } }
  const pods = { key: key('pods'), value: new Map([['u-pod', pod]]) }

  it('gives the objects listed for the key now picked', () => {
    expect(objectsFor(pods, key('pods')).get('u-pod')).toBe(pod)
  })

  it('gives none of another kind\'s, namespace\'s or context\'s list, so its rows are neither drawn nor selectable', () => {
    expect(objectsFor(pods, key('deployments.apps')).size).toBe(0)
    expect(objectsFor(pods, key('deployments.apps')).get('u-pod')).toBeUndefined()
    expect(objectsFor(pods, key('pods', 'web')).size).toBe(0)
    expect(objectsFor(pods, JSON.stringify({ context: 'other', namespace: 'api', namespaced: true, resource: 'pods' })).size).toBe(0)
  })

  it('gives none before anything is listed or while no list can be picked', () => {
    expect(objectsFor(null, key('pods')).size).toBe(0)
    expect(objectsFor(pods, null).size).toBe(0)
  })
})

describe('follow', () => {
  it('hands on a Forbidden refusal as such', async () => {
    let deliver: ((m: WatchMessage) => void) | null = null
    const client: WatchClient = {
      subscribe: async (_spec, cb) => {
        deliver = cb
        return { ok: true, stop: () => {} }
      }
    }
    const states: WatchState[] = []
    const stop = follow(client, { context: 'c', namespace: 'api', namespaced: true, resource: 'pods' }, () => {}, (s) => void states.push(s))
    await Promise.resolve()
    deliver!({ watchId: 'w', kind: 'error', message: FORBIDDEN, forbidden: true })
    deliver!({ watchId: 'w', kind: 'error', message: 'Unable to connect to the server' })
    expect(states).toEqual(['live', { error: FORBIDDEN, forbidden: true }, { error: 'Unable to connect to the server' }])
    stop()
  })
})

// Final review I4 and spec §11: events, describe and Pods follow the cluster while seen. They are one-shot reads, so a
// change of the selected object reads them again, at most once every REREAD_MS (a crash-looping Pod changes often).
describe('createRereadThrottle', () => {
  function setup() {
    vi.useFakeTimers()
    let reads = 0
    const throttle = createRereadThrottle({
      ms: REREAD_MS,
      now: () => Date.now(),
      later: (fn, ms) => {
        const id = setTimeout(fn, ms)
        return () => clearTimeout(id)
      },
      reread: () => void reads++
    })
    return { throttle, reads: () => reads }
  }

  it('waits out the window after the selection read, then reads once for the latest change', () => {
    const { throttle, reads } = setup()
    throttle.changed()
    expect(reads()).toBe(0)
    vi.advanceTimersByTime(REREAD_MS - 1)
    expect(reads()).toBe(0)
    vi.advanceTimersByTime(1)
    expect(reads()).toBe(1)
  })

  it('reads at once when the last read is old enough, and once at the end of the window for a burst', () => {
    const { throttle, reads } = setup()
    vi.advanceTimersByTime(REREAD_MS * 3)
    throttle.changed()
    expect(reads()).toBe(1)
    throttle.changed()
    throttle.changed()
    throttle.changed()
    vi.advanceTimersByTime(REREAD_MS - 1)
    expect(reads()).toBe(1)
    vi.advanceTimersByTime(1)
    expect(reads()).toBe(2)
  })

  it('reads nothing after stop', () => {
    const { throttle, reads } = setup()
    throttle.changed()
    throttle.stop()
    vi.advanceTimersByTime(REREAD_MS * 5)
    expect(reads()).toBe(0)
  })
})

// Final re-review R2: each re-read tick cancelled the read on its way, so an object that changes faster than a read
// takes (an exec auth plugin) never showed a new answer. One read on its way at a time, and at most one waiting.
describe('createSerialRead', () => {
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  function reads() {
    const answers: Array<{ resolve(v: string): void; reject(e: Error): void }> = []
    const read = (): Promise<string> => new Promise<string>((resolve, reject) => void answers.push({ resolve, reject }))
    return { read, answers }
  }

  it('lets the read on its way answer and apply before the next starts, however many asks came meanwhile', async () => {
    const { read, answers } = reads()
    const applied: string[] = []
    const r = createSerialRead({ read, apply: (v) => void applied.push(v) })
    expect(answers).toHaveLength(1)
    r.again()
    r.again()
    r.again()
    expect(answers).toHaveLength(1)
    answers[0].resolve('first')
    await settle()
    expect(applied).toEqual(['first'])
    expect(answers).toHaveLength(2)
    answers[1].resolve('second')
    await settle()
    expect(applied).toEqual(['first', 'second'])
    expect(answers).toHaveLength(2)
    r.again() // nothing on its way: read at once
    expect(answers).toHaveLength(3)
  })

  it('drops the answer on its way and the ask waiting once stopped', async () => {
    const { read, answers } = reads()
    const applied: string[] = []
    const r = createSerialRead({ read, apply: (v) => void applied.push(v) })
    r.again()
    r.stop()
    answers[0].resolve('late')
    await settle()
    expect(applied).toEqual([])
    expect(answers).toHaveLength(1)
    r.again()
    expect(answers).toHaveLength(1)
  })

  it('reads the waiting ask after a read that failed', async () => {
    const { read, answers } = reads()
    const applied: string[] = []
    const r = createSerialRead({ read, apply: (v) => void applied.push(v) })
    r.again()
    answers[0].reject(new Error('ipc'))
    await settle()
    expect(answers).toHaveLength(2)
    answers[1].resolve('after')
    await settle()
    expect(applied).toEqual(['after'])
  })
})

// Final re-review R6: with the Custom Resources group open, a context switch showed no counts at all until the new
// context's CRDs answered. The fixed kinds are counted at once; the custom kinds join when the CRDs are known.
describe('customCountsKey', () => {
  const widgets = [
    { kind: 'Widget', resource: 'widgets.example.com', namespaced: true },
    { kind: 'Gadget', resource: 'gadgets.example.com', namespaced: false }
  ]

  it('counts the fixed kinds at once while the CRDs of an open group are not known yet', () => {
    expect(customCountsKey(true, false, [])).toBe('')
  })

  it('adds the custom kinds once the CRDs are known, and none while the group is closed', () => {
    expect(customCountsKey(true, true, widgets)).toBe('widgets.example.com,gadgets.example.com')
    expect(customCountsKey(false, true, widgets)).toBe('')
    expect(customCountsKey(false, false, [])).toBe('')
  })
})
