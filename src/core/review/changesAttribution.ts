// The attribution of a changed-files list (Phase 3 Part 4 item 1), as `runs-changed-files` answers it when asked: each
// attempt in the list's scope read over its own ranges (its folder, then the project, which outlives a reaped worktree:
// attemptRanges, final review I1), its ancestry asked where its range was read, its audit records, then attributeFiles.
// Keyed by the list's file ids, so a Task part's file keeps its own. Attempts are read a few at a time.
import { isSamePath } from '../files/tree'
import type { ChangedFile } from '../git/changedFile'
import { attemptRanges, scopeAttempts } from '../orchestration/changedFiles'
import type { OrchState } from '../orchestration/state'
import type { Dispatch } from '../orchestration/types'
import { attributeFiles, type AttemptChanges, type FileAttribution } from './attribution'

export interface AttributionReads {
  read(repo: string, base: string, head: string | null): Promise<ChangedFile[] | null>
  isAncestor(repo: string, base: string, head: string): Promise<boolean | null>
  auditWrites?(a: { taskId: string; since: string; until: string }): Promise<ReadonlySet<string> | null>
}

/** At most this many attempts are read at a time. */
const ATTEMPT_READS_AT_ONCE = 4

export async function attributeChangedFiles(
  s: OrchState,
  a: { runId: string; taskId?: string; dispatchId?: string; files: readonly ChangedFile[]; now: string },
  d: AttributionReads
): Promise<Record<string, FileAttribution>> {
  const run = s.runs.find((r) => r.id === a.runId)
  const project = s.jobs.find((j) => j.id === run?.jobId)?.cwd ?? ''
  const attempts = scopeAttempts(s, a.runId, a.taskId, a.dispatchId).filter((x) => x.git?.base !== undefined)
  // Attempts past the bound are not read, so a file only they changed is unknown for want of a reading (final review M4)
  const someUnread = scopeAttempts(s, a.runId, a.taskId, a.dispatchId, Infinity).filter((x) => x.git?.base !== undefined).length > attempts.length
  const readOne = async (x: Dispatch): Promise<AttemptChanges> => {
    const base = x.git!.base!
    let files: string[] | null = null
    let fastForward: boolean | null = null
    for (const range of attemptRanges(s, a.runId, x.id)?.parts[0]?.ranges ?? []) {
      const got = await d.read(range.repo, range.base, range.head)
      if (!got) continue
      files = got.map((f) => f.path)
      fastForward = range.head !== null ? await d.isAncestor(range.repo, base, range.head) : null
      break
    }
    const audited = d.auditWrites ? ((await d.auditWrites({ taskId: x.taskId, since: x.startedAt, until: x.endedAt ?? a.now })) ?? undefined) : undefined
    return { dispatch: x, files, fastForward, shared: project !== '' && isSamePath(x.cwd, project), ...(audited !== undefined ? { audited } : {}) }
  }
  const changes: AttemptChanges[] = new Array(attempts.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < attempts.length) {
      const i = next++
      changes[i] = await readOne(attempts[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(ATTEMPT_READS_AT_ONCE, attempts.length) }, lane))
  const ids = new Set(attempts.map((x) => x.id))
  const byPath = attributeFiles([...new Set(a.files.map((f) => f.path))], changes, s.dispatches.filter((x) => !ids.has(x.id)), a.now, process.platform, { someUnread })
  return Object.fromEntries(a.files.map((f) => [f.id, byPath[f.path]]))
}
