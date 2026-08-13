import { describe, it, expect } from 'vitest'
import { reorder } from './reorder'

describe('reorder', () => {
  const L = ['A', 'B', 'C', 'D']

  it('앞 항목을 뒤쪽 위치 앞으로 이동', () => {
    expect(reorder(L, 0, 3)).toEqual(['B', 'C', 'A', 'D']) // A를 D 앞(인덱스3)으로
  })

  it('뒤 항목을 맨 앞으로 이동', () => {
    expect(reorder(L, 3, 0)).toEqual(['D', 'A', 'B', 'C'])
  })

  it('중간 항목을 맨 뒤(insertBefore=length)로 이동', () => {
    expect(reorder(L, 1, 4)).toEqual(['A', 'C', 'D', 'B'])
  })

  it('자기 자리(insertBefore=fromIndex)는 no-op', () => {
    expect(reorder(L, 1, 1)).toEqual(L)
  })

  it('자기 바로 뒤(insertBefore=fromIndex+1)도 no-op', () => {
    expect(reorder(L, 1, 2)).toEqual(L)
  })

  it('원본을 변경하지 않는다(불변)', () => {
    const copy = [...L]
    reorder(L, 0, 3)
    expect(L).toEqual(copy)
  })

  it('범위 밖 인덱스는 원본 얕은 복사 반환', () => {
    expect(reorder(L, -1, 2)).toEqual(L)
    expect(reorder(L, 5, 2)).toEqual(L)
    expect(reorder(L, 0, -1)).toEqual(L)
    expect(reorder(L, 0, 99)).toEqual(L)
  })
})
