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
 *  the reset is taken — see the field's doc comment for why the usage figures are left behind.
 *
 *  **This one is deliberately loose and must stay that way.** Its consumer is worstResetAt's fallback,
 *  which answers "if this session turns out to be blocked, when does the block clear" — a question only
 *  asked once some other signal has already decided that it *is* blocked. So reporting the reset of any
 *  window at or above the gate is right here. It is **not** enough to decide the "is it blocked" part;
 *  priorBlockAt below is the one for that, and the two are kept separate so neither bends to the other. */
async function readPriorReset(filePath: string): Promise<{ at: number; weekly: boolean } | null> {
  const lines = await tailLines(filePath)
  if (!lines) return null
  const seeded = limitStateFromLines(lines, 0)
  const reset = worstResetAt(seeded)
  return reset.at === null ? null : { at: reset.at, weekly: reset.weekly }
}

/** Index of the limit record the tail **ends** on, or null when it does not end on one.
 *
 *  **Why this walks backwards instead of asking the accumulated parse.** limitStateFromLines never
 *  clears `error` within one batch, so parsing the whole tail and then reading `error` answers "a block
 *  appears somewhere in these 512KB", which is a different question. A conversation that hit its limit
 *  in the morning, waited it out and worked back up to 91% would answer yes — and reopening it would
 *  park a healthy session in a phraseless wait of up to a window's length, and write a block for a
 *  healthy account into the shared registry where every other chain honours it. Measured on a probe:
 *  `[100% with a past reset, usage_limit_exceeded, 95% with a future reset]` handed back the future
 *  reset. The rule this implements is "accept the limit signal only when no ordinary windowed snapshot
 *  follows it", and walking from the end is simply the cheap way to evaluate it.
 *
 *  Three record shapes matter, and the parser above is what decides which is which:
 *   - a `usage_limit_exceeded` on task_complete (limitErrorOf), or a token_count whose
 *     rate_limit_reached_type is a string — **the turn was refused**, so the tail ends blocked.
 *   - a token_count carrying at least one real window (parseWindow) — rate_limits ride only on
 *     token_count and those are written when a turn *completes*, so the conversation worked after
 *     whatever came before it, and any earlier block is over.
 *   - anything else says nothing either way and is skipped. **The windowless credit-balance snapshot
 *     lives here, and that is the trap**: codex emits it (`limit_id: "premium"`, every window null)
 *     0.8s after the plan snapshot at the very moment a limit hits — measured, and the same record
 *     limitStateFromLines carries windows forward across. It is therefore often the *last* line in a
 *     blocked rollout, and reading it as "an ordinary snapshot" would answer "not blocked" for exactly
 *     the conversations this exists for. Ordinary noise (reasoning items, messages, session_meta, a
 *     clean task_complete) is skipped by the same clause. */
function lastBlockIndex(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = parseLine(lines[i])
    if (!line) continue
    if (limitErrorOf(line, 0)) return i // the `at` is discarded — only "is this the signal" is asked
    const rl = rateLimitsOf(line.payload)
    if (!rl) continue
    if (typeof rl.rate_limit_reached_type === 'string') return i
    if (parseWindow(rl.primary) || parseWindow(rl.secondary)) return null // a turn completed after it
  }
  return null
}

/** The block a rollout **ended on**, for the verdict a resumed session has to make before it has
 *  written anything of its own (priorLimitVerdict). null when the tail does not end on one.
 *
 *  **Why a usage percentage cannot answer this question, in either direction.** readPriorReset above
 *  reports the reset of any window at or above GATE_PCT, and that gate is 90, not 100 — so a
 *  conversation whose last snapshot read 91% (busy, not blocked) hands one back, and reopening it would
 *  park the session in a wait with no phrase at all. Raising the gate to 100 fails the other way, for
 *  the reason limitReached's comment already records: when the limit refuses a request no new
 *  token_count comes out, so a genuinely blocked account's last snapshot sits wherever the last
 *  *completed* turn left it, which can be well under 100. A percentage is a fact about consumption;
 *  "the turn was refused" is an event, and only the event answers "did this conversation end blocked".
 *
 *  So the answer comes from the structured signals, and from the **end** of the tail — see
 *  lastBlockIndex for which record shapes decide and why the position matters as much as the presence.
 *  The reset is then read off the records up to and including that one, through the shared assembly
 *  rule, so the windows the refusal was recorded alongside are the ones that answer (and the credit
 *  snapshot riding behind it cannot erase them).
 *
 *  A block whose reset cannot be read answers null, exactly as no block does: with no reset instant
 *  there is nothing to wait for and no way to tell a live block from a redraw, so the verdict falls
 *  back to needing a confirmed phrase, and planRetry's blind interval covers the wait. */
export async function priorBlockAt(
  filePath: string
): Promise<{ at: number; weekly: boolean } | null> {
  const lines = await tailLines(filePath)
  if (!lines) return null
  const end = lastBlockIndex(lines)
  if (end === null) return null
  const reset = worstResetAt(limitStateFromLines(lines.slice(0, end + 1), 0))
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

/** Finds the limit phrase in PTY output. Decision (2) — the phrase on its own — is retired, so what
 *  reads this now is the ignored-phrase log and priorLimitVerdict (see limitReached). Chunks are cut at arbitrary
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

/** Limit-reached decision (1) — the structured signal. Decision (2), the confirmed phrase taken on its
 *  own, is retired (2026-08-28): over one day of rolling.log the phrase-only branch never caught a real
 *  limit — **every** phrase-only detection was false (5 of 5), each a redraw of an earlier episode's
 *  screen text at 0-1% usage, while every real limit came through the structured signal at 99-100%.
 *  (The log is live and its structured count keeps growing; the load-bearing figure is that the
 *  phrase-only tally was 0 for 5, not the day's total.) (3) (100% + no output) needs a time condition, so the
 *  coordinator handles that one via maxedOut.
 *
 *  **What a false positive cost, measured.** Three of the five landed within two minutes of a legitimate
 *  in-place resume. Two of those had to respawn: the resume just before them had already spent that
 *  episode's one in-place attempt (inPlaceUsed in codexRolling.ts), so resumeAfterWait took the kill
 *  path and the log reads `did not recover — falling back to respawn` then `codex rolled`. The other
 *  three typed the resume line into a session that was working. So the cost was not a wasted timer.
 *
 *  Why the structured signal still has no usage gate: rate_limits rides only on `token_count` events, and
 *  those are recorded only once a turn completes. When the limit rejects a request no new token_count
 *  comes out, so usage stops at a low value — and a gate would then block the legitimate structured
 *  signal at exactly that moment. Claude's statusLine is no different: the instant the limit blocks,
 *  statusLine itself stops updating (measured: 0 updates over 88s of idle). GATE_PCT in rolling.ts was
 *  removed as a phrase gate for that same reason. The two providers are **no longer symmetric** on the
 *  phrase, though: codex does not accept one at all, while claude still does — gated on a direct
 *  account-usage lookup rather than on a snapshot (see onLimitCandidate in rolling.ts, which explains
 *  why claude cannot retire the phrase: a subagent limit has no structured field to fall back on).
 *
 *  What is no longer true is the old closing claim that false-positive defence was carried by the
 *  scanner's narrowed LIMIT_RE rather than a gate — the field data falsified that: all 5 false positives
 *  came through the scanner.
 *
 *  **A grace window was measured, not assumed, and it does not fit.** Anchoring a 60-second window on
 *  the resume (the size of rolling.ts's REPLAY_GRACE_MS) would have suppressed 2 of the 5: the two that
 *  arrived 27 and 37 seconds after an in-place resume. It would have missed the third resume-adjacent
 *  one at 118 seconds, and both of the two that followed a rollout *attach* rather than a resume (44
 *  seconds and ~18 minutes) — a window anchored on a resume never opens for those. inReplayGrace's
 *  usage escape hatch would not have rescued any of them either: all five read 0-1%. Widening the
 *  window until it covers 118 seconds and an attach would also swallow a genuine limit landing soon
 *  after a switch, which is the case inReplayGrace's own comment records as measured.
 *
 *  The phrase is not gone. priorLimitVerdict — the verdict for a resumed session before it has written a
 *  rate_limits record of its own — still reads it. Usually to corroborate a structured record recovered
 *  from the rollout file; but **one branch there does let the phrase stand alone** — a reopened
 *  conversation whose file records no block at all has nothing else to go on, and that function's own
 *  comment already calls it the weakest evidence in the design. Retiring decision (2) did not touch it,
 *  and it is the one remaining way a phrase can reach onLimit. And an ignored phrase still logs (see
 *  evaluate's `if (chain.textHit)` branch in codexRolling.ts), so the distribution stays visible to
 *  whoever next has reason to revisit this.
 *
 *  **A null state means "unknown," not "not limited."** That is the normal condition of a session
 *  reopened from history, before its own tail has written a rate_limits record of its own, and a
 *  session that is already at its limit can never leave it — the record that would clear the null comes
 *  from a turn completing, and a blocked turn never completes. `if (!state) return false` below stays
 *  exactly as it is: it was never wrong, it simply has nothing of its own to decide the reopened-session
 *  case with, and it no longer has to — the coordinator now branches before ever reaching this function,
 *  consulting priorLimitVerdict instead for as long as state is null. This function's own contract —
 *  decide only from this session's own recorded state — is unchanged. */
export function limitReached(state: CodexLimitState | null): boolean {
  if (!state) return false
  if (state.reachedType !== null) return true // (1) structured primary signal — never observed firing (see limitErrorOf)
  return state.error !== null // (1b) the structured signal codex actually emits — the only one measured to fire
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
 *  **Why the recovered block is the right evidence — and what it must be read from.** `prior` has to
 *  come from priorBlockAt, which reports a reset only when the tail carries a structured limit signal.
 *  A usage percentage cannot stand in for that: the gate readPriorReset uses is 90, so a conversation
 *  that was merely busy at 91% would hand back a reset and park the reopened session in a wait with no
 *  phrase at all. With the structured signal required, the value's presence means "this conversation
 *  ended on a refused turn, and the window it was refused in clears at T" — no timer guess is needed to
 *  tell that from a redraw.
 *
 *  **Why a past reset makes a phrase a replay.** `codex resume` redraws the previous conversation
 *  through the PTY, old limit error line included. If the reset we recovered has passed, the block is
 *  over and the phrase on screen is that old line — believing it rolls a session that is fine. This is
 *  what claude's inReplayGrace does with a timer; here the file answers it.
 *
 *  **The reach of this rule is narrow, deliberately.** It covers only the window before the resumed
 *  session's first snapshot of its own. A false positive that logs a usage figure (`primary=0%`) is by
 *  definition past that window — a figure only prints when the state is non-null — so it came through
 *  the ordinary phrase path — retired in 2026-08-28 (see limitReached), which is why that variant
 *  cannot recur. All five measured false positives printed a figure, which is the evidence they came
 *  from there and not from here. This branch was deliberately left standing.
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
  // planRetry's fallback interval covers that. **This branch is the weakest evidence in the design**:
  // the premise covers codex's own error line, but the scanner reads the whole redraw, so an agent's own
  // output or a quoted log carrying a limit-shaped sentence lands here too. That is why its consumer
  // keeps a verdict with at === null out of the shared block registry — the wait is this chain's alone
  // (judgedByPriorBlock in codexRolling.ts).
  return opts.textHit ? { kind: 'limited', at: null, weekly: false } : { kind: 'none' }
}
