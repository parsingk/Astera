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

export const STATUS_KEY: Record<FeatureStatus, MessageKey> = {
  'up-to-date': 'hiw.status.upToDate',
  'needs-review': 'hiw.status.needsReview',
  'possibly-stale': 'hiw.status.possiblyStale',
  'update-available': 'hiw.status.updateAvailable',
  generating: 'hiw.status.generating',
  'generation-failed': 'hiw.status.generationFailed'
}
