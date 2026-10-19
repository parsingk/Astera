/**
 * The hook-event fan-out `index.ts` wires `HookEventWatcher`'s callback to. Extracted into its own
 * file, with no Electron import, so it can be exercised directly with recorder stubs — the same move
 * `ipc.ts` makes for its own Electron-closure-bound decisions (`historyResumePlan`,
 * `forgetAttentionOnExit`, …). Not placed inside `ipc.ts` itself: every tap here (`attention`, `pendingPrompt`,
 * `slack`) is built in `index.ts`, not there, and `index.ts` cannot be imported by a test the way
 * `ipc.ts` can — it runs `app.setPath`/`app.commandLine.appendSwitch` at module load and starts
 * `app.whenReady().then(...)` immediately on import, none of which survive outside a real Electron
 * process.
 *
 * Task 5's review found exactly the gap this file closes: deleting the attention tap from the closure
 * inside `whenReady`, or moving it after the taps that used to read its result, left the whole test
 * suite green and `typecheck` clean, because nothing had ever called this function directly. `index.ts`
 * now only builds the taps and calls `fanOutHookEvent`; the fan-out logic itself lives here, where a
 * test can call it with recorders instead of the real `SlackNotifier`/`AttentionState`.
 *
 * The rolling coordinator was a tap here until 2026-10-19: its idle-stall nudge read the idle Notification, and that
 * nudge is gone — "continue" goes only after a limit it detected is lifted.
 */

/** The minimal shape each tap needs — every real tap (`SlackNotifier`, `AttentionState`,
 *  `PendingPromptState`) already has an `onHookEvent(sessionId, payload)` method with this signature, so
 *  the real objects satisfy this without adaptation. */
export interface HookFanOutTap {
  onHookEvent(sessionId: string, payload: unknown): void
}

export interface HookFanOutTaps {
  /** The one attention verdict (core/sessions/attention.ts) — see `fanOutHookEvent`'s own comment for why it
   *  runs first. */
  attention: HookFanOutTap
  /** The pending-prompt capture (core/sessions/pendingPrompt.ts). Second, after `attention`, for the same reason
   *  `attention` is first: it produces a value other code reads, and a later tap that reads it should
   *  find it current. In its own `try`, like the others. */
  pendingPrompt: HookFanOutTap
  slack: HookFanOutTap
}

/**
 * One hook event, fanned out to every tap.
 *
 * **`attention` runs first.** It is the sole writer of the shared attention state — `DesktopNotifier`
 * no longer taps this fan-out at all; it subscribes to `attention` instead (desktopNotifier.ts's
 * constructor), and that subscription fires synchronously, from inside `attention.onHookEvent` itself,
 * the moment a session's value actually changes. So today's one subscriber does not, strictly, need
 * `attention` to run before `slack` — its callback already fires at the right point inside
 * `attention`'s own call, wherever that call sits in this sequence. `attention` is still kept first on
 * purpose: it is the one tap here whose whole job is producing a value other code reads, so any future
 * tap that reads `attention`'s state directly (the way `desktopNotifier.ts` used to, and the mistake
 * that shipped once already — see attention.ts's own history) gets a current answer for free, without
 * having to remember to check where in this list it was added. `pendingPrompt` comes second under the
 * same rule: it is the other tap whose whole job is producing a value (the waiting tool call) that
 * `ipc.ts` pushes to the renderer. `slack` does not read `attention`.
 *
 * The taps before the last run inside their own `try` so one tap's exception cannot swallow another's —
 * `attention`'s `try` matters even more now that it is first: without it, a throw there would cost
 * `pendingPrompt` and `slack` their turn too, not just itself. `slack` itself is intentionally left unguarded,
 * matching its behaviour before this task; it comes last, after `attention` and `pendingPrompt`.
 */
export function fanOutHookEvent(taps: HookFanOutTaps, sessionId: string, payload: unknown): void {
  try {
    taps.attention.onHookEvent(sessionId, payload)
  } catch {
    /* an attention-state failure must not block the others */
  }
  try {
    taps.pendingPrompt.onHookEvent(sessionId, payload)
  } catch {
    /* a capture failure must not block the others */
  }
  taps.slack.onHookEvent(sessionId, payload)
}
