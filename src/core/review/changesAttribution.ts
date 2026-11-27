// The attribution of a changed-files list (Phase 3 Part 4 item 1), as `runs-changed-files` answers it when asked: each
// attempt in the list's scope read over its own range, its ancestry and its audit records, then attributeFiles. Keyed by
// the list's file ids, so a Task part's file keeps its own.
import { isSamePath } from '../files/tree'
import type { ChangedFile } from '../git/changedFile'
import { scopeAttempts } from '../orchestration/changedFiles'
import type { OrchState } from '../orchestration/state'
import { attributeFiles, type AttemptChanges, type FileAttribution } from './attribution'

export interface AttributionReads {
  read(repo: string, base: string, head: string | null): Promise<ChangedFile[] | null>
  isAncestor(repo: string, base: string, head: string): Promise<boolean | null>
  auditWrites?(a: { taskId: string; since: string; until: string }): Promise<ReadonlySet<string> | null>
}

export async function attributeChangedFiles(
  s: OrchState,
  a: { runId: string; taskId?: string; dispatchId?: string; files: readonly ChangedFile[]; now: string },
  d: AttributionReads
): Promise<Record<string, FileAttribution>> {
  const run = s.runs.find((r) => r.id === a.runId)
  const project = s.jobs.find((j) => j.id === run?.jobId)?.cwd ?? ''
  const attempts = scopeAttempts(s, a.runId, a.taskId, a.dispatchId).filter((x) => x.git?.base !== undefined)
  const changes: AttemptChanges[] = []
  for (const x of attempts) {
    const base = x.git!.base!
    const head = x.endedAt !== undefined && x.git?.head !== undefined ? x.git.head : null
    const files = (await d.read(x.cwd, base, head))?.map((f) => f.path) ?? null
    const fastForward = head !== null ? await d.isAncestor(x.cwd, base, head) : null
    const audited = d.auditWrites ? ((await d.auditWrites({ taskId: x.taskId, since: x.startedAt, until: x.endedAt ?? a.now })) ?? undefined) : undefined
    changes.push({ dispatch: x, files, fastForward, shared: project !== '' && isSamePath(x.cwd, project), ...(audited !== undefined ? { audited } : {}) })
  }
  const ids = new Set(attempts.map((x) => x.id))
  const byPath = attributeFiles([...new Set(a.files.map((f) => f.path))], changes, s.dispatches.filter((x) => !ids.has(x.id)), a.now)
  return Object.fromEntries(a.files.map((f) => [f.id, byPath[f.path]]))
}
