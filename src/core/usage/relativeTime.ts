import { t } from '../i18n'
import type { Lang } from '../i18n'

/**
 * A duration as one coarse unit in the app language: '47분' / '47m', '3시간' / '3h', '4일' / '4d'.
 *
 * One unit only. The account overlay's two time columns are 6.4ch wide, and for "when does this
 * window roll" or "how old is this figure" the leading unit is the whole answer — a remainder would
 * cost the column its width and buy nothing a decision turns on. (The status bar's formatResetHud
 * does show two units; it has a whole status bar to spend and is not touched here.)
 *
 * Minutes round up, so a window thirty seconds from rolling reads as one minute rather than zero —
 * the same choice formatResetHud makes. A negative input is a clock that has already passed the
 * instant, and reads as the same one minute rather than as a negative duration.
 *
 * The hour/day boundary is read from the raw milliseconds, not from the already-rounded-up minute
 * count: 59m59s ceils to 60 minutes, and cascading from that would read it as "1h" a second early.
 * Truncating whole hours straight from `ms` keeps that reading as '60m' until a full hour has
 * actually elapsed.
 */
export function coarseDuration(ms: number, lang: Lang): string {
  const hours = Math.floor(Math.max(0, ms) / 3_600_000)
  if (hours < 1) return t(lang, 'duration.minutes', { n: Math.max(1, Math.ceil(ms / 60_000)) })
  if (hours < 24) return t(lang, 'duration.hours', { n: hours })
  return t(lang, 'duration.days', { n: Math.floor(hours / 24) })
}
