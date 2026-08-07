import { ko } from './messages/ko'
import { en } from './messages/en'

export type Lang = 'ko' | 'en'
export type MessageKey = keyof typeof ko
export type MessageParams = Record<string, string | number>

/** The untranslated message a backend (a pure core module) returns instead of a finished sentence.
 *  A module called from both the renderer and main does not know the current language, so it produces only
 *  the key. */
export interface Message {
  key: MessageKey
  params?: MessageParams
}

export function t(lang: Lang, key: MessageKey, params?: MessageParams): string {
  // Falls back to ko when a key is missing from en — the types say it cannot happen, but it beats a blank screen
  const template: string = (lang === 'en' ? en[key] : ko[key]) ?? ko[key]
  if (!params) return template
  // A placeholder with no value is left as it is rather than erased (m is returned)
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in params ? String(params[name]) : m
  )
}
