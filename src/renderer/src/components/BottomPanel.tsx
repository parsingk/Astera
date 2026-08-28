import { useState } from 'react'
import type { RunStatus, TerminalBuffer } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { RunPanel } from './RunPanel'
import { TerminalBody } from './TerminalBody'
import { ChevronDown, Square, X } from 'lucide-react'

/**
 * Bottom panel. The Run console and the project terminals share this one panel through tabs.
 * The tab strip, collapse, clear and stop chrome are owned only here, and the bodies (RunPanel,
 * TerminalBody) draw nothing but xterm.
 * Inactive tabs are not unmounted, they are hidden with display:none — the same approach as the session
 * tabs (TerminalView), so the scrollback and xterm state are preserved and the buffer is not replayed on
 * every tab switch.
 */
export function BottomPanel({
  projectPath,
  runStatus,
  runAvailable = true,
  terminals,
  activeTab,
  onSelectTab,
  onNewTerminal,
  onCloseTerminal,
  onCloseRun,
  onStopRun,
  onCollapse
}: {
  projectPath: string
  runStatus: RunStatus | null
  /** Run 탭을 그릴지. 프로젝트가 지정되지 않았을 때(홈에서 연 패널) false — 실행 구성은 프로젝트
   *  단위라 홈에서는 돌릴 것이 없고, 빈 Run 탭은 고장처럼 보인다. 기본값 true 는 프로젝트가 있는
   *  기존 호출자를 그대로 두기 위한 것이다. */
  runAvailable?: boolean
  terminals: TerminalBuffer[]
  activeTab: string
  onSelectTab: (tab: string) => void
  onNewTerminal: () => void
  onCloseTerminal: (id: string) => void
  /** Run 탭의 ✕. 종료된 실행에만 그려지므로 도는 실행을 여기서 잃을 일은 없다 — 정지는 ⏹ 이다. */
  onCloseRun: () => void
  onStopRun: () => void
  onCollapse: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  // Clear means emptying the active body's xterm — bump a per-tab counter and let the body clear itself
  const [clearNonces, setClearNonces] = useState<Record<string, number>>({})
  const bump = (tab: string): void =>
    setClearNonces((prev) => ({ ...prev, [tab]: (prev[tab] ?? 0) + 1 }))

  const running = runStatus?.status === 'running'
  // 탭 자체의 Enter/Space. ✕ 를 품는 탭은 <button> 안에 <button> 을 넣을 수 없어 span 이어야 하고,
  // 그 대가로 키보드 접근성을 손으로 잇는다. 중첩된 ✕ 에서 올라온 키는 그 버튼이 이미 처리했으므로
  // 걸러낸다 — 거르지 않으면 ✕ 에 포커스를 둔 채 Space 를 누를 때 선택과 닫기가 함께 발화한다.
  const tabKeyDown =
    (tab: string) =>
    (e: React.KeyboardEvent): void => {
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      onSelectTab(tab)
    }
  return (
    <div className="run-panel">
      <div className="bottom-tabs">
        <span className="bottom-tab-list">
          {runAvailable && (
            <span
              role="tab"
              aria-selected={activeTab === 'run'}
              tabIndex={0}
              className={activeTab === 'run' ? 'bottom-tab on' : 'bottom-tab'}
              onClick={() => onSelectTab('run')}
              onKeyDown={tabKeyDown('run')}
            >
              {running && <span className="run-live-dot" />}
              {runStatus ? runStatus.configName : t('run.panel.noActiveRun')}
              {/* 끝난 실행에만 종료 배지와 ✕ 가 함께 붙는다. 도는 실행에 ✕ 를 두면 자식 프로세스를
                  남긴 채 탭만 사라진다 — 그쪽은 오른쪽의 ⏹ 이 맡는다. */}
              {runStatus?.status === 'exited' && (
                <>
                  <span className="run-exit">
                    {t('run.panel.exited', { code: runStatus.exitCode ?? '?' })}
                  </span>
                  <button
                    className="bottom-tab-close"
                    aria-label={t('run.panel.close')}
                    title={t('run.panel.close')}
                    onClick={(e) => {
                      e.stopPropagation() // keeps close from misfiring the tab selection
                      onCloseRun()
                    }}
                  >
                    <X size={11} />
                  </button>
                </>
              )}
            </span>
          )}
          {terminals.map((term, i) => (
            <span
              key={term.id}
              role="tab"
              aria-selected={activeTab === term.id}
              tabIndex={0}
              className={activeTab === term.id ? 'bottom-tab on' : 'bottom-tab'}
              onClick={() => onSelectTab(term.id)}
              onKeyDown={tabKeyDown(term.id)}
            >
              {/* The number in the label is the display order in the current list — creation order is not remembered */}
              {t('terminal.tab.label', { n: i + 1 })}
              <button
                className="bottom-tab-close"
                aria-label={t('terminal.tab.close')}
                title={t('terminal.tab.close')}
                onClick={(e) => {
                  e.stopPropagation() // keeps close from misfiring the tab selection
                  onCloseTerminal(term.id)
                }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <button
            className="bottom-tab-new"
            aria-label={t('terminal.tab.new')}
            title={t('terminal.tab.new')}
            onClick={onNewTerminal}
          >
            ＋
          </button>
        </span>
        <span className="run-panel-actions">
          {/* The actions match the active tab — stop only appears on the Run tab */}
          {activeTab === 'run' && running && (
            <button className="run-panel-btn stop" title={t('run.action.stop')} onClick={onStopRun}>
              <Square size={12} fill="currentColor" strokeWidth={0} />
            </button>
          )}
          <button
            className="run-panel-btn"
            title={t('run.panel.clear')}
            onClick={() => bump(activeTab)}
          >
            ⌫
          </button>
          <button className="run-panel-btn" title={t('run.panel.collapse')} onClick={onCollapse}>
            <ChevronDown size={12} />
          </button>
        </span>
      </div>
      <div className="bottom-bodies">
        {/* runAvailable 로 **마운트 자체를** 막는다. 비활성 탭은 display:none 으로 살려 두는 것이 이
            패널의 관례지만(아래 주석), RunPanel 은 마운트되면 projectPath 로 run.list 를 부른다 —
            프로젝트가 없을 때 그 값은 홈이고, 실행 구성 조회는 홈을 허용하지 않으므로 탭이 보이지도
            않는데 거부된 요청이 매번 나간다. */}
        {runAvailable && (
          <div className="bottom-body" style={{ display: activeTab === 'run' ? 'flex' : 'none' }}>
            <RunPanel projectPath={projectPath} clearNonce={clearNonces['run'] ?? 0} />
          </div>
        )}
        {/* Inactive tabs stay mounted with display:none (see the comment above) — as a result, when a
            terminal tab is first mounted while inactive, TerminalBody's initial fit.fit() runs against a
            0×0 host and xterm stays at the default 80×24 (the PTY is 120×30). Output that arrives while
            hidden wraps at that width, but opening the tab makes the ResizeObserver refit and corrects it
            — cosmetic and self-correcting. */}
        {terminals.map((term) => (
          <div
            key={term.id}
            className="bottom-body"
            style={{ display: activeTab === term.id ? 'flex' : 'none' }}
          >
            <TerminalBody
              id={term.id}
              initialBuffer={term.buffer}
              clearNonce={clearNonces[term.id] ?? 0}
              active={activeTab === term.id}
            />
          </div>
        ))}
      </div>
    </div>
  )
}
