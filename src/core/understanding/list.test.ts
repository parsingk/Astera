import { describe, it, expect } from 'vitest'
import type { ProjectFeature, FeatureStatus } from './types'
import { attentionCount, sortFeatures } from './list'

const feat = (name: string, status: FeatureStatus): ProjectFeature => ({
  id: name,
  name,
  summary: '',
  status,
  updatedAt: '2026-08-27T00:00:00.000Z',
  evidenceCount: 0
})

describe('attentionCount', () => {
  it('사람을 부르는 셋만 센다', () => {
    const list = [
      feat('a', 'up-to-date'),
      feat('b', 'needs-review'),
      feat('c', 'possibly-stale'),
      feat('d', 'update-available'),
      feat('e', 'generating')
    ]
    expect(attentionCount(list)).toBe(3)
  })

  it('실패는 세지 않는다 — 검토가 아니라 재시도가 답이다', () => {
    expect(attentionCount([feat('a', 'generation-failed')])).toBe(0)
  })

  it('빈 목록은 0', () => {
    expect(attentionCount([])).toBe(0)
  })
})

describe('sortFeatures', () => {
  it('손이 필요한 것이 먼저, 그 안에서는 이름순', () => {
    const list = [
      feat('검색', 'up-to-date'),
      feat('결제', 'needs-review'),
      feat('인증', 'up-to-date'),
      feat('알림', 'update-available')
    ]
    expect(sortFeatures(list).map((f) => f.name)).toEqual(['결제', '알림', '검색', '인증'])
  })

  it('원본 배열을 바꾸지 않는다', () => {
    const list = [feat('b', 'up-to-date'), feat('a', 'up-to-date')]
    sortFeatures(list)
    expect(list.map((f) => f.name)).toEqual(['b', 'a'])
  })
})
