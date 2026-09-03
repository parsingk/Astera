import { useState } from 'react'
import type { RunConfig, RunStatus } from '../../../core/types'
import { decideStart, toolbarState } from '../../../core/run/instances'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'
import { EllipsisVertical, Play, Square } from 'lucide-react'

/** Run toolbar. It sits in the title bar, next to the app name, and is drawn whenever a project is
 *  known — the explorer toggle does not reach it. Its own chrome (border, background, padding) is
 *  cleared by .tb-run, which owns the spacing there.
 *
 *  ▶ and ⏹ sit side by side rather than replacing each other. ▶ is enabled whenever a configuration is
 *  selected; what it does — restart the live run, or start another when the configuration allows
 *  several — is decided in main (decideStart). ⏹ appears when the selection has a running run
 *  (toolbarState names the most recent one). */
export function RunToolbar({
  configs,
  selectedId,
  onSelect,
  runs,
  onRun,
  onStop,
  onOpenManager,
  activeRuns,
  onJump,
  onStopRun
}: {
  configs: RunConfig[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** The current project's runs, finished ones included */
  runs: RunStatus[]
  onRun: () => void
  onStop: (runId: string) => void
  /** Opens the two-pane RunConfigManager — the ⋮ menu's only item. */
  onOpenManager: () => void
  /** Every live run across projects — the badge and its dropdown */
  activeRuns: RunStatus[]
  onJump: (projectPath: string) => void
  onStopRun: (runId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [showRuns, setShowRuns] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const state = toolbarState(runs, selectedId)
  const stopTargetRun = state.stopTarget ? runs.find((r) => r.runId === state.stopTarget) : undefined
  const selectedConfig = configs.find((c) => c.id === selectedId)
  // The title is the one thing that says ▶ is about to kill the user's server, so it comes from the same
  // rule main applies (decideStart) — not from toolbarState, which differs from it on validation and
  // stopping runs by design (toolbarState decides ⏹, whose target must be a running run).
  const restarts = !!selectedConfig && decideStart(runs, selectedConfig).action === 'restart'

  return (
    <div className="run-toolbar">
      <Select
        className="run-config-select"
        items={[
          ...(configs.length === 0 ? [{ value: '', label: t('run.config.none') }] : []),
          ...configs.map((c) => ({ value: c.id, label: c.name }))
        ]}
        value={selectedId ?? ''}
        onChange={onSelect}
        ariaLabel={t('run.config.selectLabel')}
      />
      {/* A validation run is not the user's. The stop button stays (a runaway validation must be
          stoppable); the label is what says why ⏹ is here for a run they did not start. */}
      {stopTargetRun?.validation === true && (
        <span className="run-tag" title={t('run.validation.tag')}>
          {t('run.validation.tag')}
        </span>
      )}
      <button
        className="run-btn play"
        title={t(restarts ? 'run.action.restart' : 'run.action.run')}
        disabled={!state.canRun}
        onClick={onRun}
      >
        <Play size={14} fill="currentColor" strokeWidth={0} />
      </button>
      {state.stopTarget && (
        <button className="run-btn stop" title={t('run.action.stop')} onClick={() => onStop(state.stopTarget!)}>
          <Square size={14} fill="currentColor" strokeWidth={0} />
        </button>
      )}
      {/* Configuration management folds into ⋮. This toolbar now sits permanently in the title bar, so
          laying out a rarely used management screen too would keep eating window width. */}
      <div className="run-more">
        <button
          className="run-btn"
          title={t('run.config.more')}
          aria-haspopup="menu"
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
        >
          <EllipsisVertical size={14} />
        </button>
        {showMore && (
          <div className="run-more-menu" role="menu" onMouseLeave={() => setShowMore(false)}>
            <button
              className="run-more-item"
              role="menuitem"
              onClick={() => {
                setShowMore(false)
                onOpenManager()
              }}
            >
              {t('run.manager.open')}
            </button>
          </div>
        )}
      </div>
      {activeRuns.length > 0 && (
        <div className="run-global">
          <button className="run-global-badge" title={t('run.global.listTitle')} onClick={() => setShowRuns((v) => !v)}>
            <span className="tri"><Play size={10} fill="currentColor" strokeWidth={0} /></span>
            <span className="n">{activeRuns.length}</span>
          </button>
          {showRuns && (
            <div className="run-global-menu" onMouseLeave={() => setShowRuns(false)}>
              {/* Keyed by runId — a project now holds several runs, so its path is no longer unique here */}
              {activeRuns.map((r) => (
                <div className="run-global-row" key={r.runId}>
                  <span className={`run-global-live${r.status === 'stopping' ? ' stopping' : ''}`} />
                  {r.validation === true && (
                    <span className="run-tag" title={t('run.validation.tag')}>
                      {t('run.validation.tag')}
                    </span>
                  )}
                  <button className="run-global-jump" title={t('run.global.jump')} onClick={() => { onJump(r.projectPath); setShowRuns(false) }}>
                    {r.projectName} — {r.configName}
                  </button>
                  {r.status === 'running' && (
                    <button className="run-global-stop" title={t('run.action.stop')} onClick={() => onStopRun(r.runId)}>
                      <Square size={11} fill="currentColor" strokeWidth={0} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
