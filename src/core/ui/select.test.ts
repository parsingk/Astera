import { describe, it, expect } from 'vitest'
import { groupRowsOf, menuPlacement, nextCursor, type SelectItem } from './select'

const it_ = (value: string, group?: string): SelectItem => ({ value, label: value, group })

describe('nextCursor', () => {
  it('아래로 한 칸 움직인다', () => {
    expect(nextCursor(0, 3, 1)).toBe(1)
  })

  it('마지막에서 아래로 가면 처음으로 감싼다', () => {
    expect(nextCursor(2, 3, 1)).toBe(0)
  })

  it('처음에서 위로 가면 마지막으로 감싼다', () => {
    // 음수 나머지를 그대로 쓰면 -1이 되어 아무 항목도 가리키지 못한다
    expect(nextCursor(0, 3, -1)).toBe(2)
  })

  it('항목이 없으면 0에 머문다 — 0으로 나누지 않는다', () => {
    expect(nextCursor(0, 0, 1)).toBe(0)
    expect(nextCursor(0, 0, -1)).toBe(0)
  })

  it('항목이 하나면 항상 그 항목이다', () => {
    expect(nextCursor(0, 1, 1)).toBe(0)
    expect(nextCursor(0, 1, -1)).toBe(0)
  })

  it('범위를 벗어난 커서에서도 유효한 값을 낸다', () => {
    // 목록이 줄어든 뒤 커서가 남아 있는 경우 — 렌더가 빈 항목을 짚지 않아야 한다
    expect(nextCursor(9, 3, 1)).toBe(1)
    expect(nextCursor(-4, 3, 1)).toBe(0)
  })
})

describe('groupRowsOf', () => {
  it('그룹이 없으면 제목을 넣지 않는다', () => {
    const rows = groupRowsOf([it_('a'), it_('b')])
    expect(rows.map((r) => r.kind)).toEqual(['option', 'option'])
  })

  it('그룹이 바뀌는 지점마다 제목을 넣는다', () => {
    const rows = groupRowsOf([it_('a', '원격'), it_('b', '원격'), it_('c', '로컬')])
    expect(rows.map((r) => (r.kind === 'group' ? `#${r.label}` : r.item.value))).toEqual([
      '#원격',
      'a',
      'b',
      '#로컬',
      'c'
    ])
  })

  it('그룹 없는 항목이 앞에 오고 그 뒤에 그룹이 시작될 수 있다', () => {
    // 브랜치 선택의 모양 — '현재 브랜치'는 그룹 밖에 있고 그 뒤로 원격·로컬이 온다
    const rows = groupRowsOf([it_('develop'), it_('origin/main', '원격'), it_('main', '로컬')])
    expect(rows.map((r) => (r.kind === 'group' ? `#${r.label}` : r.item.value))).toEqual([
      'develop',
      '#원격',
      'origin/main',
      '#로컬',
      'main'
    ])
  })

  it('같은 그룹이 떨어져 다시 나오면 제목도 다시 넣는다', () => {
    // 정렬을 신뢰하고 그대로 그린다 — 목록을 재배치하지 않는다
    const rows = groupRowsOf([it_('a', 'X'), it_('b', 'Y'), it_('c', 'X')])
    expect(rows.filter((r) => r.kind === 'group').length).toBe(3)
  })

  it('option 행은 항목의 인덱스를 그대로 들고 있다 — 커서가 이 인덱스를 쓴다', () => {
    const items = [it_('a', '원격'), it_('b', '로컬')]
    const rows = groupRowsOf(items)
    const opts = rows.flatMap((r) => (r.kind === 'option' ? [r.index] : []))
    expect(opts).toEqual([0, 1])
  })

  it('빈 목록은 빈 행', () => {
    expect(groupRowsOf([])).toEqual([])
  })
})

describe('menuPlacement', () => {
  // 트리거와 잘림 상자(스크롤 컨테이너의 보이는 영역, 또는 창)의 좌표는 같은 공간에서 온다 —
  // 컴포넌트가 getBoundingClientRect 로 재서 넘긴다.
  const clip = { top: 162, bottom: 594 }

  it('아래에 자리가 있으면 아래로 연다', () => {
    expect(menuPlacement({ top: 200, bottom: 230 }, clip, 240, 4)).toEqual({ side: 'below', maxHeight: null })
  })

  it('아래가 부족하고 위가 넉넉하면 위로 뒤집는다', () => {
    // 실제 버그: 설정 일반 탭 맨 아래의 폰트 드롭다운. 아래 여유 20px, 위 여유 374px,
    // 메뉴 240px — 240 중 22px 만 보였다.
    expect(menuPlacement({ top: 540, bottom: 570 }, clip, 240, 4)).toEqual({ side: 'above', maxHeight: null })
  })

  it('메뉴 높이가 아래 여유와 정확히 같으면 아래에 그대로 둔다', () => {
    // 경계에서 굳이 뒤집지 않는다 — 아래가 기본 방향이다
    expect(menuPlacement({ top: 300, bottom: 350 }, clip, 240, 4)).toEqual({ side: 'below', maxHeight: null })
  })

  it('양쪽 다 부족하면 더 넓은 쪽으로 열고 그 여유만큼 높이를 자른다', () => {
    // 위 138, 아래 132 → 위쪽이 넓다
    expect(menuPlacement({ top: 304, bottom: 458 }, clip, 240, 4)).toEqual({ side: 'above', maxHeight: 138 })
  })

  it('아래가 더 넓으면 부족해도 아래를 고른다', () => {
    // 위 34, 아래 236
    expect(menuPlacement({ top: 200, bottom: 354 }, clip, 240, 4)).toEqual({ side: 'below', maxHeight: 236 })
  })

  it('트리거가 잘림 상자 아래로 밀려나 있으면 위로 열고 자르지 않는다', () => {
    // 스크롤 도중 트리거가 보이는 영역을 벗어난 상태. 위쪽 여유는 534px 로 메뉴가 그대로 들어간다
    expect(menuPlacement({ top: 700, bottom: 730 }, clip, 240, 4)).toEqual({ side: 'above', maxHeight: null })
  })

  it('양쪽 여유가 음수인 자리에서도 높이는 0 아래로 내려가지 않는다', () => {
    // 잘림 상자가 트리거만큼 얕은 극단 — 음수 max-height 는 CSS 에서 무효값이라 렌더가 깨진다
    expect(menuPlacement({ top: 300, bottom: 320 }, { top: 300, bottom: 320 }, 240, 4))
      .toEqual({ side: 'below', maxHeight: 0 })
  })
})
