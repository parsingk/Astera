import type { RunStatus } from '../../../core/types'
import { labelRuns } from '../../../core/run/instances'
import { formatRunDuration } from '../../../core/run/duration'
import { useI18n } from '../i18n/I18nProvider'
import { X } from 'lucide-react'

/** The tab strip above the console: one tab per run of the current project, in seat order — state dot,
 *  label (repeats of a configuration are numbered by labelRuns), exit code once finished, the Validation
 *  tag, and ✕ on a finished run (a live run is stopped from the rail, not closed). At the right end, the
 *  selected run's command and its duration; `now` is BottomPanel's one-second clock. With no runs the
 *  strip carries the "press ▶" line. */
export function RunTabStrip({
  runs,
  selectedId,
  now,
  onSelect,
  onDismiss
}: {
  runs: RunStatus[]
  selectedId: string | null
  now: number
  onSelect: (runId: string) => void
  onDismiss: (runId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  if (runs.length === 0) return <div className="run-tabstrip run-tabstrip-empty" role="note" aria-label={t('run.panel.tab')}>{t('run.panel.empty')}</div>
  const labels = new Map(labelRuns(runs).map((l) => [l.runId, l.label]))
  const selected = runs.find((r) => r.runId === selectedId) ?? null
  // A tab holds a button, so it is a span with role=tab (no button inside a button) — the same reason
  // the bottom tabs are spans. Enter/Space select; a key from the nested ✕ is left to that button.
  const tabKeyDown =
    (runId: string) =>
    (e: React.KeyboardEvent): void => {
      if (e.target !== e.currentTarget) return
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      onSelect(runId)
    }
  return (
    <div className="run-tabstrip">
      <div className="run-tabs" role="tablist" aria-label={t('run.panel.tab')}>
        {runs.map((r) => (
          <span
            key={r.runId}
            role="tab"
            aria-selected={r.runId === selectedId}
            tabIndex={0}
            className={`run-tab${r.runId === selectedId ? ' on' : ''}`}
            onClick={() => onSelect(r.runId)}
            onKeyDown={tabKeyDown(r.runId)}
          >
            <span className={`run-tab-dot ${r.status}`} title={r.status === 'stopping' ? t('run.panel.stopping') : undefined} />
            <span className="run-tab-label">{labels.get(r.runId)}</span>
            {r.validation === true && (
              <span className="run-tag" title={t('run.validation.tag')}>
                {t('run.validation.tag')}
              </span>
            )}
            {r.status === 'exited' && (
              <span className={`run-tab-exit${r.exitCode === 0 ? '' : ' fail'}`}>
                {t('run.panel.exitCode', { code: r.exitCode ?? '?' })}
              </span>
            )}
            {r.status === 'exited' && (
              <button
                type="button"
                className="run-tab-close"
                title={t('run.panel.close')}
                aria-label={t('run.panel.close')}
                onClick={(e) => {
                  e.stopPropagation() // keeps close from also selecting the tab
                  onDismiss(r.runId)
                }}
              >
                <X size={10} />
              </button>
            )}
          </span>
        ))}
      </div>
      {selected && (
        <span className="run-tabstrip-meta">
          <span className="run-tabstrip-cmd" title={selected.command}>{selected.command}</span>
          <span className="run-tabstrip-time">{formatRunDuration(selected, now)}</span>
        </span>
      )}
    </div>
  )
}
