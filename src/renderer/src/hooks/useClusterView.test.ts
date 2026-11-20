import { afterEach, describe, expect, it, vi } from 'vitest'
import { REREAD_MS, createRereadThrottle } from './useClusterView'

afterEach(() => vi.useRealTimers())

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
