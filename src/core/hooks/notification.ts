// Decides what kind of Claude Code Notification hook fired. rolling.ts and slack.ts both have to answer
// the same question ("is this notification a plain idle wait?"), so it lives here in one place. A pure
// function — no side effects.
//
// Why the type and not the phrase:
// The hook payload carries notification_type as a structured value. The set of values confirmed by pulling
// the emit sites out of the 2.1.220 bundle is —
//   idle_prompt              "Claude is waiting for your input" (idle for N seconds after a turn ends)
//   worker_permission_prompt "<agent> needs permission for <tool>"
//   agent_needs_input · agent_completed
//   elicitation_response · elicitation_complete
//   computer_use_enter · computer_use_exit · push_notification · auth_success
// This used to split on message with a regex, and the silent failure of that phrase regex is exactly why
// this work existed — the limit phrase had changed and 13 hours went unnoticed. The move is made because
// the type wobbles less than the phrase, not because the type is a guaranteed API. It is not a documented
// contract, only an enumeration observed in one version, and if the value names change this verdict goes
// silently wrong the same way — so KNOWN_TYPES below makes a "type never seen before" tellable apart, and
// the caller logs it.

/** The old fallback — what the verdict rested on back when there was no notification_type. Not used once a type is carried. */
const IDLE_MESSAGE_RE = /waiting for your (input|response)/i

/** The type Claude Code attaches to an idle notification (measured from the bundle) */
const IDLE_TYPE = 'idle_prompt'

/** Every type observed so far. A value that is not here means Claude Code added a new kind or changed a
 *  value — ignoring that silently would reproduce the earlier failure with nothing but the field changed,
 *  so the caller logs it.
 *
 *  A fact established by a later re-check — the first note said "the values change from version to
 *  version", and that was wrong. How it was checked: every place the installed CLI binary uses a
 *  `notificationType:"…"` literal was swept exhaustively (not simply reading the array next to the
 *  `notification_type` key, but finding the actual emit sites). The result is that the emit sites of the
 *  old values observed in 2.1.220 (`worker_permission_prompt`·`computer_use_enter`·`computer_use_exit`·
 *  `push_notification`) are still alive — for example:
 *  `dAe({message:`${F.agent_id} needs permission for ${F.tool_name}`,notificationType:
 *  "worker_permission_prompt"},l)`. So this is not a "replacement": **both families coexist inside one
 *  binary**. `permission_prompt`·`elicitation_dialog` are values newly added alongside, not substitutes
 *  for the old ones — which is why the list below carries no "gone, it was an old value" classification.
 *  If the next person reads only this comment, decides a value is unused and deletes it, the only people
 *  who silently miss notifications are the users whose deleted value still has a live emit site.
 *
 *  That check is still only the result of one grep for the `notificationType:` literal, not a documented
 *  contract — a later version really can drop a value or rename it, and this list would then go silently
 *  stale the same way. Since the purpose of this set is not to be a whitelist but to detect new kinds,
 *  keeping past values around costs nothing.
 *
 *  Even when this list goes stale the notification itself does not wobble — the verdict on a pending
 *  choice comes not from the type but from an unanswered tool_use in the transcript (extractPendingToolUse
 *  in core/slack/transcript.ts). */
const KNOWN_TYPES = new Set([
  IDLE_TYPE,
  // Values newly observed in a later re-check
  'permission_prompt',
  'elicitation_dialog',
  'elicitation_complete',
  'elicitation_response',
  'agent_needs_input',
  'agent_completed',
  'auth_success',
  // Values first observed in 2.1.220 — the re-check found their emit sites still alive (see the comment above)
  'worker_permission_prompt',
  'computer_use_enter',
  'computer_use_exit',
  'push_notification'
])

/** Only the part of the Notification hook payload that is read here. The other fields have no bearing on this verdict. */
export interface NotificationPayload {
  notification_type?: unknown
  message?: unknown
}

/** Is this a plain idle notification — is the input box empty, so text may be put into it?
 *
 *  When a type is carried, only the type is looked at. Why it does not fall back to the phrase as well: if
 *  the phrase were checked alongside a type that is present, then when Claude Code changes the wording of
 *  the idle notification the type would still be right while the phrase disagreed, flipping the verdict.
 *  The phrase is a fallback only when there is no type at all (older versions). */
export function isIdleNotification(p: NotificationPayload): boolean {
  if (typeof p.notification_type === 'string') return p.notification_type === IDLE_TYPE
  return IDLE_MESSAGE_RE.test(typeof p.message === 'string' ? p.message : '')
}

/** Is this a type absent from the measured list — used by the caller to decide whether to log it.
 *  A payload with no type at all (older versions) is not a "type never seen before", so it is false. */
export function isUnknownNotificationType(p: NotificationPayload): boolean {
  return typeof p.notification_type === 'string' && !KNOWN_TYPES.has(p.notification_type)
}

/** Types that report something that already happened, not a screen waiting for an answer.
 *
 *  Read off the emit sites in the installed binary, message text included:
 *    agent_completed       `${label} finished|failed`
 *    auth_success          "Claude Code login successful"
 *    elicitation_complete  `MCP server "X" confirmed elicitation N complete`
 *    elicitation_response  `Elicitation response for server "X": decline|${action}`
 *    computer_use_enter    "Claude is using your computer · press Esc to stop"
 *    computer_use_exit     "Claude is done using your computer"
 *    push_notification     a plain relay of the message the model passed
 *
 *  Not here, because they really are waiting screens: permission_prompt · worker_permission_prompt
 *  (`${agent_id} needs permission for ${tool_name}`) · agent_needs_input (`${label} needs your input`) ·
 *  elicitation_dialog. idle_prompt is not here either — it keeps its own rule (isIdleNotification):
 *  suppressed on its own, but sent when a call really is waiting.
 *
 *  A type that is **not** on this list stays on the input-needed path, so a newly added or renamed value
 *  errs toward notifying. That is the same direction as the rest of this file: a missed notification means
 *  the user never learns their session is blocked, while a surplus one only costs noise. */
const NON_PROMPT_TYPES = new Set([
  'agent_completed',
  'auth_success',
  'elicitation_complete',
  'elicitation_response',
  'computer_use_enter',
  'computer_use_exit',
  'push_notification'
])

/** Is this notification a report of something finished rather than a prompt awaiting an answer?
 *  Only the type decides — these messages have no shared wording to match on. */
export function isNonPromptNotification(p: NotificationPayload): boolean {
  return typeof p.notification_type === 'string' && NON_PROMPT_TYPES.has(p.notification_type)
}
