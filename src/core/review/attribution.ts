// Which agent attempt changed each file (Phase 3 Part 4 item 1), from what the Host recorded and nothing else: each
// attempt's own git range (Dispatch.git base..head), the folder it worked in and when. Never git author or mtime.
//
// - agent: the attempts whose ranges changed the file, when none of them shared its folder with another Dispatch at the
//   same time. Sequential attempts in one folder (an attempt, then its repair) each keep their own range.
// - mixed: such an attempt overlapped another Dispatch in the same folder, from any Run: their ranges cannot be told
//   apart.
// - unknown: no recorded range changed the file, a range that is not a fast-forward (a rebase or a cherry-pick), or
//   uncommitted edits in the Job's project folder, which a person also uses.
//
// The person's decision (2026-11-27): only recorded data says "mixed". Commits a person made in the same folder during an
// attempt are not told apart; the screen says so. Pure.
import { isSamePath } from '../files/tree'
import type { Dispatch } from '../orchestration/types'
import type { AttemptEvidence, FileAttribution } from './types'

export type { AttemptEvidence, AttributionKind, AttributionWhy, EvidenceLevel, FileAttribution } from './types'

export interface AttemptChanges {
  /** A non-review attempt with git.base. */
  dispatch: Dispatch
  /** Paths its own base..head (head null: the working tree) changed, repo-relative with '/', or null when git could not
   *  read them. */
  files: string[] | null
  /** base is an ancestor of head; null when not asked (an open attempt) or git could not tell. */
  fastForward: boolean | null
  /** Its folder is the Job's project folder, which a person also uses (not an Astera worktree). */
  shared: boolean
  /** Paths the observe audit saw this attempt's Task write in its window; undefined with no records. */
  audited?: ReadonlySet<string>
}

const evidenceOf = (a: AttemptChanges): AttemptEvidence => {
  const d = a.dispatch
  return {
    dispatchId: d.id,
    taskId: d.taskId,
    provider: d.provider,
    accountId: d.accountId,
    sessionId: d.sessionId,
    ...(d.nativeSessionId !== undefined ? { nativeSessionId: d.nativeSessionId } : {}),
    cwd: d.cwd,
    base: d.git?.base ?? '',
    head: d.endedAt === undefined ? null : (d.git?.head ?? null)
  }
}

/** Each path's attribution. `others` is every other Dispatch on record (any Run), for the overlap rule; review attempts
 *  among them are left out, as a reviewer changes nothing. `now` closes an open window. */
export function attributeFiles(
  paths: readonly string[],
  attempts: readonly AttemptChanges[],
  others: readonly Dispatch[],
  now: string,
  platform: string = process.platform
): Record<string, FileAttribution> {
  const at = (iso: string): number => Date.parse(iso)
  const end = (d: Dispatch): number => at(d.endedAt ?? now)
  const workers = [...attempts.map((a) => a.dispatch), ...others].filter((d) => d.review !== true)
  const overlaps = (d: Dispatch): boolean =>
    workers.some((o) => o.id !== d.id && isSamePath(o.cwd, d.cwd, platform) && at(o.startedAt) < end(d) && at(d.startedAt) < end(o))
  const ordered = [...attempts].sort((a, b) => a.dispatch.startedAt.localeCompare(b.dispatch.startedAt))
  const out: Record<string, FileAttribution> = {}
  for (const path of paths) {
    const touching = ordered.filter((a) => a.files?.includes(path) === true)
    const evidence = touching.map(evidenceOf)
    if (touching.length === 0) out[path] = { kind: 'unknown', why: 'no-range', evidence: [] }
    else if (touching.some((a) => a.fastForward === false)) out[path] = { kind: 'unknown', why: 'not-fast-forward', evidence }
    else if (touching.some((a) => a.dispatch.endedAt === undefined && a.shared)) out[path] = { kind: 'unknown', why: 'shared-folder-live', evidence }
    else if (touching.some((a) => overlaps(a.dispatch))) out[path] = { kind: 'mixed', why: 'overlap', evidence }
    else out[path] = { kind: 'agent', level: touching.every((a) => a.audited?.has(path) === true) ? 'observe-audit' : 'recorded-range', evidence }
  }
  return out
}
