import { describe, expect, it } from 'vitest'
import {
  MAX_PANES,
  activateTab,
  addTab,
  clampRatio,
  computeRects,
  countLeaves,
  createGroup,
  dropZoneOf,
  findNeighbor,
  firstLeaf,
  groupOfSession,
  leafOf,
  leaves,
  moveTab,
  removeTab,
  replaceSessionId,
  setRatio,
  splitAndMove,
  splitBoundaries,
  unsplit,
  type PaneNode
} from './tree'

/** 트리가 스펙의 불변식 4개를 지키는지. 모든 연산 결과에 적용한다. */
function assertInvariants(root: PaneNode, expected: string[]): void {
  const all = leaves(root).flatMap((l) => l.sessionIds)
  expect(new Set(all).size).toBe(all.length) // 세션은 한 그룹에만 (불변식 1)
  expect([...all].sort()).toEqual([...expected].sort())
  for (const l of leaves(root)) {
    expect(l.sessionIds.length).toBeGreaterThan(0) // 빈 그룹 없음 (불변식 2)
    expect(l.sessionIds).toContain(l.activeSessionId) // (불변식 3)
  }
  expect(countLeaves(root)).toBeLessThanOrEqual(MAX_PANES) // (불변식 4)
}

/** 좌우 분할 → 오른쪽을 다시 상하 분할한 3그룹 트리 (s1 | (s2 / s3)) */
function threePane(): { root: PaneNode; ids: [string, string, string] } {
  const a = createGroup('s1')
  const r1 = splitAndMove(a, 's2', a.id, 'row', false)
  if (!r1) throw new Error('r1')
  const r2 = splitAndMove(r1.root, 's3', r1.paneId, 'col', false)
  if (!r2) throw new Error('r2')
  return { root: r2.root, ids: [a.id, r1.paneId, r2.paneId] }
}

/** 2x2 격자: (s1 | s2) 위, (s3 | s4) 아래 */
function quad(): { root: PaneNode; ids: { s1: string; s2: string; s3: string; s4: string } } {
  const top = createGroup('s1')
  const r1 = splitAndMove(top, 's3', top.id, 'col', false)! // 위/아래
  const r2 = splitAndMove(r1.root, 's2', top.id, 'row', false)! // 위를 좌/우
  const r3 = splitAndMove(r2.root, 's4', r1.paneId, 'row', false)! // 아래를 좌/우
  return { root: r3.root, ids: { s1: top.id, s2: r2.paneId, s3: r1.paneId, s4: r3.paneId } }
}

describe('createGroup / addTab / activateTab', () => {
  it('탭 하나짜리 그룹을 만든다', () => {
    const g = createGroup('s1')
    expect(g.kind).toBe('leaf')
    expect(g.sessionIds).toEqual(['s1'])
    expect(g.activeSessionId).toBe('s1')
    assertInvariants(g, ['s1'])
  })

  it('그룹 id는 매번 새로 발급된다', () => {
    expect(createGroup('s1').id).not.toBe(createGroup('s1').id)
  })

  it('addTab은 끝에 붙이고 활성 탭으로 만든다', () => {
    const g = createGroup('s1')
    const next = addTab(g, g.id, 's2')
    expect(leafOf(next, g.id)!.sessionIds).toEqual(['s1', 's2'])
    expect(leafOf(next, g.id)!.activeSessionId).toBe('s2')
    expect(g.sessionIds).toEqual(['s1']) // 원본 불변
    assertInvariants(next, ['s1', 's2'])
  })

  it('addTab의 insertBefore는 그 자리에 끼운다', () => {
    const g = createGroup('s1')
    const next = addTab(addTab(g, g.id, 's2'), g.id, 's3', 0)
    expect(leafOf(next, g.id)!.sessionIds).toEqual(['s3', 's1', 's2'])
  })

  it('activateTab은 소속 그룹과 그 그룹 id를 돌려준다', () => {
    const { root, ids } = threePane()
    const act = activateTab(root, 's3')!
    expect(act.paneId).toBe(ids[2])
    expect(leafOf(act.root, ids[2])!.activeSessionId).toBe('s3')
    expect(activateTab(root, 'nope')).toBeNull()
  })

  it('groupOfSession은 탭 목록으로 찾는다', () => {
    const g = createGroup('s1')
    const next = addTab(g, g.id, 's2')
    expect(groupOfSession(next, 's2')!.id).toBe(g.id)
    expect(groupOfSession(next, 'nope')).toBeNull()
  })
})

describe('leafOf / firstLeaf', () => {
  it('id로 그룹을 찾고 첫 그룹을 돌려준다', () => {
    const { root, ids } = threePane()
    expect(leafOf(root, ids[1])!.activeSessionId).toBe('s2')
    expect(leafOf(root, 'nope')).toBeNull()
    expect(firstLeaf(root).id).toBe(ids[0])
  })
})

describe('splitAndMove', () => {
  it('트리에 없는 세션은 새 그룹에 그냥 놓는다', () => {
    const a = createGroup('s1')
    const res = splitAndMove(a, 's2', a.id, 'row', false)!
    const root = res.root
    if (root.kind !== 'split') throw new Error('split이어야 한다')
    expect(root.dir).toBe('row')
    expect(root.ratio).toBe(0.5)
    expect(root.a).toEqual(a)
    expect(leafOf(root, res.paneId)!.sessionIds).toEqual(['s2'])
    assertInvariants(root, ['s1', 's2'])
  })

  it('placeBefore면 새 그룹이 a 자리에 온다', () => {
    const a = createGroup('s1')
    const res = splitAndMove(a, 's2', a.id, 'col', true)!
    if (res.root.kind !== 'split') throw new Error('split이어야 한다')
    expect(res.root.dir).toBe('col')
    expect((res.root.a as { id: string }).id).toBe(res.paneId)
    expect(res.root.b).toEqual(a)
  })

  it('같은 그룹의 탭이 2개 이상이면 그 탭만 새 그룹으로 옮긴다', () => {
    const g = createGroup('s1')
    const two = addTab(g, g.id, 's2') // 활성 탭은 s2
    const res = splitAndMove(two, 's2', g.id, 'row', false)!
    expect(leafOf(res.root, g.id)!.sessionIds).toEqual(['s1'])
    expect(leafOf(res.root, g.id)!.activeSessionId).toBe('s1') // 활성 탭 승계
    expect(leafOf(res.root, res.paneId)!.sessionIds).toEqual(['s2'])
    assertInvariants(res.root, ['s1', 's2'])
  })

  it('같은 그룹의 탭이 1개면 null (쪼개도 결과가 같다)', () => {
    const g = createGroup('s1')
    expect(splitAndMove(g, 's1', g.id, 'row', false)).toBeNull()
  })

  it('다른 그룹의 유일한 탭을 옮기면 그룹 수가 유지된다', () => {
    const { root, ids } = threePane() // (s1 | (s2 / s3)), 그룹 3개
    const res = splitAndMove(root, 's3', ids[0], 'col', false)!
    expect(countLeaves(res.root)).toBe(3)
    expect(groupOfSession(res.root, 's3')!.id).toBe(res.paneId)
    assertInvariants(res.root, ['s1', 's2', 's3'])
  })

  it('원본 트리를 변경하지 않는다', () => {
    const a = createGroup('s1')
    const before = JSON.stringify(a)
    splitAndMove(a, 's2', a.id, 'row', false)
    expect(JSON.stringify(a)).toBe(before)
  })

  it(`그룹이 이미 ${MAX_PANES}개면 null`, () => {
    const { root, ids } = quad()
    expect(countLeaves(root)).toBe(MAX_PANES)
    expect(splitAndMove(root, 'sX', ids.s1, 'row', false)).toBeNull()
  })

  it('없는 paneId면 null', () => {
    const a = createGroup('s1')
    expect(splitAndMove(a, 's2', 'nope', 'row', false)).toBeNull()
  })
})

describe('removeTab', () => {
  it('탭만 빠지고 그룹은 남는다', () => {
    const g = createGroup('s1')
    const two = addTab(g, g.id, 's2')
    const next = removeTab(two, 's2')!
    expect(leafOf(next, g.id)!.sessionIds).toEqual(['s1'])
    assertInvariants(next, ['s1'])
  })

  it('활성 탭이 빠지면 다음 탭이, 없으면 이전 탭이 활성이 된다', () => {
    const g = createGroup('s1')
    const three = addTab(addTab(g, g.id, 's2'), g.id, 's3') // [s1,s2,s3] 활성 s3
    const mid = activateTab(three, 's2')!.root
    expect(leafOf(removeTab(mid, 's2')!, g.id)!.activeSessionId).toBe('s3') // 다음
    const last = activateTab(three, 's3')!.root
    expect(leafOf(removeTab(last, 's3')!, g.id)!.activeSessionId).toBe('s2') // 이전
  })

  it('마지막 탭이 빠지면 그룹이 사라지고 형제가 승격된다', () => {
    const { root } = threePane()
    const next = removeTab(root, 's2')!
    expect(countLeaves(next)).toBe(2)
    assertInvariants(next, ['s1', 's3'])
  })

  it('중첩 안쪽 그룹이 사라져도 승격된다', () => {
    const { root } = threePane()
    const next = removeTab(root, 's3')!
    if (next.kind !== 'split') throw new Error('split이어야 한다')
    expect(next.b.kind).toBe('leaf') // (s2 / s3) 가 s2 로 접힘
    assertInvariants(next, ['s1', 's2'])
  })

  it('트리 전체의 마지막 탭이면 null', () => {
    const g = createGroup('s1')
    expect(removeTab(g, 's1')).toBeNull()
  })

  it('없는 세션이면 트리를 그대로 돌려준다', () => {
    const { root } = threePane()
    expect(removeTab(root, 'sX')).toBe(root)
  })
})

describe('moveTab', () => {
  it('다른 그룹으로 옮긴다', () => {
    const { root, ids } = threePane()
    const next = moveTab(root, 's3', ids[0])!
    expect(leafOf(next, ids[0])!.sessionIds).toEqual(['s1', 's3'])
    expect(leafOf(next, ids[0])!.activeSessionId).toBe('s3')
    assertInvariants(next, ['s1', 's2', 's3'])
  })

  it('출발 그룹이 비면 사라지고 형제가 승격된다', () => {
    const { root, ids } = threePane()
    const next = moveTab(root, 's3', ids[0])!
    expect(countLeaves(next)).toBe(2)
    expect(leafOf(next, ids[2])).toBeNull()
  })

  it('같은 그룹이면 재정렬이다', () => {
    const g = createGroup('s1')
    const three = addTab(addTab(g, g.id, 's2'), g.id, 's3') // [s1,s2,s3]
    const next = moveTab(three, 's3', g.id, 0)!
    expect(leafOf(next, g.id)!.sessionIds).toEqual(['s3', 's1', 's2'])
    assertInvariants(next, ['s1', 's2', 's3'])
  })

  it('insertBefore가 삽입 위치를 정한다', () => {
    const { root, ids } = threePane()
    const g = addTab(root, ids[0], 'sX') // ids[0] = [s1, sX]
    const next = moveTab(g, 's2', ids[0], 1)!
    expect(leafOf(next, ids[0])!.sessionIds).toEqual(['s1', 's2', 'sX'])
  })

  it('없는 세션·대상이면 null', () => {
    const { root, ids } = threePane()
    expect(moveTab(root, 'sX', ids[0])).toBeNull()
    expect(moveTab(root, 's2', 'nope')).toBeNull()
  })
})

describe('unsplit', () => {
  it('탭들을 형제 그룹 끝에 합치고 형제의 활성 탭은 유지한다', () => {
    const a = createGroup('s1')
    const res = splitAndMove(a, 's2', a.id, 'row', false)!
    const withTwo = addTab(res.root, res.paneId, 's3') // 오른쪽 그룹 = [s2, s3]
    const next = unsplit(withTwo, res.paneId)
    expect(next.kind).toBe('leaf')
    expect(leafOf(next, a.id)!.sessionIds).toEqual(['s1', 's2', 's3'])
    expect(leafOf(next, a.id)!.activeSessionId).toBe('s1') // 흡수한 쪽 유지
    assertInvariants(next, ['s1', 's2', 's3'])
  })

  it('형제가 split이면 그 서브트리의 firstLeaf에 합친다', () => {
    const { root, ids } = threePane() // (s1 | (s2 / s3))
    const next = unsplit(root, ids[0]) // s1을 없애면 형제는 (s2 / s3)
    expect(leafOf(next, ids[1])!.sessionIds).toEqual(['s2', 's1'])
    assertInvariants(next, ['s1', 's2', 's3'])
  })

  // 위 케이스는 형제 서브트리와 남은 트리가 같은 모양이라(둘 다 (s2/s3)) firstLeaf가 양쪽 다 s2다
  // — "형제의 firstLeaf"와 "남은 트리 전체의 firstLeaf"를 구분하지 못한다. 중첩 안쪽 그룹을
  // 없애면 둘이 갈린다. 과거에 unsplit 후 포커스가 엉뚱한 그룹으로 가던 버그가 정확히
  // 이 모양에서 나왔고, 그때 이 구분을 짚는 테스트가 없었다
  it('중첩 안쪽 그룹을 없애면 남은 트리의 firstLeaf가 아니라 형제에 합친다', () => {
    const { root, ids } = threePane() // (s1 | (s2 / s3))
    const next = unsplit(root, ids[1]) // s2를 없애면 형제는 s3 하나뿐
    expect(leafOf(next, ids[2])!.sessionIds).toEqual(['s3', 's2']) // 형제 s3에 합쳐진다
    expect(leafOf(next, ids[0])!.sessionIds).toEqual(['s1']) // 남은 트리의 firstLeaf인 s1이 아니다
    expect(leafOf(next, ids[2])!.activeSessionId).toBe('s3') // 흡수한 쪽의 활성 탭은 유지된다
    assertInvariants(next, ['s1', 's2', 's3'])
  })

  it('미분할이면 트리를 그대로 돌려준다', () => {
    const g = createGroup('s1')
    expect(unsplit(g, g.id)).toBe(g)
  })

  it('없는 paneId면 트리를 그대로 돌려준다', () => {
    const { root } = threePane()
    expect(unsplit(root, 'nope')).toBe(root)
  })
})

describe('replaceSessionId / setRatio', () => {
  it('탭의 자리와 활성 여부를 유지한 채 id만 바꾼다', () => {
    const g = createGroup('s1')
    const three = addTab(addTab(g, g.id, 's2'), g.id, 's3')
    const mid = activateTab(three, 's2')!.root
    const next = replaceSessionId(mid, 's2', 'sNew')
    expect(leafOf(next, g.id)!.sessionIds).toEqual(['s1', 'sNew', 's3'])
    expect(leafOf(next, g.id)!.activeSessionId).toBe('sNew')
    expect(leafOf(mid, g.id)!.sessionIds).toEqual(['s1', 's2', 's3']) // 원본 불변
  })

  it('비활성 탭이면 활성 탭은 건드리지 않는다', () => {
    const g = createGroup('s1')
    const two = addTab(g, g.id, 's2') // 활성 s2
    const next = replaceSessionId(two, 's1', 'sNew')
    expect(leafOf(next, g.id)!.activeSessionId).toBe('s2')
  })

  it('없는 id면 무변화', () => {
    const { root } = threePane()
    expect(replaceSessionId(root, 'sX', 'sY')).toBe(root)
  })

  it('setRatio는 하위 트리를 보존한다', () => {
    const { root } = threePane()
    if (root.kind !== 'split') throw new Error('split이어야 한다')
    const next = setRatio(root, root.id, 0.7)
    if (next.kind !== 'split') throw new Error('split이어야 한다')
    expect(next.ratio).toBe(0.7)
    expect(next.b).toEqual(root.b)
    expect(root.ratio).toBe(0.5) // 원본 불변
  })
})

describe('computeRects', () => {
  it('단일 leaf는 화면 전체', () => {
    const a = createGroup('s1')
    expect(computeRects(a).get(a.id)).toEqual({ x: 0, y: 0, w: 100, h: 100 })
  })

  it('좌우 분할은 x축을 ratio로 나눈다', () => {
    const a = createGroup('s1')
    const res = splitAndMove(a, 's2', a.id, 'row', false)!
    const rects = computeRects(res.root)
    expect(rects.get(a.id)).toEqual({ x: 0, y: 0, w: 50, h: 100 })
    expect(rects.get(res.paneId)).toEqual({ x: 50, y: 0, w: 50, h: 100 })
  })

  it('상하 분할은 y축을 ratio로 나눈다', () => {
    const a = createGroup('s1')
    const res = splitAndMove(a, 's2', a.id, 'col', false)!
    const rects = computeRects(res.root)
    expect(rects.get(a.id)).toEqual({ x: 0, y: 0, w: 100, h: 50 })
    expect(rects.get(res.paneId)).toEqual({ x: 0, y: 50, w: 100, h: 50 })
  })

  it('2x2 격자의 네 좌표', () => {
    const { root, ids } = quad()
    const r = computeRects(root)
    expect(r.get(ids.s1)).toEqual({ x: 0, y: 0, w: 50, h: 50 })
    expect(r.get(ids.s2)).toEqual({ x: 50, y: 0, w: 50, h: 50 })
    expect(r.get(ids.s3)).toEqual({ x: 0, y: 50, w: 50, h: 50 })
    expect(r.get(ids.s4)).toEqual({ x: 50, y: 50, w: 50, h: 50 })
  })

  it('면적 합이 100이고 겹치지 않는다', () => {
    const { root } = threePane()
    const rects = [...computeRects(root).values()]
    expect(rects.reduce((sum, r) => sum + r.w * r.h, 0)).toBeCloseTo(100 * 100, 6)
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const [p, q] = [rects[i], rects[j]]
        const overlap =
          Math.max(0, Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)) *
          Math.max(0, Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y))
        expect(overlap).toBeCloseTo(0, 6)
      }
  })

  it('비대칭 ratio를 반영한다', () => {
    const a = createGroup('s1')
    const res = splitAndMove(a, 's2', a.id, 'row', false)!
    const root = setRatio(res.root, (res.root as { id: string }).id, 0.25)
    const rects = computeRects(root)
    expect(rects.get(a.id)).toEqual({ x: 0, y: 0, w: 25, h: 100 })
    expect(rects.get(res.paneId)).toEqual({ x: 25, y: 0, w: 75, h: 100 })
  })
})

describe('splitBoundaries', () => {
  it('leaf 하나면 경계가 없다', () => {
    expect(splitBoundaries(createGroup('s1'))).toEqual([])
  })

  it('row 경계는 폭 0의 세로선이고 area는 부모 영역', () => {
    const a = createGroup('s1')
    const res = splitAndMove(a, 's2', a.id, 'row', false)!
    const [b] = splitBoundaries(res.root)
    expect(b.dir).toBe('row')
    expect(b.rect).toEqual({ x: 50, y: 0, w: 0, h: 100 })
    expect(b.area).toEqual({ x: 0, y: 0, w: 100, h: 100 })
  })

  it('2x2는 경계가 3개 (바깥 col 1 + 안쪽 row 2)', () => {
    const { root } = quad()
    const bs = splitBoundaries(root)
    expect(bs).toHaveLength(3)
    expect(bs.filter((b) => b.dir === 'col')).toHaveLength(1)
    expect(bs.filter((b) => b.dir === 'row')).toHaveLength(2)
    expect(bs.find((b) => b.dir === 'col')!.rect).toEqual({ x: 0, y: 50, w: 100, h: 0 })
  })

  it('중첩 row 경계의 area는 부모가 준 절반 영역', () => {
    const { root } = quad()
    const inner = splitBoundaries(root).filter((b) => b.dir === 'row')
    expect(inner.map((b) => b.area)).toEqual([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 0, y: 50, w: 100, h: 50 }
    ])
  })
})

describe('findNeighbor', () => {
  it('2x2에서 네 방향', () => {
    const { root, ids } = quad()
    expect(findNeighbor(root, ids.s1, 'right')).toBe(ids.s2)
    expect(findNeighbor(root, ids.s1, 'down')).toBe(ids.s3)
    expect(findNeighbor(root, ids.s4, 'left')).toBe(ids.s3)
    expect(findNeighbor(root, ids.s4, 'up')).toBe(ids.s2)
  })

  it('바깥 경계에서는 null', () => {
    const { root, ids } = quad()
    expect(findNeighbor(root, ids.s1, 'left')).toBeNull()
    expect(findNeighbor(root, ids.s1, 'up')).toBeNull()
  })

  it('비대칭 (s1 | (s2 / s3)) 에서 왼쪽→오른쪽은 위쪽을 고른다', () => {
    const { root, ids } = threePane()
    expect(findNeighbor(root, ids[0], 'right')).toBe(ids[1])
    expect(findNeighbor(root, ids[1], 'left')).toBe(ids[0])
    expect(findNeighbor(root, ids[2], 'left')).toBe(ids[0])
    expect(findNeighbor(root, ids[1], 'down')).toBe(ids[2])
  })

  it('없는 paneId면 null', () => {
    const { root } = quad()
    expect(findNeighbor(root, 'nope', 'right')).toBeNull()
  })
})

describe('dropZoneOf', () => {
  it('가운데는 center', () => {
    expect(dropZoneOf(0.5, 0.5)).toBe('center')
    expect(dropZoneOf(0.25, 0.75)).toBe('center')
  })

  it('네 가장자리', () => {
    expect(dropZoneOf(0.05, 0.5)).toBe('left')
    expect(dropZoneOf(0.95, 0.5)).toBe('right')
    expect(dropZoneOf(0.5, 0.05)).toBe('up')
    expect(dropZoneOf(0.5, 0.95)).toBe('down')
  })

  it('모서리는 더 가까운 변으로 간다', () => {
    expect(dropZoneOf(0.02, 0.1)).toBe('left') // 왼쪽이 더 가깝다
    expect(dropZoneOf(0.1, 0.02)).toBe('up')
    expect(dropZoneOf(0.98, 0.9)).toBe('right')
  })

  it('동률이면 left > right > up > down 순', () => {
    expect(dropZoneOf(0.1, 0.1)).toBe('left')
    expect(dropZoneOf(0.9, 0.1)).toBe('right')
  })
})

describe('clampRatio', () => {
  it('여유가 있으면 그대로', () => {
    expect(clampRatio(0.5, 1000)).toBe(0.5)
  })

  it('양끝을 최소 폭으로 막는다', () => {
    expect(clampRatio(0.01, 1000)).toBeCloseTo(0.24, 6)
    expect(clampRatio(0.99, 1000)).toBeCloseTo(0.76, 6)
  })

  it('컨테이너가 최소 폭 2배보다 좁으면 균등', () => {
    expect(clampRatio(0.9, 400)).toBe(0.5)
  })
})
