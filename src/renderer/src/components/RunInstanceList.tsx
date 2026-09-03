import type { RunStatus } from '../../../core/types'
import { labelRuns } from '../../../core/run/instances'
import { useI18n } from '../i18n/I18nProvider'
import { RotateCw, Square, X } from 'lucide-react'

/** The left pane of the Run tab: one row per run of the current project, in seat order. A row shows
 *  the run's state, its label (repeats of one configuration are numbered — core/run/instances.ts
 *  labelRuns) and, once finished, its exit code. Actions are per state: a running run can be stopped,
 *  a finished one rerun or closed, a stopping one only waited for. Close is drawn only on a finished
 *  run — a live run is stopped, not closed, or its children would be left behind.
 *
 *  Rerun asks for the *configuration* to be started, not this run: decideStart in main decides whether
 *  that means a fresh run in this seat (placeNewRun) or a restart of a live instance elsewhere. */
export function RunInstanceList({
  runs,
  selectedId,
  onSelect,
  onStop,
  onRerun,
  onDismiss
}: {
  runs: RunStatus[]
  selectedId: string | null
  onSelect: (runId: string) => void
  onStop: (runId: string) => void
  onRerun: (configId: string) => void
  onDismiss: (runId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  if (runs.length === 0) return <div className="run-list run-list-empty" role="note" aria-label={t('run.panel.tab')}>{t('run.panel.empty')}</div>
  const labels = new Map(labelRuns(runs).map((l) => [l.runId, l.label]))
  // A row holds buttons, so it is a div with role=option rather than a <button> — the same reason the
  // bottom tabs are spans (BottomPanel). Enter/Space select; a key that bubbled up from a button inside
  // is left to that button.
  const rowKeyDown =
    (runId: string) =>
    (e: React.KeyboardEvent): void => {
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      onSelect(runId)
    }
  return (
    <div className="run-list" role="listbox" aria-label={t('run.panel.tab')}>
      {runs.map((r) => (
        <div
          key={r.runId}
          role="option"
          aria-selected={r.runId === selectedId}
          tabIndex={0}
          className={`run-row${r.runId === selectedId ? ' on' : ''}`}
          onClick={() => onSelect(r.runId)}
          onKeyDown={rowKeyDown(r.runId)}
        >
          <span
            className={`run-row-dot ${r.status}`}
            title={r.status === 'stopping' ? t('run.panel.stopping') : undefined}
          />
          <span className="run-row-label">{labels.get(r.runId)}</span>
          {r.validation === true && (
            <span className="run-tag" title={t('run.validation.tag')}>
              {t('run.validation.tag')}
            </span>
          )}
          {r.status === 'exited' && (
            <span className={`run-row-exit${r.exitCode === 0 ? '' : ' fail'}`}>
              {t('run.panel.exitCode', { code: r.exitCode ?? '?' })}
            </span>
          )}
          <span className="run-row-actions">
            {r.status === 'running' && (
              <button
                className="run-row-btn stop"
                title={t('run.action.stop')}
                aria-label={t('run.action.stop')}
                onClick={(e) => {
                  e.stopPropagation() // keeps the button from also selecting the row
                  onStop(r.runId)
                }}
              >
                <Square size={9} fill="currentColor" strokeWidth={0} />
              </button>
            )}
            {r.status === 'exited' && (
              <>
                <button
                  className="run-row-btn"
                  title={t('run.action.rerun')}
                  aria-label={t('run.action.rerun')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRerun(r.configId)
                  }}
                >
                  <RotateCw size={11} />
                </button>
                <button
                  className="run-row-btn"
                  title={t('run.panel.close')}
                  aria-label={t('run.panel.close')}
                  onClick={(e) => {
                    e.stopPropagation()
                    onDismiss(r.runId)
                  }}
                >
                  <X size={11} />
                </button>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}
