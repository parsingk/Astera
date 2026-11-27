// Where each review finding was made (Phase 3 Part 4 item 3), recorded by the Host as reviews end: the head the review
// began at (the review attempt's recorded git.base, read by runGitRecorder when the attempt opened) and, when the finding
// names a line inside a committed hunk of the Task's range, that hunk's fingerprint. The diff shows a finding on its line
// only against the same head and hunk (core/review/diffFindings.ts); Problems marks it stale once the Task moves on.
//
// - An anchor belongs to the issue that made it (ReviewIssue.id, new every round): a finding is anchored again only when
//   a new round reissued it, never because a later review ended without a verdict (final review I2).
// - The round's head is the newest ended review attempt's base; while that base is not recorded, nothing is anchored
//   rather than an older review's head used (final review I2).
// - The Task's base is the first base its own attempts recorded in the folder the review read. The range is read in that
//   folder, then in the project, which outlives a reaped worktree (final review I1).
// - No base, a base equal to the head (nothing committed yet: the reviewer read the working tree), a line outside every
//   whole hunk, a diff cut at its byte bound, or a git read that fails: the anchor has the head alone. A line that is not
//   a positive line is left out, and a name over the bound skips its issue (final review I3).
//
// Written through `tasks-anchors-record`, the Host's own record: a refused reply is logged and the round settled; a write
// that throws is tried again after ANCHOR_RETRY_MS. At most ANCHOR_READS_AT_ONCE Tasks are read at a time, and a Task
// whose issues and reviews did not move since it was last settled is skipped without reading (final review M12).
// Nothing here throws.
import { isSamePath } from '../core/files/tree'
import type { ChangedFile } from '../core/git/changedFile'
import { hunkAt, parseHunks } from '../core/git/hunks'
import type { OrchState } from '../core/orchestration/state'
import type { FindingAnchor, Task } from '../core/orchestration/types'
import { taskFoldersOf } from '../core/problems/completionProblems'
import { findingRef } from '../core/problems/findingRef'
import { repoPathMatches, repoPathOf, sameRepoPath } from '../core/review/repoPath'

export interface FindingAnchorDeps {
  /** `tasks-anchors-record` as the Host itself; its reply (`{ status, body }`). */
  record(args: { task: string; anchors: Record<string, Omit<FindingAnchor, 'at'>> }): Promise<unknown>
  read(repo: string, base: string, head: string): Promise<ChangedFile[] | null>
  diff(repo: string, base: string, head: string, f: ChangedFile): Promise<{ diff: string; truncated: boolean } | null>
  log(m: string): void
  /** Epoch milliseconds, for the wait after a failed write. */
  now?(): number
}

const ANCHOR_READS_AT_ONCE = 2
/** How long a round whose write threw waits before it is tried again. */
const ANCHOR_RETRY_MS = 60_000
/** The longest file name an anchor keeps, as tasks-anchors-record allows. */
const ANCHOR_FILE_MAX = 1024

type Round = { task: Task; review: { id: string; cwd: string; head: string }; project: string; key: string }

export function createFindingAnchorRecorder(d: FindingAnchorDeps): { onState(s: OrchState): void } {
  const now = d.now ?? Date.now
  /** Rounds being anchored or settled, by `<task>:<review>:<issue ids>`. */
  const taken = new Set<string>()
  /** A round whose write threw: not tried again before then. */
  const notBefore = new Map<string, number>()
  /** Each Task's last settled shape (its issue ids and newest review), skipped while it holds. */
  const settledShape = new Map<string, string>()
  const queue: Array<() => Promise<void>> = []
  let running = 0
  const pump = (): void => {
    while (running < ANCHOR_READS_AT_ONCE && queue.length > 0) {
      const job = queue.shift()!
      running++
      void job().finally(() => {
        running--
        pump()
      })
    }
  }

  /** The repo-relative path git names for an issue's file: the same path, else its one ending (a subfolder project). */
  const fileIn = (files: ChangedFile[], file: string, repo: string): ChangedFile | undefined => {
    const exact = files.find((x) => sameRepoPath(x.path, repoPathOf(file, repo)))
    if (exact) return exact
    const ends = files.filter((x) => repoPathMatches(file, x.path, repo))
    return ends.length === 1 ? ends[0] : undefined
  }

  const anchorRound = async (s: OrchState, round: Round): Promise<void> => {
    const { task, review, project } = round
    const folders = taskFoldersOf(s, task)
    const base = s.dispatches
      .filter((x) => x.taskId === task.id && !x.review && x.git?.base !== undefined && isSamePath(x.cwd, review.cwd))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]?.git?.base
    // The range, in the review's folder and then in the project
    let read: { repo: string; files: ChangedFile[] } | null | undefined
    const readRange = async (): Promise<{ repo: string; files: ChangedFile[] } | null> => {
      for (const repo of project && !isSamePath(project, review.cwd) ? [review.cwd, project] : [review.cwd]) {
        const files = await d.read(repo, base!, review.head).catch(() => null)
        if (files) return { repo, files }
      }
      return null
    }
    const diffs = new Map<string, { diff: string; truncated: boolean } | null>()
    const anchors: Record<string, Omit<FindingAnchor, 'at'>> = {}
    for (const issue of task.reviewIssues ?? []) {
      if (issue.file === undefined || issue.file.length > ANCHOR_FILE_MAX) continue
      const ref = findingRef({ kind: 'review', taskId: task.id, file: issue.file, base: folders, message: issue.title })
      if (task.findingAnchors?.[ref]?.issue === issue.id) continue
      const line = Number.isInteger(issue.line) && (issue.line as number) >= 1 ? (issue.line as number) : undefined
      const anchor: Omit<FindingAnchor, 'at'> = { review: review.id, issue: issue.id, head: review.head, file: issue.file, ...(line !== undefined ? { line } : {}) }
      if (base !== undefined && base !== review.head && line !== undefined) {
        if (read === undefined) read = await readRange()
        const f = read ? fileIn(read.files, issue.file, read.repo) : undefined
        if (read && f) {
          if (!diffs.has(f.path)) diffs.set(f.path, await d.diff(read.repo, base, review.head, f).catch(() => null))
          const got = diffs.get(f.path)
          // A diff cut at its byte bound names no real hunk (final review M1)
          const hunk = got && !got.truncated ? hunkAt(parseHunks(got.diff), line) : null
          if (hunk?.complete === true) anchor.hunk = hunk.fingerprint
        }
      }
      anchors[ref] = anchor
    }
    if (Object.keys(anchors).length === 0) return
    const reply = (await d.record({ task: task.id, anchors })) as { status?: unknown; body?: unknown } | undefined
    if (typeof reply?.status === 'number' && reply.status >= 400) {
      const why = (reply.body as { error?: unknown } | undefined)?.error
      d.log(`the Host refused the review finding anchors of task ${task.id} (${reply.status}): ${typeof why === 'string' ? why : 'no reason'}`)
    }
  }

  return {
    onState(s) {
      for (const task of s.tasks) {
        const issues = (task.reviewIssues ?? []).filter((i) => i.file !== undefined)
        if (issues.length === 0) continue
        const review = s.dispatches
          .filter((x) => x.taskId === task.id && x.review === true && x.endedAt !== undefined)
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
          .at(-1)
        // The newest review's head, never an older one's; wait while it is not recorded (final review I2)
        if (!review || review.git?.base === undefined) continue
        const shape = `${issues.map((i) => i.id).join(',')}|${review.id}`
        if (settledShape.get(task.id) === shape) continue
        const key = `${task.id}:${shape}`
        if (taken.has(key) || (notBefore.get(key) ?? 0) > now()) continue
        taken.add(key)
        const run = s.runs.find((r) => r.id === task.runId)
        const project = s.jobs.find((j) => j.id === (task.jobId ?? run?.jobId))?.cwd ?? ''
        const round: Round = { task, review: { id: review.id, cwd: review.cwd, head: review.git.base }, project, key }
        queue.push(() =>
          anchorRound(s, round).then(
            () => {
              settledShape.set(task.id, shape)
            },
            (e: unknown) => {
              taken.delete(key)
              notBefore.set(key, now() + ANCHOR_RETRY_MS)
              d.log(`the review findings of task ${task.id} could not be anchored: ${e instanceof Error ? e.message : String(e)}`)
            }
          )
        )
      }
      pump()
    }
  }
}
