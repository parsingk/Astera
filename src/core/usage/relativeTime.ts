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
 * The rounding happens exactly once — to minutes — and the hour/day unit is chosen from that single
 * rounded value rather than re-derived from the raw milliseconds. A second, independent derivation
 * would let the function disagree with itself at the boundary; with one derivation it cannot. Rounding
 * up is deliberate for both readings this serves: a window a few seconds from rolling must not read as
 * zero, and a stale figure must not read as fresher than it is — so 59m59s, having already rounded up
 * to 60 minutes, reads as the hour it has effectively reached.
 */
export function coarseDuration(ms: number, lang: Lang): string {
  const mins = Math.max(1, Math.ceil(ms / 60_000))
  if (mins < 60) return t(lang, 'duration.minutes', { n: mins })
  const hours = Math.floor(mins / 60)
  if (hours < 24) return t(lang, 'duration.hours', { n: hours })
  return t(lang, 'duration.days', { n: Math.floor(hours / 24) })
}
