import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { t as translate } from '../../../core/i18n'
import type { Lang, LangPreference, Message, MessageKey, MessageParams } from '../../../core/i18n'
import { toast } from '../lib/toast'

interface I18nValue {
  /** What to translate with. Never null once the provider renders. */
  lang: Lang
  /** What is stored — null is System. The settings picker needs this to show System as selected
   *  rather than the language System currently resolves to. */
  storedLang: Lang | null
  /** What the OS locale resolves to, regardless of what is stored — for the System row's label. */
  systemLang: Lang
  setLang: (lang: Lang | null) => void
  t: (key: MessageKey, params?: MessageParams) => string
  /** Translates a Message that came from the backend. null passes straight through — this keeps the caller's `if (err)` pattern working */
  tm: (msg: Message | null) => string | null
}

const Ctx = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  // null = the preference has not come back from main yet. Nothing is rendered until it is settled, to
  // avoid the flicker of drawing one frame in one language and then switching to another
  const [pref, setPref] = useState<LangPreference | null>(null)
  // Tracks the current preference outside of React state so a failed save can revert to it without
  // depending on setPref's updater having already run — an IPC round trip's timing is not guaranteed.
  const prefRef = useRef<LangPreference | null>(null)

  useEffect(() => {
    // If this rejects, pref stays null and the window would be quietly blank — so it falls back to
    // Korean, the source catalog, which is the one language that cannot have a missing key
    void window.api.settings
      .getLang()
      .then((p) => {
        prefRef.current = p
        setPref(p)
      })
      .catch(() => {
        const fallback: LangPreference = { stored: 'ko', resolved: 'ko', system: 'ko' }
        prefRef.current = fallback
        setPref(fallback)
      })
  }, [])

  const setLang = useCallback((next: Lang | null) => {
    // Applied optimistically — the screen has already changed even if the save fails. Picking System
    // (null) has to resolve to something to render with, and main is the only side that knows the OS
    // locale, so the resolved half is re-read rather than guessed.
    // The previous preference is read from prefRef (kept in sync at every setPref call site here) so a
    // failed save can revert to it without depending on setPref's updater having already run.
    const previous = prefRef.current
    const optimistic = previous ? { ...previous, stored: next, resolved: next ?? previous.resolved } : previous
    prefRef.current = optimistic
    setPref(optimistic)
    void window.api.settings
      .setLang(next)
      .then(() => window.api.settings.getLang())
      .then((p) => {
        prefRef.current = p
        setPref(p)
      })
      .catch((err) => {
        prefRef.current = previous
        setPref(previous)
        const fallbackLang = previous?.resolved ?? 'ko'
        toast.error(
          translate(fallbackLang, 'settings.general.language.saveFailed', {
            detail: err instanceof Error ? err.message : String(err)
          })
        )
      })
  }, [])

  const value: I18nValue | null =
    pref === null
      ? null
      : {
          lang: pref.resolved,
          storedLang: pref.stored,
          systemLang: pref.system,
          setLang,
          t: (key, params) => translate(pref.resolved, key, params),
          tm: (msg) => (msg === null ? null : translate(pref.resolved, msg.key, msg.params))
        }

  if (value === null) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18nValue {
  const v = useContext(Ctx)
  if (v === null) throw new Error('useI18n must be used inside I18nProvider')
  return v
}
