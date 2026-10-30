// The two lines a findings report says beside its findings (lifecycle design §4, §8): the Observe note, while the usage
// findings have less than their 30 days of history, and the sources that could not be read. The CLI prints them in
// English and Settings › Security & Access › Findings in the person's language, from these same keys. Renderer-safe: no
// `node:` import.
import { t, type Lang, type Message, type MessageKey } from '../i18n'
import { OBSERVE_WINDOW_DAYS, type FindingSource, type FindingsReport } from './types'

/** Each source's plain name, which the unread line lists. */
export const SOURCE_KEYS: Record<FindingSource, MessageKey> = {
  profiles: 'findings.source.profiles',
  accounts: 'findings.source.accounts',
  orchestration: 'findings.source.orchestration',
  tokens: 'findings.source.tokens',
  policy: 'findings.source.policy',
  records: 'findings.source.records',
  extensions: 'findings.source.extensions',
  'account-mcp': 'findings.source.account-mcp',
  credentials: 'findings.source.credentials',
  'credential-uses': 'findings.source.credential-uses',
  runtimes: 'findings.source.runtimes',
  'extension-uses': 'findings.source.extension-uses',
  ignored: 'findings.source.ignored',
  settings: 'findings.source.settings',
  'cli-version': 'findings.source.cli-version'
}

/** The Observe note (§4), or null once the usage findings have had their days. Null too when the rules file could not
 *  be read: the report's `observe` then reads off without being known (FindingsReport.observe), and the unread line
 *  names the file instead, so "Observe is off" is never said on a file nobody read (Task 3's note). */
export function observeNote(r: Pick<FindingsReport, 'observe' | 'unread'>): Message | null {
  if (r.unread.includes('policy')) return null
  if (!r.observe.on) return { key: 'findings.observe.off' }
  return r.observe.days < OBSERVE_WINDOW_DAYS ? { key: 'findings.observe.days', params: { days: r.observe.days } } : null
}

/** A source's plain name in `lang`; one this reader does not know (a newer Host's) is shown as it was sent, never as
 *  nothing. */
const sourceName = (lang: Lang, s: FindingSource): string => (Object.hasOwn(SOURCE_KEYS, s) ? t(lang, SOURCE_KEYS[s]) : s)

/** The line naming each source that could not be read (§8), in `lang` and listed as it lists, or null when every one
 *  was. */
export function unreadLine(lang: Lang, unread: readonly FindingSource[]): string | null {
  if (unread.length === 0) return null
  return t(lang, 'findings.unread', { sources: unread.map((s) => sourceName(lang, s)).join(t(lang, 'findings.listSeparator')) })
}
