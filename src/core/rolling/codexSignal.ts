// Reads the limit signal out of a codex rollout file. Pure module — no timers, no side effects.
// For Claude we read the whole statusLine capture file (small, overwritten every time), but a rollout
// is an append-only file that accumulates for the entire session, so we parse it incrementally with a
// byte-offset tail.
import { stat } from 'node:fs/promises'
import { JsonlTail, type JsonlTailOptions } from './jsonlTail'
import { tailLines } from './tailLines'
import { stripAnsi, findChoiceNumber } from './detect'

/** One limit window. resetsAt is normalized to epoch ms (the source is seconds). */
export interface CodexWindow {
  usedPercent: number
  resetsAt: number | null
}

/** The usage-limit error a turn ended on. `at` is the record's own timestamp, not when we read it —
 *  a verdict has to be anchored to when it happened (the probe drops errors older than its Dispatch). */
export interface CodexLimitError {
  message: string
  at: number
}

export interface CodexLimitState {
  primary: CodexWindow | null // measured 300-minute (5 hour) window
  secondary: CodexWindow | null // measured 10080-minute (weekly) window
  reachedType: string | null // raw rate_limit_reached_type — non-null means the limit was reached
  /** The `usage_limit_exceeded` error in these lines — the only limit signal codex actually emits.
   *  Unlike the windows this is an event, not a fact about the account, so a later batch that carries
   *  its own records clears it rather than inheriting it. (A batch with no records at all leaves the
   *  whole previous state standing, error included — that is CodexRolloutTail.read()'s contract, and it
   *  is what lets a tick re-see a limit whose roll was blocked.) */
  error: CodexLimitError | null
  /** The reset recovered from the turns that came **before** this session attached, used only when this
   *  session's own windows answer nothing (see worstResetAt).
   *
   *  Deliberately not stored as a window. A resumed session attaches to a rollout whose usage figures
   *  were written before the reset it is now past — reviving those would hand a stale 100% to maxedOut
   *  and fallback verdict ③ would kill a session that is working fine. The reset instant is a fact that
   *  stays true; the usage percentage is not. */
  priorReset: { at: number; weekly: boolean } | null
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

/** One rollout line, parsed. `at` is the line's own timestamp (ms), null when it has none. */
interface RolloutLine {
  at: number | null
  payload: Record<string, unknown>
}

function parseLine(raw: string): RolloutLine | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null // defensive parsing — ignore broken lines
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  if (o.payload === null || typeof o.payload !== 'object' || Array.isArray(o.payload)) return null
  const parsed = typeof o.timestamp === 'string' ? Date.parse(o.timestamp) : NaN
  return { at: Number.isFinite(parsed) ? parsed : null, payload: o.payload as Record<string, unknown> }
}

/** Pulls rate_limits out of one token_count payload. null if the type or the shape differs.
 *
 *  rate_limits sits directly under `payload`, **not** under `payload.info` — which is where this used
 *  to look, so not one snapshot was ever read and the state stayed null forever, taking all three
 *  verdicts down with it (limitReached ignores even a confirmed phrase when the state is null). The
 *  test fixtures encoded the same wrong shape, so the suite stayed green throughout. Counted over the
 *  local rollouts (108 files, codex 0.142.5 → 0.149.1): payload.rate_limits 1338, payload.info
 *  .rate_limits 0 — the old path never existed in any version we have. */
function rateLimitsOf(p: Record<string, unknown>): Record<string, unknown> | null {
  if (p.type !== 'token_count') return null
  const rl = p.rate_limits
  if (rl === null || typeof rl !== 'object' || Array.isArray(rl)) return null
  return rl as Record<string, unknown>
}

/** The usage-limit error a task_complete carries, if it is one. null otherwise.
 *
 *  This is the signal that actually fires. `rate_limit_reached_type` was measured non-null in **0 of
 *  1288** snapshots across the local rollouts — including the two moments a limit really hit — so
 *  verdict ① never had anything to act on. Those same two moments each produced exactly one
 *  `codex_error_info: "usage_limit_exceeded"`, which is what this reads. */
function limitErrorOf(line: RolloutLine, fallbackAt: number): CodexLimitError | null {
  const p = line.payload
  if (p.type !== 'task_complete') return null
  const err = p.error
  if (err === null || typeof err !== 'object' || Array.isArray(err)) return null
  const e = err as Record<string, unknown>
  if (e.codex_error_info !== 'usage_limit_exceeded') return null
  return { message: typeof e.message === 'string' ? e.message : '', at: line.at ?? fallbackAt }
}

/** Builds a state from the lines. null when they carry neither a rate_limits snapshot nor a limit error.
 *  Shared by CodexRolloutTail.read() and the orchestration probe (limitProbe.ts) — keeping two copies
 *  of the assembly rule would let them drift. `at` is the "time this batch was observed" supplied by
 *  the caller (e.g. the probe's now()) — not a time re-read per line; the single call-time value is
 *  used as-is for every matching line.
 *
 *  `prev` supplies the windows to fall back on, and only the windows. The moment a limit hits, codex
 *  emits a credit-balance snapshot (`limit_id: "premium"`) whose windows are all null, 0.8s after the
 *  plan snapshot that carried the real reset time — measured. Taking the newest record wholesale
 *  therefore erases the reset at exactly the moment it is needed and drops the wait to the blind
 *  15-minute fallback. The windows describe the account, so the last known value stays true; the
 *  verdicts (reachedType, error) describe a moment, so they are never carried over. */
export function limitStateFromLines(
  lines: string[],
  at: number,
  prev: CodexLimitState | null = null
): CodexLimitState | null {
  let primary = prev?.primary ?? null
  let secondary = prev?.secondary ?? null
  let reachedType: string | null = null
  let error: CodexLimitError | null = null
  let saw = false
  for (const raw of lines) {
    const line = parseLine(raw)
    if (!line) continue
    const err = limitErrorOf(line, at)
    if (err) {
      error = err
      saw = true
      continue
    }
    const rl = rateLimitsOf(line.payload)
    if (!rl) continue
    saw = true
    primary = parseWindow(rl.primary) ?? primary
    secondary = parseWindow(rl.secondary) ?? secondary
    reachedType = typeof rl.rate_limit_reached_type === 'string' ? rl.rate_limit_reached_type : null
  }
  return saw ? { primary, secondary, reachedType, error, priorReset: prev?.priorReset ?? null, at } : null
}

/** Reads the reset the conversation already knew about, out of the tail of the rollout as it stands.
 *  Used to fill CodexLimitState.priorReset when a tail attaches at the end of an existing file. Only
 *  the reset is taken — see the field's doc comment for why the usage figures are left behind. */
async function readPriorReset(filePath: string): Promise<{ at: number; weekly: boolean } | null> {
  const lines = await tailLines(filePath)
  if (!lines) return null
  const seeded = limitStateFromLines(lines, 0)
  const reset = worstResetAt(seeded)
  return reset.at === null ? null : { at: reset.at, weekly: reset.weekly }
}

/** Incremental tail of one rollout file. Every read() reads only the newly appended bytes and refreshes the last rate_limits.
 *
 *  `opts` is handed straight to JsonlTail. The one that matters here is `startAtEnd`: `codex resume`
 *  does not create a new rollout, it appends to the existing file (measured on 0.149.1), so a resumed
 *  session attaches to a file that already holds the previous conversation's rate_limits — including
 *  the reachedType of the limit it ended on. Reading those would make the coordinator judge the *old*
 *  snapshot as this session's verdict and roll the instant it attaches. Starting at the end means only
 *  what this session writes counts. */
export class CodexRolloutTail {
  private tail: JsonlTail
  private last: CodexLimitState | null = null
  private priorReset: { at: number; weekly: boolean } | null = null
  // Started in the constructor for the same reason JsonlTail stats there: what we want is the file as
  // it stood at attach time, and the first read() can be a whole tick later.
  private seed: Promise<{ at: number; weekly: boolean } | null> | null = null

  constructor(
    filePath: string,
    private now: () => number = Date.now,
    opts: JsonlTailOptions = {}
  ) {
    this.tail = new JsonlTail(filePath, opts)
    // Only when skipping the existing content — reading from offset 0 already sees those turns
    if (opts.startAtEnd) this.seed = readPriorReset(filePath)
  }

  /** The reset recovered from the file at attach time, or null when this file records no block.
   *  Awaits the seed the constructor started, so the first caller may wait on one file read.
   *  The coordinator asks this while its own state is still null — see priorLimitVerdict. */
  async priorResetAt(): Promise<{ at: number; weekly: boolean } | null> {
    if (this.seed) {
      this.priorReset = await this.seed
      this.seed = null
    }
    return this.priorReset
  }

  /** With no new lines, returns the previous state unchanged (state does not disappear). Missing file or error gives null. */
  async read(): Promise<CodexLimitState | null> {
    if (this.seed) {
      this.priorReset = await this.seed
      this.seed = null
    }
    const r = await this.tail.read()
    if (!r) return null
    if (r.restarted) this.last = null // state from a recreated file has nothing to do with the previous file
    // this.last is handed in so the windows survive a batch that carries none (see limitStateFromLines)
    const next = limitStateFromLines(r.lines, this.now(), this.last)
    if (next) this.last = { ...next, priorReset: next.priorReset ?? this.priorReset }
    return this.last
  }
}

/** The rollout's size in bytes, or `null` when it cannot be read (missing file, permission error).
 *
 *  **What it is for: answering "did a turn actually run".** codex appends a record for a submitted
 *  message as soon as it accepts it, so a rollout that did not grow after we typed a line means the
 *  composer swallowed the input. PTY output cannot answer the same question — the TUI echoes our own
 *  keystrokes straight back, so the output clock advances either way. Read as a size rather than a
 *  parse because the question is only "did anything get appended"; which record it was does not
 *  matter. The caller decides what `null` means (codexRolling treats it as no growth). */
export async function rolloutSize(filePath: string): Promise<number | null> {
  try {
    return (await stat(filePath)).size
  } catch {
    return null
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

// The prompt codex interposes between turns as the credit window runs low (measured on 0.149.1).
// The brackets around `[limits]` are **not part of the real output** — the header is spliced so this
// comment is not itself a trigger, the same notation LIMIT_RE's comment uses and for the same reason:
// a hit here does not merely roll, it types a number into the session. repoSelfTrigger.test.ts runs
// this scanner over the whole repo to keep it that way. Only the header is broken; without it the
// item lines below cannot match on their own.
//
//   Approaching rate [limits]
//   Switch to gpt-5.6-luna for lower credit usage?
//     1. Switch to gpt-5.6-luna              Fast and affordable agentic coding model.
//   ❯ 2. Keep current model
//     3. Keep current model (never show again)   Hide future rate limit reminders …
//   Press enter to confirm or esc to go back
//
// Left unanswered it stops the session at an input prompt — for an unattended worker, forever. The
// same problem the claude side solves by pressing the wait item (answerLimitChoice in rolling.ts).
//
// **Which item we press is a product decision, so it is written down here.** We press "Keep current
// model": switching the model changes the work product behind the user's back, and the "never show
// again" variant writes a codex preference nobody asked to change. Keeping the model and dismissing
// the prompt is the only answer that changes nothing — the app's own answer to a limit is to wait for
// the reset or move to another account, never to quietly become a different agent.
const APPROACHING_RE = /approaching\s+rate\s+limits/i
const KEEP_MODEL_RE = /keep\s+current\s+model/i
const NEVER_AGAIN_RE = /never\s+show\s+again/i

/** The number of the "keep current model" item on codex's rate-limit prompt, or null when this screen
 *  is not that prompt, the item is missing, or the list renders without numbers (nothing can be
 *  pressed blind — the same rule as findWaitChoice). The header is required so that the label alone,
 *  appearing in ordinary agent output, cannot make us type into a session. */
export function findKeepModelChoice(text: string): number | null {
  const clean = stripAnsi(text)
  if (!APPROACHING_RE.test(clean)) return null
  return findChoiceNumber(clean, KEEP_MODEL_RE, NEVER_AGAIN_RE)
}

/** Watches PTY output for that prompt and reports which number to press. Keeps a tail for the same
 *  reason CodexLimitScanner does — the header and the item can land in different chunks — and clears
 *  it on a match so one screen is answered once. */
export class CodexModelChoiceScanner {
  private tail = ''

  push(chunk: string): number | null {
    this.tail = (this.tail + stripAnsi(chunk)).slice(-TAIL_MAX)
    const n = findKeepModelChoice(this.tail)
    if (n === null) return null
    this.tail = ''
    return n
  }

  /** Is the prompt still on screen, unanswered? **Why no second screen buffer is needed**: this
   *  tail already holds exactly that state — push clears the tail the instant it answers the prompt,
   *  so a header still sitting in the tail means exactly "it appeared and could not be answered" (no
   *  item number was found). This has to be asked before typing into a live session — Enter approves
   *  whatever item is highlighted. */
  pending(): boolean {
    return APPROACHING_RE.test(this.tail)
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
  if (state.reachedType !== null) return true // (1) structured primary signal — never observed firing (see limitErrorOf)
  if (state.error !== null) return true // (1b) the structured signal codex actually emits
  return opts.textHit // (2) confirmed phrase — independent of usage
}

/** Any window at 100% or above — the usage condition of fallback decision (3) */
export function maxedOut(state: CodexLimitState | null): boolean {
  if (!state) return false
  return windows(state).some((w) => w.usedPercent >= 100)
}

/** The latest reset among the windows at or above the gate. If both are blocked, both have to clear
 *  before the account is usable, hence max. Falls back to priorReset — the reset this conversation
 *  already knew about before the session attached — when no window answers, which is the normal case
 *  for a resumed session: the snapshot carrying the reset was written before it attached, and the only
 *  snapshot it sees afterwards is the window-less credit record.
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
  if (!cand.length) return state.priorReset ?? { at: null, weekly: false }
  const worst = cand.reduce((a, b) => (b.at > a.at ? b : a))
  return { at: worst.at, weekly: worst.weekly }
}

/** What the file already told us, for a session that has not written anything of its own yet.
 *
 *  **Why this exists.** limitReached returns false on a null state — a resumed session's state is null
 *  until codex appends a rate_limits record, and those ride on turn completion. A session that is
 *  *already* at its limit can never finish a turn, so it can never produce the snapshot that would let
 *  its own limit be believed: rolling dies for exactly the sessions that need it (measured 2026-08-27,
 *  three resumes of one conversation, every one logging that the phrase was ignored).
 *
 *  **Why the recovered reset is the right evidence.** readPriorReset takes it through worstResetAt,
 *  which only reads the reset of a window at or above the gate. A session that was working never
 *  contributes one. So the value's presence already means "this conversation ended blocked, and it
 *  clears at T" — no timer guess is needed to tell that from a redraw.
 *
 *  **Why a past reset makes a phrase a replay.** `codex resume` redraws the previous conversation
 *  through the PTY, old limit error line included. If the reset we recovered has passed, the block is
 *  over and the phrase on screen is that old line — believing it rolls a session that is fine (measured:
 *  a detection at primary=0% right after a resume, then an unneeded in-place resume 60s later). This is
 *  what claude's inReplayGrace does with a timer; here the file answers it.
 *
 *  Once the session writes its own record the coordinator stops asking this — the normal verdicts take
 *  over, unchanged. */
export type PriorLimitVerdict =
  | { kind: 'limited'; at: number | null; weekly: boolean }
  | { kind: 'replay' }
  | { kind: 'none' }

export function priorLimitVerdict(
  prior: { at: number; weekly: boolean } | null,
  opts: { textHit: boolean },
  now: number
): PriorLimitVerdict {
  // `<= now` is expiry — the same convention blockedUntil/pickAvailable use in retry.ts
  if (prior && prior.at > now) return { kind: 'limited', at: prior.at, weekly: prior.weekly }
  if (prior) return opts.textHit ? { kind: 'replay' } : { kind: 'none' }
  // No prior block on record: this conversation has never been limited here, so there is no old error
  // line to redraw and a confirmed phrase is the only evidence there is. The reset time is unknown —
  // planRetry's fallback interval covers that.
  return opts.textHit ? { kind: 'limited', at: null, weekly: false } : { kind: 'none' }
}
