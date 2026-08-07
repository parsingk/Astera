// Reads the reset time carried in the limit phrase. Pure — the only time input is the now argument.
//
// Why this is needed: recordRecovery used to use only resetsAt from the statusLine snapshot, but once
// the limit blocks a session and it stalls waiting for input, that snapshot stops being updated and
// stays pinned at its pre-limit value (measured: 0 updates over 88s of idle). If the gate (>=90%) is
// not cleared the wait drops to the 15-minute fallback, so when the real reset is 4 hours out we
// repeat ~16 kill/respawn cycles in the meantime. The phrase itself carries the time, so read that.
//
// Measured basis (105 rate_limit records across 1,976 transcripts): all 105 carry both the window
// kind and the reset time; session never has a date attached (it is always within 5 hours) and weekly
// only gets one when it crosses a day.

/** A reset read out of the phrase. weekly is true for the weekly window — it goes straight into BlockRecord.weekly. */
export interface ParsedReset {
  at: number
  weekly: boolean
}

// Only session|weekly are accepted as window kinds. LIMIT_RE also covers Opus, Sonnet, Fable 5 and
// usage credit, but not one of the 105 measured records used those, so we do not know the shape of
// their reset phrasing — rather than guess, fall through to null. The caller then falls back to the
// snapshot gate (the second path).
// The quote character class is the same as LIMIT_RE in detect.ts and the sister scanner in codexSignal.ts.
const RESET_RE =
  /You(?:['’ʼ`])?ve\s+hit\s+your\s+(session|weekly)\s+limit\s*·\s*resets\s+(?:([A-Za-z]{3})\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(([^)]+)\)/i

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
}

/** Year-boundary correction threshold — if the result is further in the past than this, read it as next year */
const YEAR_ROLLOVER_MS = 180 * 86_400_000

// Ceiling for the date-omitted branch only — if that branch resolves further out than its own window
// length it contradicts itself, so reject it. When now is properly anchored to the phrase's own
// timestamp (refAt in recordRecovery, rolling.ts below) this ceiling never fires in practice — it is
// a second line of defence, so that a future clock skew or timestamp format change degrades safely
// into this fallback (snapshot -> 15 minutes) instead of stranding us for 24 hours.
const SESSION_MAX_AHEAD_MS = 5 * 3_600_000 // the session window is 5 hours by definition — measured max 2.7h
const WEEKLY_MAX_AHEAD_MS = 24 * 3_600_000 // weekly with the date omitted is within a day (measured rule) — date-omitted measured max 3.2h

// Sanity ceiling shared by both branches — reject a result outside (now, now+PARSE_CEILING_MS].
// The year correction in the date-present branch never catches anything in the past direction (it
// only bumps to next year when the result is more than 180 days before now) — so a date that just
// passed would stay in the past (blockedUntil becomes past, and planRetry hammers at the 60s floor),
// and conversely a near-future date could be thrown months out by the year correction (setTimeout
// overflows past 24.8 days, fires immediately and hammers). Both directions are stopped here. The
// weekly window is at most 7 days, so 8 days leaves margin — measured date-present max 40.1h.
const PARSE_CEILING_MS = 8 * 86_400_000

/** UTC offset (minutes) of the utcMs instant in tz. Throws on failure — the caller catches it and turns it into null. */
function tzOffsetMin(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const p: Record<string, string> = {}
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value
  // some implementations report midnight as '24' under hour12:false, so normalize with % 24
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return (asUtc - Math.floor(utcMs / 1000) * 1000) / 60_000
}

/** Hour:minute (0-23:0-59) of the utcMs instant in tz. Used to verify wallToUtc's result — the % 24
 *  normalization against implementations that report midnight as '24' is the same as in tzOffsetMin. */
function wallHourMinute(tz: string, utcMs: number): { h: number; mi: number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit'
  })
  const p: Record<string, string> = {}
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value
  return { h: +p.hour % 24, mi: +p.minute }
}

/** Wall-clock time in tz to UTC ms. A fixed offset cannot be used (DST), so invert it through Intl.
 *  Why it iterates: the offset of the first guess may be on the wrong side of a DST transition.
 *  Taking the offset again from the applied result converges — a transition is usually 1 hour wide,
 *  so 3 rounds are enough.
 *
 *  For a wall-clock time that does not exist on that date — the skipped span of a spring-forward
 *  transition (e.g. America/New_York 02:00-02:59) — the iteration does not converge, it oscillates,
 *  and the answer flips with parity (e.g. NY 02:00 alternates between 07:00 and 06:00 UTC, and for a
 *  timezone shifted by 2 hours that answer lands before the reference time, which also corrupts the
 *  caller's day-roll and produces a +22.8h error). So do not trust convergence: read the result back
 *  and verify it — convert guess back to hour:minute in that timezone, and if it differs from the
 *  h:mi that went in, that wall-clock time does not exist on that date, so null — "there is no right
 *  answer in that gap" is the honest answer. */
function wallToUtc(tz: string, y: number, m: number, d: number, h: number, mi: number): number | null {
  let guess = Date.UTC(y, m, d, h, mi)
  for (let i = 0; i < 3; i++) guess = Date.UTC(y, m, d, h, mi) - tzOffsetMin(tz, guess) * 60_000
  const back = wallHourMinute(tz, guess)
  if (back.h !== h || back.mi !== mi) return null
  return guess
}

/** The date utcMs falls on in tz */
function tzDate(tz: string, utcMs: number): { y: number; m: number; d: number } {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
  const p: Record<string, string> = {}
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) p[type] = value
  return { y: +p.year, m: +p.month - 1, d: +p.day }
}

/** Reads the reset time out of a limit phrase. null if the format does not line up — the caller falls back. */
export function parseResetTime(text: string, now: number): ParsedReset | null {
  const m = RESET_RE.exec(text)
  if (!m) return null
  const [, kind, mon, day, hh, mm, ap, tz] = m

  let month: number | undefined
  let dayNum: number | undefined
  if (mon !== undefined) {
    month = MONTHS[mon.toLowerCase()]
    if (month === undefined) return null // the i flag makes 'Foo' match too — the table filters it out
    // day had no range check, the way hour does — Date.UTC quietly normalizes day overflow, so
    // 'Jul 99' becomes October 7. The regex already narrowed it to 1-2 digits, so we do not go as far
    // as the actual number of days in the month and only filter to 1-31 — anything beyond that exists
    // in no month at all.
    dayNum = +day
    if (dayNum < 1 || dayNum > 31) return null
  }

  const h12 = +hh
  if (h12 < 1 || h12 > 12) return null
  const h = ap.toLowerCase() === 'pm' ? (h12 % 12) + 12 : h12 % 12
  const mi = mm ? +mm : 0
  // minute had no range check either, the one hour has — '3:99pm' quietly slides through as 16:39.
  // When mm is absent (minute omitted) mi=0 is already valid, so only check when mm is present.
  if (mm !== undefined && (mi < 0 || mi > 59)) return null
  const weekly = kind.toLowerCase() === 'weekly'

  try {
    let at: number | null
    if (month !== undefined && dayNum !== undefined) {
      // Date present — the year is not in the phrase. Build it with now's year in that timezone, and
      // if the result is well in the past, next year.
      const { y } = tzDate(tz, now)
      at = wallToUtc(tz, y, month, dayNum, h, mi)
      // If at is null (a wall-clock time that does not exist on that date), changing the year does not
      // make it exist, so do not retry — carry the null straight down.
      if (at !== null && at < now - YEAR_ROLLOVER_MS) at = wallToUtc(tz, y + 1, month, dayNum, h, mi)
    } else {
      // Date omitted — the earliest occurrence of that wall-clock time after now. Date.UTC normalizes
      // day overflow.
      const { y, m: mo, d } = tzDate(tz, now)
      at = wallToUtc(tz, y, mo, d, h, mi)
      if (at !== null && at <= now) at = wallToUtc(tz, y, mo, d + 1, h, mi)
      if (at === null) return null
      // A date-omitted phrase cannot reach further out than its own window length — beyond that it
      // contradicts itself, so reject it and let the caller drop to the snapshot fallback.
      const maxAhead = weekly ? WEEKLY_MAX_AHEAD_MS : SESSION_MAX_AHEAD_MS
      if (at - now > maxAhead) return null
    }
    if (at === null || !Number.isFinite(at)) return null
    // Reject a result outside (now, now+PARSE_CEILING_MS] — see the constant's comment above.
    if (at <= now || at - now > PARSE_CEILING_MS) return null
    return { at, weekly }
  } catch {
    // Intl throws RangeError for an unknown timezone
    return null
  }
}
