// Whether a terminal session is working or waiting, as `astera sessions list` reports it (CLI phase
// D3), read off the hook event file the capture script appends (main/statusline.ts). The Host reads
// the file itself, so this answers with the app closed: the hook runs inside the agent CLI and keeps
// appending whether or not the app is there to drain it.
//
// **Only what an event means without guessing.** Claude Code runs the capture for six hooks
// (statusline.ts `everySessionHooks`, and the wider tool pair in the Slack/rolling file). The event
// that decides is the one that happened last, which is not always the last line: the async hooks
// can land out of order, and the capture's stamp orders them (`latestEventLine`, eventTime.ts).
// What that event says:
// - UserPromptSubmit: a prompt is going to the model → `working`. Claude Code runs it only for input
//   that queries the model: a local command (/clear, /model, /config) and bash mode return before
//   the hook (checked in the 2.1.280 binary), so those leave no turn standing that never starts.
//   The one way left is another UserPromptSubmit hook of the account's own that blocks the prompt
//   after this capture ran: no turn, no Stop, and `working` until something is typed.
// - PreToolUse / PostToolUse: a tool call inside a turn that has not stopped yet → `working`.
//   Except AskUserQuestion's PreToolUse, which is the question going up on screen → `waiting` (the
//   same moment main/pendingPrompt.ts draws it as a card). Its PostToolUse is the answer → `working`.
// - Stop: the turn is over (the edge slack.ts posts its turn summary on) → `waiting` for the next one.
// - StopFailure: fired *instead of* Stop when an API error (a limit, an auth failure) ends the turn
//   → `waiting`, for the same reason.
// - Notification: only the types that say this session itself is waiting on a person → `waiting`.
//   A report of something finished, a background agent or teammate asking (those arrive while this
//   session's own turn runs), a type never seen before and an untyped one say nothing about this
//   session's turn → no verdict. The app's notifiers err toward notifying on an unknown type; a
//   state errs toward `unknown`, the answer that cannot be wrong.
//
// **Where this differs from main/attention.ts, and why.** Attention answers "does this session need
// you": after a tool call returns it reads `idle`, and a bare `idle_prompt` leaves it alone, because
// neither is a reason to raise a banner. This answers "is a turn running": a returned tool call is
// still inside the turn, and `idle_prompt` ("Claude is waiting for your input") is emitted only when
// no turn is running. Replaying attention here would report a turn in progress as idle.
//
// **Input after the event voids it.** Anything typed after the last event — an answer to a
// permission prompt, an Esc that interrupts a turn (which fires no Stop), a prompt whose
// UserPromptSubmit has not landed yet — makes the answer `unknown` until the next event lands. The
// Host keeps when each pty was last typed into (host/registry.ts); the reports the app's terminal
// writes by itself (focus changes, replies to the TUI's queries) do not count (core/terminal/reports.ts).
import path from 'node:path'
import type { NotificationPayload } from './notification'
import { happenedBefore, hookEventAt } from './eventTime'

export type SessionState = 'working' | 'waiting' | 'unknown'

/** The folder the capture appends to, under the profile — the one rule for where it is, shared by the
 *  app that points each session at its file (statusline.ts) and the Host that reads it back. */
export function hookEventsDirIn(profileDir: string): string {
  return path.join(profileDir, 'hook-events')
}

/** One session's file, named by the app's session id (`ASTERA_SESSION`, the pty note's `meta.id`) —
 *  not the agent's own session id, which travels inside each payload as `session_id`. */
export function hookEventsFileIn(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.jsonl`)
}

/** The notification types that mean this session is showing a person something to answer, read off
 *  their emit sites in Claude Code 2.1.280: `permission_prompt` ("Claude needs your permission to
 *  use …", after the dialog has been up a few seconds), `elicitation_dialog` (an MCP server's
 *  question), `idle_prompt` ("Claude is waiting for your input", after a turn ended). Not here:
 *  `agent_needs_input` (a background agent's "… needs your input") and `worker_permission_prompt`
 *  (a teammate's permission request), which are about another agent and can arrive mid-turn. */
const WAITING_TYPES = new Set(['permission_prompt', 'elicitation_dialog', 'idle_prompt'])

/** What one hook payload says the session is doing, or null when it says nothing about that. */
export function hookEventState(payload: unknown): 'working' | 'waiting' | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { hook_event_name?: unknown; tool_name?: unknown } & NotificationPayload
  switch (p.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return 'working'
    case 'PreToolUse':
      return p.tool_name === 'AskUserQuestion' ? 'waiting' : 'working'
    case 'Stop':
    case 'StopFailure':
      return 'waiting'
    case 'Notification':
      return typeof p.notification_type === 'string' && WAITING_TYPES.has(p.notification_type) ? 'waiting' : null
    default:
      return null
  }
}

/**
 * The line of the event that happened last, out of a file's last lines in the order they landed.
 * Not simply the last line: the async hooks can land out of order, and the capture's stamp says
 * which came first (core/hooks/eventTime.ts). A line replaces the current pick unless it is known to
 * have happened before it, so lines without the stamp and a tie keep the append order. A blank or
 * non-JSON line (an empty-stdin capture writes a bare newline) says nothing and is skipped, except
 * as the last line, where it still stands so the state reads `unknown`: taken as a pick, it would
 * push aside a newer event and let an older one after it win. null for no lines.
 */
export function latestEventLine(lines: readonly string[]): string | null {
  let pick: { line: string; at: number | null } | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    let at: number | null = null
    try {
      at = hookEventAt(JSON.parse(line))
    } catch {
      if (i < lines.length - 1) continue
    }
    if (pick === null || !happenedBefore(at, pick.at)) pick = { line, at }
  }
  return pick?.line ?? null
}

/**
 * The state from a session's latest event line (`latestEventLine`) and two times: when the file
 * was last written (its mtime — the capture writes one line per append, so that is when the last
 * line landed) and when the pty was last typed into. `lastLine` null is "no file, or no complete
 * last line".
 *
 * Input at the same millisecond as the event counts as after it: the two cannot be ordered, and
 * `unknown` is the answer that cannot be wrong.
 */
export function sessionStateOf(a: {
  lastLine: string | null
  eventAt: number | null
  lastInputAt: number | null
}): SessionState {
  if (a.lastLine === null || a.eventAt === null) return 'unknown'
  if (a.lastInputAt !== null && a.lastInputAt >= a.eventAt) return 'unknown'
  let payload: unknown
  try {
    payload = JSON.parse(a.lastLine)
  } catch {
    return 'unknown'
  }
  return hookEventState(payload) ?? 'unknown'
}
