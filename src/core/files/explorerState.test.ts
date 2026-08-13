import { describe, expect, it } from 'vitest'
import {
  initialExplorerState,
  operableSelection,
  reduce,
  type ExplorerState
} from './explorerState'

const S = (sel: string[], anchor: string | null = null, clip: ExplorerState['clipboard'] = null): ExplorerState => ({
  selection: new Set(sel),
  anchor,
  clipboard: clip
})
const sel = (s: ExplorerState): string[] => [...s.selection]

describe('initialExplorerState', () => {
  it('클립보드를 넘기면 그대로 들고 시작한다 (언마운트 복원)', () => {
    const clip = { mode: 'cut' as const, paths: ['R\\a'] }
    expect(initialExplorerState(clip).clipboard).toEqual(clip)
  })

  it('넘기지 않으면 빈 상태', () => {
    const s = initialExplorerState()
    expect(sel(s)).toEqual([])
    expect(s.anchor).toBeNull()
    expect(s.clipboard).toBeNull()
  })
})

describe('reduce — 루트 전환 (데이터 손실 가드)', () => {
  const before = S(['R\\a', 'R\\b'], 'R\\b', { mode: 'cut', paths: ['R\\a'] })

  it('루트가 바뀌면 선택·anchor를 비우고 클립보드는 유지한다', () => {
    const after = reduce(before, { type: 'rootChanged' })
    expect(sel(after)).toEqual([])
    expect(after.anchor).toBeNull()
    expect(after.clipboard).toEqual({ mode: 'cut', paths: ['R\\a'] })
  })

  it('루트가 없어져도 같다 — 선택만 비우고 클립보드는 유지', () => {
    const after = reduce(before, { type: 'rootCleared' })
    expect(sel(after)).toEqual([])
    expect(after.anchor).toBeNull()
    expect(after.clipboard).not.toBeNull()
  })

  it('같은 루트로 재마운트되면 아무것도 건드리지 않는다', () => {
    expect(reduce(before, { type: 'rootRestored' })).toBe(before)
  })

  it('새로고침은 선택·anchor·클립보드를 모두 비운다', () => {
    const after = reduce(before, { type: 'refreshed' })
    expect(sel(after)).toEqual([])
    expect(after.anchor).toBeNull()
    expect(after.clipboard).toBeNull()
  })
})

describe('reduce — 행 클릭', () => {
  const flat = ['R\\a', 'R\\b', 'R\\c', 'R\\d']

  it('보통 클릭은 단일 선택하고 anchor를 옮긴다', () => {
    const after = reduce(S(['R\\a']), {
      type: 'rowClicked', path: 'R\\c', mods: { ctrl: false, shift: false }, flat
    })
    expect(sel(after)).toEqual(['R\\c'])
    expect(after.anchor).toBe('R\\c')
  })

  it('Ctrl 클릭은 토글한다', () => {
    const on = reduce(S(['R\\a']), {
      type: 'rowClicked', path: 'R\\c', mods: { ctrl: true, shift: false }, flat
    })
    expect(sel(on).sort()).toEqual(['R\\a', 'R\\c'])
    const off = reduce(on, {
      type: 'rowClicked', path: 'R\\c', mods: { ctrl: true, shift: false }, flat
    })
    expect(sel(off)).toEqual(['R\\a'])
  })

  it('Shift 클릭은 anchor부터 범위를 잡고 anchor를 유지한다', () => {
    const after = reduce(S(['R\\b'], 'R\\b'), {
      type: 'rowClicked', path: 'R\\d', mods: { ctrl: false, shift: true }, flat
    })
    expect(sel(after)).toEqual(['R\\b', 'R\\c', 'R\\d'])
    expect(after.anchor).toBe('R\\b') // 연속 Shift 클릭으로 범위를 늘리고 줄일 수 있어야 한다
  })

  it('anchor가 없으면 Shift 클릭도 단일 선택으로 떨어진다', () => {
    const after = reduce(S([]), {
      type: 'rowClicked', path: 'R\\c', mods: { ctrl: false, shift: true }, flat
    })
    expect(sel(after)).toEqual(['R\\c'])
    expect(after.anchor).toBe('R\\c')
  })

  it('입력 state를 변형하지 않는다 — 제자리 변형 퇴행 방지', () => {
    const before = S(['R\\a'], 'R\\a')
    const ref = before.selection
    const after = reduce(before, {
      type: 'rowClicked', path: 'R\\c', mods: { ctrl: true, shift: false }, flat
    })
    expect(before.selection).toBe(ref) // 같은 Set 객체가 그대로여야 한다
    expect([...before.selection]).toEqual(['R\\a']) // 내용도 그대로
    expect(after.selection).not.toBe(ref) // 새 Set을 돌려줬어야 한다
    expect([...after.selection].sort()).toEqual(['R\\a', 'R\\c'])
  })

  it('anchor가 flat에 없으면 클릭한 항목만 선택된다 (트리 캐시가 바뀐 경우)', () => {
    const after = reduce(S(['R\\gone'], 'R\\gone'), {
      type: 'rowClicked', path: 'R\\c', mods: { ctrl: false, shift: true }, flat
    })
    expect(sel(after)).toEqual(['R\\c'])
  })
})

describe('reduce — 우클릭', () => {
  it('선택에 든 항목이면 선택을 유지한다 (다중 대상 메뉴)', () => {
    const before = S(['R\\a', 'R\\b'], 'R\\a')
    const after = reduce(before, { type: 'rowContextMenu', path: 'R\\b' })
    expect(sel(after).sort()).toEqual(['R\\a', 'R\\b'])
    expect(after.anchor).toBe('R\\b')
  })

  it('선택 밖의 항목이면 그것만 단일 선택한다', () => {
    const after = reduce(S(['R\\a', 'R\\b'], 'R\\a'), { type: 'rowContextMenu', path: 'R\\z' })
    expect(sel(after)).toEqual(['R\\z'])
    expect(after.anchor).toBe('R\\z')
  })
})

describe('reduce — 조작 결과 반영', () => {
  it('selectionSet은 결과를 선택하고 마지막을 anchor로', () => {
    const after = reduce(S(['R\\old']), { type: 'selectionSet', paths: ['R\\x', 'R\\y'] })
    expect(sel(after)).toEqual(['R\\x', 'R\\y'])
    expect(after.anchor).toBe('R\\y')
  })

  it('selectAll은 넘긴 목록 전체를 선택한다', () => {
    const after = reduce(S([]), { type: 'selectAll', paths: ['R\\a', 'R\\b'] })
    expect(sel(after)).toEqual(['R\\a', 'R\\b'])
  })

  it('cutOrCopied는 클립보드를 채운다', () => {
    const after = reduce(S(['R\\a']), { type: 'cutOrCopied', mode: 'cut', paths: ['R\\a'] })
    expect(after.clipboard).toEqual({ mode: 'cut', paths: ['R\\a'] })
  })

  it('clipboardCleared는 클립보드만 비운다', () => {
    const after = reduce(S(['R\\a'], 'R\\a', { mode: 'cut', paths: ['R\\a'] }), { type: 'clipboardCleared' })
    expect(after.clipboard).toBeNull()
    expect(sel(after)).toEqual(['R\\a'])
    expect(after.anchor).toBe('R\\a')
  })
})

describe('reduce — pathsRemoved', () => {
  it('선택·anchor를 비운다', () => {
    const after = reduce(S(['R\\a'], 'R\\a'), { type: 'pathsRemoved', removed: ['R\\a'] })
    expect(sel(after)).toEqual([])
    expect(after.anchor).toBeNull()
  })

  it('지워진 항목이 클립보드에 있었으면 클립보드를 비운다', () => {
    const before = S(['R\\a'], 'R\\a', { mode: 'cut', paths: ['R\\a\\x.ts'] })
    expect(reduce(before, { type: 'pathsRemoved', removed: ['R\\a'] }).clipboard).toBeNull()
  })

  it('무관한 항목이 지워졌으면 클립보드를 유지한다', () => {
    const clip = { mode: 'copy' as const, paths: ['R\\keep'] }
    const before = S(['R\\a'], 'R\\a', clip)
    expect(reduce(before, { type: 'pathsRemoved', removed: ['R\\gone'] }).clipboard).toEqual(clip)
  })

  it('클립보드 경로 자신이 지워지면 클립보드를 비운다 (정확일치)', () => {
    const before = S(['R\\a'], 'R\\a', { mode: 'copy', paths: ['R\\a'] })
    expect(reduce(before, { type: 'pathsRemoved', removed: ['R\\a'] }).clipboard).toBeNull()
  })
})

describe('operableSelection — C1 루트 필터 + topLevelOnly', () => {
  it('현재 루트 밖의 경로를 걸러낸다 (다른 프로젝트 파일 영구 삭제 방지)', () => {
    const s = S(['D:\\projA\\x.ts', 'D:\\projB\\y.ts'])
    expect(operableSelection(s, 'D:\\projB')).toEqual(['D:\\projB\\y.ts'])
  })

  it('폴더와 그 하위가 함께 선택되면 최상위만 남긴다', () => {
    const s = S(['D:\\p\\a', 'D:\\p\\a\\b.ts'])
    expect(operableSelection(s, 'D:\\p')).toEqual(['D:\\p\\a'])
  })

  it('root가 null이면 조작 대상이 없다', () => {
    expect(operableSelection(S(['D:\\p\\a']), null)).toEqual([])
  })

  it('루트 자신은 조작 대상이 아니다', () => {
    expect(operableSelection(S(['D:\\p']), 'D:\\p')).toEqual([])
  })
})
