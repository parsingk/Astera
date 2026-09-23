// When a hook event happened, as opposed to when its line landed in the file.
//
// **Why the file's order is not the event order.** UserPromptSubmit and StopFailure are installed
// `async` (main/statusline.ts): Claude Code starts their capture process and does not wait for it.
// Each capture is its own node process (about 0.05 s to start directly, 0.1 s through Git Bash), so
// two of them can append in either order. Two ways that ends the file on the wrong event:
// - an API error almost as soon as a prompt is submitted appends that turn's StopFailure before its
//   own UserPromptSubmit;
// - a prompt submitted right after a failed turn (typed, or queued and sent at once) appends its
//   UserPromptSubmit before the previous turn's StopFailure.
//
// **The stamp.** The capture script takes `Date.now()` as its first statement, before it reads
// stdin, and writes it into the line as `HOOK_EVENT_AT`. Claude Code spawns hooks in event order, so
// the start time is the event order to within the spawn jitter. Measured on Windows through Git Bash
// with two captures spawned a known gap apart (40 pairs per gap): with a gap of 10 ms or more the
// stamps never inverted; at 0-3 ms they inverted in up to 7 of 40 pairs, where the landing order
// inverted in up to 13. So a stamp orders any two events more than a few milliseconds apart, and at
// worst gets wrong what append order already got wrong.
//
// **Lines without the stamp** (a capture from before it, whose session has not run a hook since the
// app rewrote the script) have no time, and a tie is two events in the same millisecond. Neither can
// be ordered by time, so both fall back to the order they landed in, which is today's rule.

/** The field the capture adds. Claude Code's hook payloads use snake_case names of their own
 *  (`hook_event_name`, `session_id`); the prefix keeps this one from ever being one of them. */
export const HOOK_EVENT_AT = 'astera_at'

/** When the capture that wrote this payload started, or null for a line without the stamp. */
export function hookEventAt(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null) return null
  const at = (payload as Record<string, unknown>)[HOOK_EVENT_AT]
  return typeof at === 'number' && Number.isFinite(at) ? at : null
}

/**
 * **The ordering rule, for every reader of the hook event files.** True only when both events carry
 * a time and `a`'s is strictly earlier. False means "not known to be earlier": the caller then keeps
 * the order the lines landed in. The Host picks the latest event with it
 * (core/hooks/sessionState.ts `latestEventLine`); the app's readers use it to tell a turn end that
 * belongs to the turn before the latest prompt (main/attention.ts, pendingPrompt.ts, slack.ts).
 */
export function happenedBefore(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && a < b
}
