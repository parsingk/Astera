// Which repo and range a Run's or a Task's changed files are read over (remote runtime design Phase 10, D10.1). Pure
// over state: the ranges come out in the order to try them, and the first one git answers is the list. The live folder
// comes first while the work can still change (its working tree, uncommitted edits included); the recorded range in
// the project comes after, since it outlives a reaped worktree whose commits were merged there.
//
// A Task that worked in its Run's shared folder alongside others gets that folder's range over its own attempts, so
// work committed there meanwhile by another Task shows too: git cannot tell them apart without a worktree each.
import { runRootOf } from './integrate'
import type { OrchState } from './state'

export interface GitReadRange {
  repo: string
  base: string
  /** Null: the working tree. */
  head: string | null
}

const uniq = (xs: string[]): string[] => [...new Set(xs)]

/** Null for an unknown Run, or a Task that is not the Run's. `ranges` is empty when nothing was recorded (the work
 *  predates Phase 10, or its base could not be read); `reported` is what the workers said they changed. */
export function rangesFor(s: OrchState, runId: string, taskId?: string): { ranges: GitReadRange[]; reported: string[] } | null {
  const run = s.runs.find((r) => r.id === runId)
  if (!run) return null
  const job = s.jobs.find((j) => j.id === run.jobId)
  const project = job?.cwd ?? ''
  if (taskId !== undefined) {
    const task = s.tasks.find((t) => t.id === taskId && t.runId === runId)
    if (!task) return null
    const attempts = s.dispatches.filter((d) => d.taskId === taskId && !d.review).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    const reported = task.filesModified ?? []
    const first = attempts.find((d) => d.git?.base !== undefined)
    if (!first) return { ranges: [], reported }
    const base = first.git!.base!
    const head = [...attempts].reverse().find((d) => d.git?.head !== undefined)?.git?.head
    const ranges: GitReadRange[] = []
    if (attempts.some((d) => d.endedAt === undefined)) ranges.push({ repo: first.cwd, base, head: null })
    if (head !== undefined) ranges.push({ repo: first.cwd, base, head }, ...(project && project !== first.cwd ? [{ repo: project, base, head }] : []))
    return { ranges, reported }
  }
  const reported = uniq(s.tasks.filter((t) => t.runId === runId).flatMap((t) => t.filesModified ?? []))
  const base = run.git?.base
  if (base === undefined) return { ranges: [], reported }
  const root = runRootOf(run, job)
  const runTasks = new Set(s.tasks.filter((t) => t.runId === runId).map((t) => t.id))
  const open = s.dispatches.some((d) => runTasks.has(d.taskId) && d.endedAt === undefined)
  const ranges: GitReadRange[] = []
  // Its own worktree is its work alone, as long as it is there; the project folder is only while an attempt is open,
  // since after that it moves on with other work.
  if (run.worktree !== undefined || open) ranges.push({ repo: root, base, head: null })
  if (run.git?.head !== undefined) ranges.push({ repo: project || root, base, head: run.git.head })
  return { ranges, reported }
}
