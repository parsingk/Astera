// Whether a terminal session is working or waiting, as `astera sessions list` reports it (CLI phase
// D3), read off the hook event file the capture script appends (main/statusline.ts). The Host reads
// the file itself, so this answers with the app closed: the hook runs inside the agent CLI and keeps
// appending whether or not the app is there to drain it.
//
// **Only what an event means without guessing.** Claude Code runs the capture for four hooks
// (statusline.ts `everySessionHooks` and the tool pair in the Slack/rolling file): Notification, Stop,
// PreToolUse and PostToolUse. There is no hook for "a turn was submitted", so no event says a new
// turn started. What the last event does say:
// - PreToolUse / PostToolUse: a tool call inside a turn that has not stopped yet → `working`.
// - Stop: the turn is over (the edge slack.ts posts its turn summary on) → `waiting` for the next one.
// - Notification: classified by core/hooks/notification.ts, the rule main/attention.ts, slack.ts,
//   rolling.ts and desktopNotifier.ts share. A report of something that already happened says
//   nothing about now → no verdict. Everything else, a type never seen before included, is a screen
//   waiting on a person → `waiting`, which is the app's own call for an unknown type.
//
// **Where this differs from main/attention.ts, and why.** Attention answers "does this session need
// you": after a tool call returns it reads `idle`, and a bare `idle_prompt` leaves it alone, because
// neither is a reason to raise a banner. This answers "is a turn running": a returned tool call is
// still inside the turn, and `idle_prompt` ("Claude is waiting for your input") is emitted only when
// no turn is running. Replaying attention here would report a turn in progress as idle.
//
// **Input after the event voids it.** Because nothing announces a new turn, `waiting` after a Stop
// would stay `waiting` through the whole next turn in a session whose tools are not hooked. So the
// Host keeps when each pty was last typed into (host/registry.ts), and anything typed after the last
// event — the next prompt, an answer to a permission prompt, an Esc that interrupts a turn (which
// fires no Stop) — makes the answer `unknown` until the next event lands.
import path from 'node:path'
import { isNonPromptNotification, type NotificationPayload } from './notification'

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

/** What one hook payload says the session is doing, or null when it says nothing about that. */
export function hookEventState(payload: unknown): 'working' | 'waiting' | null {
  if (typeof payload !== 'object' || payload === null) return null
  const p = payload as { hook_event_name?: unknown } & NotificationPayload
  switch (p.hook_event_name) {
    case 'PreToolUse':
    case 'PostToolUse':
      return 'working'
    case 'Stop':
      return 'waiting'
    case 'Notification':
      return isNonPromptNotification(p) ? null : 'waiting'
    default:
      return null
  }
}

/**
 * The state from a session's last event line and two times: when that line landed (the file's
 * mtime — the capture writes one line per append, so the last line is the last write) and when the
 * pty was last typed into. `lastLine` null is "no file, or no complete last line".
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
