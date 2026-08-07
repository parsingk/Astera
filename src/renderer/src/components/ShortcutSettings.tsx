import { useEffect, useState } from 'react'
import {
  ACTIONS,
  chordFromEvent,
  findConflicts,
  formatChord,
  resolveBindings,
  riskyReasonKey,
  type ActionId
} from '../../../core/keys/binding'
import { useI18n } from '../i18n/I18nProvider'
import { confirmModal } from '../lib/confirm'
import { toast } from '../lib/toast'
import type { MessageKey } from '../../../core/i18n'

/**
 * Shortcut settings. Only the actions handled by the global capture handler can be edited —
 * FileExplorer's DOM onKeyDown (F2, Delete, Ctrl+A/X/C/V) and the CodeMirror keymap (Ctrl+S) go through a
 * different handling mechanism, so they are outside this list and the caller shows them separately as a
 * 'fixed' list.
 *
 * Two things are checked before saving: a clash with another action is rejected, and for a key the
 * terminal CLI uses, the user is told what it would block and it is saved anyway if they still want it
 * (not blocking it was a deliberate decision).
 */
export function ShortcutSettings({
  overrides,
  onChanged
}: {
  overrides: Record<string, string[]>
  onChanged: (next: Record<string, string[]>) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [capturing, setCapturing] = useState<ActionId | null>(null)
  const bindings = resolveBindings(overrides)
  const conflicts = findConflicts(bindings)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      const chord = chordFromEvent(e)
      if (!chord) return // only modifiers are down — wait for an actual key
      const key = formatChord(chord)
      const taken = ACTIONS.find(
        (a) => a.id !== capturing && bindings[a.id].some((c) => formatChord(c) === key)
      )
      setCapturing(null)
      if (taken) {
        toast.error(t('shortcut.conflictWith', { key, action: t(taken.descKey as MessageKey) }))
        return
      }
      const riskKey = riskyReasonKey(chord)
      void (async () => {
        if (riskKey) {
          const ok = await confirmModal({
            title: t('shortcut.riskTitle', { key }),
            body: t(riskKey as MessageKey),
            confirmLabel: t('shortcut.riskConfirm')
          })
          if (!ok) return
        }
        await window.api.keys.set(capturing, [key])
        onChanged(await window.api.keys.get())
      })()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing, bindings, t, onChanged])

  const reset = async (id: ActionId): Promise<void> => {
    await window.api.keys.reset(id)
    onChanged(await window.api.keys.get())
  }

  return (
    <div className="shortcut-group">
      <div className="shortcut-group-title">{t('shortcut.group.editable')}</div>
      {ACTIONS.map((action) => {
        const keys = bindings[action.id].map(formatChord)
        const conflicted = conflicts.some((c) => c.actions.includes(action.id))
        return (
          <div className="shortcut-row" key={action.id}>
            <span className="shortcut-keys">
              {capturing === action.id ? (
                <kbd className="shortcut-capturing">{t('shortcut.capturing')}</kbd>
              ) : keys.length === 0 ? (
                <kbd className="shortcut-unbound">{t('shortcut.unbound')}</kbd>
              ) : (
                keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 && <span className="shortcut-or">{t('common.or')}</span>}
                    <kbd className={conflicted ? 'shortcut-conflict' : undefined}>{k}</kbd>
                  </span>
                ))
              )}
            </span>
            <span className="shortcut-desc">{t(action.descKey as MessageKey)}</span>
            {/* In a narrow modal a text button pushes the description to 3~4 lines (measured) — reduced to an icon plus a title */}
            <span className="shortcut-actions">
              <button
                onClick={() => setCapturing(action.id)}
                disabled={capturing !== null}
                title={t('shortcut.edit')}
                aria-label={t('shortcut.edit')}
              >
                ✎
              </button>
              <button
                onClick={() => void reset(action.id)}
                disabled={capturing !== null || overrides[action.id] === undefined}
                title={t('shortcut.resetOne')}
                aria-label={t('shortcut.resetOne')}
              >
                ↺
              </button>
            </span>
          </div>
        )
      })}
    </div>
  )
}
