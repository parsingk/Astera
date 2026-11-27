// A file's review findings for the diff being shown (Phase 3 Part 4 item 4), placed by the anchor the Host recorded
// (host/findingAnchors.ts): on their line when the diff is of the head the review began at and the hunk holding the line
// has the recorded fingerprint, even moved by edits above it; found on another revision when the diff is of another
// head (a later attempt, a rebase, the working tree); on the file otherwise (no anchor, no committed hunk, a hunk past a
// truncated cut, or a scope whose hunks differ). Each carries its state and history from the finding store. Pure.
import { hunkAt, parseHunks } from '../git/hunks'
import type { OrchState } from '../orchestration/state'
import { taskFindings, taskFoldersOf } from '../problems/completionProblems'
import { findingRef } from '../problems/findingRef'
import { repoPathMatches } from './repoPath'
import type { DiffFinding, FindingPlacement } from './types'

export type { DiffFinding, FindingPlacement } from './types'

export function diffFindings(
  s: OrchState,
  a: { taskIds: readonly string[]; path: string; repo: string; head: string | null; diff: string; truncated: boolean; platform?: string }
): DiffFinding[] {
  const platform = a.platform ?? process.platform
  let hunks: ReturnType<typeof parseHunks> | null = null
  const out: DiffFinding[] = []
  for (const taskId of a.taskIds) {
    const task = s.tasks.find((t) => t.id === taskId)
    if (!task) continue
    const folders = taskFoldersOf(s, task)
    const texts = new Map(taskFindings(task, folders).map((f) => [f.ref, f.text]))
    for (const issue of task.reviewIssues ?? []) {
      if (issue.file === undefined || !repoPathMatches(issue.file, a.path, a.repo, platform)) continue
      const ref = findingRef({ kind: 'review', taskId, file: issue.file, base: folders, message: issue.title })
      const rec = task.findingStates?.[ref]
      const anchor = task.findingAnchors?.[ref]
      let placement: FindingPlacement = 'file'
      if (anchor && anchor.head !== a.head) placement = 'other-revision'
      else if (anchor?.hunk !== undefined && anchor.line !== undefined) {
        hunks ??= parseHunks(a.diff)
        // A hunk cut short by the diff's byte bound has rows the diff does not show (final review M1)
        const hunk = hunkAt(hunks, anchor.line)
        if (hunk?.complete === true && hunk.fingerprint === anchor.hunk) placement = { line: anchor.line }
      }
      out.push({
        ref,
        taskId,
        title: issue.title,
        text: texts.get(ref) ?? issue.title,
        severity: issue.severity,
        ...(issue.line !== undefined ? { line: issue.line } : {}),
        state: rec?.state ?? 'open',
        ...(rec?.note !== undefined ? { note: rec.note } : {}),
        history: rec?.history ?? [],
        ...(anchor ? { head: anchor.head } : {}),
        placement
      })
    }
  }
  return out
}
