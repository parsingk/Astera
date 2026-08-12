import { useMemo, useState } from 'react'
import { Select, type SelectOption } from './Select'
import { useI18n } from '../i18n/I18nProvider'
import { useTerminalFont } from '../lib/terminalFont'
import { hasHangulGlyph, listLocalFontFamilies } from '../lib/fontProbe'
import { toast } from '../lib/toast'
import type { TerminalFont } from '../../../core/terminal/font'

/** The value the "System default" row carries. Empty string, because Select keys rows by string and
 *  null is not one — it is mapped back to null on the way out. */
const SYSTEM = ''

export function TerminalFontSettings(): React.JSX.Element {
  const { t } = useI18n()
  const { font, setFont } = useTerminalFont()
  const [families, setFamilies] = useState<string[] | null>(null)

  // Loaded on the first dropdown open rather than on mount: enumerating fonts costs nothing on a
  // machine with 200 families and something on a machine with 2000, and nobody opens Settings to look
  // at a closed dropdown.
  const loadFamilies = (): void => {
    if (families) return
    void listLocalFontFamilies()
      .then(setFamilies)
      .catch((err) => {
        // Leave families null (not []) so a transient failure can be retried on the next open,
        // instead of caching an empty list for the rest of the session.
        toast.error(
          t('settings.font.listFailed', {
            detail: err instanceof Error ? err.message : String(err)
          })
        )
      })
  }

  const save = (next: TerminalFont): void => {
    const prev = font
    setFont(next) // optimistic — the terminals change immediately
    void window.api.settings.setTerminalFont(next).catch((err) => {
      setFont(prev)
      toast.error(
        t('settings.font.saveFailed', {
          detail: err instanceof Error ? err.message : String(err)
        })
      )
    })
  }

  const itemsFor = (current: string | null): SelectOption[] => {
    const known = families ?? []
    // A font that was uninstalled since it was chosen still has to appear, or the dropdown would show
    // the placeholder and the user could not tell what is stored. The chain already falls back, so the
    // terminal itself is fine.
    const missing = current && !known.includes(current) ? [current] : []
    return [
      { value: SYSTEM, label: t('settings.font.system') },
      ...missing.map((name) => ({
        value: name,
        label: name,
        meta: t('settings.font.notInstalled')
      })),
      ...known.map((name) => ({
        value: name,
        label: name,
        meta: t('settings.font.sample'),
        font: `"${name}"`
      }))
    ]
  }

  // Measures via a canvas, so it is memoized instead of recomputed on every re-render of this tab.
  const shadowed = useMemo(
    () => font.latin !== null && hasHangulGlyph(font.latin),
    [font.latin]
  )

  return (
    <>
      <div className="settings-row">
        <span>{t('settings.font.latin')}</span>
        {/* onMouseDown covers the mouse path; onFocus (bubbles) covers keyboard users tabbing onto
            the trigger, since Select can be opened with Enter/Space/ArrowDown with no mousedown at
            all. Both are needed — neither is redundant with the other. */}
        <div className="settings-font-select" onMouseDown={loadFamilies} onFocus={loadFamilies}>
          <Select
            items={itemsFor(font.latin)}
            value={font.latin ?? SYSTEM}
            onChange={(v) => save({ ...font, latin: v === SYSTEM ? null : v })}
            ariaLabel={t('settings.font.latin')}
          />
        </div>
      </div>
      <div className="settings-row">
        <span>{t('settings.font.hangul')}</span>
        {/* onMouseDown covers the mouse path; onFocus (bubbles) covers keyboard users tabbing onto
            the trigger, since Select can be opened with Enter/Space/ArrowDown with no mousedown at
            all. Both are needed — neither is redundant with the other. */}
        <div className="settings-font-select" onMouseDown={loadFamilies} onFocus={loadFamilies}>
          <Select
            items={itemsFor(font.hangul)}
            value={font.hangul ?? SYSTEM}
            onChange={(v) => save({ ...font, hangul: v === SYSTEM ? null : v })}
            ariaLabel={t('settings.font.hangul')}
          />
        </div>
      </div>
      {shadowed && <span className="settings-hint">{t('settings.font.hangulShadowed')}</span>}
    </>
  )
}
