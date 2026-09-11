import type { RateLimitWindow, SessionUsage } from '../types'

// Maps the values Claude Code (v2.1.6+) hands over in the statusLine stdin payload to SessionUsage.
// context_window: { used_percentage, context_window_size, current_usage{input/cache_*} }
// rate_limits: { five_hour{used_percentage,resets_at}, seven_day{...} }
// Claude computes all of it, so no window-size (200k/1M) heuristic and no credentials are needed. Pure functions.

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function normalizeReset(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return new Date(raw * 1000).toISOString()
  if (typeof raw === 'string' && raw.trim() !== '') return raw
  return null
}

function mapWindow(raw: unknown): RateLimitWindow | null {
  if (typeof raw !== 'object' || raw === null) return null
  const w = raw as { used_percentage?: unknown; utilization?: unknown; resets_at?: unknown }
  const pct = finite(w.used_percentage) ?? finite(w.utilization)
  if (pct === null) return null
  return { usedPercent: clampPercent(pct), resetsAt: normalizeReset(w.resets_at) }
}

function mapContext(raw: unknown): SessionUsage['context'] {
  if (typeof raw !== 'object' || raw === null) return null
  const cw = raw as {
    used_percentage?: unknown
    context_window_size?: unknown
    current_usage?: Record<string, unknown>
  }
  const size = finite(cw.context_window_size)
  const u = cw.current_usage
  const tokens =
    typeof u === 'object' && u !== null
      ? (finite(u.input_tokens) ?? 0) +
        (finite(u.cache_read_input_tokens) ?? 0) +
        (finite(u.cache_creation_input_tokens) ?? 0)
      : null
  // First choice: the used_percentage Claude gave us (matches /context). Fallback: tokens / window size.
  let usedPercent = finite(cw.used_percentage)
  if (usedPercent === null && size && size > 0 && tokens !== null) usedPercent = (tokens / size) * 100
  if (usedPercent === null) return null
  return { usedPercent: clampPercent(usedPercent), usedTokens: tokens, windowSize: size }
}

/** statusLine payload (the JSON.parse'd object) → SessionUsage. null when there is not a single usable value. */
export function parseStatusLinePayload(payload: unknown): SessionUsage | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { context_window?: unknown; rate_limits?: unknown }
  const context = mapContext(p.context_window)
  const rl = typeof p.rate_limits === 'object' && p.rate_limits !== null ? (p.rate_limits as Record<string, unknown>) : null
  const session = rl ? mapWindow(rl.five_hour) : null
  const weekly = rl ? mapWindow(rl.seven_day) : null
  if (!context && !session && !weekly) return null
  return { context, session, weekly }
}

/** Pulls the session identity metadata (session_id, transcript_path) out of the statusLine payload —
 *  rolling uses it as the path of the transcript copy and as the ID to --resume. It lives here
 *  because the capture script records the whole payload. */
/** What the CLI reports about the model it is running under, or nulls when it has said nothing yet.
 *
 *  The conversation view has no statusline of its own to read this off — the terminal draws one and
 *  this pane does not — so it asks here. Same tolerance as extractStatusLineSession below: a payload
 *  that is missing, malformed, or shaped unexpectedly answers nulls rather than throwing, because
 *  every caller is drawing a label and none of them can do anything useful with an error. */
export function extractStatusLineModel(payload: unknown): {
  model: string | null
  effort: string | null
} {
  if (typeof payload !== 'object' || payload === null) return { model: null, effort: null }
  const p = payload as { model?: unknown; effort?: unknown }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
  const field = (v: unknown, key: string): string | null =>
    typeof v === 'object' && v !== null ? str((v as Record<string, unknown>)[key]) : null
  return { model: field(p.model, 'display_name'), effort: field(p.effort, 'level') }
}

export function extractStatusLineSession(payload: unknown): {
  sessionId: string | null
  transcriptPath: string | null
} {
  if (typeof payload !== 'object' || payload === null) return { sessionId: null, transcriptPath: null }
  const p = payload as { session_id?: unknown; transcript_path?: unknown }
  const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
  return { sessionId: str(p.session_id), transcriptPath: str(p.transcript_path) }
}
