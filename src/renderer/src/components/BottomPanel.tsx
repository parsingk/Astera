import { useState } from 'react'
import type { RunStatus, TerminalBuffer } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { RunInstanceList } from './RunInstanceList'
import { RunPanel } from './RunPanel'
import { TerminalBody } from './TerminalBody'
import { ChevronDown, Delete, Plus, Square, X } from 'lucide-react'

/**
 * Bottom panel. The Run tab and the project terminals share this one panel through tabs.
 * The tab strip, collapse, clear and stop chrome are owned only here; the bodies (RunPanel,
 * TerminalBody) draw nothing but xterm.
 * The Run tab's body is two panes: the project's runs on the left (RunInstanceList), the selected run's
 * console on the right. Every run has its own RunPanel, and the ones not selected stay mounted under
 * display:none — the same approach as the session tabs (TerminalView) and the terminal tabs below — so
 * their scrollback survives switching rows and no buffer is replayed on every switch.
 */
export function BottomPanel({
  runAvailable = true,
  runs,
  selectedRunId,
  onSelectRun,
  onStopRun,
  onRerun,
  onDismissRun,
  terminals,
  activeTab,
  onSelectTab,
  onNewTerminal,
  onCloseTerminal,
  onCollapse
}: {
  /** Whether to draw the Run tab. false when no project is set (the panel opened from home) — run
   *  configurations are per project, there is nothing to run at home, and an empty Run tab looks broken.
   *  Defaults to true so existing callers with a project are unchanged. */
  runAvailable?: boolean
  /** This project's runs, finished ones included, in seat order */
  runs: RunStatus[]
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
  onStopRun: (runId: string) => void
  /** Start that configuration again — the list's ↻ on a finished row */
  onRerun: (configId: string) => void
  /** Drop a finished run — the list's ✕. Only ever offered on a finished row, so a live run cannot be lost here. */
  onDismissRun: (runId: string) => void
  terminals: TerminalBuffer[]
  activeTab: string
  onSelectTab: (tab: string) => void
  onNewTerminal: () => void
  onCloseTerminal: (id: string) => void
  onCollapse: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  // Clear means emptying the active body's xterm — bump a per-body counter (a runId or a terminal id)
  // and let the body clear itself
  const [clearNonces, setClearNonces] = useState<Record<string, number>>({})
  const bump = (key: string): void =>
    setClearNonces((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }))

  const anyRunning = runs.some((r) => r.status === 'running')
  const selectedRun = runs.find((r) => r.runId === selectedRunId) ?? null
  // The tab's own Enter/Space. A tab that holds a ✕ cannot be a <button> (no button inside a button),
  // so it is a span and keyboard access is wired by hand. A key that bubbled up from the nested ✕ has
  // already been handled by that button and is left alone — otherwise Space on a focused ✕ would both
  // select and close.
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
              {anyRunning && <span className="run-live-dot" />}
              {t('run.panel.tab')}
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
            <Plus size={13} />
          </button>
        </span>
        <span className="run-panel-actions">
          {/* The actions follow the active tab — stop only appears on the Run tab, for the selected run */}
          {activeTab === 'run' && selectedRun?.status === 'running' && (
            <button className="run-panel-btn stop" title={t('run.action.stop')} onClick={() => onStopRun(selectedRun.runId)}>
              <Square size={12} fill="currentColor" strokeWidth={0} />
            </button>
          )}
          <button
            className="run-panel-btn"
            title={t('run.panel.clear')}
            // On the Run tab the body being cleared is the selected run's console
            disabled={activeTab === 'run' && !selectedRunId}
            onClick={() => bump(activeTab === 'run' ? (selectedRunId ?? 'run') : activeTab)}
          >
            <Delete size={12} />
          </button>
          <button className="run-panel-btn" title={t('run.panel.collapse')} onClick={onCollapse}>
            <ChevronDown size={12} />
          </button>
        </span>
      </div>
      <div className="bottom-bodies">
        {/* runAvailable gates the **mount itself**. Hidden tabs are kept alive with display:none elsewhere
            in this panel (below), but every RunPanel calls run.output for its run on mount, and with no
            project there is no run to ask about. */}
        {runAvailable && (
          <div className="bottom-body run-body" style={{ display: activeTab === 'run' ? 'flex' : 'none' }}>
            <RunInstanceList
              runs={runs}
              selectedId={selectedRunId}
              onSelect={onSelectRun}
              onStop={onStopRun}
              onRerun={onRerun}
              onDismiss={onDismissRun}
            />
            <div className="run-consoles">
              {runs.map((r) => (
                <div
                  key={r.runId}
                  className="run-console"
                  style={{ display: r.runId === selectedRunId ? 'flex' : 'none' }}
                >
                  <RunPanel runId={r.runId} clearNonce={clearNonces[r.runId] ?? 0} />
                </div>
              ))}
            </div>
          </div>
        )}
        {/* Inactive tabs stay mounted with display:none (see the comment above) — as a result, when a
            terminal tab is first mounted while inactive, TerminalBody's initial fit.fit() runs against a
            0×0 host and xterm stays at the default 80×24 (the PTY is 120×30). Output that arrives while
            hidden wraps at that width, but opening the tab makes the ResizeObserver refit and corrects it
            — cosmetic and self-correcting. The same applies to a RunPanel mounted for a row that is not
            selected. */}
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
