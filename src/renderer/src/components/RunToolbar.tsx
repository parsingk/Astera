import { useState } from 'react'
import type { RunConfig, RunStatus } from '../../../core/types'
import { actedConfigIds, decideStart, toolbarState } from '../../../core/run/instances'
import { useI18n } from '../i18n/I18nProvider'
import { RunConfigMenu } from './RunConfigMenu'
import { EllipsisVertical, Play, Square } from 'lucide-react'

/** Run toolbar. It sits in the title bar, next to the app name, and is drawn whenever a project is
 *  known — the explorer toggle does not reach it. Its own chrome (border, background, padding) is
 *  cleared by .tb-run, which owns the spacing there.
 *
 *  ▶ and ⏹ sit side by side rather than replacing each other. ▶ is enabled whenever a configuration is
 *  selected; what it does — restart a live run, start another when the configuration allows several,
 *  or press ▶ on every member of a compound — is decided in main, by the launch planner, not by
 *  decideStart alone (decideStart answers for one runnable configuration; a compound has no run of its
 *  own for it to answer about). ⏹ appears when the selection has a running run, and for a compound it
 *  stops every live member, not just the most recent one. The configuration menu groups by folder and
 *  then by kind, through the same function the manager's tree uses, so the two cannot disagree about
 *  where a configuration lives. */
export function RunToolbar({
  configs,
  selectedId,
  onSelect,
  runs,
  onRun,
  onRunConfig,
  onStop,
  onOpenManager,
  onEditConfig,
  activeRuns,
  onJump,
  onStopRun,
  menuOpen,
  onMenuOpenChange,
  shortcut
}: {
  configs: RunConfig[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** The current project's runs, finished ones included */
  runs: RunStatus[]
  onRun: () => void
  /** The configuration menu's row ▶. Selects that row's configuration as well as running it — the
   *  no-argument onRun above always reads the current selection, which the row must not depend on. */
  onRunConfig: (id: string) => void
  onStop: (runId: string) => void
  /** Opens the two-pane RunConfigManager — the ⋮ menu's item, and the configuration menu's footer. */
  onOpenManager: () => void
  /** The configuration menu's "Edit '<name>'…" row. Opens the manager pinned to that configuration. */
  onEditConfig: (id: string) => void
  /** Every live run across projects — the badge and its dropdown */
  activeRuns: RunStatus[]
  onJump: (projectPath: string) => void
  onStopRun: (runId: string) => void
  /** Controlled: Task 9's run.selectConfig shortcut opens the configuration menu from outside. */
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
  /** run.selectConfig's binding, already formatted — shown in the pill's title, since that shortcut
   *  opens the pill. Undefined when the user cleared every binding for it. */
  shortcut?: string
}): React.JSX.Element {
  const { t } = useI18n()
  const [showRuns, setShowRuns] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const state = toolbarState(runs, selectedId, configs)
  // The Validation tag explains why ⏹ is offered for a run the user did not start. ⏹ now stops every
  // live member of a compound, so the question is whether *any* target is a validation run — a
  // validation run can be any member, not the first one live.
  const stopTargetRun = state.stopTargets
    .map((id) => runs.find((r) => r.runId === id))
    .find((r) => r?.validation === true)
  // The title is the one thing that says ▶ is about to kill the user's server, so it comes from the same
  // rule main applies (decideStart) — not from toolbarState, which differs from it on validation and
  // stopping runs by design (toolbarState decides ⏹, whose target must be a running run). A compound
  // never owns a run of its own, so decideStart on the selection itself always answers 'start' — the
  // selection is expanded through actedConfigIds to what ▶ actually presses, the same expansion ⏹
  // already uses, and the title says restart if any of those would be.
  const restarts = (selectedId ? actedConfigIds(configs, selectedId) : [])
    .map((id) => configs.find((c) => c.id === id))
    .some((c) => !!c && decideStart(runs, c).action === 'restart')

  return (
    <div className="run-toolbar">
      <RunConfigMenu
        configs={configs}
        runs={runs}
        selectedId={selectedId}
        open={menuOpen}
        onOpenChange={onMenuOpenChange}
        onSelect={onSelect}
        onRun={onRunConfig}
        onEdit={onEditConfig}
        onManage={onOpenManager}
        shortcut={shortcut}
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
      {state.stopTargets.length > 0 && (
        <button
          className="run-btn stop"
          title={t('run.action.stop')}
          onClick={() => state.stopTargets.forEach((id) => onStop(id))}
        >
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
