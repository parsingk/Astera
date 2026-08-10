// The pure decisions and conversions that turn a Slack thread reply into session input.
//
// Everything that touches the SDK (@slack/socket-mode) is main/slackInbox.ts's job; only "should this
// message be injected" and "what should be written" live here — those two questions are where this
// feature's risk is concentrated (infinite loops, the wrong channel, newline handling), and being pure
// functions they can all be tested without a real connection.
import type { Message } from '../i18n'

/** Only the fields we look at on a Slack message event. Kept narrow so it is not tied to the SDK types. */
export interface InboundMessage {
  channel?: unknown
  text?: unknown
  thread_ts?: unknown
  ts?: unknown
  bot_id?: unknown
  subtype?: unknown
  /** Who sent it. Slack's UI calls this value the "Member ID" (profile → ⋯ → Copy member ID) and
   *  sends it in this `user` field — that is the pairing the memberId setting is compared against. */
  user?: unknown
}

export type InboundDecision =
  | { kind: 'inject'; threadTs: string; text: string }
  | { kind: 'ignore'; reason: IgnoreReason; threadTs?: string }

export type IgnoreReason =
  | 'bot-message' // posted by the bot itself — cuts the notify → receive → inject infinite loop
  | 'other-channel' // not the configured channel
  | 'member-id-unset' // no Member ID is configured — everything is blocked until one is (see classifyInbound)
  | 'not-allowed-user' // someone other than the configured Member ID
  | 'not-thread-reply' // not a thread reply, so which session it belongs to cannot be determined
  | 'subtype' // an edit, a delete and so on — not something the user actually said (file_share and thread_broadcast are exceptions — allowed)
  | 'empty-text'
  | 'too-long' // over MAX_INJECT_CHARS — rejected rather than truncated and sent (a partial command is more dangerous)

/** Cases where a subtype is present but the message is still something the user just said — these are
 *  not ignored.
 *  file_share: a reply sent along with a file, a screenshot for instance (it carries the text too).
 *  thread_broadcast: a thread reply sent with the "also send to channel" option — still a reply in that
 *  thread. */
const ALLOWED_SUBTYPES = new Set(['file_share', 'thread_broadcast'])

/** The maximum length of a reply injected at once. A Slack message body itself allows up to ~40,000
 *  characters, but a thread reply is a path meant for commands and prompt text, not for bulk pasting.
 *  A reply over the limit is rejected rather than truncated and sent — a truncated command turning into
 *  a different (yet plausible) command than the one intended is the more dangerous outcome (the same
 *  reasoning as "removing is safer than escaping" in commands.ts sanitizeResumePrompt). */
export const MAX_INJECT_CHARS = 4000

/**
 * Decides whether to inject this message. Why the ignore reason comes back as a value: it has to be in
 * the log for the user to learn "why isn't my reply landing", and each reason can be pinned down by a
 * test.
 *
 * `channelId` is the configured channel. If the bot is invited to other channels too, those channels'
 * messages arrive as events as well; they do get filtered indirectly by not being in the thread
 * mapping — but they are cut off here first. The control belongs in an explicit check rather than in
 * "it is not in the mapping, so it is safe as a consequence".
 *
 * `memberId` is the one Slack Member ID allowed to drive the session. The channel check alone is not a
 * permission boundary: anyone invited to that channel could reply in a thread and push input into
 * someone else's session. **A missing memberId blocks everything** rather than allowing everyone —
 * the safe direction for a value whose whole purpose is a permission check. It is passed as a required
 * parameter for the same reason: made optional, a caller that forgot the argument would silently fall
 * back to allowing the entire channel.
 */
export function classifyInbound(
  msg: InboundMessage,
  channelId: string,
  memberId: string | null
): InboundDecision {
  // The bot check comes first — cutting it off before any other condition is what leaves no loop risk
  if (typeof msg.bot_id === 'string' && msg.bot_id !== '') return { kind: 'ignore', reason: 'bot-message' }
  if (msg.channel !== channelId) return { kind: 'ignore', reason: 'other-channel' }
  // A message event with a subtype is mostly an edit (message_changed), a delete, a channel join and so
  // on. It is not something the user just typed, and an edit event's text sometimes carries the previous
  // content, so injecting it produces nonsense input. file_share and thread_broadcast are the
  // exceptions — both are replies the user really did send at that moment.
  if (
    typeof msg.subtype === 'string' &&
    msg.subtype !== '' &&
    !ALLOWED_SUBTYPES.has(msg.subtype)
  ) {
    return { kind: 'ignore', reason: 'subtype' }
  }
  // The sender check. It sits *after* the subtype check and *before* everything below, and both halves
  // of that position are deliberate.
  //
  // After subtype: an edit event (message_changed) carries its author in `message.user`, so the
  // top-level `user` is empty. Checked earlier, every edit would be logged as not-allowed-user and the
  // existing reason would stop meaning what it says.
  //
  // Before the thread and text checks: `too-long` is the only ignore path that posts a note back into
  // the thread. Were the sender check below it, anyone in the channel could make the bot answer them
  // with a reply over MAX_INJECT_CHARS.
  //
  // Unset and mismatched are separate reasons because the log is the only diagnosis surface here —
  // unset says "go set it", while mismatched carries the rejected id so a typo in one's own Member ID
  // can be fixed from that value. Trimmed on both sides; case is not normalised (Slack IDs are always
  // upper case, and a typo is diagnosed from the logged id).
  const allowed = memberId !== null ? memberId.trim() : ''
  if (allowed === '') return { kind: 'ignore', reason: 'member-id-unset' }
  const sender = typeof msg.user === 'string' ? msg.user.trim() : ''
  if (sender !== allowed) return { kind: 'ignore', reason: 'not-allowed-user' }
  const threadTs = typeof msg.thread_ts === 'string' ? msg.thread_ts : null
  // No thread_ts means it was written straight into the channel, and a thread_ts equal to ts means it is
  // the thread root itself — neither is a reply
  if (!threadTs || threadTs === msg.ts) return { kind: 'ignore', reason: 'not-thread-reply' }
  const rawText = typeof msg.text === 'string' ? msg.text : ''
  const text = unescapeSlackText(rawText).trim()
  if (text === '') return { kind: 'ignore', reason: 'empty-text' }
  if (text.length > MAX_INJECT_CHARS) return { kind: 'ignore', reason: 'too-long', threadTs }
  return { kind: 'inject', threadTs, text }
}

/**
 * Turns the notation Slack encodes for mrkdwn back into the text a human actually typed
 * — without this, `npm run build && npm test` arrives as
 * `npm run build &amp;&amp; npm test`, and `<https://x|docs>` gets injected with that syntax intact.
 *
 * The order matters:
 * 1) Links and mentions (`<url|label>`, `<@U123>`, `<#C123|channel>`) are unwrapped first. Every
 *    `<...>` still alive in the raw text at this point is Slack link syntax — a `<` or `>` the user
 *    actually typed is already sent escaped by Slack as `&lt;`/`&gt;`, so it does not match this regex.
 *    Unescaping the entities first would make the `&lt;@fake&gt;` of a user who literally wrote
 *    `<@fake>` get misread as a mention here.
 * 2) `&lt;` and `&gt;` are unescaped.
 * 3) `&amp;` is unescaped last — doing it first would take the `&amp;lt;` that arrives when a user
 *    literally wrote `&lt;` and, with the order reversed, double-decode it through `&lt;` all the way
 *    to `<`.
 */
function unescapeSlackText(text: string): string {
  const withLinks = text.replace(/<([^<>]+)>/g, (_match: string, inner: string) => {
    const pipeIdx = inner.indexOf('|')
    return pipeIdx === -1 ? inner : inner.slice(pipeIdx + 1)
  })
  return withLinks.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** The result of converting reply text into the form to write to the PTY. Enter (submit) itself is not
 *  part of text — by the same convention as scheduler.ts and rolling.ts, SlackInbox has to send it
 *  separately ENTER_DELAY_MS (150ms) after writing the text so the TUI has digested the whole paste
 *  before it submits. */
export interface SessionInput {
  /** The body to write to the PTY — newlines are already folded into Alt+Enter (ESC+CR). */
  text: string
  /** When true, Enter has to be sent separately after writing text in order to submit. Every path where
   *  classifyInbound returns inject intends a submit, so it is always true for now, but making the caller
   *  check the value explicitly keeps it from breaking silently if the value ever changes (pure typing
   *  with no submit, for instance). */
  submit: boolean
}

/** What gets stripped: C0 control characters (0x00-0x1F) and DEL (0x7F) — only the newlines
 *  (\n=0x0A, \r=0x0D) are kept as exceptions. Those two are the newlines we intend, converted to
 *  Alt+Enter below. The rest are bytes that cannot be typed into a text field from a keyboard —
 *  Ctrl+C (\x03, interrupt the turn), Ctrl+D (\x04, end the session), ESC (\x1b, start of an ANSI
 *  sequence) and so on. The same reasoning as sanitizeResumePrompt in commands.ts: removing is safer
 *  than implementing perfect escaping. */
const CONTROL_CHARS_EXCEPT_NEWLINE = /[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g

/**
 * Converts reply text into the bytes to write to the PTY.
 *
 * Sending newlines as they are makes the CLI take every line as a submit and start several turns. By
 * the same rule as TerminalView's Ctrl+Enter handling, an Alt+Enter sequence (ESC+CR) is sent so only a
 * newline is inserted. CRLF and a bare CR are folded the same way — Slack sends LF, but depending on
 * the client they can be mixed in.
 */
export function toSessionInput(text: string): SessionInput {
  const safe = text.replace(CONTROL_CHARS_EXCEPT_NEWLINE, '')
  return { text: safe.replace(/\r\n|\r|\n/g, '\x1b\r'), submit: true }
}

/** The shape of one choice screen — whether each question is multi-select, and how many items can be
 *  picked by number */
export interface ChoiceShape {
  multiSelect: boolean
  /** The number of options AskUserQuestion gave. The automatically appended 'Other' is excluded — it is
   *  type:"input", so picking it by number enters free-input mode, and in that state number keys are
   *  ignored (measured in Claude Code). */
  optionCount: number
}

/** The failure reason is a `Message`, not a sentence — this module is core and does not know the
 *  language, so main (slackInbox) translates it before posting it into the thread. That is the same
 *  layering convention the file-operation errors follow. */
export type ChoiceKeysResult = { ok: true; keys: string[] } | { ok: false; reason: Message }

/**
 * Turns a reply to a choice prompt into an auto-submit key sequence.
 *
 * The format separates questions with `/` and multiple choices within one question with `,` —
 * `"1,3 / 2"`. Newlines are not used as a separator because that would collide in meaning with the
 * existing path where toSessionInput folds newlines into Alt+Enter.
 *
 * The key sequence was settled by reading the Claude Code TUI's key handling:
 *  - A number key **toggles** the item with that number (focus does not move).
 *  - Tab moves to the next question's tab, and on the last question to the `✓ Submit` tab.
 *  - On the Submit tab, Enter submits. A multi-select is not submitted by Enter alone (the
 *    `!isMultiSelect && return → onSubmit` path, which exists only for single-select, is closed).
 *  - **A single-select advances to the next question on its own once an answer is picked, through the
 *    `shouldAdvance` default.** So putting a Tab after a single-select overshoots by one — Tab is
 *    attached to multi-selects only.
 *  - The reducer that increments the question index has no upper bound (`currentQuestionIndex + 1`, no
 *    Math.min). That is why sending Tab generously is not safe, and why exactly one is counted per
 *    question.
 *
 * If the format is off, nothing is injected and the reason is returned. A wrongly sent sequence commits
 * items that were not intended and cannot be undone, so when it is ambiguous, pressing nothing is the
 * right call (the same rule as answerLimitChoice in rolling.ts).
 */
export function buildChoiceKeys(text: string, shape: ChoiceShape[]): ChoiceKeysResult {
  if (shape.length === 0) return { ok: false, reason: { key: 'slack.choice.noShape' } }
  const parts = text
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (parts.length !== shape.length)
    return {
      ok: false,
      reason: {
        key: 'slack.choice.countMismatch',
        params: { expected: shape.length, got: parts.length }
      }
    }
  const keys: string[] = []
  for (let i = 0; i < shape.length; i++) {
    const nums = parts[i].match(/\d+/g) ?? []
    // With more than one question the reason has to say which one, so the *At variant of each key is
    // used and carries the 1-based index.
    const at = shape.length > 1 ? { index: i + 1 } : null
    if (nums.length === 0)
      return {
        ok: false,
        reason: at
          ? { key: 'slack.choice.noNumberAt', params: at }
          : { key: 'slack.choice.noNumber' }
      }
    if (!shape[i].multiSelect && nums.length > 1)
      return {
        ok: false,
        reason: at
          ? { key: 'slack.choice.singleOnlyAt', params: at }
          : { key: 'slack.choice.singleOnly' }
      }
    for (const raw of nums) {
      const n = Number(raw)
      // There are at most 4 items (the AskUserQuestion schema is min(2).max(4)), so a number is always a
      // single digit. Two or more digits cannot be sent as one key and are out of range to begin with —
      // the upper-bound check below filters them out along the way.
      if (n < 1 || n > shape[i].optionCount)
        return {
          ok: false,
          reason: at
            ? {
                key: 'slack.choice.outOfRangeAt',
                params: { ...at, n: raw, max: shape[i].optionCount }
              }
            : { key: 'slack.choice.outOfRange', params: { n: raw, max: shape[i].optionCount } }
        }
      keys.push(String(n))
    }
    if (shape[i].multiSelect) keys.push('\t')
  }
  keys.push('\r')
  return { ok: true, keys }
}
