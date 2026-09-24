// The Host's record of the merges it makes into a person's project folder (carry 1, R24).
//
// The long-lived Host merges worker branches while the app may be closed, or attach in the middle of
// the merge and so miss its `git-op begin` (final review m7). The app's Work Unit screen would then
// read that merge as an outside change. So the Host writes each merge down here — the HEAD before,
// first, and the HEAD after once it is done — and the app reads the file (Task 4).
//
// This file is the shape and the reader, shared by both sides; the writer is src/host/mergeRecords.ts.
// Node builtins only: it bundles into the Host.

import path from 'node:path'
import { readFileRetrying } from '../renameRetry'

export interface HostMergeRecord {
  id: string
  /** mergeInto, as the Host wrote it. Compared with isSamePath. */
  projectPath: string
  headBefore: string | null
  /** Absent while the merge runs. null when HEAD could not be read afterwards. */
  headAfter?: string | null
  startedAt: string
  endedAt?: string
}

/** How many records the file keeps, newest last. */
export const HOST_MERGES_KEPT = 200
/** How long an open record (no `endedAt`) counts as a merge in progress: above git's 30-second merge
 *  timeout, so a Host that died mid-merge leaves a record that stops explaining anything. */
export const MERGE_OPEN_MAX_MS = 120_000

/** `<profile>/host/merges.json`. */
export function hostMergesPathIn(profileDir: string): string {
  return path.join(profileDir, 'host', 'merges.json')
}

const isRecord = (v: unknown): v is HostMergeRecord => {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return (
    typeof r.id === 'string' &&
    typeof r.projectPath === 'string' &&
    typeof r.startedAt === 'string' &&
    (typeof r.headBefore === 'string' || r.headBefore === null)
  )
}

/** The records in a `{ "merges": [...] }` file. Malformed entries are dropped; anything else — not
 *  JSON, not that object — is no records. Never throws. */
export function parseHostMerges(text: string): HostMergeRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return []
  const merges = (parsed as { merges?: unknown }).merges
  return Array.isArray(merges) ? merges.filter(isRecord) : []
}

/** The records on disk; [] on any failure (no file, unreadable, damaged). */
export async function readHostMerges(file: string): Promise<HostMergeRecord[]> {
  try {
    return parseHostMerges(await readFileRetrying(file))
  } catch {
    return []
  }
}

/** Does the Host's own record of its merges explain this HEAD move — so the Work Unit collector
 *  does not write it down again as an outside change (Task 4, carry 1)?
 *
 *  **Two shapes of "yes", both bounded so an old or wrong record cannot explain forever (fix round 1,
 *  review I1/m1/m3).**
 *
 *  - An open record (no `endedAt`) explains *any* move of its folder, without looking at the heads at
 *    all — the app attached mid-merge and so never saw `git-op begin` for it, and per the Task 3
 *    review (m3) the Host broadcasts `git-op end` *before* it finishes writing `headAfter`, so a
 *    record whose `end` was just announced can still be open here. This rule stays **branch-blind**
 *    (an app attaching mid-merge cannot yet know which branch the merge will land on), but is now
 *    bounded on *both* sides of `startedAt` (review m3): the age must be `0 <= age <= MERGE_OPEN_MAX_MS`,
 *    so a record whose clock reads in the future (a skewed record, or the local clock set back) does
 *    not get to explain every move in the folder until real time catches up to it.
 *  - Otherwise, only when the branch did not change (`sameBranch`) does it walk a chain of *completed*
 *    records for the folder from `fromHead`, stepping through each one's `headBefore` → `headAfter`
 *    until it reaches `toHead` or runs out — a `Set` of consumed ids stops a cycle from looping
 *    forever. **Why gated on the branch (review I1):** the Host only ever merges into the checked-out
 *    branch and never switches one itself (`mergeRecords.ts`'s `mergeInto`), so a completed record can
 *    never be the reason a *branch switch* happened — without this, an aborted or no-op merge's
 *    harmless `a→a` record would explain away a person's later, unrelated switch to any branch sitting
 *    at `a`. **Why bounded by `sinceMs` (also I1):** only a record whose `endedAt` is at or after the
 *    stored snapshot's own `capturedAt` (read by the caller *before* this round moves it) counts — a
 *    merge that finished before the app had already caught up past its `headAfter` cannot be the
 *    reason for a *later*, unrelated move that happens to retrace the same heads (a redo, or another
 *    branch fast-forwarding to a head the Host produced on this one, days apart). **Why a record with
 *    a `null` `headAfter` is never a step (review m1):** a failed merge (`rev-parse` came back empty)
 *    cannot have landed anywhere in particular, so it is dropped from the chain outright — walking
 *    oldest-first (the order the file keeps them, `HOST_MERGES_KEPT`'s doc) would otherwise let it
 *    shadow a later, successful record sharing the same `headBefore`. */
export function explainedByHostMerges(a: {
  projectPath: string
  fromHead: string | null
  toHead: string | null
  records: readonly HostMergeRecord[]
  nowMs: number
  /** `before.branch === after.branch` in the caller. Gates only the completed-record chain — the
   *  open-record rule above ignores it. */
  sameBranch: boolean
  /** The stored snapshot's own `capturedAt` (ms since epoch), from *before* this round overwrote it.
   *  A completed record that ended earlier than this was already accounted for when that snapshot was
   *  captured, so it cannot explain a move discovered afterwards. */
  sinceMs: number
  samePath(a: string, b: string): boolean
}): boolean {
  if (a.fromHead === null || a.toHead === null) return false
  const mine = a.records.filter((r) => a.samePath(r.projectPath, a.projectPath))
  const openExplains = mine.some((r) => {
    if (r.endedAt !== undefined) return false
    const age = a.nowMs - Date.parse(r.startedAt)
    return age >= 0 && age <= MERGE_OPEN_MAX_MS
  })
  if (openExplains) return true
  if (!a.sameBranch) return false

  const completed = mine.filter(
    (r) =>
      r.endedAt !== undefined &&
      r.headAfter !== undefined &&
      r.headAfter !== null &&
      Date.parse(r.endedAt) >= a.sinceMs
  )
  const used = new Set<string>()
  let at: string = a.fromHead
  for (;;) {
    const next = completed.find((r) => !used.has(r.id) && r.headBefore === at)
    if (!next) return false
    if (next.headAfter === undefined || next.headAfter === null) return false // unreachable — completed already excludes this; keeps the assignment below typed as string
    used.add(next.id)
    at = next.headAfter
    if (at === a.toHead) return true
  }
}
