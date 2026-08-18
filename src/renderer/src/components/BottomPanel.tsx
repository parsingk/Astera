import { useState } from 'react'
import type { RunStatus, TerminalBuffer } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { RunPanel } from './RunPanel'
import { TerminalBody } from './TerminalBody'

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
  onStopRun: () => void
  onCollapse: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  // Clear means emptying the active body's xterm — bump a per-tab counter and let the body clear itself
  const [clearNonces, setClearNonces] = useState<Record<string, number>>({})
  const bump = (tab: string): void =>
    setClearNonces((prev) => ({ ...prev, [tab]: (prev[tab] ?? 0) + 1 }))

  const running = runStatus?.status === 'running'
  return (
    <div className="run-panel">
      <div className="bottom-tabs">
        <span className="bottom-tab-list">
          {runAvailable && (
          <button
            className={activeTab === 'run' ? 'bottom-tab on' : 'bottom-tab'}
            onClick={() => onSelectTab('run')}
          >
            {running && <span className="run-live-dot" />}
            {runStatus ? runStatus.configName : t('run.panel.noActiveRun')}
            {runStatus?.status === 'exited' && (
              <span className="run-exit">
                {t('run.panel.exited', { code: runStatus.exitCode ?? '?' })}
              </span>
            )}
          </button>
          )}
          {terminals.map((term, i) => (
            <span
              key={term.id}
              role="tab"
              aria-selected={activeTab === term.id}
              tabIndex={0}
              className={activeTab === term.id ? 'bottom-tab on' : 'bottom-tab'}
              onClick={() => onSelectTab(term.id)}
              onKeyDown={(e) => {
                // A ✕ <button> cannot be nested inside a <button>, so the tab itself is a span — the price
                // is wiring up keyboard accessibility by hand. The Run tab in the same strip is a button,
                // so it does not need this.
                // Keys that came up from the nested ✕ are handled by that button itself — without
                // filtering them out, pressing Space with ✕ focused fires both the selection and the close
                if (e.target !== e.currentTarget) return
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                onSelectTab(term.id)
              }}
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
                ✕
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
              ⏹
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
            ▽
          </button>
        </span>
      </div>
      <div className="bottom-bodies">
        <div className="bottom-body" style={{ display: activeTab === 'run' ? 'flex' : 'none' }}>
          <RunPanel projectPath={projectPath} clearNonce={clearNonces['run'] ?? 0} />
        </div>
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
