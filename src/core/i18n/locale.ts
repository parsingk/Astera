import type { Lang } from './index'

/** OS locale string → the initial language. It takes the string rather than calling app.getLocale() itself,
 *  so it is testable without mocking Electron. Starting with ko means Korean, anything else English. */
export function pickInitialLang(osLocale: string): Lang {
  return osLocale.toLowerCase().startsWith('ko') ? 'ko' : 'en'
}
