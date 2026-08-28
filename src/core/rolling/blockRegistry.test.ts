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
