import type { RateLimitUsage, RateLimitWindow } from '../types'

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
  return {
    session,
    weekly,
    maxPercent: maxPercentOf(d.limits, session, weekly),
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
function maxPercentOf(
  limits: unknown,
  session: RateLimitWindow | null,
  weekly: RateLimitWindow | null
): number | null {
  const pcts: number[] = []
  if (Array.isArray(limits))
    for (const l of limits) {
      if (typeof l !== 'object' || l === null) continue
      const p = (l as { percent?: unknown }).percent
      if (typeof p === 'number' && Number.isFinite(p)) pcts.push(clampPercent(p))
    }
  if (!pcts.length) {
    if (session) pcts.push(session.usedPercent)
    if (weekly) pcts.push(weekly.usedPercent)
  }
  return pcts.length ? Math.max(...pcts) : null
}
