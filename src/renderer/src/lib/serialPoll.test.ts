import { describe, it, expect, vi, afterEach } from 'vitest'
import { startSerialPoll } from './serialPoll'

afterEach(() => vi.useRealTimers())

// Phase 6 review C1: a Runtime that answers slowly must still have its answer drawn. One request at a time, the next
// only after the last answered, so the newest request is always the one whose answer comes.
describe('startSerialPoll', () => {
  it('never starts a request while one is pending, and waits the interval after each answer', async () => {
    vi.useFakeTimers()
    let pending = 0
    let max = 0
    let calls = 0
    const resolvers: Array<() => void> = []
    const stop = startSerialPoll(() => {
      calls++
      pending++
      max = Math.max(max, pending)
      return new Promise<void>((r) => resolvers.push(() => (pending--, r())))
    }, 5_000)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(calls).toBe(1)
    resolvers.shift()!()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toBe(2)
    expect(max).toBe(1)
    stop()
    resolvers.shift()!()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(2)
  })
  it('keeps polling after a request that fails', async () => {
    vi.useFakeTimers()
    let calls = 0
    const stop = startSerialPoll(() => {
      calls++
      return Promise.reject(new Error('down'))
    }, 1_000)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(calls).toBe(3)
    stop()
  })
})
