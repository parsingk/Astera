// Where the app's worker-stop ends a worker's session (Host S2, Task 11 review I3(c)).
//
// `core.sessions.kill` of a session the app does not hold does nothing at all, and `worker-stop`
// then marks the Dispatch stopped. Since S2 that is a real case: a worker the Host started for a CLI
// call runs in the Host's registry, and the app holds it only once `pty-opened` has been answered by
// adopting it. Before then, a Stop pressed in RunDetail would close the Dispatch over a worker that
// goes on working, and the next worker-start puts a second agent in the same worktree. So a session
// the app does not hold running is ended in the Host that runs it, and when the Host cannot be asked,
// the stop is refused rather than claimed.
import type { PtyEntry } from '../../core/host/protocol'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../core/sessions/pty'
import type { SessionStatus } from '../../core/types'

export interface KillWorkerDeps {
  app: {
    /** The app's record for this session, if it has one (`core.sessions.list()`). */
    info(id: string): { status: SessionStatus; exitCode?: number } | undefined
    kill(id: string): void
  }
  /** The Host, or null when this app has no Host wiring at all (then every session is its own).
   *  `list` is one `pty-list` round trip, null when unanswered; `kill` sends `pty-kill` and answers
   *  whether it left the app. */
  host: { list(): Promise<PtyEntry[] | null>; kill(ptyId: string): boolean } | null
  log(m: string): void
}

const notStopped = (sessionId: string, why: string): Error =>
  new Error(
    `the worker was not stopped: session ${sessionId} is not held by this app and ${why}, so it may still be running in the Host — try again, or use worker-abandon to stop tracking it`
  )

export async function killWorkerSession(sessionId: string, d: KillWorkerDeps): Promise<void> {
  const info = d.app.info(sessionId)
  // Held and running: the app's own handle. For an adopted session that handle is the Host's pty, so
  // its kill is a `pty-kill` and the exit comes back to this app, which sent `pty-attach` for it.
  if (info?.status === 'running' || !d.host) {
    d.app.kill(sessionId)
    return
  }
  // The app saw it end with a real code: there is nothing left anywhere to kill. A lost-sight exit
  // is not that — the process may well be alive in the Host — so it is asked about like an unknown one.
  if (info && info.exitCode !== PTY_LOST_SIGHT_EXIT_CODE) return
  const entries = await d.host.list()
  if (entries === null) throw notStopped(sessionId, 'the Host did not answer')
  const entry = entries.find((e) => e.alive && e.meta?.kind === 'session' && e.meta.id === sessionId)
  // Not running in the Host either: it has already ended, and the stop has nothing to end.
  if (!entry) return
  if (!d.host.kill(entry.id)) throw notStopped(sessionId, 'the Host could not be reached')
  // Its exit is the Host's to handle (no app holds this pty), and it finds the Dispatch already
  // stopped, which `handleExit` leaves as it is.
  d.log(`worker-stop: session ${sessionId} runs in the Host, not in this app — asked the Host to end it (pty ${entry.id})`)
}
