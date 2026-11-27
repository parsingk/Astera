// Where each review finding was made (Phase 3 Part 4 item 3), recorded by the Host as reviews end: the head the review
// began at (the review attempt's recorded git.base, read by runGitRecorder when the attempt opened) and, when the finding
// names a line inside a committed hunk of the Task's range, that hunk's fingerprint. The diff shows a finding on its line
// only against the same head and hunk (core/review/diffFindings.ts); Problems marks it stale once the Task's head moves.
//
// - A Task's newest review attempt that has ended and has a base is the round; a round is anchored once.
// - The Task's base is the first base its own attempts recorded in the folder the review read.
// - No base, a base equal to the head (nothing committed yet: the reviewer read the working tree), a line outside every
//   hunk, or a git read that fails: the anchor has the head alone.
//
// At most ANCHOR_READS_AT_ONCE Tasks are read at a time; nothing here throws. Written through `tasks-anchors-record`,
// the Host's own record.
import { isSamePath } from '../core/files/tree'
import type { ChangedFile } from '../core/git/changedFile'
import { hunkAt, parseHunks } from '../core/git/hunks'
import type { OrchState } from '../core/orchestration/state'
import type { FindingAnchor, Task } from '../core/orchestration/types'
import { taskFoldersOf } from '../core/problems/completionProblems'
import { findingRef } from '../core/problems/findingRef'
import { repoPathOf, sameRepoPath } from '../core/review/repoPath'

export interface FindingAnchorDeps {
  /** `tasks-anchors-record` as the Host itself. */
  record(args: { task: string; anchors: Record<string, Omit<FindingAnchor, 'at'>> }): Promise<unknown>
  read(repo: string, base: string, head: string): Promise<ChangedFile[] | null>
  diff(repo: string, base: string, head: string, f: ChangedFile): Promise<{ diff: string; truncated: boolean } | null>
  log(m: string): void
}

const ANCHOR_READS_AT_ONCE = 2

export function createFindingAnchorRecorder(d: FindingAnchorDeps): { onState(s: OrchState): void } {
  /** `<task>:<review attempt>` rounds being anchored or done. A failed write leaves, so a later state tries again. */
  const taken = new Set<string>()
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

  const anchorRound = async (s: OrchState, task: Task, review: { id: string; cwd: string; head: string }): Promise<void> => {
    const folders = taskFoldersOf(s, task)
    const base = s.dispatches
      .filter((x) => x.taskId === task.id && !x.review && x.git?.base !== undefined && isSamePath(x.cwd, review.cwd))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0]?.git?.base
    let files: ChangedFile[] | null | undefined
    const diffs = new Map<string, string | null>()
    const anchors: Record<string, Omit<FindingAnchor, 'at'>> = {}
    for (const issue of task.reviewIssues ?? []) {
      if (issue.file === undefined) continue
      const ref = findingRef({ kind: 'review', taskId: task.id, file: issue.file, base: folders, message: issue.title })
      if (task.findingAnchors?.[ref]?.review === review.id) continue
      const anchor: Omit<FindingAnchor, 'at'> = { review: review.id, head: review.head, file: issue.file, ...(issue.line !== undefined ? { line: issue.line } : {}) }
      if (base !== undefined && base !== review.head && issue.line !== undefined) {
        if (files === undefined) files = await d.read(review.cwd, base, review.head).catch(() => null)
        const path = repoPathOf(issue.file, review.cwd)
        const f = files?.find((x) => sameRepoPath(x.path, path))
        if (f) {
          if (!diffs.has(f.path)) diffs.set(f.path, (await d.diff(review.cwd, base, review.head, f).catch(() => null))?.diff ?? null)
          const text = diffs.get(f.path)
          const hunk = text ? hunkAt(parseHunks(text), issue.line) : null
          if (hunk) anchor.hunk = hunk.fingerprint
        }
      }
      anchors[ref] = anchor
    }
    if (Object.keys(anchors).length === 0) return
    await d.record({ task: task.id, anchors })
  }

  return {
    onState(s) {
      for (const task of s.tasks) {
        if (!(task.reviewIssues ?? []).some((i) => i.file !== undefined)) continue
        const review = s.dispatches
          .filter((x) => x.taskId === task.id && x.review === true && x.endedAt !== undefined && x.git?.base !== undefined)
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
          .at(-1)
        if (!review) continue
        const key = `${task.id}:${review.id}`
        if (taken.has(key)) continue
        taken.add(key)
        const round = { id: review.id, cwd: review.cwd, head: review.git!.base! }
        queue.push(() =>
          anchorRound(s, task, round).catch((e: unknown) => {
            taken.delete(key)
            d.log(`the review findings of task ${task.id} could not be anchored: ${e instanceof Error ? e.message : String(e)}`)
          })
        )
      }
      pump()
    }
  }
}
