// Which lost workers a recovery pass may act on (P1 design §6). Moved here unchanged from
// src/main/recovery/reconciler.ts, which re-exports it, so the Host can ask the same question: the
// Host's lost-worker Gate (R16, core/orchestration/lostGate.ts) and the app's reconciler judge "lost"
// by one rule. Pure: no electron, no src/main.
import { runGatedForTask, runIdOf, type OrchState } from '../orchestration/state'
import type { Dispatch } from '../orchestration/types'

/** What `candidates` found, before a decision has been asked for. */
export interface LostAttemptSeed {
  runId: string
  taskId: string
  /** The Dispatch that was lost — the new attempt (if any) links back to it through `retryOf`. */
  dispatch: Dispatch
}

/** A Dispatch this sweep can act on: closed on its own (no `closedBy` — a person's stop, abandon or
 *  pause is left alone), and with no reported outcome. */
export const isLost = (d: Dispatch): boolean =>
  d.endedAt !== undefined && d.outcome === undefined && d.closedBy === undefined

/** Every dispatched Task whose Run is live (not paused, not a schedule template) and whose most
 *  recent Dispatch was lost — one seed per Task, and none at all when the Task already has an open
 *  Dispatch (a fresh attempt is already running).
 *
 *  **The most recent Dispatch, then the lost test — not the most recent lost one.** Filtering the
 *  person-closed attempts out first would reach past a stop to an older crash: a worker crashes, the
 *  boot sweep restarts it, the person stops the restart they did not want, and the next boot
 *  recovers the original attempt anyway. That is exactly what `Dispatch.closedBy` exists to prevent,
 *  and through `worker-abandon` it would put a second agent in a worktree whose resources may still
 *  be live. */
export function candidates(state: OrchState): LostAttemptSeed[] {
  const out: LostAttemptSeed[] = []
  for (const task of state.tasks) {
    if (task.status !== 'dispatched') continue
    // The Run gates, shared with the two other places that put a session on a Task
    // (`runGatedForTask`, core/orchestration/state.ts). `pendingStart` is the one that looks
    // redundant here — it is a one-way gate `startRun` clears, so a Run holding it cannot have
    // dispatched anything to lose. The shared predicate keeps it all the same, because
    // orchestration.json outlives the process and is hand-edited, and recovery is a second door into
    // starting workers: it holds to the same standard.
    if (runGatedForTask(state, task)) continue
    const lost = lostAttemptOf(state, task.id)
    if (!lost) continue
    out.push({ runId: runIdOf(task), taskId: task.id, dispatch: lost })
  }
  return out
}

/** The Task's most recent Dispatch when that one was lost, else undefined — and undefined while any of
 *  its Dispatches is still open (a fresh attempt is already running). The rule `candidates` applies, and
 *  the one the dispatch loop asks when it starts a Task again after a person answered the Gate a lost
 *  worker left (P1 carry-over 5): that new attempt is a retry of this one, as a reconciler re-dispatch is. */
export function lostAttemptOf(state: OrchState, taskId: string): Dispatch | undefined {
  const own = state.dispatches.filter((d) => d.taskId === taskId)
  // A `dispatched` Task always has one — openDispatch writes the Dispatch and the status together.
  // The guard is here because orchestration.json outlives the process and is hand-edited, the same
  // reason schedule.ts refuses to infer a Task's account from the command that made it.
  if (own.length === 0) return undefined
  if (own.some((d) => d.endedAt === undefined)) return undefined
  const latest = own.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
  return isLost(latest) ? latest : undefined
}
