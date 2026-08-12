import { ko } from './messages/ko'
import { en } from './messages/en'
import { ja } from './messages/ja'
import { es } from './messages/es'
import { isPseudoLocalization, pseudoize } from './pseudo'

export type MessageKey = keyof typeof ko
export type MessageParams = Record<string, string | number>

/** A catalog is read as partial everywhere except where ko and en are declared. Two of the four are
 *  complete and two are not, so the lookup has to cope with a miss — typing it as partial here is what
 *  forces the fallback chain to be handled rather than assumed away. */
export type Catalog = Partial<Record<MessageKey, string>>

/** The one place a language is declared. Lang, isLang, the lookup below, the OS-locale match in
 *  locale.ts and the settings picker all derive from this table, so adding a language is a catalog file
 *  plus one line here.
 *  nativeName is written in its own language and is not a translation target — someone hunting for
 *  their language should not have to know the current one. */
export const CATALOGS = {
  ko: { messages: ko as Catalog, nativeName: '한국어' },
  en: { messages: en as Catalog, nativeName: 'English' },
  ja: { messages: ja, nativeName: '日本語' },
  es: { messages: es, nativeName: 'Español' }
} as const

export type Lang = keyof typeof CATALOGS

export const LANGS = Object.keys(CATALOGS) as Lang[]

/** The trust-boundary check for anything arriving from disk or the renderer. */
export const isLang = (v: unknown): v is Lang => typeof v === 'string' && v in CATALOGS

/** What the app stores versus what it renders with. `stored: null` is System — the user has never
 *  chosen, or has chosen to follow the OS. */
export interface LangPreference {
  stored: Lang | null
  resolved: Lang
}

/** The untranslated message a backend (a pure core module) returns instead of a finished sentence.
 *  A module called from both the renderer and main does not know the current language, so it produces only
 *  the key. */
export interface Message {
  key: MessageKey
  params?: MessageParams
}

export function t(lang: Lang, key: MessageKey, params?: MessageParams): string {
  // requested → en → ko. Korean is last because it is the source catalog and therefore cannot be
  // missing a key; English sits in front of it so a gap in ja or es shows English rather than Korean.
  const template: string = CATALOGS[lang].messages[key] ?? en[key] ?? ko[key]
  // A placeholder with no value is left as it is rather than erased (m is returned)
  const out = !params
    ? template
    : template.replace(/\{(\w+)\}/g, (m, name: string) =>
        name in params ? String(params[name]) : m
      )
  return isPseudoLocalization() ? pseudoize(out) : out
}
