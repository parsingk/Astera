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
 *  **Two shapes of "yes".** An open record (no `endedAt`) younger than `MERGE_OPEN_MAX_MS` explains
 *  *any* move of its folder, without looking at the heads at all — the app attached mid-merge and so
 *  never saw `git-op begin` for it, and per the Task 3 review (m3) the Host broadcasts `git-op end`
 *  *before* it finishes writing `headAfter`, so a record whose `end` was just announced can still be
 *  open here. A round with no such record instead walks a chain of *completed* records for the
 *  folder from `fromHead`, newest first (a Host that merged twice writes two records, and the second
 *  one's `headBefore` is the first one's `headAfter`), stepping until it reaches `toHead` or runs out
 *  — a `Set` of consumed ids stops a cycle from looping forever. */
export function explainedByHostMerges(a: {
  projectPath: string
  fromHead: string | null
  toHead: string | null
  records: readonly HostMergeRecord[]
  nowMs: number
  samePath(a: string, b: string): boolean
}): boolean {
  if (a.fromHead === null || a.toHead === null) return false
  const mine = a.records.filter((r) => a.samePath(r.projectPath, a.projectPath))
  const openExplains = mine.some(
    (r) => r.endedAt === undefined && a.nowMs - Date.parse(r.startedAt) <= MERGE_OPEN_MAX_MS
  )
  if (openExplains) return true

  const completed = mine.filter((r) => r.endedAt !== undefined)
  const used = new Set<string>()
  let at: string | null = a.fromHead
  for (;;) {
    const next = completed.find((r) => !used.has(r.id) && r.headBefore === at)
    if (!next) return false
    used.add(next.id)
    at = next.headAfter ?? null
    if (at === a.toHead) return true
    if (at === null) return false
  }
}
