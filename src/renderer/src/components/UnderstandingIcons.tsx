import type { MessageKey } from '../../../core/i18n'
import type { FeatureStatus } from '../../../core/understanding/types'

/** 상태 글리프. **색이 아니라 모양이 상태를 말한다** — Quasar 는 accent 가 --ok 와 같은 초록이라
 *  색만으로는 "최신"과 "선택됨"이 구별되지 않는다(설계 §7). */
export const GLYPH: Record<FeatureStatus, string> = {
  'up-to-date': '✓',
  'needs-review': '⚠',
  'possibly-stale': '⚠',
  'update-available': '⚠',
  generating: '◐',
  'generation-failed': '!'
}

/** 상태 글리프의 색. **집합이 아니라 상태에서 끌어온다** — "검토 필요" 집합(ATTENTION_STATUSES)에
 *  드는지로 색을 고르면 그 집합에 일부러 빠져 있는 `generation-failed` 가 기본값으로 떨어져
 *  **실패 표시가 초록으로 그려진다.** 사용자에게 거짓말하는 색이다.
 *
 *  **표가 여기 한 벌인 이유**: 이 색을 쓰는 자리가 셋이다(사이드바 줄·탭 줄·페인 머리). 각 자리에서
 *  CSS 클래스로 고르면 셋이 조용히 갈라지고, 실제로 갈라진 채로 이 브랜치가 끝났다. 모양(GLYPH)과
 *  문구(STATUS_KEY)가 이미 이 모듈에 한 벌씩 있는 것과 같은 이유다 — `JobIcons.tsx` 의
 *  `STATUS_COLOR` 가 같은 갈래다.
 *
 *  값은 전부 테마 토큰이다. `generation-failed` 는 설계 §8 이 지정한 `--danger`,
 *  `generating` 은 이 앱이 "지금 돌고 있다"에 쓰는 `--accent`(JobIcons 의 dispatched)다 —
 *  Quasar 에서 accent 는 --ok 와 같은 초록이지만 `◐` 라는 모양이 이미 상태를 말하므로
 *  색은 거들 뿐이라는 설계 §7 이 그대로 성립한다. */
export const GLYPH_COLOR: Record<FeatureStatus, string> = {
  'up-to-date': 'var(--ok)',
  'needs-review': 'var(--warn)',
  'possibly-stale': 'var(--warn)',
  'update-available': 'var(--warn)',
  generating: 'var(--accent)',
  'generation-failed': 'var(--danger)'
}

export const STATUS_KEY: Record<FeatureStatus, MessageKey> = {
  'up-to-date': 'hiw.status.upToDate',
  'needs-review': 'hiw.status.needsReview',
  'possibly-stale': 'hiw.status.possiblyStale',
  'update-available': 'hiw.status.updateAvailable',
  generating: 'hiw.status.generating',
  'generation-failed': 'hiw.status.generationFailed'
}
