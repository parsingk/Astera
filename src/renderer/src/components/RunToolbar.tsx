import { useState } from 'react'
import type { RunConfig, RunStatus } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'

/** Run toolbar. It sits in the title bar, next to the app name, and is drawn whenever a project is
 *  known — the explorer toggle does not reach it. Its own chrome (border, background, padding) is
 *  cleared by .tb-run, which owns the spacing there. */
export function RunToolbar({
  configs,
  selectedId,
  onSelect,
  active,
  onRun,
  onStop,
  onOpenManager,
  activeRuns,
  onJump,
  onStopProject
}: {
  configs: RunConfig[]
  selectedId: string | null
  onSelect: (id: string) => void
  active: RunStatus | null
  onRun: () => void
  onStop: () => void
  /** Opens the two-pane RunConfigManager — the ⋮ menu's only item. Add/edit/delete used to be three
   *  separate items here, opening a single-config modal (RunConfigDialog); the manager replaced all of
   *  that (Task 8), including suppressing global shortcuts while it is open — App computes that
   *  directly from whether the manager is on screen, so this toolbar no longer reports its own modal
   *  state up. */
  onOpenManager: () => void
  activeRuns: RunStatus[]
  onJump: (projectPath: string) => void
  onStopProject: (projectPath: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [showRuns, setShowRuns] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const running = active?.status === 'running'

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
      {running ? (
        <button className="run-btn stop" title={t('run.action.stop')} onClick={onStop}>
          ⏹
        </button>
      ) : (
        <button className="run-btn play" title={t('run.action.run')} disabled={!selectedId} onClick={onRun}>
          ▶
        </button>
      )}
      {/* 구성 관리는 ⋮ 안으로 접는다. 이 툴바는 이제 타이틀바에 상시로 놓이므로, 자주 쓰지 않는
          관리 화면까지 늘어놓으면 창 폭을 계속 먹는다. */}
      <div className="run-more">
        <button
          className="run-btn"
          title={t('run.config.more')}
          aria-haspopup="menu"
          aria-expanded={showMore}
          onClick={() => setShowMore((v) => !v)}
        >
          ⋮
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
            <span className="tri">▶</span>
            <span className="n">{activeRuns.length}</span>
          </button>
          {showRuns && (
            <div className="run-global-menu" onMouseLeave={() => setShowRuns(false)}>
              {activeRuns.map((r) => (
                <div className="run-global-row" key={r.projectPath}>
                  <span className="run-global-live" />
                  <button className="run-global-jump" title={t('run.global.jump')} onClick={() => { onJump(r.projectPath); setShowRuns(false) }}>
                    {r.projectName} — {r.configName}
                  </button>
                  <button className="run-global-stop" title={t('run.action.stop')} onClick={() => onStopProject(r.projectPath)}>
                    ⏹
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
