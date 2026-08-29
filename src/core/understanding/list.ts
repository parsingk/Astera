// 사이드바 목록의 두 규칙. 렌더러가 아니라 여기 있는 이유는 graphLayout.ts 와 같다 —
// 규칙이 있는 계산은 테스트가 닿는 자리에 있어야 한다.
import type { FeatureStatus, ProjectFeature } from './types'

/** 요약 줄이 세는 상태. **generation-failed 를 넣지 않는다** — 그것은 사람이 검토할 것이 아니라
 *  다시 만들 것이고, 그 줄은 자기 자리에서 [다시] 버튼으로 말한다. */
export const ATTENTION_STATUSES: readonly FeatureStatus[] = [
  'needs-review',
  'possibly-stale',
  'update-available'
]

export function attentionCount(features: ProjectFeature[]): number {
  return features.filter((f) => ATTENTION_STATUSES.includes(f.status)).length
}

/** 손이 필요한 것을 위로. 같은 무리 안에서는 이름순이다 — 시각순으로 두면 목록의 순서가 볼 때마다
 *  바뀌어 "아까 그 줄"을 눈으로 찾지 못한다. */
export function sortFeatures(features: ProjectFeature[]): ProjectFeature[] {
  const rank = (f: ProjectFeature): number => (ATTENTION_STATUSES.includes(f.status) ? 0 : 1)
  return [...features].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}
