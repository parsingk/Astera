import { describe, it, expect } from 'vitest'
import { runTypeIcon } from './typeIcon'
import type { RunConfigType } from './types'

const ALL: RunConfigType[] = ['shell', 'npm', 'node', 'gradle', 'maven', 'cargo', 'go']

describe('runTypeIcon', () => {
  it('모든 종류에 아이콘이 있다', () => {
    for (const t of ALL) expect(runTypeIcon(t)).toBeTruthy()
  })

  // label 변형은 3자까지만 그린다 (FileIcon 의 glyph) — 넘으면 잘려 나온다
  it('label 은 3자를 넘지 않는다', () => {
    for (const t of ALL) {
      const spec = runTypeIcon(t)
      if (spec.id === 'label') expect(spec.label!.length).toBeLessThanOrEqual(3)
    }
  })

  // 3자 라벨은 textLength 로 폭이 강제로 눌린다. 소문자는 x-height 가 낮아 그 압축에서 글자가
  // 서로 붙어 버린다 — 실제로 소문자 'npm' 이 그렇게 그려졌다. 트리의 라벨이 전부 대문자인 이유다
  it('label 은 대문자다', () => {
    for (const t of ALL) {
      const spec = runTypeIcon(t)
      if (spec.id === 'label') expect(spec.label).toBe(spec.label!.toUpperCase())
    }
  })

  // 같은 도구가 보는 곳에 따라 달라 보이면 안 된다 — 파일 트리의 go.mod 가 청록 GO 다
  it('go 는 파일 트리의 go.mod 와 같은 모양이다', () => {
    expect(runTypeIcon('go')).toEqual({ id: 'label', tone: 'cyan', label: 'GO' })
  })
})
