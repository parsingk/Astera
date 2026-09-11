/**
 * The hook-event fan-out `index.ts` wires `HookEventWatcher`'s callback to. Extracted into its own
 * file, with no Electron import, so it can be exercised directly with recorder stubs — the same move
 * `ipc.ts` makes for its own Electron-closure-bound decisions (`historyResumePlan`,
 * `forgetAttentionOnExit`, …). Not placed inside `ipc.ts` itself: every tap here (`attention`, `slack`,
 * `rolling`) is built in `index.ts`, not there, and `index.ts` cannot be imported by a test the way
 * `ipc.ts` can — it runs `app.setPath`/`app.commandLine.appendSwitch` at module load and starts
 * `app.whenReady().then(...)` immediately on import, none of which survive outside a real Electron
 * process.
 *
 * Task 5's review found exactly the gap this file closes: deleting the attention tap from the closure
 * inside `whenReady`, or moving it after the taps that used to read its result, left the whole test
 * suite green and `typecheck` clean, because nothing had ever called this function directly. `index.ts`
 * now only builds the taps and calls `fanOutHookEvent`; the fan-out logic itself lives here, where a
 * test can call it with recorders instead of the real `SlackNotifier`/`RollingCoordinator`/
 * `AttentionState`.
 */

/** The minimal shape each tap needs — every real tap (`SlackNotifier`, `RollingCoordinator`,
 *  `AttentionState`) already has an `onHookEvent(sessionId, payload)` method with this signature, so
 *  the real objects satisfy this without adaptation. */
export interface HookFanOutTap {
  onHookEvent(sessionId: string, payload: unknown): void
}

export interface HookFanOutTaps {
  /** The one attention verdict (main/attention.ts) — see `fanOutHookEvent`'s own comment for why it
   *  runs first. */
  attention: HookFanOutTap
  slack: HookFanOutTap
  /** Absent until the rolling coordinator is constructed later in the boot sequence — the same reason
   *  index.ts's own `rollingRef` starts `null` (see that variable's comment in index.ts). */
  rolling?: HookFanOutTap | null
}

/**
 * One hook event, fanned out to every tap.
 *
 * **`attention` runs first.** It is the sole writer of the shared attention state — `DesktopNotifier`
 * no longer taps this fan-out at all; it subscribes to `attention` instead (desktopNotifier.ts's
 * constructor), and that subscription fires synchronously, from inside `attention.onHookEvent` itself,
 * the moment a session's value actually changes. So today's one subscriber does not, strictly, need
 * `attention` to run before `slack`/`rolling` — its callback already fires at the right point inside
 * `attention`'s own call, wherever that call sits in this sequence. `attention` is still kept first on
 * purpose: it is the one tap here whose whole job is producing a value other code reads, so any future
 * tap that reads `attention`'s state directly (the way `desktopNotifier.ts` used to, and the mistake
 * that shipped once already — see attention.ts's own history) gets a current answer for free, without
 * having to remember to check where in this list it was added. `slack` and `rolling` do not read
 * `attention` and are unaffected by their order relative to each other.
 *
 * Each tap after the first runs inside its own `try` so one tap's exception cannot swallow another's —
 * `attention`'s `try` matters even more now that it is first: without it, a throw there would cost
 * `slack` and `rolling` their turn too, not just itself. `slack` itself is intentionally left unguarded,
 * matching its behaviour before this task; it comes second only because `attention` moved ahead of it.
 */
export function fanOutHookEvent(taps: HookFanOutTaps, sessionId: string, payload: unknown): void {
  try {
    taps.attention.onHookEvent(sessionId, payload)
  } catch {
    /* an attention-state failure must not block the others */
  }
  taps.slack.onHookEvent(sessionId, payload)
  // Rolling taps the hooks too — an idle Notification is the signal for the idle nudge.
  // Isolated in its own try, separate from the Slack tap, so an exception on one side does not
  // swallow the other.
  try {
    taps.rolling?.onHookEvent(sessionId, payload)
  } catch {
    /* a rolling tap failure must not block the Slack notification */
  }
}
