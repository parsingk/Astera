import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FeatureExplanation, ProjectFeature } from '../../../core/understanding/types'
import { scopeToStep } from '../../../core/understanding/scope'
import { toast } from '../lib/toast'
import { useI18n } from '../i18n/I18nProvider'
import { FlowDiagram } from './FlowDiagram'
import { GLYPH, GLYPH_COLOR, STATUS_KEY } from './UnderstandingIcons'

const dateOf = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 참조 단이 접히는 폭. 이 아래에서는 왼쪽 본문이 40자 밑으로 내려가 흐름도가 잘린다. */
const NARROW_PANE = 720

type FeatureDetailProps = {
  feature: ProjectFeature
  explanation: FeatureExplanation | null
  /** 고른 흐름 단계. 고를 수 없는 단계가 들어오면 scopeToStep 이 null 을 주고 전체를 그린다 */
  scopedNodeId: string | null
  onPickStep: (nodeId: string | null) => void
  onOpenPath: (path: string) => void
  /** 페인이 좁다(NARROW_PANE 미만). 참조 단을 접고 머리에 버튼을 남긴다.
   *  **아래로 이어 붙이지 않는다** — 그러면 좁은 화면에서 이 화면이 세로 한 장짜리 다른 레이아웃이
   *  되고, 사용자는 폭에 따라 서로 다른 두 화면을 배우게 된다(설계 §6). 그 대신 한 레이아웃을 그대로
   *  두고 절반을 접는다 — 서랍으로. */
  narrow: boolean
  drawerOpen: boolean
  onToggleDrawer: () => void
}

/** 한 기능의 상세. 왼쪽은 사람이 읽는 이야기, 오른쪽은 개발자가 되짚는 참조다 —
 *  "설명을 먼저, 구현을 나중에"가 위아래 순서가 아니라 좌우 공간으로 지켜진다(설계 §4). */
export function FeatureDetail({
  feature,
  explanation,
  scopedNodeId,
  onPickStep,
  onOpenPath,
  narrow,
  drawerOpen,
  onToggleDrawer
}: FeatureDetailProps): React.JSX.Element {
  const { t } = useI18n()

  if (!explanation) {
    return <div className="hiw-pane hiw-pane-empty">{t('hiw.pane.noExplanation')}</div>
  }

  const notYet = (): void => toast.info(t('hiw.empty.notYet'))

  const scoped = scopedNodeId ? scopeToStep(explanation, scopedNodeId) : null

  // 참조 단 하나를 변수로 뽑아 둔다 — 넓을 때는 본문 옆에, 좁을 때는 서랍 안에 그대로 넣는다.
  // 두 자리에서 같은 노드를 만드는 대신 하나를 그대로 옮겨 쓰는 것이라, 결정/구현/변경 내용이
  // 두 갈래로 갈라져 어긋날 일이 없다.
  const reference = (
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
              <span>{c.sourceLabel}</span>
            </span>
            {/* 출처는 라벨이지 링크가 아니다. 이 앱에서 --accent 밑줄은 누를 수 있는 것의 모습인데
                갈 곳이 아직 없다(근거 화면은 이 브랜치가 만들지 않는다) — 버튼과 달리 글에는
                누를 수 있다는 약속을 걸지 않고 메타로 되돌린다 */}
            <span className="hiw-cb">{c.body}</span>
          </div>
        ))}
      </section>
    </div>
  )

  return (
    <div className="hiw-pane">
      <div className="hiw-fhead">
        <h4>{feature.name}</h4>
        {/* 상태를 박아 두지 않는다 — 모양도 문구도 색도 사이드바와 같은 표를 본다(설계 §8).
            색을 여기서 따로 고르면 세 자리가 갈라진다(UnderstandingIcons 의 GLYPH_COLOR) */}
        <span className="hiw-st" style={{ color: GLYPH_COLOR[feature.status] }}>
          {GLYPH[feature.status]} {t(STATUS_KEY[feature.status])}
        </span>
        <span className="hiw-sp" />
        {/* 셋 다 아직 뒤가 없다. 사이드바의 [프로젝트 분석] 이 이미 이 경우의 답을 정해 두었으므로
            같은 토스트를 준다 — 한 화면에서 "아직 안 만든 컨트롤"에 두 가지 답을 주면, 눌러도
            아무 일이 없는 쪽은 사용자에게 고장으로 읽힌다 */}
        <button className="hiw-ghost" onClick={notYet}>
          {t('hiw.pane.evidence', { count: feature.evidenceCount })}
        </button>
        <button className="hiw-ghost" onClick={notYet}>
          {t('hiw.pane.edit')}
        </button>
        <button className="hiw-ghost acc" onClick={notYet}>
          {t('hiw.pane.regenerate')}
        </button>
        {narrow && (
          <button className="hiw-ghost acc" onClick={onToggleDrawer}>
            {t('hiw.pane.reference')} {drawerOpen ? '▾' : '▸'}
          </button>
        )}
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

        {!narrow && reference}
        {narrow && drawerOpen && <div className="hiw-drawer">{reference}</div>}
      </div>
    </div>
  )
}

/** `FeatureDetail` 을 페인 폭에 맞춰 씌운다. 폭은 `ResizeObserver` 로 재는데 — 페인은 사용자가
 *  끌어 나누므로 창 크기로는 알 수 없고, 이미 코드베이스가 자기 크기를 스스로 재는 자리마다 이
 *  방식을 쓴다(Select.tsx 의 메뉴 재기, RunPanel/TerminalBody 의 터미널 재기).
 *
 *  이 재는 일을 `FeatureDetail` 밖으로 뺀 이유: 그 컴포넌트의 테스트는 jsdom 도 `ResizeObserver` 도
 *  없이 `renderToStaticMarkup` 만으로 돌아간다(FeatureDetail.test.ts) — narrow/drawerOpen 을 강제로
 *  넘겨 접힌 렌더와 펼친 렌더를 확인해야 하므로, `FeatureDetail` 자신은 그 둘을 그대로 받는 순수한
 *  컴포넌트로 남겨 두고 재는 일은 이 컴포넌트에만 둔다.
 *
 *  **첫 재기는 `useLayoutEffect` 다** — `useEffect` 면 브라우저가 이미 넓은 2단 레이아웃을 한 번
 *  그린 뒤에야 좁혀서, 이미 좁은 페인에서 열면 첫 프레임이 넓게 그려졌다가 튄다. `Select.tsx` 의
 *  메뉴 자리 재기가 같은 이유로 이미 `useLayoutEffect` 를 쓴다. */
export function FeatureDetailHost(
  props: Omit<FeatureDetailProps, 'narrow' | 'drawerOpen' | 'onToggleDrawer'>
): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const measure = (width: number): void => setNarrow(width < NARROW_PANE)
    measure(host.clientWidth)
    const ro = new ResizeObserver((entries) => {
      measure(entries[0]?.contentRect.width ?? host.clientWidth)
    })
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  // 넓어지면 서랍을 닫아 둔다. 열어 둔 채로 두면 나중에 다시 좁혔을 때 누르지도 않은 서랍이 곧장
  // 열려 있는 것으로 보인다 — 좁힐 때마다 접힌 채로 시작하는 쪽이 놀라지 않는다.
  useEffect(() => {
    if (!narrow) setDrawerOpen(false)
  }, [narrow])

  return (
    <div className="workbench-body" ref={hostRef}>
      <FeatureDetail
        {...props}
        narrow={narrow}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
      />
    </div>
  )
}
