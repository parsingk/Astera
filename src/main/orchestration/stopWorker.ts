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
   *  whether it left the app; `onExit` hears the `pty-exit` the Host broadcasts for that pty, and
   *  answers the way to stop listening. */
  host: {
    list(): Promise<PtyEntry[] | null>
    kill(ptyId: string): boolean
    onExit(ptyId: string, cb: () => void): () => void
  } | null
  log(m: string): void
  /** How long to wait for that `pty-exit` before looking again. Test injection; the wiring leaves it
   *  out and gets STOP_EXIT_WAIT_MS. */
  waitMs?: number
}

/** How long a stop waits for the Host's `pty-exit`: the same bound as a `pty-list` answer. A pty kill
 *  that has not ended the process by then is looked at once more rather than waited for longer. */
export const STOP_EXIT_WAIT_MS = 5_000

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
  const host = d.host
  let unsent = false
  d.log(`worker-stop: session ${sessionId} runs in the Host, not in this app — asking the Host to end it (pty ${entry.id})`)
  // **A kill that left the app is not a worker that ended** (fix round, I2). The registry only logs a
  // kill that throws (win32's ConPTY teardown is the documented case), and a socket can drop before
  // the Host reads the line. So the stop counts only on the Host's own `pty-exit` for this pty, or,
  // when none comes within the bound, on a fresh list that no longer shows it alive. Anything else is
  // a refusal, and the Dispatch stays open; a second press then finds the pty gone, or not.
  //
  // Listening before sending, so an exit that comes back at once is not missed.
  let off: () => void = () => {}
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), d.waitMs ?? STOP_EXIT_WAIT_MS)
    off = host.onExit(entry.id, () => {
      clearTimeout(timer)
      resolve(true)
    })
    if (!host.kill(entry.id)) {
      clearTimeout(timer)
      resolve(false)
      unsent = true
    }
  }).finally(() => off())
  if (unsent) throw notStopped(sessionId, 'the Host could not be reached')
  if (exited) return
  const again = await host.list()
  if (again === null) throw notStopped(sessionId, 'the Host did not confirm the kill')
  if (again.some((e) => e.id === entry.id && e.alive)) throw notStopped(sessionId, 'the Host did not end it')
  // Gone, though its exit never reached this app. Its exit was the Host's to handle anyway (no app
  // holds this pty), and it finds the Dispatch already stopped, which `handleExit` leaves as it is.
}
