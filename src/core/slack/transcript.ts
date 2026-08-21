// For Slack turn-completion notifications — pulls the assistant text of the last turn out of the
// transcript (jsonl) tail text. Pure module: reading the file is the caller's job (readFileTail in main
// SlackNotifier).
import { t, type Lang } from '../i18n'

/** Is this `type:'user'` line the start of a turn — a message a person (or the injected prompt) wrote?
 *
 *  A content array holding only tool_result blocks is the transcript's record of a tool run, not a new
 *  turn, so it must not end the collection: the very reason the text comes in several pieces is that
 *  tool runs sit between them. */
function isTurnBoundary(obj: Record<string, unknown>): boolean {
  const content = (obj.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return true
  if (Array.isArray(content))
    return content.some((c) => (c as { type?: unknown } | null)?.type === 'text')
  return false
}

/** Every text block of one assistant line, in order. Blank ones are dropped.
 *
 *  extractText in history/parser.ts is deliberately not reused: it takes only the **first** text block
 *  (`content.find`), which is right for a list title but drops content here. */
function assistantTexts(obj: Record<string, unknown>): string[] {
  const content = (obj.message as { content?: unknown } | undefined)?.content
  if (typeof content === 'string') return content.trim() ? [content.trim()] : []
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const c of content) {
    const item = c as { type?: unknown; text?: unknown } | null
    if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim())
      out.push(item.text.trim())
  }
  return out
}

/**
 * The assistant text of the last turn in a jsonl tail string, with every segment joined, or null when
 * there is none. The tail is read from the middle of the file, so even a truncated first line is
 * ignored by the JSON.parse-failure skip (defensive parsing).
 *
 * **Why the whole turn and not the last message.** This used to return the text of the last assistant
 * message alone, and that is not "the response" — a turn records its text in several pieces with tool
 * runs in between. Measured over the 367 transcripts of 2026-08-19~20 (1,159 turns that carry text):
 * **49.7% of turns leave two or more text segments**, and the last segment alone is **77.8%** of the
 * turn's text; in 92 turns (7.9%) it is under half, the worst being 7%. One real case: of 1,610
 * characters the conclusion ("the commit was blocked by a hook") sat in the first segment and Slack
 * received only the closing 486 ("what would you like to check?").
 *
 * Walking backwards stops at the first real user message (isTurnBoundary) — but only once something has
 * been collected. A tail ending on a user line (the next turn already started, or a `!` command slipped
 * in) then falls back to the previous turn's text instead of losing the excerpt entirely.
 *
 * isSidechain lines are skipped. The current Claude Code writes subagent conversations to their own
 * files (`<session>/subagents/agent-*.jsonl`, measured), so they do not reach this tail, but a
 * transcript carried over from an older version has them inline and a worker's words must not be
 * reported as this session's answer.
 */
export function extractLastTurnAssistantText(tail: string): string | null {
  const lines = tail.split('\n')
  const segments: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue // skip a truncated first line or a corrupted line
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) continue
    if (obj.isSidechain === true) continue
    if (obj.type === 'user') {
      if (segments.length > 0 && isTurnBoundary(obj)) break
      continue
    }
    if (obj.type !== 'assistant') continue
    segments.unshift(...assistantTexts(obj))
  }
  return segments.length > 0 ? segments.join('\n\n') : null
}

/** A tool call waiting for a response */
export interface PendingToolUse {
  id: string
  name: string
  input: unknown
}

// Slack's cap on the `text` field. Transport sends `text` only, never blocks, so the 3,000-character
// block limit does not apply. Every display cap below is opened all the way to it: the earlier values
// were narrow enough that ordinary messages arrived ending in '…', and the reason they were narrow
// ("do not flood a thread reply with file contents") no longer outweighs losing the content.
//
// Known trade-off: with the per-item caps opened, one long argument (a Write `content`, say) can take
// over the whole message. Slack also folds long messages behind "Show more" — that is not truncation.
const SLACK_TEXT_MAX = 40_000
const ARG_MAX = SLACK_TEXT_MAX // display cap per argument (one key)
const DESC_MAX = SLACK_TEXT_MAX // display cap for an option's description (one option)
const QUESTION_MAX = SLACK_TEXT_MAX // display cap for the question text
const LABEL_MAX = SLACK_TEXT_MAX // display cap for an option label
const COMMAND_MAX = SLACK_TEXT_MAX // display cap for a Bash command
const TOTAL_MAX = SLACK_TEXT_MAX

/** Keys shown as a character count instead of the value itself. Write's content and Edit's
 *  old_string/new_string are far more likely to be raw file contents than prose arguments, so they
 *  carry a real risk of leaking literal secrets (credentials, keys), and the body is not needed to
 *  decide on an approval — which file is being changed is already visible from file_path. There is no
 *  per-tool allowlist; the split is by key name alone — the same logic holds when these three keys
 *  show up in another tool (any file-editing tool's old_string/new_string is a body, for instance).
 *
 *  Bash's command is deliberately not here — what is about to run is the very core of the approval
 *  decision, and hiding it makes the decision impossible. It is truncated shorter than ARG_MAX via
 *  COMMAND_MAX instead: what the decision needs is usually the front (the command to run), and even
 *  when a long payload follows, the decision was already settled by the front. */
const REDACTED_KEYS = new Set(['content', 'old_string', 'new_string'])

/**
 * Hint on the reply format for a choice prompt.
 *
 * The injection layer turns the reply into a key sequence and carries it through Submit
 * (buildChoiceKeys in main/slackInbox.ts), so the hint is about the **format**, not "go do it in the
 * terminal". When the format is off, no key is pressed and only the reason is left in the thread, so
 * saying the format up front is what cuts wasted round trips the most.
 *
 * For a single question with a single choice only a number has to be sent, so no hint is attached —
 * the same line on every notification pushes down the options that actually need reading.
 */
function replyHint(questionCount: number, anyMulti: boolean, lang: Lang): string {
  if (questionCount > 1) return t(lang, 'slack.choice.hintPerQuestion')
  return anyMulti ? t(lang, 'slack.choice.hintMulti') : ''
}

/** Truncates past the total cap and appends …. Every return path of describePendingToolUse has to go
 *  through this, so fixing one place keeps the cap honoured everywhere. */
function capTotal(text: string): string {
  return text.length > TOTAL_MAX ? `${text.slice(0, TOTAL_MAX)}…` : text
}

/** Scans the jsonl lines and collects (the list of tool_use, the set of ids whose tool_result has
 *  arrived). The tail is read from the middle, so corrupted lines are mixed in and parse failures are
 *  skipped (the same rule as extractLastAssistantText). */
function scanToolCalls(tail: string): { uses: PendingToolUse[]; answered: Set<string> } {
  const uses: PendingToolUse[] = []
  const answered = new Set<string>()
  for (const raw of tail.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    let obj: Record<string, unknown>
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    const content = (obj?.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) continue
    for (const c of content) {
      if (c === null || typeof c !== 'object') continue
      const item = c as Record<string, unknown>
      if (item.type === 'tool_use' && typeof item.id === 'string' && typeof item.name === 'string') {
        uses.push({ id: item.id, name: item.name, input: item.input })
      } else if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
        answered.add(item.tool_use_id)
      }
    }
  }
  return { uses, answered }
}

/**
 * The tool call currently waiting for a response, or null if there is none.
 *
 * Why this is decided from transcript state and not from the hook's notification_type: the type names
 * are not a documented contract, only values observed in one version — measuring the emit sites in
 * the binary shows several families such as `worker_permission_prompt` and `permission_prompt` alive
 * at once inside a single binary (see the KNOWN_TYPES comment in core/hooks/notification.ts). The
 * fact that "there is a tool_use whose response has not arrived yet" maps directly onto a question
 * being on screen, regardless of those name changes. Once rolling's automatic prompt proceeds, a
 * tool_result gets attached to that tool_use and it drops out on its own.
 *
 * If several are waiting, the last one is picked — that is the screen the user is looking at now.
 */
export function extractPendingToolUse(tail: string): PendingToolUse | null {
  const { uses, answered } = scanToolCalls(tail)
  for (let i = uses.length - 1; i >= 0; i--) if (!answered.has(uses[i].id)) return uses[i]
  return null
}

/**
 * The number of tool_use entries for a given tool recorded in the tail.
 *
 * **Claude Code does not flush assistant messages to the transcript while it waits for user
 * interaction.** Both cases were measured directly:
 *  - AskUserQuestion: while the question sat on screen for 5 minutes there was not one line in the
 *    file, and by the time it appeared a tool_result was already attached (flushed together within
 *    60ms).
 *  - Permission approval (Write): while the prompt sat there for over 2 minutes the transcript was
 *    frozen at the user message — no assistant message and no tool_use.
 *
 * So extractPendingToolUse cannot, in principle, find a tool that is "waiting". Waiting *is* the
 * interaction-wait state, and at that moment the tail does not contain that tool_use. A tool that ran
 * automatically because it needed no approval does have its tool_use recorded before it runs (measured
 * with markers), but that one is not a notification target in the first place. The pending content has
 * to be captured separately, from the PreToolUse hook.
 *
 * **This function is no longer called in production.** Its original job was to decide whether content
 * captured that way was still valid — the rule being "if the count has grown past the count at capture
 * time, that call finished and got recorded" — and that rule rested on the assumption that the tail
 * window is fixed, which broke: a measured transcript was 3.6MB against a 256KB tail (TAIL_BYTES), so
 * only 7% of the file was visible, and as appends continued the window slid forward and carried items
 * that were inside it at capture time out of view. The count then stopped growing, or even shrank, so a
 * call that had already finished stayed marked "pending" and an idle notification went out as "input
 * needed". The verdict was replaced by whether the tool_use_id appears (see the SlackRecord.pendingTool
 * comment in main/slack.ts).
 *
 * It is kept because this comment is the only place holding the measurement above — that Claude Code does
 * not flush assistant messages while waiting for interaction — and that fact is what explains both the
 * limit of extractPendingToolUse and why the PreToolUse hook is needed. If it is ever used again, **do not
 * use it to decide whether a call has finished by comparing counts** — it is wrong for the reason above.
 * (It must also not be judged by "is the last one answered": calls from earlier turns of the same session
 * always stay answered, which would misjudge the new call as complete too.)
 */
export function countToolUses(tail: string, name: string): number {
  return scanToolCalls(tail).uses.filter((u) => u.name === name).length
}

/** Shrinks a value onto one line — newlines are folded to spaces and it is truncated at the cap */
function brief(value: unknown, max: number): string {
  // There used to be a `?? String(value)` fallback here, but it was unreachable dead code.
  // JSON.stringify only returns undefined when handed a function or a symbol, and this value is the
  // result of JSON.parse on the transcript's tool_use.input, so those types cannot arrive. undefined
  // itself is handled by the branch before it.
  const text =
    typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * Turns a waiting tool call into text that can be read and decided on from a phone.
 *
 * AskUserQuestion has its questions and options structured, so they are carried over as they are. For
 * other tools (waiting on a permission approval) the on-screen `1. Yes / 2. No` text is built by the
 * TUI client and is not in the transcript, so **what is being approved** is shown through the tool
 * name and its arguments instead. Reproducing the item text from constants is avoided because it can
 * drift from the real screen.
 *
 * The argument is taken as {name, input} rather than PendingToolUse — this function never uses id, and
 * there are now two call sites: the tool_use pulled from the transcript, and the PreToolUse hook
 * payload (tool_name/tool_input, no id). Requiring only the real dependency lets the latter be passed
 * without conversion, and since PendingToolUse is a wider type than that, the existing call sites
 * still pass.
 */
export function describePendingToolUse(
  use: { name: string; input: unknown },
  lang: Lang
): string {
  if (use.name === 'AskUserQuestion') {
    const questions = (use.input as { questions?: unknown } | null)?.questions
    if (Array.isArray(questions) && questions.length > 0) {
      const blocks = questions.map((q) => {
        const item = (q ?? {}) as Record<string, unknown>
        const head = typeof item.question === 'string' ? brief(item.question, QUESTION_MAX) : ''
        const options = Array.isArray(item.options) ? item.options : []
        const lines = options.map((o, i) => {
          const opt = (o ?? {}) as Record<string, unknown>
          const label = typeof opt.label === 'string' ? brief(opt.label, LABEL_MAX) : ''
          const desc = typeof opt.description === 'string' ? brief(opt.description, DESC_MAX) : ''
          return desc ? `${i + 1}. ${label} — ${desc}` : `${i + 1}. ${label}`
        })
        return [`❓ ${head}`, ...lines].join('\n')
      })
      // This used to append ' (multiple choices allowed)' after the question, but the model often puts
      // the same hint into the question text itself, so it went out doubled (measured: "…would you
      // like? (multiple choices allowed) (multiple choices allowed)"). Blocking that with a substring
      // check is fragile — the slightest change in wording slips past it. The place that states the
      // fact is moved to its own line after the list instead — it cannot collide with the model's
      // wording, and alongside the fact that this is a multi-select it also carries what to do about
      // it.
      //
      // When there are several questions and only some of them are multi-select, the hint is still
      // attached only once. Which question it refers to gets blurry, but the hint's real purpose (this
      // screen has to be finished from the terminal) still holds, and repeating it per question fills a
      // short notification with the same sentence.
      const multi = questions.some(
        (q) => ((q ?? {}) as Record<string, unknown>).multiSelect === true
      )
      // Attached **after** capTotal — if the hint gets cut away by the total cap, the reply comes back
      // written without knowing the format. It is a fixed length, so the overshoot is predictable too.
      const hint = replyHint(questions.length, multi, lang)
      const body = capTotal(blocks.join('\n\n'))
      return hint === '' ? body : `${body}\n${hint}`
    }
    // A missing or empty questions array means the schema changed. This used to end here with a fixed
    // sentence ("could not read the options"), which left zero information — a schema change would
    // reproduce a silent failure the moment it happened. It falls through to the shared argument-dump
    // path below instead — showing what actually arrived in input means that even after a schema change
    // something is left and the next person can find the cause.
  }
  // Waiting on a permission approval (or the AskUserQuestion schema-mismatch fallback): what it is
  // about to do is the information the decision needs
  const input = use.input
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const entries = Object.entries(input as Record<string, unknown>)
    if (entries.length > 0) {
      const args = entries
        .map(([k, v]) => {
          if (REDACTED_KEYS.has(k)) {
            const len = typeof v === 'string' ? v.length : (JSON.stringify(v)?.length ?? 0)
            return t(lang, 'slack.pending.charCount', { key: k, len })
          }
          return `${k}: ${brief(v, k === 'command' ? COMMAND_MAX : ARG_MAX)}`
        })
        .join('\n')
      return capTotal(`🔧 ${use.name}\n${args}`)
    }
  }
  return `🔧 ${use.name}`
}
