import { describe, it, expect } from 'vitest'
import { BlockRegistry } from './blockRegistry'
import { absorbBlocks, blocksOfChange, parseBlocks } from './blockWire'
import type { BlockRecord } from './retry'

const rec = (at: number | null, since = 0, weekly = false): BlockRecord => ({ at, weekly, since })

describe('blocksOfChange', () => {
  it('기록은 records 로, clear 는 cleared 로 옮긴다', () => {
    expect(blocksOfChange({ accountId: 'a', rec: rec(9, 1), at: 1 })).toEqual({ records: { a: rec(9, 1) }, cleared: [] })
    expect(blocksOfChange({ accountId: 'a', rec: null, at: 7 })).toEqual({ records: {}, cleared: [{ accountId: 'a', at: 7 }] })
  })
})

describe('parseBlocks (R3: 잘못된 값은 던지지 않고 버린다)', () => {
  it('올바른 값은 그대로 읽는다', () => {
    expect(parseBlocks({ t: 'blocks', records: { a: rec(null, 3, true) }, cleared: [{ accountId: 'b', at: 4 }] })).toEqual({
      records: { a: rec(null, 3, true) },
      cleared: [{ accountId: 'b', at: 4 }]
    })
  })

  it('객체가 아니면 null 이다', () => {
    for (const v of [null, undefined, 3, 'x', [1]]) expect(parseBlocks(v)).toBeNull()
  })

  it('잘못된 항목만 버리고 나머지는 읽는다', () => {
    const p = parseBlocks({
      records: {
        ok: rec(10, 1),
        noSince: { at: 1, weekly: false },
        nanAt: { at: Number.NaN, weekly: false, since: 1 },
        infSince: { at: null, weekly: false, since: Number.POSITIVE_INFINITY },
        strWeekly: { at: null, weekly: 'yes', since: 1 },
        notObj: 5,
        '': rec(10, 1)
      },
      cleared: [{ accountId: 'c', at: 2 }, { accountId: 3, at: 2 }, { accountId: 'd', at: 'x' }, null, { accountId: '', at: 1 }]
    })
    expect(p).toEqual({ records: { ok: rec(10, 1) }, cleared: [{ accountId: 'c', at: 2 }] })
  })

  it('records 나 cleared 가 틀린 모양이면 빈 것으로 본다', () => {
    expect(parseBlocks({ records: [1, 2], cleared: 'x' })).toEqual({ records: {}, cleared: [] })
  })

  it('남는 필드는 옮기지 않는다', () => {
    expect(parseBlocks({ records: { a: { ...rec(10, 1), extra: 1 } } })?.records.a).toEqual(rec(10, 1))
  })
})

describe('absorbBlocks', () => {
  it('기록을 흡수하고 clear 를 흡수하되 리스너는 부르지 않는다 (no echo)', () => {
    const r = new BlockRegistry()
    r.record('b', rec(9_000, 1), 0)
    const heard: unknown[] = []
    r.onChange((e) => heard.push(e))
    absorbBlocks(r, { records: { a: rec(5_000, 10) }, cleared: [{ accountId: 'b', at: 20 }] }, 30)
    expect(r.get('a', 30)).toEqual(rec(5_000, 10))
    expect(r.get('b', 30)).toBeNull()
    expect(heard).toEqual([])
  })

  it('clear 를 먼저 적용하므로 같은 메시지 안의 더 새 기록은 남는다', () => {
    const r = new BlockRegistry()
    absorbBlocks(r, { records: { a: rec(5_000, 30) }, cleared: [{ accountId: 'a', at: 20 }] }, 40)
    expect(r.get('a', 40)).toEqual(rec(5_000, 30))
  })

  it('여기서 그 clear 보다 나중에 적힌 기록은 지우지 않는다 (늦게 도착한 clear)', () => {
    const r = new BlockRegistry()
    r.record('a', rec(5_000, 50), 50)
    absorbBlocks(r, { records: {}, cleared: [{ accountId: 'a', at: 20 }] }, 60)
    expect(r.get('a', 60)).toEqual(rec(5_000, 50))
  })
})
