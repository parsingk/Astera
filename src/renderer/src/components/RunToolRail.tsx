import type { RunStatus } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { ChevronsDown, Eraser, RotateCw, Search, Square } from 'lucide-react'

/** The vertical tool rail on the console's left, acting on the selected run: rerun · stop, then
 *  scroll-to-end · clear, then find. Rerun starts the run's configuration again (main decides whether
 *  that restarts a live instance or adds one — the same call the toolbar's ▶ makes); stop is enabled
 *  only while the run is running. Everything is disabled with no run selected. */
export function RunToolRail({
  run,
  findOpen,
  onRerun,
  onStop,
  onScrollToEnd,
  onClear,
  onToggleFind
}: {
  run: RunStatus | null
  findOpen: boolean
  onRerun: (configId: string) => void
  onStop: (runId: string) => void
  onScrollToEnd: () => void
  onClear: () => void
  onToggleFind: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const none = run === null
  return (
    <div className="run-rail" role="toolbar" aria-orientation="vertical" aria-label={t('run.panel.tab')}>
      <button type="button" className="run-rail-btn rerun" title={t('run.action.rerun')} aria-label={t('run.action.rerun')} disabled={none} onClick={() => run && onRerun(run.configId)}>
        <RotateCw size={14} />
      </button>
      <button type="button" className="run-rail-btn stop" title={t('run.action.stop')} aria-label={t('run.action.stop')} disabled={run?.status !== 'running'} onClick={() => run && onStop(run.runId)}>
        <Square size={12} fill="currentColor" strokeWidth={0} />
      </button>
      <span className="run-rail-sep" />
      <button type="button" className="run-rail-btn" title={t('run.rail.scrollToEnd')} aria-label={t('run.rail.scrollToEnd')} disabled={none} onClick={onScrollToEnd}>
        <ChevronsDown size={14} />
      </button>
      <button type="button" className="run-rail-btn" title={t('run.panel.clear')} aria-label={t('run.panel.clear')} disabled={none} onClick={onClear}>
        <Eraser size={14} />
      </button>
      <span className="run-rail-sep" />
      <button type="button" className={`run-rail-btn${findOpen ? ' on' : ''}`} title={t('run.rail.find')} aria-label={t('run.rail.find')} aria-pressed={findOpen} disabled={none} onClick={onToggleFind}>
        <Search size={14} />
      </button>
    </div>
  )
}
