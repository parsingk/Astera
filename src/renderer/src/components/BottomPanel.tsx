import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunStatus, TerminalBuffer } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { RunPanel } from './RunPanel'
import { RunTabStrip } from './RunTabStrip'
import { RunToolRail } from './RunToolRail'
import { TerminalBody } from './TerminalBody'
import { FileIcon } from './FileIcon'
import { KubeLogPanel } from './kube/KubeLogPanel'
import { KubeSegments, type KubeSegment } from './kube/KubeSegments'
import { kubeCommandText, kubeFailureCount } from './kube/kubeLogView'
import type { KubeLogEntry } from '../hooks/useKubeOps'
import { logTabShowsContainer, type KubeLogTab } from '../lib/kubeLogTabs'
import { shellTabShowsContainer, type KubeShellTab } from '../lib/kubeShellTabs'
import { ChevronDown, Delete, Plus, Search, X } from 'lucide-react'

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
  configIds,
  selectedRunId,
  onSelectRun,
  onStopRun,
  onRerun,
  onDismissRun,
  onOpenFile,
  onOpenFolder,
  onOpenUrl,
  onOpenPreview,
  onSendRunLog,
  terminals,
  terminalCwd,
  activeTab,
  onSelectTab,
  onNewTerminal,
  onCloseTerminal,
  onCollapse,
  kubeLog = [],
  onKubeRerun,
  onKubeCancel,
  onKubeClear,
  kubeAvailable,
  kubeSegment,
  onKubeSegment,
  kubeCluster,
  kubeForwardCount,
  kubeForward,
  logTabs,
  onCloseLogTab,
  logHost,
  shellTabs,
  onCloseShellTab,
  shellHost,
  onShellAction
}: {
  /** Whether to draw the Run tab. false when no project is set (the panel opened from home) — run
   *  configurations are per project, there is nothing to run at home, and an empty Run tab looks broken.
   *  Defaults to true so existing callers with a project are unchanged. */
  runAvailable?: boolean
  /** This project's runs, finished ones included, in seat order */
  runs: RunStatus[]
  /** ids of the project's configurations as the toolbar knows them — the rail disables ↻ for a run whose
   *  id is not among them */
  configIds: readonly string[]
  selectedRunId: string | null
  onSelectRun: (runId: string) => void
  onStopRun: (runId: string) => void
  /** Start that configuration again — the rail's ↻ */
  onRerun: (configId: string) => void
  /** Drop a finished run — the tab's ✕. Only ever offered on a finished run, so a live run cannot be lost here. */
  onDismissRun: (runId: string) => void
  /** A path link in a console or a terminal was activated — App opens the file at that line, or a
   *  media file in the viewer */
  onOpenFile: (path: string, at: { line?: number; col?: number }) => void
  /** A folder a project terminal's link named (D2, 2026-10-14); the run console links files only. */
  onOpenFolder?: (path: string) => void
  /** A URL link in a console or a terminal was activated — App's link rule routes it. */
  onOpenUrl: (url: string, ev: MouseEvent) => void
  /** Open a running server's address in a preview tab — the run tab's globe button. */
  onOpenPreview: (url: string) => void
  /** The rail's send-to-agent for a run (spec W4): App opens the context preview from what its console holds. */
  onSendRunLog: (runId: string) => void
  terminals: TerminalBuffer[]
  /** The folder the terminals were opened in — a relative path link in one resolves against it */
  terminalCwd: string | null
  activeTab: string
  onSelectTab: (tab: string) => void
  onNewTerminal: () => void
  onCloseTerminal: (id: string) => void
  onCollapse: () => void
  /** The session's Kubernetes operations, shown in the Kubernetes tab's Operation log segment. */
  kubeLog?: KubeLogEntry[]
  onKubeRerun?: (id: string) => void
  onKubeCancel?: (id: string) => void
  onKubeClear?: () => void
  /** Whether to draw the Kubernetes tab: kubectl is found, or the log has entries to show (spec 4.1, 4.12). */
  kubeAvailable: boolean
  /** The Kubernetes tab's segment: the cluster view, the port forwards or the operation log. */
  kubeSegment: KubeSegment
  onKubeSegment: (s: KubeSegment) => void
  /** The Cluster segment's body, given the segmented switch to put first in its toolbar row (spec 4.2). App owns the
   *  view's state, so it builds this (or the kubectl-missing notice). */
  kubeCluster: (switcher: React.ReactNode) => React.ReactNode
  /** The Port forwarding segment's count and body, built by App, which owns the forwards. */
  kubeForwardCount: number
  kubeForward: (switcher: React.ReactNode) => React.ReactNode
  /** Pods' logs tabs, after the Kubernetes tab (spec 4.8). App keeps each one's view mounted in an element of its own
   *  (`logHost`) for the tab's life, so collapsing this panel does not stop its kubectl; the tab's body holds that
   *  element while the panel is open. */
  logTabs: KubeLogTab[]
  onCloseLogTab: (id: string) => void
  logHost: (id: string) => HTMLElement
  /** Shells into containers, after the logs tabs (spec 4.8), kept the same way: App holds each KubeShellView in the
   *  element `shellHost` gives. `onShellAction` is the header's find and clear for the shown shell tab. */
  shellTabs: KubeShellTab[]
  onCloseShellTab: (id: string) => void
  shellHost: (id: string) => HTMLElement
  onShellAction: (id: string, what: 'clear' | 'find') => void
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

  // A tab focused off the end of the strip (the strip scrolls sideways) would stay out of sight: bring the shown one in.
  const tabListRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    tabListRef.current?.querySelector(`[data-tab-id="${CSS.escape(activeTab)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [activeTab])

  const kubeFailures = kubeFailureCount(kubeLog)
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
        <span className="bottom-tab-list" ref={tabListRef}>
          {runAvailable && (
            <span
              role="tab"
              data-tab-id="run"
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
          {kubeAvailable && (
            <span
              role="tab"
              data-tab-id="kube"
              aria-selected={activeTab === 'kube'}
              tabIndex={0}
              className={activeTab === 'kube' ? 'bottom-tab on' : 'bottom-tab'}
              onClick={() => onSelectTab('kube')}
              onKeyDown={tabKeyDown('kube')}
            >
              <FileIcon id="kubernetes" tone="blue" />
              {t('kube.log.tab')}
              {kubeFailures > 0 && (
                <span className="bottom-tab-badge" title={t('kube.log.tabFailures', { count: kubeFailures })} aria-label={t('kube.log.tabFailures', { count: kubeFailures })}>
                  {kubeFailures}
                </span>
              )}
            </span>
          )}
          {logTabs.map((tab) => (
            <span
              key={tab.id}
              role="tab"
              data-tab-id={tab.id}
              aria-selected={activeTab === tab.id}
              tabIndex={0}
              className={activeTab === tab.id ? 'bottom-tab on' : 'bottom-tab'}
              // Two tabs of one Pod read the same: where each reads from tells them apart.
              title={`${[tab.ref.context, tab.ref.namespace].filter((s) => s !== null).join(' / ')} · ${t('kube.logs.container')} ${tab.container}`}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={tabKeyDown(tab.id)}
            >
              {logTabShowsContainer(logTabs, tab)
                ? t('kube.logs.tabContainer', { pod: tab.ref.name, container: tab.container })
                : t('kube.logs.tab', { pod: tab.ref.name })}
              <button
                className="bottom-tab-close"
                aria-label={t('kube.logs.closeTab')}
                title={t('kube.logs.closeTab')}
                onClick={(e) => {
                  e.stopPropagation() // keeps close from also selecting the tab it closes
                  onCloseLogTab(tab.id)
                }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {shellTabs.map((tab) => (
            <span
              key={tab.id}
              role="tab"
              data-tab-id={tab.id}
              aria-selected={activeTab === tab.id}
              tabIndex={0}
              className={'bottom-tab' + (activeTab === tab.id ? ' on' : '') + (tab.ended ? ' ended' : '')}
              // Two tabs of one Pod read the same: where each reads from tells them apart.
              title={`${[tab.ref.context, tab.ref.namespace].filter((s) => s !== null).join(' / ')} · ${t('kube.logs.container')} ${tab.container}`}
              onClick={() => onSelectTab(tab.id)}
              onKeyDown={tabKeyDown(tab.id)}
            >
              {shellTabShowsContainer(shellTabs, tab)
                ? t('kube.shell.tabContainer', { pod: tab.ref.name, container: tab.container })
                : t('kube.shell.tab', { pod: tab.ref.name })}
              <button
                className="bottom-tab-close"
                aria-label={t('kube.shell.closeTab')}
                title={t('kube.shell.closeTab')}
                onClick={(e) => {
                  e.stopPropagation() // keeps close from also selecting the tab it closes
                  onCloseShellTab(tab.id)
                }}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {terminals.map((term, i) => (
            <span
              key={term.id}
              role="tab"
              data-tab-id={term.id}
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
              for terminal tabs, which have no rail. A logs tab clears from its own toolbar. */}
          {terminals.some((term) => term.id === activeTab) && (
            <button className="run-panel-btn" title={t('run.panel.clear')} onClick={() => bump(setClearNonces, activeTab)}>
              <Delete size={12} />
            </button>
          )}
          {shellTabs.some((tab) => tab.id === activeTab) && (
            <>
              <button className="run-panel-btn" title={t('kube.shell.find')} aria-label={t('kube.shell.find')} onClick={() => onShellAction(activeTab, 'find')}>
                <Search size={12} />
              </button>
              <button className="run-panel-btn" title={t('run.panel.clear')} aria-label={t('run.panel.clear')} onClick={() => onShellAction(activeTab, 'clear')}>
                <Delete size={12} />
              </button>
            </>
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
              rerunGone={!!selectedRun && !configIds.includes(selectedRun.configId)}
              findOpen={!!(selectedRunId && findOpen[selectedRunId])}
              onRerun={onRerun}
              onStop={onStopRun}
              onScrollToEnd={() => selectedRunId && bump(setScrollNonces, selectedRunId)}
              onClear={() => selectedRunId && bump(setClearNonces, selectedRunId)}
              onToggleFind={() => selectedRunId && setFindOpen((prev) => ({ ...prev, [selectedRunId]: !prev[selectedRunId] }))}
              onSendToAgent={onSendRunLog}
            />
            <div className="run-main">
              <RunTabStrip runs={runs} selectedId={selectedRunId} now={now} onSelect={onSelectRun} onDismiss={onDismissRun} onOpenPreview={onOpenPreview} />
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
                      onOpenUrl={onOpenUrl}
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
        {kubeAvailable && (
          <div className="bottom-body kube-body" style={{ display: activeTab === 'kube' ? 'flex' : 'none' }}>
            <KubeSegments
              segment={kubeSegment}
              onSegment={onKubeSegment}
              logCount={kubeLog.length}
              cluster={kubeCluster}
              forwardCount={kubeForwardCount}
              forward={kubeForward}
              log={
                <KubeLogPanel
                  log={kubeLog}
                  onRerun={(id) => onKubeRerun?.(id)}
                  onCancel={(id) => onKubeCancel?.(id)}
                  onCopy={(id) => {
                    const e = kubeLog.find((x) => x.id === id)
                    if (e) window.api.clipboard.writeText(e.commandLines.map((a) => kubeCommandText(a, window.api.platform)).join(String.fromCharCode(10)))
                  }}
                  onClear={() => onKubeClear?.()}
                  onOpenFile={(path) => onOpenFile(path, {})}
                />
              }
            />
          </div>
        )}
        {logTabs.map((tab) => (
          <HostedBody key={tab.id} host={logHost(tab.id)} shown={activeTab === tab.id} />
        ))}
        {shellTabs.map((tab) => (
          <HostedBody key={tab.id} host={shellHost(tab.id)} shown={activeTab === tab.id} />
        ))}
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
              cwd={terminalCwd}
              onOpenUrl={onOpenUrl}
              onOpenFile={onOpenFile}
              onOpenFolder={onOpenFolder}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Puts a logs view's element in its tab's body unless it is there already: an element moved out and back loses its
 *  scroll position, so a body drawn again must leave it where it is. A body going away (null) lets go of it, or the
 *  element would keep the removed panel's DOM in memory until the panel opened again. */
export function holdHost(body: Node | null, host: Node): void {
  if (body === null) host.parentNode?.removeChild(host)
  else if (host.parentNode !== body) body.appendChild(host)
}

/** A logs or shell tab's body. The view is not mounted here: App keeps it in `host`, so the panel's own mount and
 *  unmount (a collapse) leave its kubectl or shell and lines alone, and the body only holds that element while it is
 *  drawn. */
function HostedBody({ host, shown }: { host: HTMLElement; shown: boolean }): React.JSX.Element {
  const hold = useCallback((el: HTMLDivElement | null) => holdHost(el, host), [host])
  return <div ref={hold} className="bottom-body" style={{ display: shown ? 'flex' : 'none' }} />
}
