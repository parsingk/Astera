// Which repos and ranges a Run's or a Task's changed files are read over (remote runtime design Phase 10, D10.1). Pure
// over state. A list is made of parts, each read from the first of its ranges git answers:
//
// - A Run: its root's range, then each Task that worked in a worktree of its own. A parallel Run's Tasks merge into the
//   project straight from their worktrees (integrate.ts runWorktrees), so the root's range alone would miss them; where
//   a Task's worktree was folded into the root, the root's list already has its files and the command keeps one each.
// - A Task: the folder of its last attempt (a retry can get a new worktree), from the first base recorded there.
//
// Within a part: while an attempt is open in its folder, that folder's working tree comes first (uncommitted edits
// included); otherwise the recorded range comes first, in the folder and then in the project, which outlives a reaped
// worktree. A folder that is the work's own is read as it is last, when nothing was recorded at its end.
//
// A Task that worked in its Run's shared folder alongside others gets that folder's range over its own attempts, so
// work committed there meanwhile by another Task shows too: git cannot tell them apart without a worktree each.
import { isSamePath } from '../files/tree'
import { runRootOf } from './integrate'
import type { OrchState } from './state'
import type { Dispatch } from './types'
import { CHANGES_MAX_FILES, type ChangedFile } from '../git/changedFile'

export interface GitReadRange {
  repo: string
  base: string
  /** Null: the working tree. */
  head: string | null
}

export interface ChangesPart {
  /** The Task this part is, for a Task in a worktree of its own; absent for a Run's root. */
  taskId?: string
  ranges: GitReadRange[]
}

const uniq = (xs: string[]): string[] => [...new Set(xs)]

function taskRanges(attempts: Dispatch[], project: string): GitReadRange[] {
  const open = [...attempts].reverse().find((d) => d.endedAt === undefined)
  const last = [...attempts].reverse().find((d) => d.git?.head !== undefined)
  const firstBaseIn = (cwd: string): string | undefined => attempts.find((d) => d.git?.base !== undefined && isSamePath(d.cwd, cwd))?.git?.base
  const ranges: GitReadRange[] = []
  if (open) {
    const base = firstBaseIn(open.cwd)
    if (base !== undefined) ranges.push({ repo: open.cwd, base, head: null })
    return ranges
  }
  if (last) {
    const base = firstBaseIn(last.cwd)
    if (base !== undefined) {
      ranges.push({ repo: last.cwd, base, head: last.git!.head! })
      if (project && !isSamePath(project, last.cwd)) ranges.push({ repo: project, base, head: last.git!.head! })
      ranges.push({ repo: last.cwd, base, head: null })
    }
    return ranges
  }
  // Ended with no head recorded: its folder as it is, if it is still there.
  const latest = attempts.at(-1)
  const base = latest ? firstBaseIn(latest.cwd) : undefined
  if (latest && base !== undefined) ranges.push({ repo: latest.cwd, base, head: null })
  return ranges
}

/** Null for an unknown Run, or a Task that is not the Run's. `parts` is empty when nothing was recorded (the work
 *  predates Phase 10, or its base could not be read); `reported` is what the workers said they changed. */
export function rangesFor(s: OrchState, runId: string, taskId?: string): { parts: ChangesPart[]; reported: string[] } | null {
  const run = s.runs.find((r) => r.id === runId)
  if (!run) return null
  const job = s.jobs.find((j) => j.id === run.jobId)
  const project = job?.cwd ?? ''
  const attemptsOf = (id: string): Dispatch[] =>
    s.dispatches.filter((d) => d.taskId === id && !d.review).sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  if (taskId !== undefined) {
    const task = s.tasks.find((t) => t.id === taskId && t.runId === runId)
    if (!task) return null
    const ranges = taskRanges(attemptsOf(taskId), project)
    return { parts: ranges.length > 0 ? [{ taskId, ranges }] : [], reported: task.filesModified ?? [] }
  }
  const tasks = s.tasks.filter((t) => t.runId === runId)
  const reported = uniq(tasks.flatMap((t) => t.filesModified ?? []))
  const root = runRootOf(run, job)
  const parts: ChangesPart[] = []
  const base = run.git?.base
  if (base !== undefined) {
    const openInRoot = tasks.some((t) => attemptsOf(t.id).some((d) => d.endedAt === undefined && isSamePath(d.cwd, root)))
    const live: GitReadRange = { repo: root, base, head: null }
    const recorded: GitReadRange[] =
      run.git?.head !== undefined ? [{ repo: project || root, base, head: run.git.head }] : []
    // The project folder moves on with other work once the Run's attempts there end: read as it is only while open.
    const ranges = openInRoot ? [live, ...recorded] : [...recorded, ...(run.worktree !== undefined ? [live] : [])]
    if (ranges.length > 0) parts.push({ ranges })
  }
  for (const t of tasks) {
    const attempts = attemptsOf(t.id)
    if (attempts.length === 0 || attempts.every((d) => isSamePath(d.cwd, root))) continue
    const ranges = taskRanges(attempts, project)
    if (ranges.length > 0) parts.push({ taskId: t.id, ranges })
  }
  return { parts, reported }
}

type Read = (repo: string, base: string, head: string | null) => Promise<ChangedFile[] | null>

/** Each part read from the first of its ranges git answers, joined into one list: the root's files first, then each
 *  Task part's files whose path the list does not have yet (a Task worktree folded into the root is already there). A
 *  Task part's file gets an id of its own, so its diff is read in its own range. `read` is false when no part could be
 *  read at all. */
export async function collectChanges(
  parts: ChangesPart[],
  read: Read
): Promise<{ read: boolean; files: Array<{ file: ChangedFile; range: GitReadRange }>; live: boolean; total: number }> {
  const files: Array<{ file: ChangedFile; range: GitReadRange }> = []
  const paths = new Set<string>()
  let any = false
  let live = false
  let total = 0
  for (const part of parts) {
    for (const range of part.ranges) {
      const got = await read(range.repo, range.base, range.head)
      if (!got) continue
      any = true
      if (range.head === null) live = true
      const listed = (got as ChangedFile[] & { total?: number }).total ?? got.length
      let added = 0
      for (const f of got) {
        if (paths.has(f.path)) continue
        paths.add(f.path)
        added++
        if (files.length < CHANGES_MAX_FILES)
          files.push({ file: part.taskId === undefined ? f : { ...f, id: `${f.id}~${part.taskId}`, taskId: part.taskId }, range })
      }
      // What git did not list (past its own cut) counts too.
      total += added + (listed - got.length)
      break
    }
  }
  return { read: any, files, live, total }
}
