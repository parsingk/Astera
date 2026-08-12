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

  // The Hangul row needs both lists: the filtered one to populate the dropdown, and the
  // unfiltered one (loadFamilies/`families`) to tell "not installed" apart from "installed but
  // filtered out because it doesn't cover Hangul" — see itemsFor below.
  const openHangul = (): void => {
    loadFamilies()
    loadHangulFamilies()
  }

  // Both lists start loading as soon as the General tab is on screen, rather than waiting for a
  // dropdown to be opened. Neither is instant — enumerating the installed families takes a moment,
  // and the Hangul scan reads a cmap table per family — and doing it here spends that time while
  // the user is still looking at the panel instead of after they have clicked and are waiting on it.
  // The open handlers still call these: the loaders are idempotent (fontProbe memoises the in-flight
  // promise), so a click that lands before this finishes joins the same work rather than starting more.
  useEffect(() => {
    loadFamilies()
    loadHangulFamilies()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount; the loaders' own guards handle repeats
  }, [])

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

  // `known` is what actually populates the dropdown (all installed families for Latin; only the
  // Hangul-capable ones for Hangul). `allFamilies` is the unfiltered installed list, used only to
  // decide the stored-but-absent row's meta — it must answer "is this installed at all", which for
  // the Hangul dropdown `known` cannot answer once it is filtered down to Hangul-capable families:
  // a stored family that is installed but does not cover Hangul must not read as "not installed".
  const itemsFor = (
    current: string | null,
    known: string[],
    allFamilies: string[] | null
  ): SelectOption[] => {
    // A font that was uninstalled since it was chosen still has to appear, or the dropdown would show
    // the placeholder and the user could not tell what is stored. The chain already falls back, so the
    // terminal itself is fine.
    const alreadyShown = current !== null && known.includes(current)
    const extra: SelectOption[] =
      current && !alreadyShown
        ? [
            allFamilies === null
              ? // The unfiltered list hasn't loaded yet — we don't actually know whether this is
                // installed, so no meta is shown rather than a guess that could read as "not
                // installed" when it may well be.
                { value: current, label: current }
              : allFamilies.includes(current)
                ? // Installed, just filtered out of `known` (e.g. a non-Hangul family stored as
                  // the Hangul font) — a real font, so it can render its own sample.
                  { value: current, label: current, meta: t('settings.font.sample'), font: `"${current}"` }
                : { value: current, label: current, meta: t('settings.font.notInstalled') }
          ]
        : []
    return [
      { value: SYSTEM, label: t('settings.font.system') },
      ...extra,
      ...known.map((name) => ({
        value: name,
        label: name,
        meta: t('settings.font.sample'),
        font: `"${name}"`
      }))
    ]
  }

  // itemsFor(current, [], families) plus one extra row instead of the usual family list, while
  // listHangulFamilies() (a cmap read per installed font, a few seconds on a large machine) is
  // still running. The row's value mirrors the current selection so picking it (unlikely, since it
  // looks and reads as a status line, not a choice) is a no-op save rather than a real change.
  const hangulItems = (): SelectOption[] => {
    const current = font.hangul
    if (hangulFamilies === null) {
      return [
        ...itemsFor(current, [], families),
        { value: current ?? SYSTEM, label: t('settings.font.checkingHangul') }
      ]
    }
    return itemsFor(current, hangulFamilies, families)
  }

  // The same status row for the Latin dropdown. It only waits on the family enumeration, which is far
  // quicker than the Hangul scan — but "quicker" is not "instant", and without a row saying so the
  // dropdown reads as an empty list that failed to load rather than one that is still filling.
  const latinItems = (): SelectOption[] => {
    const current = font.latin
    if (families === null) {
      return [
        ...itemsFor(current, [], families),
        { value: current ?? SYSTEM, label: t('settings.font.loadingList') }
      ]
    }
    return itemsFor(current, families, families)
  }

  // familyCoversHangul() reads the font file's cmap table, so it is async — held in state and
  // recomputed whenever the Latin choice changes. shadowed is reset to false at the top of the
  // effect, before the probe starts, so a hint left over from the previous font never lingers
  // while the new answer is in flight. The "did the input change while this was in flight" guard
  // then stops a slow answer for a since-replaced font from overwriting a newer one.
  const [shadowed, setShadowed] = useState(false)
  useEffect(() => {
    setShadowed(false)
    const latin = font.latin
    if (latin === null) return
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
            items={latinItems()}
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
          onMouseDown={openHangul}
          onFocus={openHangul}
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
