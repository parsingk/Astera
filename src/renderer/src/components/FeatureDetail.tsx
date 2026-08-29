import type { FeatureExplanation, ProjectFeature } from '../../../core/understanding/types'
import { scopeToStep } from '../../../core/understanding/scope'
import { useI18n } from '../i18n/I18nProvider'
import { FlowDiagram } from './FlowDiagram'
import { GLYPH, STATUS_KEY } from './UnderstandingIcons'

const dateOf = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 한 기능의 상세. 왼쪽은 사람이 읽는 이야기, 오른쪽은 개발자가 되짚는 참조다 —
 *  "설명을 먼저, 구현을 나중에"가 위아래 순서가 아니라 좌우 공간으로 지켜진다(설계 §4). */
export function FeatureDetail({
  feature,
  explanation,
  scopedNodeId,
  onPickStep,
  onOpenPath
}: {
  feature: ProjectFeature
  explanation: FeatureExplanation | null
  /** 고른 흐름 단계. 고를 수 없는 단계가 들어오면 scopeToStep 이 null 을 주고 전체를 그린다 */
  scopedNodeId: string | null
  onPickStep: (nodeId: string | null) => void
  onOpenPath: (path: string) => void
}): React.JSX.Element {
  const { t } = useI18n()

  if (!explanation) {
    return <div className="hiw-pane hiw-pane-empty">{t('hiw.pane.noExplanation')}</div>
  }

  const scoped = scopedNodeId ? scopeToStep(explanation, scopedNodeId) : null

  return (
    <div className="hiw-pane">
      <div className="hiw-fhead">
        <h4>{feature.name}</h4>
        {/* 상태를 박아 두지 않는다 — 사이드바와 같은 표를 본다(설계 §8) */}
        <span className={feature.status === 'up-to-date' ? 'hiw-st' : 'hiw-st warn'}>
          {GLYPH[feature.status]} {t(STATUS_KEY[feature.status])}
        </span>
        <span className="hiw-sp" />
        <button className="hiw-ghost">
          {t('hiw.pane.evidence', { count: feature.evidenceCount })}
        </button>
        <button className="hiw-ghost">{t('hiw.pane.edit')}</button>
        <button className="hiw-ghost acc">{t('hiw.pane.regenerate')}</button>
      </div>

      <div className="hiw-split">
        <div className="hiw-main">
          <section className="hiw-sec">
            <p className="hiw-lab">{t('hiw.pane.overview')}</p>
            <p className="hiw-p">{explanation.overview}</p>
          </section>

          <section className="hiw-sec hiw-grow">
            <p className="hiw-lab">
              {t('hiw.pane.flow')} <span className="hiw-hint">{t('hiw.pane.flowHint')}</span>
            </p>
            <FlowDiagram
              nodes={explanation.userFlow}
              selectedId={scoped?.node.id ?? null}
              onPick={onPickStep}
            />
          </section>

          {explanation.failureFlows.length > 0 && (
            <section className="hiw-sec">
              <p className="hiw-lab">{t('hiw.pane.failures')}</p>
              <div className="hiw-fail">
                {explanation.failureFlows.map((f) => (
                  <div key={f.id}>
                    <b>{f.label}</b>
                    <span>{f.description}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <div className="hiw-side-col">
          {scoped && (
            <div className="hiw-scope">
              <span className="hiw-scope-label">{scoped.node.label}</span>
              <button className="hiw-scope-clear" onClick={() => onPickStep(null)}>
                × {t('hiw.scope.clear')}
              </button>
            </div>
          )}

          {scoped?.node.description && (
            <section className="hiw-sec">
              <p className="hiw-lab">{t('hiw.scope.whatHappens')}</p>
              <p className="hiw-p">{scoped.node.description}</p>
            </section>
          )}

          <section className="hiw-sec">
            <p className="hiw-lab">{scoped ? t('hiw.scope.why') : t('hiw.pane.decisions')}</p>
            {(scoped ? scoped.decisions : explanation.keyDecisions).map((d) => (
              <div key={d.id} className="hiw-why">
                <span className="hiw-wt">{d.title}</span>
                <span className="hiw-wr">{d.reason}</span>
                {/* 추정만 --warn 이다. 추정을 결정과 같은 무게로 보여 주지 않는다(설계 §4) */}
                <span className={d.source === 'agent' ? 'hiw-src low' : 'hiw-src'}>
                  {d.sourceLabel}
                </span>
              </div>
            ))}
          </section>

          <section className="hiw-sec">
            <p className="hiw-lab">
              {scoped ? t('hiw.scope.implementation') : t('hiw.pane.implementation')}
            </p>
            <div className="hiw-impl">
              {(scoped ? scoped.implementation : explanation.implementation).map((i) => (
                <span key={i.path} className="hiw-impl-row">
                  <b>{i.role}</b>
                  <button onClick={() => onOpenPath(i.path)}>{i.path.split('/').pop()}</button>
                </span>
              ))}
            </div>
          </section>

          <section className="hiw-sec">
            <p className="hiw-lab">{scoped ? t('hiw.scope.changes') : t('hiw.pane.changes')}</p>
            {(scoped ? scoped.changes : explanation.recentChanges).map((c) => (
              <div key={c.id} className="hiw-chg">
                <span className="hiw-ct">
                  <span>{dateOf(c.at)}</span>
                  <u>{c.sourceLabel}</u>
                </span>
                <span className="hiw-cb">{c.body}</span>
              </div>
            ))}
          </section>
        </div>
      </div>
    </div>
  )
}
