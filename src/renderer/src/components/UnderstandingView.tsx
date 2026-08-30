import type { ProjectUnderstanding } from '../../../core/understanding/types'
import { attentionCount, ATTENTION_STATUSES, sortFeatures } from '../../../core/understanding/list'
import { useI18n } from '../i18n/I18nProvider'
import { GLYPH, GLYPH_COLOR } from './UnderstandingIcons'

const dateOf = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** How It Works 사이드바. 목록만 그린다 — 상세는 페인 탭이다(설계 §2). */
export function UnderstandingView({
  understanding,
  selectedFeatureId,
  onOpenFeature,
  onReview,
  onAnalyze,
  analyzing = false
}: {
  understanding: ProjectUnderstanding | null
  selectedFeatureId: string | null
  onOpenFeature: (featureId: string) => void
  onReview: (featureId: string) => void
  onAnalyze: () => void
  /** 분석이 도는 동안 — 버튼을 잠그고 그 사실을 보여 준다. 에이전트 왕복은 수십 초라
   *  아무 표시가 없으면 사용자가 다시 누르고, 그러면 두 번 돈다 */
  analyzing?: boolean
}): React.JSX.Element {
  const { t } = useI18n()

  if (!understanding) {
    return (
      <div className="hiw-side">
        <div className="hiw-head">
          <b>{t('hiw.title')}</b>
        </div>
        <div className="hiw-empty">
          <p>{t('hiw.empty.body')}</p>
          <button className="hiw-cta" onClick={onAnalyze} disabled={analyzing}>
            {t(analyzing ? 'hiw.analyze.running' : 'hiw.empty.analyze')}
          </button>
          <p className="hiw-fine">{t('hiw.empty.readOnly')}</p>
        </div>
      </div>
    )
  }

  const features = sortFeatures(understanding.features)
  const attention = attentionCount(understanding.features)

  return (
    <div className="hiw-side">
      <div className="hiw-head">
        <b>{t('hiw.title')}</b>
        <button className="hiw-act" title={t(analyzing ? 'hiw.analyze.running' : 'hiw.reanalyze')} onClick={onAnalyze} disabled={analyzing}>
          ⟳
        </button>
      </div>

      <div className="hiw-sum">
        <span>{t('hiw.summary', { count: understanding.features.length })}</span>
        {attention > 0 && <em>{t('hiw.summary.attention', { count: attention })}</em>}
        {understanding.analyzedAt && (
          <span>{t('hiw.summary.analyzed', { date: dateOf(understanding.analyzedAt) })}</span>
        )}
      </div>

      <div className="hiw-list">
        {features.map((f) => {
          const needs = ATTENTION_STATUSES.includes(f.status)
          return (
            <div
              key={f.id}
              className={`hiw-row${f.id === selectedFeatureId ? ' on' : ''}`}
              onClick={() => onOpenFeature(f.id)}
            >
              {/* 색은 상태에서 온다 — 줄이 "검토 필요" 집합에 드는지로 고르면 그 집합에 없는
                  generation-failed 가 초록으로 그려진다(UnderstandingIcons 의 GLYPH_COLOR) */}
              <span className="hiw-g" style={{ color: GLYPH_COLOR[f.status] }} aria-hidden="true">
                {GLYPH[f.status]}
              </span>
              <span className="hiw-body">
                <span className="hiw-name">{f.name}</span>
                <span className="hiw-summary" title={f.summary}>
                  {f.summary}
                </span>
                <span className="hiw-meta">
                  {/* 검토가 필요하면 시각이 아니라 이유가 선다 — 그 버튼을 누를지 정하려면
                      이유가 먼저 보여야 한다(설계 §3) */}
                  {needs && f.staleReason ? (
                    <span className="w">{f.staleReason}</span>
                  ) : (
                    t('hiw.feature.evidence', { count: f.evidenceCount })
                  )}
                </span>
                {needs && (
                  <button
                    className="hiw-review"
                    onClick={(e) => {
                      e.stopPropagation()
                      onReview(f.id)
                    }}
                  >
                    {t('hiw.feature.review')}
                  </button>
                )}
              </span>
            </div>
          )
        })}
      </div>

      {understanding.recentChanges.length > 0 && (
        <div className="hiw-recent">
          <div className="hiw-lab">{t('hiw.recent.project')}</div>
          {understanding.recentChanges.slice(0, 3).map((c) => (
            <div key={c.id} className="hiw-rrow">
              <b>
                {dateOf(c.at)} {c.sourceLabel}
              </b>
              <span>
                {c.featureName ? `${c.featureName} — ` : ''}
                {c.body}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
