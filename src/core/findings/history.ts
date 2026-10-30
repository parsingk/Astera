// Observe history and item age (lifecycle design §4, Review Focus 2 and 3). A usage finding judges only the whole days of
// Observe records that exist: from the later of when Observe was last turned on (plan ruling 3) and when this release
// first ran on the profile (ruling 2), at most the 30 days records are kept, less the local days that stopped at the
// size. "Never call something unused on missing data."
import { isObserving } from '../audit/policy'
import { auditDayOf } from '../audit/store'
import type { AuditPolicy } from '../audit/types'
import { OBSERVE_WINDOW_DAYS, type ObserveHistory } from './types'

// Declared with the shapes, which the renderer reads too (the Observe note, note.ts); kept importable from here
export { OBSERVE_WINDOW_DAYS } from './types'

export const DAY_MS = 24 * 60 * 60 * 1000

/** Whole days from `sinceIso` to `nowMs`, never below 0. NaN for a time that does not parse, which no threshold passes,
 *  so nothing is judged old on a time that cannot be read. */
export function ageDays(sinceIso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(sinceIso)) / DAY_MS))
}

const timeOf = (iso: string | undefined): number => (iso === undefined ? Number.NaN : Date.parse(iso))

/** How much Observe history the usage findings may judge (§4). Off (compatibility, or no policy file) is `on: false` with
 *  no days. On, the days are whole days from the start to now, capped at 30, less each stopped local day from the counted
 *  days' first local day to today: a day only partly inside is still taken out, since its records stopped short. */
export function observeHistory(a: {
  policy: Pick<AuditPolicy, 'mode' | 'observingSince'> | null
  findingsSince: string
  stoppedDays: readonly string[]
  nowMs: number
}): ObserveHistory {
  if (a.policy === null || !isObserving(a.policy.mode)) return { on: false, days: 0 }
  const starts = [timeOf(a.policy.observingSince), timeOf(a.findingsSince)].filter((ms) => !Number.isNaN(ms))
  if (starts.length === 0) return { on: true, days: 0 }
  const start = Math.max(...starts)
  const whole = Math.min(OBSERVE_WINDOW_DAYS, Math.max(0, Math.floor((a.nowMs - start) / DAY_MS)))
  const first = auditDayOf(new Date(Math.max(start, a.nowMs - OBSERVE_WINDOW_DAYS * DAY_MS)).toISOString())
  const today = auditDayOf(new Date(a.nowMs).toISOString())
  const stopped = new Set(a.stoppedDays.filter((d) => d >= first && d <= today)).size
  return { on: true, days: Math.max(0, whole - stopped) }
}
