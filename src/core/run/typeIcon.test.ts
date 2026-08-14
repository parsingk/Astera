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

  it('label 은 대문자다', () => {
    for (const t of ALL) {
      const spec = runTypeIcon(t)
      if (spec.id === 'label') expect(spec.label).toBe(spec.label!.toUpperCase())
    }
  })

  // 3자 라벨은 textLength 로 폭이 눌려, 14px 로 그리면 글자가 뭉개져 테두리와 겹친 것처럼 보인다.
  // 실제로 그려서 확인한 결과다 — 'NPM' 과 'MVN' 이 그랬고, 그래서 그 둘은 모양 아이콘을 쓴다
  it('label 은 두 자를 넘지 않는다', () => {
    for (const t of ALL) {
      const spec = runTypeIcon(t)
      if (spec.id === 'label') expect(spec.label!.length).toBeLessThanOrEqual(2)
    }
  })

  // 같은 도구가 보는 곳에 따라 달라 보이면 안 된다 — 파일 트리의 go.mod 가 청록 GO 다
  it('go 는 파일 트리의 go.mod 와 같은 모양이다', () => {
    expect(runTypeIcon('go')).toEqual({ id: 'label', tone: 'cyan', label: 'GO' })
  })
})
