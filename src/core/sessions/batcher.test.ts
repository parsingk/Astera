import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { DataBatcher } from './batcher'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('DataBatcher', () => {
  it('flushMs 안의 push를 세션별 한 건으로 합쳐 emit한다', () => {
    const emitted: [string, string][] = []
    const batcher = new DataBatcher(16, (id, data) => emitted.push([id, data]))
    batcher.push('s1', 'a')
    batcher.push('s1', 'b')
    batcher.push('s2', 'x')
    expect(emitted).toEqual([])
    vi.advanceTimersByTime(16)
    expect(emitted).toEqual([
      ['s1', 'ab'],
      ['s2', 'x']
    ])
  })

  it('flush()는 타이머를 기다리지 않고 즉시 내보낸다', () => {
    const emitted: [string, string][] = []
    const batcher = new DataBatcher(16, (id, data) => emitted.push([id, data]))
    batcher.push('s1', 'now')
    batcher.flush()
    expect(emitted).toEqual([['s1', 'now']])
    vi.advanceTimersByTime(16)
    expect(emitted).toEqual([['s1', 'now']]) // 중복 emit 없음
  })

  it('dispose 후에는 emit하지 않는다', () => {
    const emitted: [string, string][] = []
    const batcher = new DataBatcher(16, (id, data) => emitted.push([id, data]))
    batcher.push('s1', 'zzz')
    batcher.dispose()
    vi.advanceTimersByTime(100)
    expect(emitted).toEqual([])
  })
})
