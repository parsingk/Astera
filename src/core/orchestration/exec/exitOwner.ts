// Who handles a session's exit (Host S2 design §2.6, plan rulings R2 and R3).
//
// Both processes can see one pty end: the Host holds every pty, and the app hears the exit of every
// session it spawned or adopted. Handling it twice is harmless (`handleExit` on a closed Dispatch is a
// no-op), but handling it never leaves a Dispatch open with nobody to close it. So each pty has one
// owner. The app owns the ptys an app socket has spawned or attached; the Host owns every other agent
// session, which is the ones it spawned itself for a CLI call, whether or not an app is attached.
//
// **Why "held", not "is an app attached".** An attached app sees only the sessions it holds. A worker
// the Host spawned for a coordinator's `worker-start` is unknown to it until it adopts it, and an older
// app never adopts it at all. Rolling runs in both processes since S6: the app rolls the ptys it owns,
// the Host the ones it spawned or took over; each defers its own exits by this window so its own roll
// tap rekeys first.

/** How long an exit waits before it is handled.
 *
 *  **The same value as Slack's EXIT_DELAY_MS, for the same purpose.** A roll kills the session and
 *  respawns it, and the exit of the kill must not close the Dispatch the roll is about to rekey. Every
 *  subscriber that sees the same event uses the same window, because two windows can leave one
 *  subscriber cancelled and the other not, and nobody finds that without putting the two values side
 *  by side. Moved here from `rollTap.ts` so the Host reads the same number. */
export const EXIT_DEFER_MS = 3_000

/** Whether the Host handles this pty's exit: an agent session that no app socket holds. */
export function hostOwnsExit(a: { kind: string | null; heldByApp: boolean }): boolean {
  return a.kind === 'session' && !a.heldByApp
}
