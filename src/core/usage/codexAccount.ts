import type { RateLimitUsage, RateLimitWindow } from '../types'
import { peakOfWindows } from './rateLimit'

// Maps the codex account-usage response to RateLimitUsage — the codex counterpart of rateLimit.ts,
// which does the same for Anthropic's /api/oauth/usage. Pure functions, no network.
//
// Why an account query at all, when core/usage/codex.ts already reads the two windows out of a
// rollout: that one answers for a *session*, and only for a session this app spawned and is tailing.
// The accounts tab asks about an account — including one with nothing running, which is most of them
// most of the time. The rollout cannot answer that: its figures are as old as that account's last
// turn, which can be days.
//
// The response shape, measured 2026-09-04 against a live `plan_type: "plus"` account:
//   { user_id, account_id, email, plan_type,
//     rate_limit: { allowed, limit_reached,
//       primary_window:   { used_percent: 0,  limit_window_seconds: 18000,  reset_after_seconds, reset_at },
//       secondary_window: { used_percent: 35, limit_window_seconds: 604800, reset_after_seconds, reset_at } },
//     code_review_rate_limit, additional_rate_limits, model_usage, credits, spend_control,
//     rate_limit_reached_type, promo, rate_limit_reset_credits }
//
// primary is the 5-hour window (18000s) and secondary the weekly one (604800s) — the same two windows
// the rollout's `payload.rate_limits` carries under the same two names, so the account row's existing
// "5-hour / weekly" labels are right without translation. The window lengths are not read: they are
// what identifies the two windows in the first place, and a response that renamed or re-sized them
// would need a decision here rather than an arithmetic adjustment.
//
// `additional_rate_limits` and `code_review_rate_limit` are deliberately left alone. On the claude side
// the per-bucket `limits[]` is folded into `peak` because the limit verdict runs on it (see peakOf);
// codex's limit verdict does not — it reads the rollout (core/rolling/codexSignal.ts) — so here `peak`
// only feeds AccountUsageStore's discard arithmetic, and the two named windows are the two the row
// draws.

/** One window of the response. `used_percent` was measured as an integer, but the claude side accepts
 *  a fraction too and clamps, so this does the same rather than trusting the shape. */
interface CodexWindowRaw {
  used_percent?: unknown
  reset_at?: unknown // epoch seconds
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** epoch seconds → ISO, the form RateLimitWindow carries. Anything else is null.
 *
 *  Unlike rateLimit.ts's normalizeReset there is no string branch: this field was measured as a number
 *  and a string here would mean the shape changed, which is worth showing as "no reset" rather than
 *  passing through unvalidated into a countdown. */
function normalizeReset(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return new Date(raw * 1000).toISOString()
  }
  return null
}

function mapWindow(raw: unknown): RateLimitWindow | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const w = raw as CodexWindowRaw
  if (typeof w.used_percent !== 'number' || !Number.isFinite(w.used_percent)) return null
  return { usedPercent: clampPercent(w.used_percent), resetsAt: normalizeReset(w.reset_at) }
}

/**
 * Maps the codex usage response to RateLimitUsage. With no window at all the status is 'error' — a
 * response arrived but carried nothing usable, the same verdict mapUsageResponse gives.
 */
export function mapCodexUsageResponse(data: unknown): RateLimitUsage {
  const d = (data === null || typeof data !== 'object' || Array.isArray(data) ? {} : data) as {
    rate_limit?: unknown
  }
  const rl = (
    d.rate_limit === null || typeof d.rate_limit !== 'object' || Array.isArray(d.rate_limit)
      ? {}
      : d.rate_limit
  ) as { primary_window?: unknown; secondary_window?: unknown }
  const session = mapWindow(rl.primary_window)
  const weekly = mapWindow(rl.secondary_window)
  const peak = peakOfWindows(session, weekly)
  return {
    session,
    weekly,
    maxPercent: peak ? peak.percent : null,
    peak,
    status: session || weekly ? 'ok' : 'error'
  }
}
