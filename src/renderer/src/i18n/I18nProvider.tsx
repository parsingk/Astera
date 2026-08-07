import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { t as translate } from '../../../core/i18n'
import type { Lang, Message, MessageKey, MessageParams } from '../../../core/i18n'

interface I18nValue {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: MessageKey, params?: MessageParams) => string
  /** Translates a Message that came from the backend. null passes straight through — this keeps the caller's `if (err)` pattern working */
  tm: (msg: Message | null) => string | null
}

const Ctx = createContext<I18nValue | null>(null)

export function I18nProvider({ children }: { children: ReactNode }): ReactNode {
  // null = the language has not come back from main yet. Nothing is rendered until it is settled, to avoid
  // the flicker of drawing one frame in Korean and then switching to English
  const [lang, setLangState] = useState<Lang | null>(null)

  useEffect(() => {
    // If this rejects, lang stays null forever and :40 keeps returning null, leaving the window quietly
    // blank — so it falls back to 'ko' (the catalog's source language, so it is always present)
    void window.api.settings.getLang().then(setLangState).catch(() => setLangState('ko'))
  }, [])

  const setLang = useCallback((next: Lang) => {
    setLangState(next) // applied optimistically — the screen has already changed even if the save fails
    void window.api.settings.setLang(next)
  }, [])

  const value: I18nValue | null =
    lang === null
      ? null
      : {
          lang,
          setLang,
          t: (key, params) => translate(lang, key, params),
          tm: (msg) => (msg === null ? null : translate(lang, msg.key, msg.params))
        }

  if (value === null) return null
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useI18n(): I18nValue {
  const v = useContext(Ctx)
  if (v === null) throw new Error('useI18n must be used inside I18nProvider')
  return v
}
