import { useEffect, useState } from 'react'
import type { RunStatus, TerminalBuffer } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { RunPanel } from './RunPanel'
import { RunTabStrip } from './RunTabStrip'
import { RunToolRail } from './RunToolRail'
import { TerminalBody } from './TerminalBody'
import { ChevronDown, Delete, Plus, X } from 'lucide-react'

/**
 * Bottom panel. The Run tab and the project terminals share this one panel through tabs.
 * The tab strip, collapse and clear chrome are owned only here; the bodies (RunPanel,
 * TerminalBody) draw nothing but xterm.
 * The Run tab's body is a tool rail on the left and, to its right, a strip of run tabs over the selected
 * run's console. Every run has its own RunPanel, and the ones not selected stay mounted under
 * display:none — the same approach as the session tabs (TerminalView) and the terminal tabs below — so
 * their scrollback and their find state survive switching tabs.
 */
export function BottomPanel({
  runAvailable = true,
  runs,
  selectedRunId,
  onSelectRun,
  onStopRun,
  onRerun,
  onDismissRun,
  onOpenFile,
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
  /** Start that configuration again — the rail's ↻ */
  onRerun: (configId: string) => void
  /** Drop a finished run — the tab's ✕. Only ever offered on a finished run, so a live run cannot be lost here. */
  onDismissRun: (runId: string) => void
  /** A path link in a console was activated — App opens the file at that line */
  onOpenFile: (path: string, at: { line?: number; col?: number }) => void
  terminals: TerminalBuffer[]
  activeTab: string
  onSelectTab: (tab: string) => void
  onNewTerminal: () => void
  onCloseTerminal: (id: string) => void
  onCollapse: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  // Clear means emptying a body's xterm — bump a per-body counter (a runId or a terminal id) and let the
  // body clear itself. Scroll-to-end works the same way for runs.
  const [clearNonces, setClearNonces] = useState<Record<string, number>>({})
  const [scrollNonces, setScrollNonces] = useState<Record<string, number>>({})
  const bump = (set: typeof setClearNonces, key: string): void =>
    set((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }))
  // The find bar is per run, so switching tabs shows that run's search
  const [findOpen, setFindOpen] = useState<Record<string, boolean>>({})

  // One clock for the whole panel, ticking only while something is still alive. Finished runs are
  // computed from their own exitedAt, so the tick never changes their text.
  const anyRunning = runs.some((r) => r.status !== 'exited')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [anyRunning])

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
          {/* On the Run tab, stop and clear live in the rail beside the console; the header keeps them
              for terminal tabs, which have no rail. */}
          {activeTab !== 'run' && (
            <button className="run-panel-btn" title={t('run.panel.clear')} onClick={() => bump(setClearNonces, activeTab)}>
              <Delete size={12} />
            </button>
          )}
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
            <RunToolRail
              run={selectedRun}
              findOpen={!!(selectedRunId && findOpen[selectedRunId])}
              onRerun={onRerun}
              onStop={onStopRun}
              onScrollToEnd={() => selectedRunId && bump(setScrollNonces, selectedRunId)}
              onClear={() => selectedRunId && bump(setClearNonces, selectedRunId)}
              onToggleFind={() => selectedRunId && setFindOpen((prev) => ({ ...prev, [selectedRunId]: !prev[selectedRunId] }))}
            />
            <div className="run-main">
              <RunTabStrip runs={runs} selectedId={selectedRunId} now={now} onSelect={onSelectRun} onDismiss={onDismissRun} />
              <div className="run-consoles">
                {runs.map((r) => (
                  <div
                    key={r.runId}
                    className="run-console"
                    style={{ display: r.runId === selectedRunId ? 'flex' : 'none' }}
                  >
                    <RunPanel
                      runId={r.runId}
                      clearNonce={clearNonces[r.runId] ?? 0}
                      scrollToEndNonce={scrollNonces[r.runId] ?? 0}
                      findOpen={!!findOpen[r.runId]}
                      onFindOpenChange={(open) => setFindOpen((prev) => ({ ...prev, [r.runId]: open }))}
                      onOpenFile={onOpenFile}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {/* Inactive tabs stay mounted with display:none (see the comment above) — as a result, when a
            terminal tab is first mounted while inactive, TerminalBody's initial fit.fit() runs against a
            0×0 host and xterm stays at the default 80×24 (the PTY is 120×30). Output that arrives while
            hidden wraps at that width, but opening the tab makes the ResizeObserver refit and corrects it
            — cosmetic and self-correcting. The same applies to a RunPanel mounted for a tab that is not
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
