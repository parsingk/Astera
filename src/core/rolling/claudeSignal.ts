// Reads the limit-hit signal out of a claude transcript. A pure module — no timers, no side effects.
// Symmetric with CodexRolloutTail in codexSignal.ts, but what it reads differs: codex looks at the
// rate_limits snapshot (usage) carried in the rollout, whereas claude looks at the error entries recorded
// in the transcript.
//
// Why this signal is used, in contrast to what the statusLine path ran into:
//   statusLine stops updating once the session halts at an input wait, and its usage figures freeze at a
//   stale value. The transcript is append-only, so it cannot freeze that way. And a main-loop limit is
//   structured in the error field, so the verdict does not wobble when the phrase changes — the silent
//   failure of a phrase regex was the cause of that earlier bug.
import { JsonlTail } from './jsonlTail'
import { matchesLimitPhrase } from './detect'

const EXCERPT_MAX = 200 // the cap on the excerpt used for logs — the full original is never leaked into the log

/** The limit-hit signal read from a transcript. It does not carry the reset time or scope — the
 *  statusLine path (recordRecovery in rolling.ts) already does that, and it is sturdier than parsing a
 *  time out of the phrase. */
export interface ClaudeLimitHit {
  at: number // the entry's timestamp (ms)
  source: 'main' | 'subagent' // which verdict rule fired — for logs and calibration
  text: string // an excerpt of the original
}

function excerpt(s: string): string {
  return s.length > EXCERPT_MAX ? s.slice(0, EXCERPT_MAX) + '…' : s
}

/** The entry's timestamp (ms). null when it is absent or unparseable — without a time there is nothing to
 *  compare against since, and in that case ignoring it is the safe direction (not firing beats firing
 *  wrongly). */
function timestampOf(o: Record<string, unknown>): number | null {
  if (typeof o.timestamp !== 'string') return null
  const t = Date.parse(o.timestamp)
  return Number.isFinite(t) ? t : null
}

/** Joins the text of an assistant entry — for the excerpt */
function assistantText(o: Record<string, unknown>): string {
  const msg = o.message
  if (typeof msg !== 'object' || msg === null) return ''
  const content = (msg as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  return content
    .filter((c): c is { type: string; text: string } => {
      if (typeof c !== 'object' || c === null) return false
      const x = c as { type?: unknown; text?: unknown }
      return x.type === 'text' && typeof x.text === 'string'
    })
    .map((c) => c.text)
    .join(' ')
}

// The API error envelope of a subagent termination (found by re-checking 4,706 real transcripts).
// The whole of tool_result.content used to be tested against LIMIT_RE, which also bites when a tool's
// output happens to quote or reproduce the phrase — 5 of the 9 measured cases were false positives on this
// path: an old_string echoed back by a failed Edit (a failure while editing a file that contains the
// phrase), the regex source echoed back by a SyntaxError from node -e, and the test title printed by a
// failed vitest run (the phrase interpolated at runtime). All four are ordinary tool failures with nothing
// to do with whether this session hit a limit.
// A real limit termination carries its cause only after this prefix:
// `Agent terminated early due to an API error: <cause>`.
// Only the <cause> part may be tested against LIMIT_RE — however long the tool output before or after the
// prefix is, it is ignored.
// Never anchor at the start of the string (^): whitespace can precede it, and the variant in the
// toolUseResult field carries one extra layer of "Error:" — `Error: Agent terminated early…`. That field
// is not read here (the narrowness below is kept), but the same prefix rule is allowed to match that
// variant too, so it does not conflict with it.
const SUBAGENT_ERROR_ENVELOPE_RE = /^\s*(?:Error:\s*)?Agent terminated early due to an API error:\s*/i

/** The subagent termination causes that are limits. There is no error field, so they can only be sifted by
 *  the phrase. But the phrase is looked for only in the <cause> after this envelope — the measurements in
 *  the SUBAGENT_ERROR_ENVELOPE_RE comment above are the reason. A tool_result without the envelope is
 *  excluded from the verdict, limit or not. */
function subagentLimitText(o: Record<string, unknown>): string | null {
  const msg = o.message
  if (typeof msg !== 'object' || msg === null) return null
  const content = (msg as { content?: unknown }).content
  if (!Array.isArray(content)) return null
  for (const c of content) {
    if (typeof c !== 'object' || c === null) continue
    const x = c as { type?: unknown; is_error?: unknown; content?: unknown }
    if (x.type !== 'tool_result' || x.is_error !== true) continue
    // content that is not a plain string (an array form, for instance) is not examined — this narrowness is
    // protective (every measured false positive was on the plain-string path). Do not widen it here.
    const text = typeof x.content === 'string' ? x.content : ''
    const m = SUBAGENT_ERROR_ENVELOPE_RE.exec(text)
    if (!m) continue // no envelope — even with the phrase present this is a false-positive candidate, so skip it
    if (matchesLimitPhrase(text.slice(m[0].length))) return text
  }
  return null
}

/** Pulls the limit signal out of one transcript line. null when it is not a limit or has a different shape.
 *  A public API — the orchestration limit probe (main/orchestration/limitProbe.ts) reuses it.
 *  The body of this function (including the false-positive defences) is unchanged — widening or narrowing
 *  it away from what the 9 measured cases justify is a regression. */
export function parseClaudeLimitLine(raw: string): ClaudeLimitHit | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw)
  } catch {
    return null // defensive parsing — a broken line is ignored
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null
  const o = obj as Record<string, unknown>
  const at = timestampOf(o)
  if (at === null) return null
  // ① The main loop — the error field pins down the kind. apiErrorStatus is not used for the verdict (the
  //    server may change it, and error alone is enough).
  if (o.type === 'assistant' && o.error === 'rate_limit')
    return { at, source: 'main', text: excerpt(assistantText(o)) }
  // ② The subagent — there is no structured field, so it is sifted by the phrase
  if (o.type === 'user') {
    const text = subagentLimitText(o)
    if (text !== null) return { at, source: 'subagent', text: excerpt(text) }
  }
  return null
}

/** The incremental tail of one transcript file. Entries earlier than since (or at exactly that time) are
 *  ignored.
 *
 *  Why since is needed: a roll copies the transcript over to the new account, and a history resume takes
 *  over an existing transcript. In both cases the file holds old limit errors, and the since filter
 *  excludes them.
 *
 *  Why JsonlTail is used with `startAtEnd: true`: without that option it starts at offset 0 and the first
 *  read consumes the whole file — this class is always constructed with since=now, so every entry already
 *  in the file is discarded by the since filter anyway, yet before making that call it would read up to
 *  37MB (the largest transcript measured) in one go and stringify, split and JSON.parse all of it — on the
 *  Electron main thread, every time a tail is created, and again on every roll. Skipping that read with
 *  `startAtEnd` is a pure optimisation that does not change the result (no pre-existing entry could pass
 *  since). The default (false) is left alone — CodexRolloutTail and CodexTurnWatcher do not use this
 *  option, so they are unaffected, and the `restarted` path is already made safe by the since filter and
 *  needs no changes. */
export class ClaudeTranscriptTail {
  private tail: JsonlTail
  // Whether the last read() ended in a JsonlTail error (a missing file, permissions and so on) — read()'s
  // own return value does not distinguish that from "no hit" (the caller intervenes in neither case), so
  // this is a separate window for a caller that wants to log it. It is false until read() has been called
  // at least once.
  private failed = false

  constructor(
    filePath: string,
    private since: number
  ) {
    this.tail = new JsonlTail(filePath, { startAtEnd: true })
  }

  /** The latest of the limit entries that have appeared since the last call. null when there is none.
   *  A missing file or an error is also null — the caller has no need to distinguish that from "none" (it
   *  intervenes in neither case).
   *  "No need to distinguish" is a statement about the verdict logic — if the learned path is wrong or
   *  becomes unreadable the primary signal dies quietly, and noticing that is the log's job, so it is
   *  exposed separately as `readFailed`. */
  async read(): Promise<ClaudeLimitHit | null> {
    const r = await this.tail.read()
    this.failed = !r
    if (!r) return null
    let latest: ClaudeLimitHit | null = null
    for (const line of r.lines) {
      const hit = parseClaudeLimitLine(line)
      if (!hit || hit.at <= this.since) continue
      if (!latest || hit.at > latest.at) latest = hit
    }
    return latest
  }

  /** Whether the last read() call ended in a file-access failure */
  get readFailed(): boolean {
    return this.failed
  }
}
