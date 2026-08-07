// Reads the limit signal out of a codex rollout file. Pure module — no timers, no side effects.
// For Claude we read the whole statusLine capture file (small, overwritten every time), but a rollout
// is an append-only file that accumulates for the entire session, so we parse it incrementally with a
// byte-offset tail.
import { JsonlTail } from './jsonlTail'
import { stripAnsi } from './detect'

/** One limit window. resetsAt is normalized to epoch ms (the source is seconds). */
export interface CodexWindow {
  usedPercent: number
  resetsAt: number | null
}

export interface CodexLimitState {
  primary: CodexWindow | null // measured 300-minute (5 hour) window
  secondary: CodexWindow | null // measured 10080-minute (weekly) window
  reachedType: string | null // raw rate_limit_reached_type — non-null means the limit was reached
  at: number // when this state was read (ms)
}

const GATE_PCT = 90 // how worstResetAt picks which window's reset to report — not used as a gate for accepting the phrase (same role as GATE_PCT in rolling.ts and slack.ts)

function parseWindow(v: unknown): CodexWindow | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (typeof o.used_percent !== 'number') return null
  // resets_at is in epoch seconds (measured) — normalize to ms so it compares directly with Date.now()
  const sec = o.resets_at
  return {
    usedPercent: o.used_percent,
    resetsAt: typeof sec === 'number' && Number.isFinite(sec) ? sec * 1000 : null
  }
}

/** Pulls rate_limits out of one rollout line. null if it is not a token_count or the shape differs. */
function rateLimitsOf(raw: string): Record<string, unknown> | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null // defensive parsing — ignore broken lines
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const payload = (obj as Record<string, unknown>).payload
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const p = payload as Record<string, unknown>
  if (p.type !== 'token_count') return null
  const info = p.info
  if (info === null || typeof info !== 'object' || Array.isArray(info)) return null
  const rl = (info as Record<string, unknown>).rate_limits
  if (rl === null || typeof rl !== 'object' || Array.isArray(rl)) return null
  return rl as Record<string, unknown>
}

/** Builds a state from the last rate_limits snapshot in the lines. null if there is no snapshot at all.
 *  Shared by CodexRolloutTail.read() and the orchestration probe (limitProbe.ts) — keeping two copies
 *  of the assembly rule would let them drift. `at` is the "time this batch was observed" supplied by
 *  the caller (e.g. the probe's now()) — not a time re-read per line; the single call-time value is
 *  used as-is for every matching line. */
export function limitStateFromLines(lines: string[], at: number): CodexLimitState | null {
  let last: CodexLimitState | null = null
  for (const line of lines) {
    const rl = rateLimitsOf(line)
    if (!rl) continue
    last = {
      primary: parseWindow(rl.primary),
      secondary: parseWindow(rl.secondary),
      reachedType: typeof rl.rate_limit_reached_type === 'string' ? rl.rate_limit_reached_type : null,
      at
    }
  }
  return last
}

/** Incremental tail of one rollout file. Every read() reads only the newly appended bytes and refreshes the last rate_limits. */
export class CodexRolloutTail {
  private tail: JsonlTail
  private last: CodexLimitState | null = null

  constructor(
    filePath: string,
    private now: () => number = Date.now
  ) {
    this.tail = new JsonlTail(filePath)
  }

  /** With no new lines, returns the previous state unchanged (state does not disappear). Missing file or error gives null. */
  async read(): Promise<CodexLimitState | null> {
    const r = await this.tail.read()
    if (!r) return null
    if (r.restarted) this.last = null // state from a recreated file has nothing to do with the previous file
    const next = limitStateFromLines(r.lines, this.now())
    if (next) this.last = next
    return this.last
  }
}

// The real limit phrasing, extracted from the codex 0.146.0 binary. Every observed variant starts
// with one of the two below. The angle brackets around `<usage>` and the splicing in the two lines
// below are **not part of the real output** — they are notation inserted so that this comment does
// not become a trigger itself (see (b) below). The codex regex hard-codes `usage` in that slot, and
// no other window name has ever been observed there. That differs from detect.ts on the claude side,
// which enumerates the window names. `<model>`, by contrast, really is a template variable:
//   "You've hit your <usage> limit[ for <model>]. {Switch to another model|Upgrade to Plus|Visit ...}"
//   "Usage limit" + " reached." / "You've reached your <usage> limit."
// The previous /(usage|rate)\s+limit/i also matched the codex TUI's "Rate limits" panel, `/status`
// output and even source code, so it produced many false positives. The apostrophe class allows both
// the straight quote and the typographic one ('’').
//
// There are two reasons the gaps between words are \s+ rather than a literal space:
//   (a) Soft-wrap tolerance — stripAnsi only strips escapes and does not touch the terminal's line
//       breaks, so when a narrow window splits it like "Usage limit\r\nreached" a literal space fails
//       to match. The claude side was already changed to \s+ for the same reason and codex never
//       picked that change up.
//   (b) It stops this file from being a trigger itself — "usage limit" + " reached" written with a
//       literal space matches the second alternative of claude's LIMIT_RE (detect.ts) exactly. That
//       is, if this source scrolls across the screen of a rolling session (cat, grep, an editor), a
//       claude roll fired. The five characters \s+ are not whitespace, so the regex does not bite its
//       own source. repoSelfTrigger.test.ts guards against the regression.
const LIMIT_RE = /you(?:['’ʼ`])?ve\s+(?:hit|reached)\s+your\s+usage\s+limit|usage\s+limit\s+reached/i
const TAIL_MAX = 2000 // same width as OutputScanner in detect.ts

/** Finds the limit phrase in PTY output (the input to decision (2)). Chunks are cut at arbitrary
 *  positions, so we keep a tail of the stripped text and test the concatenation — testing each chunk
 *  statelessly would miss a phrase that is split across two writes. Same idea as OutputScanner in
 *  detect.ts, but that one has the Claude-only regex baked in, so it is not shared.
 *  Clears the buffer on a match to stop the same phrase from matching repeatedly. */
export class CodexLimitScanner {
  private tail = ''

  push(chunk: string): boolean {
    this.tail = (this.tail + stripAnsi(chunk)).slice(-TAIL_MAX)
    if (!LIMIT_RE.test(this.tail)) return false
    this.tail = ''
    return true
  }
}

const windows = (s: CodexLimitState): CodexWindow[] =>
  [s.primary, s.secondary].filter((w): w is CodexWindow => w !== null)

/** Limit-reached decisions (1) and (2). (3) (100% + no output) needs a time condition, so the
 *  coordinator handles that one via maxedOut.
 *
 *  Why (2) has no usage gate: rate_limits rides only on `token_count` events, and those are recorded
 *  only once a turn completes. When the limit rejects a request no new token_count comes out, so usage
 *  stops at a low value — and a gate would then block the legitimate limit phrase at exactly that
 *  moment. Claude's statusLine is no different: the instant the limit blocks, statusLine itself stops
 *  updating (measured: 0 updates over 88s of idle). That is why GATE_PCT in rolling.ts is no longer a
 *  gate for accepting the phrase either (it was removed). So both providers decide without a gate, and
 *  false-positive defence is carried not by a gate but by the scanner, which narrows LIMIT_RE down to
 *  the measured phrasing. */
export function limitReached(state: CodexLimitState | null, opts: { textHit: boolean }): boolean {
  if (!state) return false
  if (state.reachedType !== null) return true // (1) structured primary signal
  return opts.textHit // (2) confirmed phrase — independent of usage
}

/** Any window at 100% or above — the usage condition of fallback decision (3) */
export function maxedOut(state: CodexLimitState | null): boolean {
  if (!state) return false
  return windows(state).some((w) => w.usedPercent >= 100)
}

/** The latest reset among the windows at or above the gate. If both are blocked, both have to clear
 *  before the account is usable, hence max.
 *  (the codex counterpart of recordRecovery in rolling.ts) */
export function worstResetAt(
  state: CodexLimitState | null,
  gatePct = GATE_PCT
): { at: number | null; weekly: boolean } {
  if (!state) return { at: null, weekly: false }
  const cand: { at: number; weekly: boolean }[] = []
  if (state.primary && state.primary.usedPercent >= gatePct && state.primary.resetsAt !== null)
    cand.push({ at: state.primary.resetsAt, weekly: false })
  if (state.secondary && state.secondary.usedPercent >= gatePct && state.secondary.resetsAt !== null)
    cand.push({ at: state.secondary.resetsAt, weekly: true })
  if (!cand.length) return { at: null, weekly: false }
  const worst = cand.reduce((a, b) => (b.at > a.at ? b : a))
  return { at: worst.at, weekly: worst.weekly }
}
