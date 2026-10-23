import type { RateLimitWindow, SessionUsage, TokensSpent } from '../types'
import type { CodexLimitState, CodexWindow } from '../rolling/codexSignal'

// Maps a codex rollout's token_count records to SessionUsage — the codex counterpart of
// statusline.ts, which does the same for claude's statusLine payload. Pure functions.
//
// Why the rollout at all: codex has no statusLine mechanism, so the only place these figures are
// written down is the rollout jsonl. Two different levels of the same record carry them —
// `payload.info` holds the token counts, `payload.rate_limits` the two limit windows — which is why
// the windows are not parsed here: limitStateFromLines (core/rolling/codexSignal.ts) already reads
// them, carry-forward rule included, and sessionUsageOf takes its result.

/** The baseline codex subtracts from **both** sides before reporting context usage.
 *
 *  This is not our choice — it is a mirror of what the codex TUI displays, so that the app's chip and
 *  `N% context left` on the same screen do not disagree. The intent (codex's own words) is that tokens
 *  which are always present — system prompt, fixed tool instructions — should not count as context the
 *  user spent. A session that has just started really holds ~12k tokens and codex still shows
 *  `100% context left`.
 *
 *  Source: `codex-rs/tui/src/token_usage.rs` 의 `BASELINE_TOKENS` and
 *  `percent_of_context_window_remaining`; the input choice (last_token_usage, and `100 - remaining`)
 *  is `codex-rs/tui/src/chatwidget/status_controls.rs` 의
 *  `status_line_context_remaining_percent`. Read at tag `rust-v0.150.1` (the latest release on
 *  2026-08-27; the installed CLI was 0.149.1 and both files are byte-identical between the two).
 *  Measured the same value 12000 across `rust-v0.130.0` … `rust-v0.150.1`; before 0.130 the constant
 *  lived in `codex-rs/protocol/src/protocol.rs`, where a second definition of it still sits — the TUI
 *  uses its own, so that is the one mirrored here.
 *
 *  **If codex changes it, our number drifts silently and no data can tell us.** The rollout records
 *  raw token counts only — the computed percentage is never written down — so the value cannot be
 *  recovered or calibrated at runtime. `npm run check:codex-baseline` re-reads the upstream source and
 *  fails when any of the three facts above stops holding. */
const BASELINE_TOKENS = 12_000

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function clampPercent(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

/** epoch ms → ISO. The two sides differ by design: CodexWindow.resetsAt is normalized to ms because
 *  rolling compares it against Date.now(), RateLimitWindow.resetsAt is a string because the renderer
 *  formats it. */
function toRateLimitWindow(w: CodexWindow | null): RateLimitWindow | null {
  if (!w) return null
  return {
    usedPercent: clampPercent(w.usedPercent),
    resetsAt: w.resetsAt === null ? null : new Date(w.resetsAt).toISOString()
  }
}

/** Context usage %, as codex would display it (see BASELINE_TOKENS).
 *
 *  The rounding happens **once, on the remaining side**, and the result is subtracted from 100 —
 *  exactly as codex does it. Rounding the used side directly is not the same computation: at a
 *  window of 12200 with 12099 tokens, remaining is 50.5% → 51% → 49% used, while the used side gives
 *  49.5% → 50%. So the value returned here is already an integer and must not be passed through
 *  clampPercent, which would round a second time. */
function usedPercentOf(totalTokens: number, contextWindow: number): number {
  if (contextWindow <= BASELINE_TOKENS) return 100
  const effective = contextWindow - BASELINE_TOKENS
  const used = Math.max(0, totalTokens - BASELINE_TOKENS)
  const remaining = Math.max(0, effective - used)
  return 100 - clampPercent((remaining / effective) * 100)
}

/** `payload.info` of one token_count record → context. null when it cannot answer.
 *
 *  last_token_usage, not total_token_usage: the latter is the session's accumulated spend and grows
 *  far past the context window, so it would read as 100% on any long session.
 *  model_context_window is the only source of the window size anywhere in the rollout (session_meta
 *  does not carry it), and without it there is no percentage — null, so the chip shows nothing rather
 *  than a made-up 0%. */
function contextOf(info: unknown): SessionUsage['context'] {
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return null
  const o = info as { last_token_usage?: unknown; model_context_window?: unknown }
  const window = finite(o.model_context_window)
  if (window === null) return null
  const last = o.last_token_usage
  if (last === null || typeof last !== 'object' || Array.isArray(last)) return null
  const total = finite((last as { total_tokens?: unknown }).total_tokens)
  if (total === null) return null
  // usedTokens/windowSize stay the raw figures the record carried, deliberately — the tooltip is the
  // detail view and codex's own /status does the same (adjusted indicator, raw totals). The tooltip's
  // ratio therefore does not match the chip's %.
  return { usedPercent: usedPercentOf(total, window), usedTokens: total, windowSize: window }
}

/** `payload.info` of a token_count line, or null for any other line. Defensive — a broken line is
 *  ignored rather than thrown, the same rule as parseLine in codexSignal.ts. */
function tokenCountInfoOf(raw: string): unknown | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const p = (obj as { payload?: unknown }).payload
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return null
  const payload = p as { type?: unknown; info?: unknown }
  return payload.type === 'token_count' ? (payload.info ?? null) : null
}

/** The newest context figure in these lines, falling back to `prev`.
 *
 *  `prev` is kept rather than cleared for the same reason limitStateFromLines keeps its windows: the
 *  moment a limit hits, codex writes a credit-balance token_count whose `info` carries no window, and
 *  taking the newest record wholesale would blank the chip at exactly that moment. */
export function contextFromLines(
  lines: string[],
  prev: SessionUsage['context'] = null
): SessionUsage['context'] {
  let out = prev
  for (const raw of lines) {
    const info = tokenCountInfoOf(raw)
    if (info === null) continue
    const c = contextOf(info)
    if (c) out = c
  }
  return out
}

/** `payload.info.total_token_usage` and `last_token_usage` of a token_count line with its time, or null. */
function countedOf(raw: string): { at: string; total: { input: number; output: number }; last: { input: number; output: number } | null } | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null
  }
  const o = obj as { timestamp?: unknown; payload?: { type?: unknown; info?: unknown } } | null
  const info = o?.payload?.type === 'token_count' ? (o.payload.info as { total_token_usage?: unknown; last_token_usage?: unknown } | null) : null
  if (typeof o?.timestamp !== 'string' || !info || typeof info !== 'object') return null
  const pair = (u: unknown): { input: number; output: number } | null => {
    const v = u as { input_tokens?: unknown; output_tokens?: unknown } | null
    const input = finite(v?.input_tokens)
    const output = finite(v?.output_tokens)
    return input === null || output === null ? null : { input, output }
  }
  const total = pair(info.total_token_usage)
  return total ? { at: o.timestamp, total, last: pair(info.last_token_usage) } : null
}

/** The tokens a Codex session spent, one response at a time, off its rollout's token_count lines (observe mode
 *  design §10), as many batches as it is handed.
 *
 *  total_token_usage is the conversation's running total, not the session's: a resumed or forked conversation starts
 *  from the total its rollout already holds (codex-rs 0.160 `last_token_info_from_rollout`, on resume and on fork), so
 *  a roll's new session carries the old one's figure on. What this session spent is therefore what the total grew by
 *  since the session started: a line written before `since` (epoch ms) is where it starts from. When the read began
 *  past every such line (it starts near the end of a long rollout), the first line's own response is the step: the
 *  rollout writes one token_count per response, so its total less its `last_token_usage` is the total before it
 *  (1094 of 1096 measured pairs; the other two repeated a total, which adds nothing here).
 *
 *  `input` is input_tokens, the cached ones inside it; `output` is output_tokens, reasoning inside it. A line without
 *  `info` (the credit balance written at a limit) carries nothing. A total that went down is a new start, counted
 *  from there. */
export function codexTokenReader(since: number): (lines: readonly string[]) => TokensSpent[] {
  let prev: { input: number; output: number } | null = null
  return (lines) => {
    const out: TokensSpent[] = []
    for (const raw of lines) {
      if (!raw.includes('"token_count"')) continue
      const c = countedOf(raw)
      if (!c) continue
      if (!(Date.parse(c.at) >= since)) {
        prev = c.total
        continue
      }
      const from: { input: number; output: number } = prev ?? (c.last ? { input: c.total.input - c.last.input, output: c.total.output - c.last.output } : c.total)
      prev = c.total
      const input = c.total.input - from.input
      const output = c.total.output - from.output
      if (input < 0 || output < 0 || input + output === 0) continue
      out.push({ at: c.at, input, output })
    }
    return out
  }
}

/** Assembles what the usage chips read. null when not one of the three values is known — the same
 *  "nothing usable" contract as parseStatusLinePayload.
 *
 *  The two arguments are tracked separately on purpose. After an account roll the context is still
 *  true (same conversation) while the windows belong to the previous account, so the watcher seeds one
 *  and not the other. */
export function sessionUsageOf(
  context: SessionUsage['context'],
  limits: CodexLimitState | null
): SessionUsage | null {
  const session = toRateLimitWindow(limits?.primary ?? null)
  const weekly = toRateLimitWindow(limits?.secondary ?? null)
  if (!context && !session && !weekly) return null
  return { context, session, weekly }
}
