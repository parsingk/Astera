// The `check --wait` long-polls in flight in this process, by Run and caller session (final round 2,
// I-A). **What it answers, and only that:** whether a coordinator session is parked in `check --wait`
// for its Run right now. A title spinner or a busy flag cannot tell "parked in check --wait" from
// "thinking", and a fire that replaces an idle-only Run (U4) must not stop a coordinator that is
// doing the work itself.
//
// **In memory, per process, where the check is served.** Every CLI call reaches the Host (the CLI
// stopped going through the app in the control plane work), so the Host's command server holds the
// one tracker that sees coordinators' waits. The app runs `handleCommand` for its own UI and its loop
// only, never for a session's `check`, so it has nothing to record and answers "unknown".
export interface CheckWaits {
  /** Records one wait's entry; the returned function records its exit. Calling it twice is harmless. */
  enter(runId: string, sessionId: string): () => void
  /** Whether `sessionId` has a `check --wait` on `runId` in flight now. */
  parked(runId: string, sessionId: string): boolean
}

export function createCheckWaits(): CheckWaits {
  const open = new Map<string, number>()
  const key = (runId: string, sessionId: string): string => `${runId}\0${sessionId}`
  return {
    enter(runId, sessionId) {
      const k = key(runId, sessionId)
      open.set(k, (open.get(k) ?? 0) + 1)
      let left = false
      return () => {
        if (left) return
        left = true
        const n = (open.get(k) ?? 1) - 1
        if (n <= 0) open.delete(k)
        else open.set(k, n)
      }
    },
    parked: (runId, sessionId) => (open.get(key(runId, sessionId)) ?? 0) > 0
  }
}
