import type { RateLimitPeak, RateLimitUsage, RateLimitWindow } from '../types'

// Maps the /api/oauth/usage response to RateLimitUsage. Pure functions — no network, no electron.
// This is the evidence the limit verdict runs on: unlike the statusLine snapshot, which stops updating
// the moment a session halts at an input wait, an account query answers regardless of session state.

/** One window (five_hour / seven_day) of the /api/oauth/usage response. Both field names are accepted
 *  so a schema drift on either side does not break the mapping. */
interface UsageWindowRaw {
  used_percentage?: unknown
  utilization?: unknown // the name the OAuth usage endpoint uses (0-100)
  resets_at?: unknown // epoch seconds (number), or an ISO/other string
}

/** One entry of `limits[]`. Measured 2026-08-30 on a live account:
 *  `{kind:"weekly_all", group:"weekly", percent:88, severity:"warning",
 *    resets_at:"2026-09-02T09:59:59+00:00", scope:null, is_active:true}` */
interface UsageLimitRaw {
  percent?: unknown
  resets_at?: unknown
  group?: unknown
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

function normalizeReset(raw: unknown): string | null {
  // epoch seconds → ISO. A string passes through as-is (assumed ISO); anything else is null.
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return new Date(raw * 1000).toISOString()
  }
  if (typeof raw === 'string' && raw.trim() !== '') return raw
  return null
}

function mapWindow(raw: unknown): RateLimitWindow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const w = raw as UsageWindowRaw
  const pct =
    typeof w.used_percentage === 'number' && Number.isFinite(w.used_percentage)
      ? w.used_percentage
      : typeof w.utilization === 'number' && Number.isFinite(w.utilization)
        ? w.utilization
        : null
  if (pct === null) return null
  return { usedPercent: clampPercent(pct), resetsAt: normalizeReset(w.resets_at) }
}

/**
 * Maps the Anthropic /api/oauth/usage response to RateLimitUsage (the same contract as Orca's
 * claude-fetcher). With no window at all the status is 'error' — a response arrived but carried
 * nothing usable.
 */
export function mapUsageResponse(data: unknown): RateLimitUsage {
  const d = (typeof data === 'object' && data !== null ? data : {}) as {
    five_hour?: unknown
    seven_day?: unknown
    limits?: unknown
  }
  const session = mapWindow(d.five_hour)
  const weekly = mapWindow(d.seven_day)
  const peak = peakOf(d.limits, session, weekly)
  return {
    session,
    weekly,
    maxPercent: peak ? peak.percent : null,
    peak,
    status: session || weekly ? 'ok' : 'error'
  }
}

/** The highest usage across every limit bucket — the value the limit verdict uses.
 *
 *  The two windows (five_hour / seven_day) alone are not enough. LIMIT_RE (core/rolling/detect.ts) also
 *  matches "Opus limit", "Sonnet limit", "Fable 5 limit" and "usage credit limit", and those live in
 *  separate buckets that do not show up in either window. Judging on the two windows alone would read a
 *  genuine Opus weekly limit as "five 30% / weekly 55%" and reject it as a false positive.
 *
 *  The measured response (2026-08-08) carries `limits[]` as
 *  `{kind, group, percent, severity, resets_at, scope, is_active}`, covering every bucket
 *  (session, weekly_all, weekly_scoped). The maximum is the right reduction because one exhausted
 *  bucket is already a limit — including the per-model scoped ones.
 *
 *  An older response shape with no `limits[]` falls back to the two windows. */
function peakOf(
  limits: unknown,
  session: RateLimitWindow | null,
  weekly: RateLimitWindow | null
): RateLimitPeak | null {
  const found: RateLimitPeak[] = []
  if (Array.isArray(limits))
    for (const l of limits) {
      if (typeof l !== 'object' || l === null) continue
      const raw = l as UsageLimitRaw
      const p = raw.percent
      if (typeof p !== 'number' || !Number.isFinite(p)) continue
      found.push({
        percent: clampPercent(p),
        resetsAt: normalizeReset(raw.resets_at),
        // `group` is "session" or "weekly" (measured). Anything else is read as not-weekly rather
        // than guessed at — a wrong weekly flag mislabels the wait a block record is describing.
        weekly: raw.group === 'weekly'
      })
    }
  // The older response shape with no limits[] — the two windows are all there is.
  if (!found.length) return peakOfWindows(session, weekly)
  // Ties go to the first: with two buckets equally full either reset is as good an answer, and
  // reduce's `>` already keeps the earlier one.
  return found.reduce((a, b) => (b.percent > a.percent ? b : a))
}

/** The fuller of the two named windows. Used when the two windows are the whole story: the older
 *  Anthropic response shape that carries no `limits[]`, and the codex response, which has no
 *  per-bucket array at all (core/usage/codexAccount.ts). Shared so "which window is the peak" is one
 *  rule — session wins a tie, because reduce's `>` keeps the earlier entry. */
export function peakOfWindows(
  session: RateLimitWindow | null,
  weekly: RateLimitWindow | null
): RateLimitPeak | null {
  const found: RateLimitPeak[] = []
  if (session) found.push({ percent: session.usedPercent, resetsAt: session.resetsAt, weekly: false })
  if (weekly) found.push({ percent: weekly.usedPercent, resetsAt: weekly.resetsAt, weekly: true })
  if (!found.length) return null
  return found.reduce((a, b) => (b.percent > a.percent ? b : a))
}
