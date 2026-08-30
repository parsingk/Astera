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
  onRegenerate,
  onAnalyze,
  analyzing = false
}: {
  understanding: ProjectUnderstanding | null
  selectedFeatureId: string | null
  onOpenFeature: (featureId: string) => void
  onReview: (featureId: string) => void
  /** 이 기능의 설명을 다시 만든다. **결과를 기다리지 않는다** — 줄의 상태가 곧 "만드는 중"이 되고,
   *  끝나면 화면이 스스로 다시 읽는다(App 의 'understanding:changed' 구독) */
  onRegenerate: (featureId: string) => void
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
          // **[다시] 가 서는 두 자리.** 만들지 못한 줄은 그 자리에서 다시 눌러 볼 수 있어야 하고
          // (그러지 않으면 사유만 남고 고칠 길이 없다), 갱신이 있는 줄에서 새 설명을 받는 길도
          // 이 버튼뿐이다 — 사람이 고친 설명은 배경 재생성이 덮지 않기 때문이다(스펙 §56).
          const retry = f.status === 'generation-failed' || f.status === 'update-available'
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
                  {/* 손이 필요하면 시각이 아니라 이유가 선다 — 그 버튼을 누를지 정하려면 이유가
                      먼저 보여야 한다(설계 §3). **만들지 못한 줄도 여기에 든다**: 그 사유가
                      "왜 다시 눌러야 하는가"의 답이고, 그것이 없으면 버튼만 남는다 */}
                  {(needs || retry) && f.staleReason ? (
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
                {retry && (
                  <button
                    className="hiw-review"
                    onClick={(e) => {
                      e.stopPropagation()
                      onRegenerate(f.id)
                    }}
                  >
                    {t('hiw.feature.regenerate')}
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
