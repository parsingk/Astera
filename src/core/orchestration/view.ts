// Read-only projections of OrchState for the Jobs sidebar. The renderer has no test environment
// (vitest runs environment: 'node', no jsdom), so every judgement the view needs lives here.
//
// This module is main-side, not renderer-side: it imports isSamePath, which pulls in node:path,
// so it must not be added to tsconfig.web.json's include. The renderer never calls these functions
// directly — it consumes the already-folded OrchSnapshot that snapshotFor returns, which the
// 'orch.list' handler and the 'orch:state' push (src/main/ipc.ts) both hand across the bridge.
// Adding this file to the web tsconfig to make an import resolve is the wrong fix; it
// either fails (files/tree.ts's node:path import has no declarations there) or "succeeds" by adding
// "types": ["node"], which loosens the guard that keeps Node globals out of the renderer typecheck.
import { isSamePath } from '../files/tree'
import type { JobTask, OrchSnapshot } from '../types'
import type { OrchState } from './state'
import type { Run, Task } from './types'

/** The Runs belonging to one project, open ones first and newest first within each group.
 *
 *  Matching is isSamePath rather than ===: Run.cwd is the project root (worktrees are created per
 *  Dispatch, not per Run — see coordinator.ts), but the same path can arrive with a different drive
 *  letter or casing on win32, and a string compare would silently drop the Run from the list.
 *  isPathWithin (base-or-below) is the wrong shape here, not just a stricter one than needed:
 *  orchestration.json is a single app-wide store, not scoped per project, and nothing constrains
 *  what --cwd a Run is created with, so "at or below" would also match a Run whose cwd is a nested
 *  repository below this project root — a Run that belongs to that nested project, not this one. */
export function runsForProject(state: OrchState, projectPath: string): Run[] {
  return state.runs
    .filter((r) => isSamePath(projectPath, r.cwd))
    .sort((a, b) => {
      if ((a.status === 'open') !== (b.status === 'open')) return a.status === 'open' ? -1 : 1
      return b.createdAt.localeCompare(a.createdAt)
    })
}

/** Completed Tasks over total Tasks, unweighted.
 *
 *  'failed' does not count as done: a Task can still be retried until consecutiveFailures reaches
 *  FAILURE_LIMIT, and counting it would make the bar run ahead and then fall back on the next
 *  attempt. (The direction document's mock reads "5/7 … 78%"; 5/7 is 71% — the ratio here is the
 *  plain one, not that figure.) */
export function progressOf(state: OrchState, runId: string): { done: number; total: number } {
  const tasks = state.tasks.filter((t) => t.runId === runId)
  return { done: tasks.filter((t) => t.status === 'completed').length, total: tasks.length }
}

/** One Task row.
 *
 *  sessionId comes from the Task's most recent Dispatch, not from the open one: a retry opens a new
 *  Dispatch for the same Task, and a finished worker's session is still the session this row points
 *  at. It is dropped unless isKnownSession accepts it — that predicate asks whether **this process
 *  still has a session under that id**, which excludes exactly two things:
 *
 *  - the `pending:<hex>` placeholder worker-start commits before the coordinator has produced a real
 *    session id (server.ts) — that value names no session and would otherwise reach the renderer on
 *    every dispatch, for as long as the spawn and the worktree take;
 *  - a Dispatch left over from a previous app run — orchestration.json outlives the process, the
 *    session map does not.
 *
 *  It is **not** a liveness check and must not be read as one. A worker that exited keeps its entry
 *  in the session map (SessionManager only flips status to 'exited'; nothing is ever removed), so its
 *  tab is still there and its row stays clickable — which is what the user wants after a worker
 *  finishes. worker-release kills the PTY, and that lands in the same place: still listed, still
 *  clickable. */
function jobTaskOf(
  state: OrchState,
  task: Task,
  isKnownSession: (sessionId: string) => boolean
): JobTask {
  const dispatches = state.dispatches
    .filter((d) => d.taskId === task.id)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  const latest = dispatches[dispatches.length - 1]
  const open = state.gates
    .filter((g) => g.taskId === task.id && g.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    sessionId: latest && isKnownSession(latest.sessionId) ? latest.sessionId : undefined,
    // The oldest open Gate is the one the orchestrator has to answer first, so that is the question
    // the row shows. openGates carries the rest as a count rather than a second question.
    gateQuestion: open[0]?.question,
    openGates: open.length
  }
}

/** The whole Jobs sidebar payload for one project — what both 'orch.list' and the 'orch:state' push
 *  send. Folding here rather than in the IPC layer is what makes these rules testable: src/main/ipc.ts
 *  imports electron at line 1 and exposes nothing but registerIpc(core, win, …), so a function defined
 *  inside it cannot be reached by a test at all. That is a property of **that file**, not of main —
 *  vitest.config.ts includes main's test files as well and 32 of them exist. The renderer is the
 *  layer with no test environment at all (vitest runs environment: 'node', no jsdom).
 *
 *  isKnownSession is injected because session ownership belongs to main (core.sessions.list()) and
 *  this layer is framework-free. */
export function snapshotFor(
  state: OrchState,
  projectPath: string,
  isKnownSession: (sessionId: string) => boolean
): OrchSnapshot {
  return {
    runs: runsForProject(state, projectPath).map((run) => {
      const { done, total } = progressOf(state, run.id)
      return {
        id: run.id,
        objective: run.objective,
        status: run.status,
        done,
        total,
        // createdAt ascending — the order the orchestrator declared the Tasks in, which is the order
        // the dependency chain reads in. Task.deps is not a total order, so it cannot sort this.
        tasks: state.tasks
          .filter((t) => t.runId === run.id)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((t) => jobTaskOf(state, t, isKnownSession))
      }
    })
  }
}

/** Whether two folds show the same thing — the guard that keeps a push from going out when nothing
 *  the view can see has changed.
 *
 *  Most orchestration writes do not touch this projection at all: a heartbeat, a status message, a
 *  Delivery being taken or acknowledged, a Dispatch's tail moving. All of them commit state, and the
 *  push hangs off every commit (src/main/ipc.ts), so without this the sidebar is re-sent constantly
 *  with an identical payload. Comparing the result instead of debouncing the trigger kills the whole
 *  class and has nothing to tune.
 *
 *  **This is a serialized compare, and it is only sound for values snapshotFor built.** JSON.stringify
 *  is key-order sensitive, and what makes that safe here is that both sides come out of the object
 *  literals above, so the key order is fixed by this file rather than by the caller. An absent
 *  optional (sessionId, gateQuestion) is dropped from the string entirely, which is still correct —
 *  it can only be dropped on both sides at once, and any change into or out of undefined changes the
 *  string. If this ever has to compare snapshots from another source, replace it with a structural
 *  compare rather than trying to normalise the input. */
export const sameSnapshot = (a: OrchSnapshot, b: OrchSnapshot): boolean =>
  JSON.stringify(a) === JSON.stringify(b)
