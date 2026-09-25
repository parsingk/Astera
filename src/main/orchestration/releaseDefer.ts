// The app half of S6 R14: a coordinator's slot is released only after the same roll window every other
// exit subscriber waits (EXIT_DEFER_MS), so a roll's rekey of the slot lands first.
import { EXIT_DEFER_MS } from '../../core/orchestration/exec/exitOwner'
import { detachCoordinator, type OrchState } from '../../core/orchestration/state'
import type { JobRun } from '../../core/orchestration/types'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../../core/sessions/pty'

/** What an exit does to the coordinator slot: the Run whose slot named this session, and the state
 *  with that slot emptied, or null when it keeps it. `releaseCoordinator` (ipc.ts) commits it; its
 *  comment has the why of the lost-sight rule. One function, so the tests read the rule ipc runs. */
export function coordinatorReleaseOf(
  st: OrchState,
  sessionId: string,
  exitCode: number
): { run: JobRun; state: OrchState } | null {
  if (exitCode === PTY_LOST_SIGHT_EXIT_CODE) return null
  const run = st.runs.find((r) => r.coordinatorSessionId === sessionId)
  if (!run) return null
  const detached = detachCoordinator(st, { runId: run.id })
  if (!detached.ok) return null
  return { run, state: detached.state }
}

/** Arms one deferred release. Returns its cancel handle. */
export function deferCoordinatorRelease(
  release: (sessionId: string, exitCode: number) => Promise<void>,
  e: { sessionId: string; exitCode: number },
  log: (m: string) => void = () => {}
): () => void {
  const timer = setTimeout(() => {
    void release(e.sessionId, e.exitCode).catch((err) => log(`coordinator release failed session=${e.sessionId}: ${String(err)}`))
  }, EXIT_DEFER_MS)
  return () => clearTimeout(timer)
}

/** The releases still inside their window, so the server's `stop()` can drop them the way it drops
 *  the roll tap's deferred exits (`OrchRollTap.dispose`): a release firing after stop would run
 *  `setState` against a server that has gone. */
export class PendingCoordinatorReleases {
  private readonly cancels = new Set<() => void>()

  get size(): number {
    return this.cancels.size
  }

  defer(
    release: (sessionId: string, exitCode: number) => Promise<void>,
    e: { sessionId: string; exitCode: number },
    log: (m: string) => void = () => {}
  ): void {
    const cancel = deferCoordinatorRelease(
      (sessionId, exitCode) => {
        this.cancels.delete(cancel)
        return release(sessionId, exitCode)
      },
      e,
      log
    )
    this.cancels.add(cancel)
  }

  cancelAll(): void {
    for (const cancel of this.cancels) cancel()
    this.cancels.clear()
  }
}
