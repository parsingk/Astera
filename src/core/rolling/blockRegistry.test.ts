import { describe, it, expect } from 'vitest'
import { BlockRegistry } from './blockRegistry'
import type { BlockRecord } from './retry'

const rec = (at: number | null, since = 0, weekly = false): BlockRecord => ({ at, weekly, since })

describe('BlockRegistry', () => {
  it('적은 것을 그대로 돌려준다', () => {
    const r = new BlockRegistry()
    r.record('a', rec(1_000), 0)
    expect(r.get('a', 0)).toEqual(rec(1_000))
  })

  it('모르는 계정은 null 이다', () => {
    expect(new BlockRegistry().get('a', 0)).toBeNull()
  })

  it('만료된 기록은 없는 것과 같다', () => {
    const r = new BlockRegistry()
    r.record('a', rec(1_000), 0)
    expect(r.get('a', 1_001)).toBeNull()
  })

  it('두 번 적히면 더 늦게까지 막히는 쪽이 남는다', () => {
    const r = new BlockRegistry()
    r.record('a', rec(5_000), 0)
    r.record('a', rec(1_000), 0) // 더 이른 것은 이기지 못한다
    expect(r.get('a', 0)).toEqual(rec(5_000))
    r.record('a', rec(9_000), 0)
    expect(r.get('a', 0)).toEqual(rec(9_000))
  })

  it('리셋 시각을 아는 기록이 모르는 기록을 이긴다', () => {
    const r = new BlockRegistry()
    // 모르는 기록은 since + RETRY_FALLBACK_MS(15분) 까지만 막는다
    r.record('a', rec(null, 0), 0)
    r.record('a', rec(3 * 60 * 60_000, 0), 0) // 3시간
    expect(r.get('a', 0)?.at).toBe(3 * 60 * 60_000)
  })

  it('clear 는 그 계정만 지운다', () => {
    const r = new BlockRegistry()
    r.record('a', rec(5_000), 0)
    r.record('b', rec(5_000), 0)
    r.clear('a')
    expect(r.get('a', 0)).toBeNull()
    expect(r.get('b', 0)).toEqual(rec(5_000))
  })

  it('만료된 기록은 다음 쓰기에서 정리된다 (무한히 쌓이지 않는다)', () => {
    const r = new BlockRegistry()
    r.record('a', rec(1_000), 0)
    r.record('b', rec(9_000), 2_000) // a 는 이 시점에 이미 만료
    expect(r.size).toBe(1)
  })
})

describe('BlockRegistry — onChange / absorb / absorbClear', () => {
  it('record 는 합쳐진 값으로 리스너를 부른다 (merge)', () => {
    const r = new BlockRegistry()
    const events: Array<{ accountId: string; rec: BlockRecord | null; at: number }> = []
    r.onChange((e) => events.push(e))
    r.record('a', rec(5_000), 0)
    r.record('a', rec(1_000), 7) // 더 이른 것은 이기지 못한다 — 그래도 통지는 합쳐진 값(5_000)으로 온다
    expect(events).toEqual([
      { accountId: 'a', rec: rec(5_000), at: 0 },
      { accountId: 'a', rec: rec(5_000), at: 7 },
    ])
  })

  it('clear 는 null 로 리스너를 부른다', () => {
    const r = new BlockRegistry()
    const events: Array<{ accountId: string; rec: BlockRecord | null; at: number }> = []
    r.record('a', rec(5_000), 0)
    r.onChange((e) => events.push(e))
    r.clear('a', 3_000)
    expect(events).toEqual([{ accountId: 'a', rec: null, at: 3_000 }])
  })

  it('absorb 는 실제로 합치지만 리스너는 부르지 않는다 (no echo)', () => {
    const r = new BlockRegistry()
    const events: unknown[] = []
    r.onChange((e) => events.push(e))
    r.absorb('a', rec(5_000), 0)
    expect(events).toEqual([])
    expect(r.get('a', 0)).toEqual(rec(5_000))
  })

  it('absorbClear 는 지우기만 하고 리스너는 부르지 않는다', () => {
    const r = new BlockRegistry()
    const events: unknown[] = []
    r.record('a', rec(5_000), 0)
    r.onChange((e) => events.push(e))
    r.absorbClear('a', 1_000)
    expect(events).toEqual([])
    expect(r.get('a', 0)).toBeNull()
  })

  it('clear 뒤에 도착한, 그보다 오래된 원격 기록은 무시한다 (로컬 clear → absorb)', () => {
    const r = new BlockRegistry()
    r.record('a', rec(5_000), 0)
    r.clear('a', 1_000) // 로컬 clear, 1_000 을 기억
    r.absorb('a', rec(9_000, 500), 2_000) // since=500 은 clear(1_000) 이전 → 무시
    expect(r.get('a', 2_000)).toBeNull()
  })

  it('absorbClear 뒤에 도착한, 그보다 오래된 원격 기록도 무시한다 (원격 clear → absorb)', () => {
    const r = new BlockRegistry()
    r.record('a', rec(5_000), 0)
    r.absorbClear('a', 1_000) // 원격 clear, 1_000 을 기억
    r.absorb('a', rec(9_000, 500), 2_000) // since=500 은 clear(1_000) 이전 → 무시
    expect(r.get('a', 2_000)).toBeNull()
  })

  it('clear 시각보다 늦은 since 를 가진 원격 기록은 무시하지 않는다', () => {
    const r = new BlockRegistry()
    r.clear('a', 1_000)
    r.absorb('a', rec(9_000, 1_500), 2_000) // since=1_500 > clear(1_000) → 살아있다
    expect(r.get('a', 2_000)).toEqual(rec(9_000, 1_500))
  })

  it('clear 뒤라도 새로운 로컬 record 는 그대로 먹는다', () => {
    const r = new BlockRegistry()
    r.record('a', rec(5_000), 0)
    r.clear('a', 1_000)
    r.record('a', rec(9_000, 2_000), 2_000) // 로컬 record 는 clear 시각과 무관하게 항상 적용된다
    expect(r.get('a', 2_000)).toEqual(rec(9_000, 2_000))
  })

  it('리스너가 던져도 record/clear 는 끝까지 실행되고 다른 리스너도 불린다', () => {
    const r = new BlockRegistry()
    const calls: string[] = []
    r.onChange(() => {
      throw new Error('boom')
    })
    r.onChange(() => calls.push('second'))

    expect(() => r.record('a', rec(5_000), 0)).not.toThrow()
    expect(calls).toEqual(['second'])
    expect(r.get('a', 0)).toEqual(rec(5_000))

    calls.length = 0
    expect(() => r.clear('a', 1_000)).not.toThrow()
    expect(calls).toEqual(['second'])
  })

  it('구독 해지 함수는 그 리스너만 더는 부르지 않는다', () => {
    const r = new BlockRegistry()
    const calls: unknown[] = []
    const unsubscribe = r.onChange((e) => calls.push(e))
    r.record('a', rec(1_000), 0)
    expect(calls.length).toBe(1)
    unsubscribe()
    r.record('a', rec(2_000), 100)
    expect(calls.length).toBe(1)
  })
})

describe('BlockRegistry — snapshot (Task 3)', () => {
  it('살아 있는 기록과 기억하는 clear 시각을 모두 돌려준다', () => {
    const r = new BlockRegistry()
    r.record('a', rec(5_000, 10), 0)
    r.record('b', rec(1_000, 10), 0)
    r.clear('c', 20)
    expect(r.snapshot(2_000)).toEqual({ records: { a: rec(5_000, 10) }, cleared: [{ accountId: 'c', at: 20 }] })
  })

  it('비어 있으면 빈 값을 돌려준다', () => {
    expect(new BlockRegistry().snapshot(0)).toEqual({ records: {}, cleared: [] })
  })
})

describe('BlockRegistry — noteCleared (Task 3 수정 1차)', () => {
  it('기록은 지우지 않고 clear 시각만 더 늦은 쪽으로 올린다', () => {
    const r = new BlockRegistry()
    r.record('a', rec(5_000, 50), 50)
    const heard: unknown[] = []
    r.onChange((e) => heard.push(e))
    r.noteCleared('a', 20)
    expect(r.get('a', 60)).toEqual(rec(5_000, 50))
    expect(r.snapshot(60).cleared).toEqual([{ accountId: 'a', at: 20 }])
    r.noteCleared('a', 10) // 더 이른 시각은 내리지 않는다
    expect(r.snapshot(60).cleared).toEqual([{ accountId: 'a', at: 20 }])
    r.absorb('a', rec(9_000, 15), 60) // 15 <= 20: 무시된다
    expect(r.get('a', 60)).toEqual(rec(5_000, 50))
    expect(heard).toEqual([])
  })
})
