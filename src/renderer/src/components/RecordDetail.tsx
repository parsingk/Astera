import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { WorkRecord } from '../../../core/understanding/types'
import { scopeToStep } from '../../../core/understanding/scope'
import { toast } from '../lib/toast'
import { useI18n } from '../i18n/I18nProvider'
import { FlowDiagram } from './FlowDiagram'
import { RECORD_GLYPH, RECORD_GLYPH_COLOR, RECORD_STATUS_KEY, StatusGlyph } from './UnderstandingIcons'

/** 참조 단이 접히는 폭. 이 아래에서는 왼쪽 본문이 40자 밑으로 내려가 흐름도가 잘린다. */
const NARROW_PANE = 720

type RecordDetailProps = {
  record: WorkRecord
  /** 고른 흐름 단계. 고를 수 없는 단계가 들어오면 scopeToStep 이 null 을 주고 전체를 그린다 */
  scopedNodeId: string | null
  onPickStep: (nodeId: string | null) => void
  onOpenPath: (path: string) => void
  /** 페인이 좁다(NARROW_PANE 미만). 참조 단을 접고 머리에 버튼을 남긴다.
   *  **아래로 이어 붙이지 않는다** — 그러면 좁은 화면에서 이 화면이 세로 한 장짜리 다른 레이아웃이
   *  되고, 사용자는 폭에 따라 서로 다른 두 화면을 배우게 된다(설계 §6). 그 대신 한 레이아웃을 그대로
   *  두고 절반을 접는다 — 서랍으로. */
  /** Writes this record's explanation again — the head's [Write it up again]. Goes to the same
   *  place as the sidebar row's button of the same name (UnderstandingView's onRegenerate). */
  onRegenerate: () => void
  narrow: boolean
  drawerOpen: boolean
  onToggleDrawer: () => void
}

/** One record's detail. The left side is the story a person reads; the right side is the reference
 *  a developer double-checks against — "explanation first, implementation after" is kept not by
 *  top-to-bottom order but by left-right space (design §4). */
export function RecordDetail({
  record,
  scopedNodeId,
  onPickStep,
  onOpenPath,
  onRegenerate,
  narrow,
  drawerOpen,
  onToggleDrawer
}: RecordDetailProps): React.JSX.Element {
  const { t } = useI18n()
  const explanation = record.explanation

  if (!explanation) {
    return <div className="hiw-pane hiw-pane-empty">{t('hiw.pane.noExplanation')}</div>
  }

  const notYet = (): void => toast.info(t('hiw.pane.notYet'))

  const scoped = scopedNodeId ? scopeToStep(explanation, scopedNodeId) : null

  // The reference column is pulled out into one variable — placed beside the body when wide, tucked
  // into the drawer when narrow. Building the same node in two places instead of moving one node
  // between two slots is what keeps decisions and implementation from drifting apart between them.
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
        {(scoped ? scoped.decisions : explanation.decisions).map((d) => (
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
            // 경로만으로는 키가 겹칠 수 있다 — 한 파일이 두 역할을 맡는 것은 생성기의 현실적인
            // 출력이다("인증 API" 와 "세션 저장" 이 같은 파일)
            <span key={`${i.role}:${i.path}`} className="hiw-impl-row">
              <b>{i.role}</b>
              {/* Splits on both separators — if the stored path uses backslashes, `/` alone cuts
                  nothing and the whole path lands where the filename should. The click side
                  (onOpenPath, App's openRecordPath) also accepts both. */}
              <button onClick={() => onOpenPath(i.path)}>{i.path.split(/[/\\]/).pop()}</button>
            </span>
          ))}
        </div>
      </section>
    </div>
  )

  return (
    <div className="hiw-pane">
      <div className="hiw-fhead">
        <h4>{record.request}</h4>
        {/* The status is not hard-coded here — shape, wording and colour all read the same table
            the sidebar does (design §8). Picking the colour separately here would let the three
            places drift apart (UnderstandingIcons' RECORD_GLYPH_COLOR). */}
        <span className="hiw-st" style={{ color: RECORD_GLYPH_COLOR[record.status] }}>
          <StatusGlyph glyph={RECORD_GLYPH[record.status]} spinning={record.status === 'generating'} />{' '}
          {t(RECORD_STATUS_KEY[record.status])}
        </span>
        <span className="hiw-sp" />
        {/* This button has nothing behind it yet — editing has no place to save to (§56's
            userEdited) yet. Saying "not yet" beats a button that does nothing when pressed: on a
            screen like this, an unresponsive button reads as broken. */}
        <button className="hiw-ghost" onClick={notYet}>
          {t('hiw.pane.edit')}
        </button>
        {/* 이쪽은 뒤가 있다. 도는 동안은 잠근다 — 두 번 누르면 두 번 돈다 */}
        <button className="hiw-ghost acc" onClick={onRegenerate} disabled={record.status === 'generating'}>
          {/* 방금 누른 자리에서 움직임이 보여야 한다 — 잠긴 버튼만으로는 눌린 것인지 고장인지 모른다 */}
          {record.status === 'generating' ? (
            <>
              <StatusGlyph glyph={RECORD_GLYPH.generating} spinning /> {t('hiw.record.generating')}
            </>
          ) : (
            t('hiw.record.regenerate')
          )}
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

          {/* Empty when the work changed nothing a user would notice (an internal refactor, a test
              fixed) — the guard keeps that case from drawing a labelled section with nothing in it */}
          {explanation.userVisibleChanges.length > 0 && (
            <section className="hiw-sec">
              <p className="hiw-lab">{t('hiw.pane.userVisible')}</p>
              <ul className="hiw-p">
                {explanation.userVisibleChanges.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </section>
          )}

          {/* A record whose flow is empty is expected (a change that only touched configuration or
              logging, say). Without this guard an empty box with just the label and a "click a step
              to..." hint would remain, and with no step to click that hint would be a lie. */}
          {explanation.flow.length > 0 && (
            <section className="hiw-sec hiw-grow">
              <p className="hiw-lab">{t('hiw.pane.flow')}</p>
              <FlowDiagram
                nodes={explanation.flow}
                selectedId={scoped?.node.id ?? null}
                onPick={onPickStep}
              />
            </section>
          )}
        </div>

        {!narrow && reference}
        {narrow && drawerOpen && <div className="hiw-drawer">{reference}</div>}
      </div>
    </div>
  )
}

/** Wraps `RecordDetail` to fit the pane's width. The width is measured with `ResizeObserver` —
 *  panes are resized by the user so window size cannot tell it, and the codebase already uses this
 *  approach everywhere it measures its own size (Select.tsx's menu sizing, RunPanel/TerminalBody's
 *  terminal sizing).
 *
 *  Why this measuring is kept out of `RecordDetail`: that component's test runs on
 *  `renderToStaticMarkup` alone, without jsdom or `ResizeObserver` (RecordDetail.test.ts) — it has to
 *  force narrow/drawerOpen to check the folded and unfolded renders, so `RecordDetail` itself stays a
 *  pure component that just takes those two as given, and the measuring lives only in this component.
 *
 *  **The first measurement is `useLayoutEffect`.** With `useEffect`, the browser would already paint
 *  the wide two-column layout once before narrowing it, so opening an already-narrow pane would flash
 *  wide on the first frame. `Select.tsx`'s menu placement already uses `useLayoutEffect` for the same
 *  reason. */
export function RecordDetailHost(
  props: Omit<RecordDetailProps, 'narrow' | 'drawerOpen' | 'onToggleDrawer'>
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
      <RecordDetail
        {...props}
        narrow={narrow}
        drawerOpen={drawerOpen}
        onToggleDrawer={() => setDrawerOpen((v) => !v)}
      />
    </div>
  )
}
