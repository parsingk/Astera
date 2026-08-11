import { useEffect, useState } from 'react'
import type { RunConfig, RunStatus } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'
import { RunConfigDialog } from './RunConfigDialog'

/** Run toolbar in the workbench's top right. Rendered only in explorer mode. */
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
          ...configs.map((c) => ({ value: c.id, label: c.name })),
          // An action disguised as an option, as it was before — picking it opens the editor instead of
          // selecting anything, which is why onChange branches on the sentinel rather than passing it on
          { value: '__add__', label: t('run.config.addOption') }
        ]}
        value={selectedId ?? ''}
        onChange={(v) => (v === '__add__' ? setEditing({ config: null }) : onSelect(v))}
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
      {editable && !running && (
        <>
          <button
            className="run-btn"
            title={t('run.config.editTitle')}
            onClick={() => setEditing({ config: selected })}
          >
            ✎
          </button>
          <button className="run-btn" title={t('run.config.deleteTitle')} onClick={() => selected && onDeleteConfig(selected.id)}>
            ✕
          </button>
        </>
      )}
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
