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
//
// - One attempt (Phase 3 Part 4): that attempt's own range, its base..head as the Host recorded them, in its folder and
//   then in the project.
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

/** At most this many attempts are read for attribution (Phase 3 Part 4), the newest: one git read each. */
export const ATTRIBUTION_ATTEMPTS_MAX = 30

const attemptsOfTask = (s: OrchState, taskId: string): Dispatch[] =>
  s.dispatches.filter((d) => d.taskId === taskId && !d.review).sort((a, b) => a.startedAt.localeCompare(b.startedAt))

/** One attempt's own range (Phase 3 Part 4): null for an unknown attempt, a review attempt, or one whose Task is not the
 *  Run's; no part when its base was never recorded. */
export function attemptRanges(s: OrchState, runId: string, dispatchId: string): { parts: ChangesPart[]; reported: string[]; dispatch: Dispatch } | null {
  const d = s.dispatches.find((x) => x.id === dispatchId)
  if (!d || d.review) return null
  const task = s.tasks.find((t) => t.id === d.taskId && t.runId === runId)
  if (!task) return null
  const run = s.runs.find((r) => r.id === runId)
  const project = s.jobs.find((j) => j.id === run?.jobId)?.cwd ?? ''
  const base = d.git?.base
  const ranges: GitReadRange[] = []
  if (base !== undefined) {
    if (d.endedAt === undefined || d.git?.head === undefined) ranges.push({ repo: d.cwd, base, head: null })
    else {
      ranges.push({ repo: d.cwd, base, head: d.git.head })
      if (project && !isSamePath(project, d.cwd)) ranges.push({ repo: project, base, head: d.git.head })
    }
  }
  return { parts: ranges.length > 0 ? [{ taskId: task.id, ranges }] : [], reported: task.filesModified ?? [], dispatch: d }
}

/** The attempts a list's attribution reads (Phase 3 Part 4): one attempt, a Task's, or every Task's of the Run; review
 *  attempts left out, oldest first, the newest ATTRIBUTION_ATTEMPTS_MAX. */
export function scopeAttempts(s: OrchState, runId: string, taskId?: string, dispatchId?: string): Dispatch[] {
  const taskIds = new Set(s.tasks.filter((t) => t.runId === runId && (taskId === undefined || t.id === taskId)).map((t) => t.id))
  const all = [...taskIds]
    .flatMap((id) => attemptsOfTask(s, id))
    .filter((d) => dispatchId === undefined || d.id === dispatchId)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  return all.slice(-ATTRIBUTION_ATTEMPTS_MAX)
}

/** Null for an unknown Run, or a Task that is not the Run's. `parts` is empty when nothing was recorded (the work
 *  predates Phase 10, or its base could not be read); `reported` is what the workers said they changed. */
export function rangesFor(s: OrchState, runId: string, taskId?: string): { parts: ChangesPart[]; reported: string[] } | null {
  const run = s.runs.find((r) => r.id === runId)
  if (!run) return null
  const job = s.jobs.find((j) => j.id === run.jobId)
  const project = job?.cwd ?? ''
  const attemptsOf = (id: string): Dispatch[] => attemptsOfTask(s, id)
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
 *  read at all; `used` is the range each part that answered was read over (Phase 3 Part 4 names it). */
export async function collectChanges(
  parts: ChangesPart[],
  read: Read
): Promise<{ read: boolean; files: Array<{ file: ChangedFile; range: GitReadRange }>; live: boolean; total: number; used: Array<{ taskId?: string; range: GitReadRange }> }> {
  const files: Array<{ file: ChangedFile; range: GitReadRange }> = []
  const used: Array<{ taskId?: string; range: GitReadRange }> = []
  const paths = new Set<string>()
  let any = false
  let live = false
  let total = 0
  for (const part of parts) {
    for (const range of part.ranges) {
      const got = await read(range.repo, range.base, range.head)
      if (!got) continue
      any = true
      used.push({ ...(part.taskId !== undefined ? { taskId: part.taskId } : {}), range })
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
  return { read: any, files, live, total, used }
}
