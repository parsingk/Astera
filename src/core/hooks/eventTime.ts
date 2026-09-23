// When a hook event happened, as opposed to when its line landed in the file.
//
// **Why the file's order is not the event order.** UserPromptSubmit and StopFailure are installed
// `async` (core/sessions/statusline.ts): Claude Code starts their capture process and does not wait for it.
// Each capture is its own node process (about 0.05 s to start directly, 0.1 s through Git Bash), so
// two of them can append in either order. Two ways that ends the file on the wrong event:
// - an API error almost as soon as a prompt is submitted appends that turn's StopFailure before its
//   own UserPromptSubmit;
// - a prompt submitted right after a failed turn (typed, or queued and sent at once) appends its
//   UserPromptSubmit before the previous turn's StopFailure.
//
// **The stamp.** The capture script writes when its node process started (`performance.timeOrigin`,
// epoch milliseconds with a fraction; `Date.now()` as its first statement on a node too old to have
// it) into the line as `HOOK_EVENT_AT`. Claude Code spawns hooks in event order, so the start time is
// the event order to within the spawn jitter. Measured on Windows through Git Bash with two captures
// spawned a known gap apart (40 pairs per gap): with a gap of 10 ms or more no stamp ever inverted;
// spawned at the same moment, the process start time inverted 2 of 40 pairs, a first-statement
// `Date.now()` 7, and the landing order 13. So a stamp orders any two events more than a few
// milliseconds apart, and at worst gets wrong what append order already got wrong.
//
// **Lines without the stamp** (a capture from before it, whose session has not run a hook since the
// app rewrote the script) have no time, and a tie is two events at the same instant. Neither can
// be ordered by time, so both fall back to the order they landed in, which is today's rule. So
// does a gap too large to be a reordering (REORDER_WINDOW_MS).

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
 * How far apart two stamps may be and still be trusted to reorder lines. The reorderings this fixes
 * are two async captures landing within node's startup jitter: measured, a few milliseconds, and
 * well under a second even through Git Bash under full load. A gap of seconds is not a reordering
 * but a wall clock that was set back (Windows steps the clock after a resume or a large offset).
 * Trusting it would make every event after the step look older than the ones before it, and a
 * session would read `working`, or keep a turn open, until wall time caught up. Past this window
 * the stamps are ignored and append order stands. A step shorter than the window can still misorder
 * a turn shorter than the step.
 */
export const REORDER_WINDOW_MS = 5_000

/**
 * **The ordering rule, for every reader of the hook event files.** True only when both events carry
 * a time and `a`'s is earlier by more than 0 and less than REORDER_WINDOW_MS. False means "not known
 * to be earlier": the caller then keeps the order the lines landed in. The Host picks the latest event with it
 * (core/hooks/sessionState.ts `latestEventLine`); the app's readers use it to tell a turn end that
 * belongs to the turn before the latest prompt (main/attention.ts, pendingPrompt.ts, slack.ts).
 */
export function happenedBefore(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && b - a > 0 && b - a < REORDER_WINDOW_MS
}
