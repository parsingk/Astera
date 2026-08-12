import { useEffect, useState } from 'react'
import { Select, type SelectOption } from './Select'
import { useI18n } from '../i18n/I18nProvider'
import { useTerminalFont } from '../lib/terminalFont'
import { familyCoversHangul, listHangulFamilies, listLocalFontFamilies } from '../lib/fontProbe'
import { toast } from '../lib/toast'
import type { TerminalFont } from '../../../core/terminal/font'

/** The value the "System default" row carries. Empty string, because Select keys rows by string and
 *  null is not one — it is mapped back to null on the way out. */
const SYSTEM = ''

export function TerminalFontSettings(): React.JSX.Element {
  const { t } = useI18n()
  const { font, setFont } = useTerminalFont()
  const [families, setFamilies] = useState<string[] | null>(null)
  // null: not loaded yet: the Hangul dropdown shows a "checking installed fonts…" row instead of
  // pretending the list is empty while listHangulFamilies() (a few seconds — it reads every
  // installed font file's cmap table) is still running.
  const [hangulFamilies, setHangulFamilies] = useState<string[] | null>(null)

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

  const loadHangulFamilies = (): void => {
    if (hangulFamilies) return
    void listHangulFamilies()
      .then(setHangulFamilies)
      .catch((err) => {
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

  const itemsFor = (current: string | null, known: string[]): SelectOption[] => {
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

  // itemsFor(current, []) plus one extra row instead of the usual family list, while
  // listHangulFamilies() (a cmap read per installed font, a few seconds on a large machine) is
  // still running. The row's value mirrors the current selection so picking it (unlikely, since it
  // looks and reads as a status line, not a choice) is a no-op save rather than a real change.
  const hangulItems = (): SelectOption[] => {
    const current = font.hangul
    if (hangulFamilies === null) {
      return [
        ...itemsFor(current, []),
        { value: current ?? SYSTEM, label: t('settings.font.checkingHangul') }
      ]
    }
    return itemsFor(current, hangulFamilies)
  }

  // familyCoversHangul() reads the font file's cmap table, so it is async — held in state and
  // recomputed whenever the Latin choice changes. The "did the input change while this was in
  // flight" guard stops a slow answer for a since-replaced font from overwriting a newer one.
  const [shadowed, setShadowed] = useState(false)
  useEffect(() => {
    const latin = font.latin
    if (latin === null) {
      setShadowed(false)
      return
    }
    let cancelled = false
    void familyCoversHangul(latin).then((covers) => {
      if (!cancelled) setShadowed(covers)
    })
    return () => {
      cancelled = true
    }
  }, [font.latin])

  return (
    <>
      <div className="settings-row">
        <span>{t('settings.font.latin')}</span>
        {/* onMouseDown covers the mouse path; onFocus (bubbles) covers keyboard users tabbing onto
            the trigger, since Select can be opened with Enter/Space/ArrowDown with no mousedown at
            all. Both are needed — neither is redundant with the other. */}
        <div className="settings-font-select" onMouseDown={loadFamilies} onFocus={loadFamilies}>
          <Select
            items={itemsFor(font.latin, families ?? [])}
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
        <div
          className="settings-font-select"
          onMouseDown={loadHangulFamilies}
          onFocus={loadHangulFamilies}
        >
          <Select
            items={hangulItems()}
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
