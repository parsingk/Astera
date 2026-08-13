import { describe, expect, it } from 'vitest'
import { placeTab } from './place'
import {
  MAX_PANES,
  addTab,
  countLeaves,
  createGroup,
  firstLeaf,
  groupOfTab,
  leafOf,
  leaves,
  splitAndMove,
  type PaneNode
} from './tree'

/** 트리가 불변식을 지키는지. placeTab의 모든 결과에 적용한다 — 이 함수가 불변식 1을 깨뜨린
 *  것이 리뷰에서 Critical로 잡힌 결함이었고, 그때 App.tsx에 테스트가 없어 못 잡았다. */
function assertInvariants(root: PaneNode, expected: string[]): void {
  const all = leaves(root).flatMap((l) => l.tabIds)
  expect(new Set(all).size).toBe(all.length) // 탭은 한 그룹에만 (불변식 1)
  expect([...all].sort()).toEqual([...expected].sort())
  for (const l of leaves(root)) {
    expect(l.tabIds.length).toBeGreaterThan(0) // 빈 그룹 없음 (불변식 2)
    expect(l.tabIds).toContain(l.activeTabId) // (불변식 3)
  }
  expect(countLeaves(root)).toBeLessThanOrEqual(MAX_PANES) // (불변식 4)
}

/** 좌우 분할 → 오른쪽을 다시 상하 분할한 3그룹 트리 (s1 | (s2 / s3)) */
function threePane(): { root: PaneNode; ids: [string, string, string] } {
  const a = createGroup('s1')
  const r1 = splitAndMove(a, 's2', a.id, 'row', false)!
  const r2 = splitAndMove(r1.root, 's3', r1.paneId, 'col', false)!
  return { root: r2.root, ids: [a.id, r1.paneId, r2.paneId] }
}

describe('placeTab — 레이아웃이 비어 있을 때', () => {
  it('새 그룹을 만들고 그 그룹을 포커스한다', () => {
    const res = placeTab(null, 's1')
    expect(res.root.kind).toBe('leaf')
    expect(leafOf(res.root, res.paneId!)!.tabIds).toEqual(['s1'])
    expect(res.splitFellBack).toBe(false)
    assertInvariants(res.root, ['s1'])
  })

  it('분할을 요청해도 쪼갤 대상이 없으므로 그냥 새 그룹이다', () => {
    const res = placeTab(null, 's1', { splitDir: 'row' })
    expect(countLeaves(res.root)).toBe(1)
    expect(res.splitFellBack).toBe(false) // 폴백이 아니라 정상 경로다
    assertInvariants(res.root, ['s1'])
  })
})

describe('placeTab — 활성 그룹에 탭으로 올린다', () => {
  it('activePaneId가 가리키는 그룹에 넣고 활성 탭으로 만든다', () => {
    const { root, ids } = threePane()
    const res = placeTab(root, 'sNew', { activePaneId: ids[2] })
    expect(res.paneId).toBe(ids[2])
    expect(leafOf(res.root, ids[2])!.tabIds).toEqual(['s3', 'sNew'])
    expect(leafOf(res.root, ids[2])!.activeTabId).toBe('sNew')
    assertInvariants(res.root, ['s1', 's2', 's3', 'sNew'])
  })

  it('activePaneId가 없거나 트리에 없으면 firstLeaf에 올린다', () => {
    const { root, ids } = threePane()
    for (const active of [null, undefined, 'nope']) {
      const res = placeTab(root, 'sNew', { activePaneId: active })
      expect(res.paneId).toBe(ids[0])
      expect(leafOf(res.root, ids[0])!.tabIds).toEqual(['s1', 'sNew'])
      assertInvariants(res.root, ['s1', 's2', 's3', 'sNew'])
    }
  })

  it('원본 트리를 변경하지 않는다', () => {
    const { root } = threePane()
    const before = JSON.stringify(root)
    placeTab(root, 'sNew')
    expect(JSON.stringify(root)).toBe(before)
  })
})

describe('placeTab — 이미 트리에 있는 세션 (리뷰에서 잡힌 회귀)', () => {
  it('다른 그룹에 있으면 재삽입하지 않고 그 그룹을 활성화한다', () => {
    const { root, ids } = threePane()
    // 롤링 재개 가드가 새로 spawn하는 대신 이미 열려 있는 live 세션을 그대로 돌려주는 경로
    const res = placeTab(root, 's3', { activePaneId: ids[0] })
    expect(res.paneId).toBe(ids[2]) // 활성 그룹이 아니라 s3가 실제로 있는 그룹
    expect(leafOf(res.root, ids[2])!.activeTabId).toBe('s3')
    expect(countLeaves(res.root)).toBe(3)
    assertInvariants(res.root, ['s1', 's2', 's3']) // 중복 삽입이 없다
  })

  it('활성 그룹에 이미 있으면 활성 탭으로만 만든다', () => {
    const g = createGroup('s1')
    const two = addTab(g, g.id, 's2') // 활성 탭은 s2
    const res = placeTab(two, 's1', { activePaneId: g.id })
    expect(res.paneId).toBe(g.id)
    expect(leafOf(res.root, g.id)!.tabIds).toEqual(['s1', 's2']) // 순서 그대로
    expect(leafOf(res.root, g.id)!.activeTabId).toBe('s1')
    assertInvariants(res.root, ['s1', 's2'])
  })
})

// 워커는 오케스트레이터가 만든다 — 사용자가 타이핑하는 중에 활성 탭이 워커로 바뀌면 이후 키가
// 워커 PTY로 들어간다(PaneGrid가 active를 넘기고 TerminalView가 term.focus를 부른다).
// 탭은 뜨되(가시성 요건) 포커스는 빼앗지 않는다
describe('placeTab — background (오케스트레이션 워커)', () => {
  it('탭은 올리되 활성 탭을 바꾸지 않는다', () => {
    const { root, ids } = threePane()
    const before = leafOf(root, ids[2])!.activeTabId
    const res = placeTab(root, 'sWorker', { activePaneId: ids[2], background: true })
    expect(leafOf(res.root, ids[2])!.tabIds).toEqual(['s3', 'sWorker'])
    expect(leafOf(res.root, ids[2])!.activeTabId).toBe(before) // 's3' — 바뀌지 않았다
    assertInvariants(res.root, ['s1', 's2', 's3', 'sWorker'])
  })

  it('활성 패널도 바꾸지 않는다 — paneId가 null이다 (replaces와 같은 관례)', () => {
    const { root, ids } = threePane()
    const res = placeTab(root, 'sWorker', { activePaneId: ids[2], background: true })
    expect(res.paneId).toBeNull()
    expect(res.splitFellBack).toBe(false)
  })

  it('탭은 트리에 실재한다 — 사용자가 눌러서 열 수 있어야 한다 (C2 회귀 방어)', () => {
    const { root, ids } = threePane()
    const res = placeTab(root, 'sWorker', { activePaneId: ids[1], background: true })
    const g = groupOfTab(res.root, 'sWorker')
    expect(g).not.toBeNull()
    expect(g!.id).toBe(ids[1]) // 활성 그룹에 들어간다
  })

  it('레이아웃이 비어 있으면 그룹을 만들되 활성 패널로 세우지 않는다', () => {
    const res = placeTab(null, 'sWorker', { background: true })
    expect(leaves(res.root)[0].tabIds).toEqual(['sWorker'])
    expect(res.paneId).toBeNull()
    assertInvariants(res.root, ['sWorker'])
  })

  it('이미 트리에 있으면 아무것도 하지 않는다 — 활성화도 하지 않는다', () => {
    // 재입양(sessions.list)과 session:created가 겹치는 경우. 일반 배치는 activateTab을 하지만
    // 배경 배치는 그것조차 하지 않는다
    const g = createGroup('s1')
    const two = addTab(g, g.id, 's2') // 활성 탭은 s2
    const res = placeTab(two, 's1', { activePaneId: g.id, background: true })
    expect(leafOf(res.root, g.id)!.activeTabId).toBe('s2')
    expect(leafOf(res.root, g.id)!.tabIds).toEqual(['s1', 's2'])
    expect(res.paneId).toBeNull()
    assertInvariants(res.root, ['s1', 's2'])
  })

  it('background가 없으면 기존대로 활성 탭이 된다 — 사용자 경로 회귀 방어', () => {
    const { root, ids } = threePane()
    const res = placeTab(root, 'sNew', { activePaneId: ids[2] })
    expect(leafOf(res.root, ids[2])!.activeTabId).toBe('sNew')
    expect(res.paneId).toBe(ids[2])
  })
})

describe('placeTab — replaces (재시작·롤링)', () => {
  it('탭의 자리·순서를 유지한 채 id만 갈아끼우고 포커스는 옮기지 않는다', () => {
    const g = createGroup('s1')
    const three = addTab(addTab(g, g.id, 's2'), g.id, 's3')
    const res = placeTab(three, 'sNew', { activePaneId: g.id, replaces: 's2' })
    expect(leafOf(res.root, g.id)!.tabIds).toEqual(['s1', 'sNew', 's3'])
    // 재시작은 그 탭 자리를 이어받을 뿐이므로 활성 패널을 건드리지 않는다
    expect(res.paneId).toBeNull()
    assertInvariants(res.root, ['s1', 'sNew', 's3'])
  })

  it('교체 대상이 활성 탭이었으면 활성 탭도 따라 바뀐다', () => {
    const g = createGroup('s1')
    const two = addTab(g, g.id, 's2') // 활성 탭은 s2
    const res = placeTab(two, 'sNew', { replaces: 's2' })
    expect(leafOf(res.root, g.id)!.activeTabId).toBe('sNew')
    assertInvariants(res.root, ['s1', 'sNew'])
  })

  it('교체 대상이 트리에 없으면 일반 배치로 떨어진다', () => {
    const { root, ids } = threePane()
    const res = placeTab(root, 'sNew', { activePaneId: ids[0], replaces: 'sGone' })
    expect(res.paneId).toBe(ids[0])
    expect(leafOf(res.root, ids[0])!.tabIds).toEqual(['s1', 'sNew'])
    assertInvariants(res.root, ['s1', 's2', 's3', 'sNew'])
  })

  it('레이아웃이 비어 있으면 replaces는 무의미하고 새 그룹이 된다', () => {
    const res = placeTab(null, 'sNew', { replaces: 'sGone' })
    expect(leaves(res.root)[0].tabIds).toEqual(['sNew'])
    expect(res.paneId).not.toBeNull()
    assertInvariants(res.root, ['sNew'])
  })
})

describe('placeTab — splitDir (Ctrl+\\ 가 예약한 분할)', () => {
  it('새 그룹으로 쪼개고 그 그룹을 포커스한다', () => {
    const g = createGroup('s1')
    const res = placeTab(g, 'sNew', { activePaneId: g.id, splitDir: 'row' })
    expect(countLeaves(res.root)).toBe(2)
    expect(leafOf(res.root, res.paneId!)!.tabIds).toEqual(['sNew'])
    expect(leafOf(res.root, g.id)!.tabIds).toEqual(['s1'])
    expect(res.splitFellBack).toBe(false)
    assertInvariants(res.root, ['s1', 'sNew'])
  })

  it('col 방향도 같다', () => {
    const g = createGroup('s1')
    const res = placeTab(g, 'sNew', { activePaneId: g.id, splitDir: 'col' })
    if (res.root.kind !== 'split') throw new Error('split이어야 한다')
    expect(res.root.dir).toBe('col')
    assertInvariants(res.root, ['s1', 'sNew'])
  })

  it(`그룹이 이미 ${MAX_PANES}개면 활성 그룹에 올리고 폴백을 알린다`, () => {
    let root: PaneNode = createGroup('s1')
    for (let i = 2; i <= MAX_PANES; i++) {
      root = splitAndMove(root, `s${i}`, firstLeaf(root).id, 'row', false)!.root
    }
    expect(countLeaves(root)).toBe(MAX_PANES)
    const active = firstLeaf(root).id
    const res = placeTab(root, 'sNew', { activePaneId: active, splitDir: 'row' })
    expect(countLeaves(res.root)).toBe(MAX_PANES) // 상한을 넘지 않는다
    expect(res.paneId).toBe(active)
    expect(leafOf(res.root, active)!.tabIds).toContain('sNew')
    expect(res.splitFellBack).toBe(true)
    assertInvariants(res.root, ['s1', 's2', 's3', 's4', 'sNew'])
  })

  it('이미 트리에 있는 세션이 대상 그룹의 유일한 탭이면 쪼개지 않고 활성화만 한다', () => {
    // splitAndMove의 no-op 조건(출발==대상 && 탭 1개) — 쪼개도 결과가 같아 null을 돌려준다.
    // 폴백은 addTab이 아니라 activateTab이어야 한다. addTab이면 같은 id가 두 번 들어간다.
    const g = createGroup('s1')
    const res = placeTab(g, 's1', { activePaneId: g.id, splitDir: 'row' })
    expect(countLeaves(res.root)).toBe(1)
    expect(leafOf(res.root, g.id)!.tabIds).toEqual(['s1'])
    expect(res.paneId).toBe(g.id)
    expect(res.splitFellBack).toBe(true)
    assertInvariants(res.root, ['s1'])
  })

  it('이미 다른 그룹에 있는 세션은 그 탭을 새 그룹으로 옮긴다', () => {
    // splitAndMove는 "이미 어딘가 있었으면 옮겨온다"가 이름의 뜻이다 — 분할 요청을 존중한다
    const g = createGroup('s1')
    const two = addTab(g, g.id, 's2')
    const res = placeTab(two, 's2', { activePaneId: g.id, splitDir: 'row' })
    expect(countLeaves(res.root)).toBe(2)
    expect(leafOf(res.root, g.id)!.tabIds).toEqual(['s1'])
    expect(leafOf(res.root, res.paneId!)!.tabIds).toEqual(['s2'])
    expect(res.splitFellBack).toBe(false)
    assertInvariants(res.root, ['s1', 's2'])
  })

  it('replaces가 splitDir보다 우선한다 — 재시작은 자리를 이어받는 것이 목적이다', () => {
    const g = createGroup('s1')
    const res = placeTab(g, 'sNew', { activePaneId: g.id, splitDir: 'row', replaces: 's1' })
    expect(countLeaves(res.root)).toBe(1)
    expect(leafOf(res.root, g.id)!.tabIds).toEqual(['sNew'])
    expect(res.paneId).toBeNull()
    assertInvariants(res.root, ['sNew'])
  })

  it('activePaneId가 유효하지 않으면 firstLeaf를 쪼갠다', () => {
    const { root, ids } = threePane()
    const res = placeTab(root, 'sNew', { activePaneId: 'nope', splitDir: 'col' })
    expect(countLeaves(res.root)).toBe(4)
    expect(groupOfTab(res.root, 's1')!.id).toBe(ids[0]) // s1은 원래 그룹에 남는다
    assertInvariants(res.root, ['s1', 's2', 's3', 'sNew'])
  })
})
