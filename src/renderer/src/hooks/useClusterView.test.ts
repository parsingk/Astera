import { afterEach, describe, expect, it, vi } from 'vitest'
import { REREAD_MS, createRereadThrottle, follow, listFailure, liveOf, type WatchState } from './useClusterView'
import type { WatchClient } from '../lib/kubeWatchClient'
import type { WatchMessage } from '../../../core/kube/cluster/types'

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
