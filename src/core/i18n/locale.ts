import { LANGS, type Lang } from './index'

/** OS locale string → the language to start in. It takes the string rather than calling app.getLocale()
 *  itself, so it is testable without mocking Electron.
 *  Matching is on the language subtag only: 'ja-JP' is Japanese, 'esk' is not Spanish. Anything not in
 *  LANGS falls back to English — this is the only place the app decides what an unsupported locale sees. */
export function pickInitialLang(osLocale: string): Lang {
  const lower = osLocale.toLowerCase()
  return LANGS.find((l) => lower === l || lower.startsWith(`${l}-`)) ?? 'en'
}
