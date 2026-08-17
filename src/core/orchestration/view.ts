// Read-only projections of OrchState for the Jobs sidebar. The renderer has no test environment
// (vitest runs environment: 'node', no jsdom), so every judgement the view needs lives here.
//
// This module is main-side, not renderer-side: it imports isSamePath, which pulls in node:path,
// so it must not be added to tsconfig.web.json's include. The renderer never calls these functions
// directly — it consumes the already-folded OrchSnapshot that snapshotFor (src/main/ipc.ts) builds
// from them. Adding this file to the web tsconfig to make an import resolve is the wrong fix; it
// either fails (files/tree.ts's node:path import has no declarations there) or "succeeds" by adding
// "types": ["node"], which loosens the guard that keeps Node globals out of the renderer typecheck.
import { isSamePath } from '../files/tree'
import type { OrchState } from './state'
import type { Run } from './types'

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
