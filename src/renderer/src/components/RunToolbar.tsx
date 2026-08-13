import { useEffect, useState } from 'react'
import type { RunConfig, RunStatus } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'
import { RunConfigDialog } from './RunConfigDialog'

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
  onAddConfig,
  onEditConfig,
  onDeleteConfig,
  activeRuns,
  onJump,
  onStopProject,
  onModalOpenChange,
  projectPath,
  isSpringBoot
}: {
  configs: RunConfig[]
  selectedId: string | null
  onSelect: (id: string) => void
  active: RunStatus | null
  onRun: () => void
  onStop: () => void
  onAddConfig: (name: string, command: string, env?: Record<string, string>, cwd?: string) => void
  onEditConfig: (
    id: string,
    name: string,
    command: string,
    env?: Record<string, string>,
    cwd?: string
  ) => void
  onDeleteConfig: (id: string) => void
  activeRuns: RunStatus[]
  onJump: (projectPath: string) => void
  onStopProject: (projectPath: string) => void
  /** Whether the config modal is open — App uses this to suppress the global Ctrl shortcuts */
  onModalOpenChange: (open: boolean) => void
  /** Starting location for the run config modal's working folder "Choose…" dialog, and the base for relative path conversion */
  projectPath: string
  /** Whether the Spring profile field is shown — run.list decides this from the build file's contents */
  isSpringBoot: boolean
}): React.JSX.Element {
  const { t } = useI18n()
  // null = closed, { config: null } = add, { config: X } = edit. The field state is owned by the modal.
  const [editing, setEditing] = useState<{ config: RunConfig | null } | null>(null)
  const [showRuns, setShowRuns] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const running = active?.status === 'running'
  const selected = configs.find((c) => c.id === selectedId) ?? null
  // Only user-defined configs (ids starting with user:) can be edited or deleted — the auto-seeded ones are derived, so they are not targets
  const editable = !!selected && selected.id.startsWith('user:')

  // Mirrored into App's modalOpenRef. Without it, Ctrl+W behind the modal closes a file tab — that
  // handler is the only one with no focusEditable check, so it relies on modalOpenRef alone.
  useEffect(() => {
    onModalOpenChange(editing !== null)
  }, [editing, onModalOpenChange])
  // The suppression also has to be released when the modal disappears through an unmount (leaving
  // explorer mode, etc.) — otherwise the global shortcuts stay blocked forever
  useEffect(() => () => onModalOpenChange(false), [onModalOpenChange])

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
          추가·편집·삭제까지 늘어놓으면 창 폭을 계속 먹는다. 편집과 삭제는 대상이 있을 때만 나오고,
          추가는 언제나 있다 — 구성이 하나도 없을 때 만들 길이 그것뿐이기 때문이다 */}
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
                setEditing({ config: null })
              }}
            >
              {t('run.config.add')}
            </button>
            {editable && !running && (
              <>
                <button
                  className="run-more-item"
                  role="menuitem"
                  onClick={() => {
                    setShowMore(false)
                    setEditing({ config: selected })
                  }}
                >
                  {t('run.config.editTitle')}
                </button>
                <button
                  className="run-more-item"
                  role="menuitem"
                  onClick={() => {
                    setShowMore(false)
                    if (selected) onDeleteConfig(selected.id)
                  }}
                >
                  {t('run.config.deleteTitle')}
                </button>
              </>
            )}
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
      {editing && (
        <RunConfigDialog
          config={editing.config}
          projectPath={projectPath}
          isSpringBoot={isSpringBoot}
          onClose={() => setEditing(null)}
          onSubmit={(name, command, env, cwd) => {
            if (editing.config) onEditConfig(editing.config.id, name, command, env, cwd)
            else onAddConfig(name, command, env, cwd)
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
