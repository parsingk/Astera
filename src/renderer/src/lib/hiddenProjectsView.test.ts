import { describe, expect, it } from 'vitest'
import { viewOf } from './hiddenProjectsView'

const paths = (n: number): string[] => Array.from({ length: n }, (_, i) => `D:\\p\\proj-${i}`)

describe('viewOf', () => {
  it('검색어가 비면 전부 대상으로 두고 첫 페이지만 잘라 준다', () => {
    const v = viewOf(paths(20), '', 0, 8)
    expect(v.rows).toEqual(paths(20).slice(0, 8))
    expect(v.total).toBe(20)
    expect(v.matched).toBe(20)
    expect(v.pages).toBe(3)
    expect(v.page).toBe(0)
  })

  it('마지막 페이지는 남은 만큼만 준다', () => {
    expect(viewOf(paths(20), '', 2, 8).rows).toEqual(paths(20).slice(16))
  })

  it('검색어는 경로 일부와 부분 일치한다', () => {
    const v = viewOf(['D:\\work\\alpha', 'D:\\work\\beta', 'C:\\other\\alpha'], 'work', 0, 8)
    expect(v.rows).toEqual(['D:\\work\\alpha', 'D:\\work\\beta'])
    expect(v.matched).toBe(2)
    expect(v.total).toBe(3) // total 은 검색과 무관하게 숨긴 전체 개수다
  })

  it('검색어의 대소문자는 무시한다', () => {
    expect(viewOf(['D:\\Work\\Alpha'], 'work\\alpha', 0, 8).rows).toEqual(['D:\\Work\\Alpha'])
  })

  // 사용자가 경로를 어느 구분자로 치는지는 그때그때 다르다 — 표시용 필터에서 그것 때문에 안 잡히면
  // 목록에 있는데도 없는 것처럼 보인다
  it('경로 구분자 표기가 달라도 같은 경로로 본다', () => {
    expect(viewOf(['D:\\work\\alpha'], 'd:/work', 0, 8).rows).toEqual(['D:\\work\\alpha'])
    expect(viewOf(['D:/work/alpha'], 'd:\\work', 0, 8).rows).toEqual(['D:/work/alpha'])
  })

  it('검색어 앞뒤 공백은 무시한다', () => {
    expect(viewOf(['D:\\work\\alpha'], '  alpha  ', 0, 8).matched).toBe(1)
  })

  it('검색어에 일치하는 것이 없으면 빈 목록에 matched 0 이다', () => {
    const v = viewOf(paths(20), 'nothing-like-this', 0, 8)
    expect(v.rows).toEqual([])
    expect(v.matched).toBe(0)
    expect(v.pages).toBe(1) // 페이지가 0이면 '0 / 0' 이 되므로 빈 결과도 한 장으로 센다
    expect(v.page).toBe(0)
  })

  it('페이지 수는 검색 결과 기준으로 센다', () => {
    const all = [...paths(20), 'D:\\q\\only-one']
    expect(viewOf(all, 'only-one', 0, 8).pages).toBe(1)
  })

  // 마지막 페이지의 마지막 항목을 해제하면 page 가 범위 밖으로 남는다. 컴포넌트가 effect 로 뒤늦게
  // 되돌리면 한 프레임 빈 목록이 보이므로, 렌더 시점에 이미 잡아 준 값을 돌려준다.
  it('페이지가 범위를 넘으면 마지막 페이지로 잡아 준다', () => {
    const v = viewOf(paths(9), '', 5, 8)
    expect(v.page).toBe(1)
    expect(v.rows).toEqual(['D:\\p\\proj-8'])
  })

  it('음수 페이지는 첫 페이지로 잡아 준다', () => {
    const v = viewOf(paths(9), '', -3, 8)
    expect(v.page).toBe(0)
    expect(v.rows).toEqual(paths(9).slice(0, 8))
  })

  it('목록이 비면 빈 결과에 한 페이지를 돌려준다', () => {
    expect(viewOf([], '', 0, 8)).toEqual({ rows: [], page: 0, pages: 1, total: 0, matched: 0, matchedAll: [] })
  })

  it('페이지 크기와 정확히 같은 개수는 한 페이지다', () => {
    expect(viewOf(paths(8), '', 0, 8).pages).toBe(1)
  })

  it('원본 배열의 순서를 유지한다', () => {
    const v = viewOf(['D:\\z\\last', 'D:\\a\\first'], '', 0, 8)
    expect(v.rows).toEqual(['D:\\z\\last', 'D:\\a\\first'])
  })

  // '보이는 것 모두 선택'은 현재 페이지가 아니라 검색으로 좁힌 결과 전체를 고른다 — 검색해 놓고
  // 페이지마다 다시 눌러야 한다면 좁힌 뜻이 없다
  it('matchedAll 은 페이지에 걸리지 않은 것까지 검색 결과 전체를 준다', () => {
    const v = viewOf(paths(20), '', 0, 8)
    expect(v.rows).toHaveLength(8)
    expect(v.matchedAll).toEqual(paths(20))
  })

  it('matchedAll 은 검색으로 걸러진 것만 담는다', () => {
    const v = viewOf(['D:\\work\\alpha', 'D:\\work\\beta', 'C:\\other\\gamma'], 'work', 0, 8)
    expect(v.matchedAll).toEqual(['D:\\work\\alpha', 'D:\\work\\beta'])
  })

  it('검색 결과가 없으면 matchedAll 도 비어 있다', () => {
    expect(viewOf(paths(20), 'nope', 0, 8).matchedAll).toEqual([])
  })

})
