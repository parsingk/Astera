// Detects limit-reached and the folder-trust dialog in PTY output. A phrase can be cut at a chunk
// boundary, so the scanner keeps a tail of the stripped text and tests the concatenation. Pure
// module — main wires it up.

// Removes CSI (\x1b[...cmd), OSC (\x1b]...BEL|ST) and standalone ESC sequences. Not a full
// xterm-grade parser, but enough for the purpose of phrase detection.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b](?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

// The limit phrasing as observed in Claude Code 2.1.220. On screen it reads "You've hit your <label>",
// where the label names the window that ran out:
//   five_hour → "session limit"   seven_day → "weekly limit"   opus → "Opus limit"
//   sonnet → "Sonnet limit"       overage-included → "Fable 5 limit"   overage → "usage credit limit"
// The previous regex required a trailing `reached`, so it bit none of these phrases, and as a result
// the phrase-detection path had never fired once since release (verified across all of rolling.log).
// The "... limit reached" form still exists in API error messages and in other versions, so it is
// kept alongside.
// Narrowing the window names down to an enumeration is the crux — catching a broad `limit reached`
// alone also bites unrelated phrases like "Subagent spawn limit reached" and "Context limit
// reached", which misfires a roll. The gate has been removed, so this specificity takes over
// false-positive defence.
// The apostrophe class allows both the straight quote and the typographic one ('’') (same rule as
// codexSignal.ts).
// 'Approaching ...' (the advance warning) has neither hit|reached nor the reached suffix, so it does
// not match.
/** Whitespace removed entirely — the form the PTY-screen patterns are matched against.
 *
 *  A TUI does not repaint a boxed, wrapped panel by writing spaces. It writes a word, emits a
 *  cursor-move escape, writes the next word. stripAnsi removes the escape and leaves nothing behind,
 *  so the words arrive concatenated. rolling.log caught it verbatim: the folder-trust dialog reached
 *  the scanner as "Thesewillapplywithoutasking.Onlyproceedifyoutrustthisconfiguration." — every
 *  inter-word space gone. Ordinary lines on the same screen keep their spaces, so both renderings
 *  coexist and a screen pattern has to survive either.
 *
 *  A literal space and \s+ are both defeated by this (each demands at least one character that is not
 *  there), and \s+ was in fact defeated in production: an unrecognised trust dialog let the post-roll
 *  fallback type the carry-on prompt into the dialog. Squashing the haystack and the pattern together
 *  is the only form that matches all three renderings — spaced, soft-wrapped, escape-separated. */
function squash(s: string): string {
  return stripAnsi(s).replace(/\s+/g, '')
}

// The limit phrasing as observed in Claude Code 2.1.220. On screen it reads "You've hit your <label>",
// where the label names the window that ran out:
//   five_hour → "session limit"   seven_day → "weekly limit"   opus → "Opus limit"
//   sonnet → "Sonnet limit"       overage-included → "Fable 5 limit"   overage → "usage credit limit"
// The previous regex required a trailing `reached`, so it bit none of these phrases, and as a result
// the phrase-detection path had never fired once since release (verified across all of rolling.log).
// The "... limit reached" form still exists in API error messages and in other versions, so it is
// kept alongside.
// Narrowing the window names down to an enumeration is the crux — catching a broad `limit reached`
// alone also bites unrelated phrases like "Subagent spawn limit reached" and "Context limit
// reached", which misfires a roll. The gate has been removed, so this specificity takes over
// false-positive defence.
// The apostrophe class allows both the straight quote and the typographic one ('’') (same rule as
// codexSignal.ts).
// 'Approaching ...' (the advance warning) has neither hit|reached nor the reached suffix, so it does
// not match.
// The word gaps are \s+ rather than a literal space, so a soft-wrapped "You've hit your\r\nsession
// limit" still matches. This is the form used on ordinary prose — transcript text and the log masking
// below, both of which carry real spaces.
const LIMIT_RE =
  /you(?:['’ʼ`])?ve\s+(?:hit|reached)\s+your\s+(?:session|weekly|Opus|Sonnet|Fable\s+5|usage\s+credit)\s+limit|(?:usage|5-hour|session)\s+limit\s+reached/i
// The same phrase with every gap removed, for squash()ed screen text. Kept beside LIMIT_RE rather
// than derived from it: deriving would mean rewriting \s+ into nothing at runtime, which is the kind
// of cleverness that hides a divergence instead of preventing one. The pair is covered by a test that
// feeds both renderings of the same sentence.
const LIMIT_SQUASHED_RE =
  /you(?:['’ʼ`])?ve(?:hit|reached)your(?:session|weekly|Opus|Sonnet|Fable5|usagecredit)limit|(?:usage|5-hour|session)limitreached/i
// The folder-trust dialog. Trust is only ever asked of screen text, so this has no spaced twin.
//
// It is anchored on the **choice label**, not on the question, because the question is the part that
// changes. Claude Code once asked "Do you trust the files in this folder?"; the wording observed in
// production is now a paragraph — "Quick safety check: Is this a project you created or one you
// trust? … Claude Code'll be able to read, edit, and execute files here." — with nothing of the old
// sentence left. Matching that prose would mean re-chasing it at every rewrite. "Yes, I trust this
// folder" is the option we actually press, so it is both the most stable string on the screen and the
// one whose disappearance would genuinely mean the dialog changed. The old question stays as an
// alternative for versions that still ask it.
const TRUST_RE = /yes,itrustthisfolder|doyoutrustthefilesinthisfolder/i

export interface ScanHit {
  limit: boolean
  trust: boolean
  /** The stripped text accumulated up to the moment of the match (the value before the buffer is
   *  cleared). For callers that need to know "what it was looking at when it bit", such as parsing
   *  the choice list. With no match, this is the currently accumulated tail as-is.
   *  Why there is no separate accessor: push clears the buffer on a match, so reading after the call
   *  always gives an empty string, and even if the caller concatenates the current chunk, the choice
   *  list that was in the earlier chunk is already gone. */
  text: string
}

/** One instance per session. Each push reports true only for newly matched signals — the buffer is cleared on a match to stop the same phrase from matching repeatedly. */
export class OutputScanner {
  private tail = ''

  push(chunk: string): ScanHit {
    this.tail = (this.tail + stripAnsi(chunk)).slice(-2000)
    // Both renderings are tried: the spaced pattern for ordinary lines, the squashed one for the
    // escape-separated panels. Testing only the squashed form would be enough in principle, but the
    // spaced pattern is the one every other caller uses and keeping it in the path means a change
    // there cannot silently stop applying to the screen.
    const squashed = squash(this.tail)
    const limit = LIMIT_RE.test(this.tail) || LIMIT_SQUASHED_RE.test(squashed)
    const trust = TRUST_RE.test(squashed)
    const text = this.tail // capture before clearing — so the caller can re-parse what the match was based on
    if (limit || trust) this.tail = ''
    return { limit, trust, text }
  }
}

// Label of the "wait" item in the limit-reached choice list. The bundle's choice array is
//   [{id:"adjust", label:`Adjust monthly spend limit: ${…}`},
//    {id:"wait",   label:"Wait for limit to reset"},
//    {id:"upgrade", label:`Upgrade to ${Max|Max 20x} …`}]  <- upgrade is conditional
// and the number of items varies with the account state. Pinning the number could press adjust
// (adjust the spend limit) by mistake, so we find it by label and use only the number on that line.
// **The label is no longer the first thing after the number.** Observed 2026-08-26 on a managed
// (admin-controlled) plan, the list reads:
//   1. Stop and wait for limit to reset
//   2. Wait here, then continue automatically shortly
//   3. Ask your admin for more usage
// The old form required the label immediately after "N." and so found no number at all on that screen
// — measured in rolling.log as `limit choice not found` with waitPhrase=true, after which nothing is
// pressed and the dialog stays up forever.
//
// Note item 2: **the CLI now offers to wait and continue by itself.** Whether to prefer that over
// pressing the wait item is a product decision and is deliberately not made here — this code keeps
// pressing the wait item, which is the choice the app's own waiting and resuming is built around.
const WAIT_LABEL = 'Wait for limit to reset'
// The label-only variant — it exists to separate "the list was on screen but the numbering differs"
// from "the list had not arrived yet" in the log when no number is found. Sharing WAIT_LABEL removes
// any room for the two regexes to drift apart — the same convention as maskLimitPhrase reusing
// LIMIT_RE.source.
const WAIT_LABEL_RE = new RegExp(WAIT_LABEL, 'i')

/** Finds the number of the wait item on the limit choice screen.
 *  null for a rendering with no numbers (an arrow-key-only UI) — the caller then types nothing,
 *  because we cannot know the cursor position and so cannot judge how many steps to move with the
 *  arrow keys.
 *
 *  **The number is taken from the item the label belongs to, not from the label's neighbourhood.**
 *  It walks the line carrying the label and uses the *nearest* "N." to its left. That is what makes
 *  it survive a prefix ("1. Stop and wait for limit to reset") while still refusing the two cases the
 *  old form was written to refuse:
 *    - the label with no number on its line (an arrow-key-only UI) — nothing to the left, so null;
 *    - a number on the *preceding* line, e.g. "…spend limit: $50." — a different line, never read.
 *  Taking the nearest rather than the first also fixes a case the old regex got wrong: with two items
 *  rendered on one line it would have returned the *first* number, i.e. pressed adjust (raise the
 *  spend limit) instead of wait. */
export function findWaitChoice(text: string): number | null {
  return findChoiceNumber(text, WAIT_LABEL_RE)
}

/** The rule above, with the label left to the caller. Shared with the codex side (findKeepModelChoice
 *  in codexSignal.ts), which needs the same "nearest N. to the left of the label" reading of a menu.
 *  `exclude` skips a line even when it carries the label — codex renders two items whose labels are
 *  prefixes of each other, and only one of them may be pressed. */
export function findChoiceNumber(text: string, labelRe: RegExp, exclude?: RegExp): number | null {
  for (const line of stripAnsi(text).split('\n')) {
    if (exclude?.test(line)) continue
    const at = line.search(labelRe)
    if (at < 0) continue
    const numbered = line.slice(0, at).match(/\d+[ \t]*[.)]/g)
    if (!numbered) continue
    const digits = /\d+/.exec(numbered[numbered.length - 1])
    if (!digits) continue
    const n = Number(digits[0])
    if (Number.isInteger(n) && n > 0) return n
  }
  return null
}

/** Does this text carry the "wait" choice label — the number is not considered.
 *  Used only to record in the log why findWaitChoice returned null. */
export function hasWaitChoiceLabel(text: string): boolean {
  return WAIT_LABEL_RE.test(stripAnsi(text))
}

// The footer a modal draws under its choices — "Enter to confirm · Esc to cancel". Both halves are
// required, which is what separates a dialog from the "esc to interrupt" hint shown while the agent
// is merely working. Matched on squashed text, since this footer sits inside the panel that renders
// without spaces.
const CHOICE_FOOTER_RE = /entertoconfirm/i
const CHOICE_CANCEL_RE = /esctocancel/i
// The spaced rendering of the same thing: a cursor sitting on a numbered item. Kept alongside the
// footer because a dialog that draws its list plainly has real spaces and real lines, and the cursor
// is what tells it apart from a numbered list in ordinary agent output. Both cursor glyphs are
// accepted — the trust dialog draws a plain ">" where the limit list draws "❯".
const CHOICE_CURSOR_RE = /^[^\S\n]*[❯>][^\S\n]*\d+[ \t]*[.)][ \t]*\S/m

/** Is an interactive choice list waiting for input on this screen? The automatic prompt after a roll
 *  asks this before typing blind: a dialog we failed to recognise (an unknown wording, a new kind of
 *  prompt) swallows the carry-on text and turns the following Enter into an arbitrary menu press.
 *  Answering "something is waiting" is enough to stop — knowing *what* is waiting is not needed. */
export function looksLikeChoicePrompt(text: string): boolean {
  const squashed = squash(text)
  if (CHOICE_FOOTER_RE.test(squashed) && CHOICE_CANCEL_RE.test(squashed)) return true
  return CHOICE_CURSOR_RE.test(stripAnsi(text))
}

/** Does this text contain a limit-reached phrase? Used by transcript's subagent error decision
 * — that side has no structured error field, so the phrase is the only way to tell it apart.
 *  Why the regex is not exported directly: a caller should never have to care about flags or lastIndex. */
export function matchesLimitPhrase(text: string): boolean {
  return LIMIT_RE.test(text)
}

// A variant with the global flag that replaceAll needs — it reuses LIMIT_RE.source verbatim so there
// is no room for the two regexes to drift apart.
const LIMIT_RE_G = new RegExp(LIMIT_RE.source, LIMIT_RE.flags.includes('g') ? LIMIT_RE.flags : LIMIT_RE.flags + 'g')

/** Masks limit-reached phrases in a text with a placeholder. For callers such as logs, which want to
 *  keep the diagnostic value of the original (why the choice could not be found) but must not carry a
 *  re-firing trigger — it shares its source with LIMIT_RE, so the phrase the scanner bites and the
 *  phrase this function masks cannot drift apart. RESET_RE (resetTime.ts) requires this phrase
 *  immediately before it, so masking this phrase also renders the reset clause left behind after it
 *  ("· resets …") harmless. */
export function maskLimitPhrase(text: string): string {
  return text.replace(LIMIT_RE_G, '[limit phrase]')
}
