import { useState } from 'react'
import type { RunConfig } from '../../../core/types'
import type { RunContext } from '../../../core/run/build'
import { buildCommand } from '../../../core/run/build'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'

/** Run configuration management — a tree on the left, the selected configuration's form on the
 *  right. The same layout as IntelliJ's Run/Debug Configurations. It used to be a small modal reached
 *  from the titlebar's ⋮ menu, with add/edit/delete as three separate items that only ever applied to
 *  the currently selected configuration. With the tree visible, those become one toolbar in the same
 *  place.
 *
 *  This task (6) only wires up shell configurations — the per-kind fields (npm/node/gradle/…) are
 *  Task 7, so the ＋ button that would create a new configuration has no handler yet. Auto-detected
 *  (seed) configurations show up in the tree too, in italics, but are read-only here: turning one into
 *  an editable copy on first edit (promotion) is Task 8. */
export function RunConfigManager({
  configs,
  context,
  projectPath,
  onSave,
  onDelete,
  onClose
}: {
  configs: RunConfig[]
  context: RunContext
  /** Reserved for the working-folder "Choose…" picker Task 7's form adds — unused until then */
  projectPath: string
  onSave: (config: RunConfig) => void
  onDelete: (id: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState<string | null>(configs[0]?.id ?? null)
  const selected = configs.find((c) => c.id === selectedId) ?? null
  const isSeed = !!selected && selected.id.startsWith('seed:')

  // The draft being edited. Reseeded from the configuration whenever the selection changes — updated
  // explicitly instead of remounting the form via key (selection changes often, and a remount would
  // also lose scroll position).
  const [draft, setDraft] = useState<RunConfig | null>(selected)
  const [draftFor, setDraftFor] = useState<string | null>(selectedId)
  if (draftFor !== selectedId) {
    setDraftFor(selectedId)
    setDraft(selected)
  }
  /** Saves the draft. Does nothing if nothing changed — a write must not go out on every blur */
  const commit = (): void => {
    if (!draft || !selected || JSON.stringify(draft) === JSON.stringify(selected)) return
    onSave(draft)
  }

  // Grouped by kind for the tree. Order follows the list's own order — user configurations come first
  const groups = new Map<string, RunConfig[]>()
  for (const c of configs) {
    const list = groups.get(c.type) ?? []
    list.push(c)
    groups.set(c.type, list)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rcm" onClick={(e) => e.stopPropagation()}>
        <h2>{t('run.manager.title')}</h2>
        <div className="rcm-panes">
          <div className="rcm-list">
            <div className="rcm-tools">
              <button title={t('run.manager.add')}>＋</button>
              <button
                title={t('run.manager.remove')}
                disabled={!selected || isSeed}
                onClick={() => selected && onDelete(selected.id)}
              >
                −
              </button>
              <button title={t('run.manager.duplicate')} disabled={!selected}>
                ⧉
              </button>
            </div>
            <div className="rcm-tree">
              {[...groups].map(([type, list]) => (
                <div key={type}>
                  <div className="rcm-group">{t(`run.type.${type}` as MessageKey)}</div>
                  {list.map((c) => (
                    <button
                      key={c.id}
                      className={`rcm-item${c.id === selectedId ? ' on' : ''}${c.id.startsWith('seed:') ? ' seed' : ''}`}
                      onClick={() => setSelectedId(c.id)}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className="rcm-form">
            {selected && draft && (
              <>
                {/* Auto-detected configurations are read-only here (Task 8 turns an edit into a
                    promotion). readOnly on its own would silently swallow keystrokes, so the state
                    also gets a visible hint and a dimmed input style (.rcm-form input:read-only). */}
                {isSeed && <div className="rcm-seed-hint">{t('run.manager.seedHint')}</div>}
                {/* The draft is held as local state and saved on blur. Calling onSave from onChange
                    would send an IPC round trip, and rewrite the stored file, on every keystroke. */}
                <div className="field">
                  <label>{t('run.form.nameLabel')}</label>
                  <input
                    type="text"
                    value={draft.name}
                    readOnly={isSeed}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    onBlur={commit}
                  />
                </div>
                {draft.type === 'shell' && (
                  <div className="field">
                    <label>{t('run.form.commandLabel')}</label>
                    <input
                      type="text"
                      value={draft.command}
                      readOnly={isSeed}
                      onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                      onBlur={commit}
                    />
                  </div>
                )}
                {/* The assembled command. If the app assembled it silently there would be no way to
                    know what actually runs, and the Run console is a real terminal that also takes
                    input, so the user has to know. Built from the saved configuration, not the draft
                    — this is what run.start would actually run right now. */}
                <div className="rcm-resolved">{buildCommand(selected, context)}</div>
              </>
            )}
          </div>
        </div>
        <div className="row right">
          <button type="button" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
