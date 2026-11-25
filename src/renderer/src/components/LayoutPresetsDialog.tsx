// The person's saved layout presets (spec W3): keep the window's layout under a name, put it back later, or forget it.
// What a preset holds and how it is applied is core/panes/presets.ts; saving and applying are App's, which owns the
// tree and the panels. This box only names, lists and asks.
import { useState } from 'react'
import { MAX_PRESET_NAME, type SavedPreset } from '../../../core/panes/presets'
import { useI18n } from '../i18n/I18nProvider'
import { backdropProps } from '../lib/backdrop'

export function LayoutPresetsDialog({
  presets,
  onSave,
  onApply,
  onDelete,
  onClose
}: {
  presets: readonly SavedPreset[]
  /** Keeps the current layout under `name` (a same name is replaced); 'full' when there is no room for one more. */
  onSave: (name: string) => 'saved' | 'full'
  onApply: (p: SavedPreset) => void
  onDelete: (name: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [full, setFull] = useState(false)
  const trimmed = name.trim()
  const save = (): void => {
    if (trimmed === '') return
    const result = onSave(trimmed)
    setFull(result === 'full')
    if (result === 'saved') setName('')
  }
  return (
    <div className="modal-backdrop" {...backdropProps(onClose)}>
      <div
        className="modal layout-presets"
        role="dialog"
        aria-label={t('layout.presets.title')}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <h2>{t('layout.presets.title')}</h2>
        <div className="field">
          <label htmlFor="layout-preset-name">{t('layout.presets.name')}</label>
          <div className="layout-presets-name-row">
            <input
              id="layout-preset-name"
              type="text"
              autoFocus
              value={name}
              maxLength={MAX_PRESET_NAME}
              onChange={(e) => {
                setName(e.target.value)
                setFull(false)
              }}
              onKeyDown={(e) => {
                // Enter that commits an IME composition (Korean, Japanese) is not a save
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) save()
              }}
            />
            <button className="primary" disabled={trimmed === ''} onClick={save}>
              {t('layout.presets.save')}
            </button>
          </div>
          <p className="modal-hint">{t('layout.presets.replaces')}</p>
          {full && <p className="warn">{t('layout.presets.full')}</p>}
        </div>
        {presets.length === 0 ? (
          <p className="modal-hint">{t('layout.presets.empty')}</p>
        ) : (
          <ul className="layout-preset-list">
            {presets.map((p) => (
              <li key={p.name}>
                <span className="layout-preset-name" title={p.name}>
                  {p.name}
                </span>
                <button onClick={() => onApply(p)}>{t('layout.presets.apply')}</button>
                <button onClick={() => onDelete(p.name)}>{t('layout.presets.delete')}</button>
              </li>
            ))}
          </ul>
        )}
        <div className="row right">
          <button onClick={onClose}>{t('common.close')}</button>
        </div>
      </div>
    </div>
  )
}
