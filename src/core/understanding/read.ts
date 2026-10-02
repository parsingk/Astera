// understanding.json read by something other than the app (MCP P2-C): the Host answers How It Works
// records to MCP clients from the same file the app writes. **Read only**: the app's
// UnderstandingStore is the file's one writer, so this never recovers, backs up or rewrites it.
//
// The shape guard lives here and the store imports it, so the two readers cannot drift on what a
// valid file is.
import { isSamePath } from '../files/tree'
import { readFileRetrying } from '../renameRetry'
import type { ProjectUnderstanding, RecordSource, RecordStatus, Verification, WorkRecord } from './types'

/** projectPath to that project's understanding. As in orchestration.json, projects are told apart by
 *  a key inside the file, not by separate files. */
export interface StoreShape {
  projects: Record<string, ProjectUnderstanding>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

function isUnderstanding(v: unknown): v is ProjectUnderstanding {
  if (!isObj(v)) return false
  return Array.isArray(v.records)
}

export function isValid(v: unknown): v is StoreShape {
  if (!isObj(v) || !isObj(v.projects)) return false
  return Object.values(v.projects).every(isUnderstanding)
}

/** The sentence every failure to read the file carries. **Nothing from the file goes with it**: the
 *  file holds the person's requests verbatim, and a parse error quotes the text it stopped at. */
export const UNREADABLE = 'understanding.json could not be read'

/** The file as it is on disk. A missing file is no records yet; any other failure, and a shape the
 *  store would not load, throws an Error whose message is `UNREADABLE` only. */
export async function readUnderstandingFile(filePath: string): Promise<StoreShape> {
  let text: string
  try {
    // Retried through a writer's rename-replace (EBUSY/EPERM on win32): that lasts milliseconds.
    text = await readFileRetrying(filePath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { projects: {} }
    throw new Error(UNREADABLE)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(UNREADABLE)
  }
  if (!isValid(parsed)) throw new Error(UNREADABLE)
  return parsed
}

/** A project's records, newest first. The keys are repository roots (ipc.ts `understandingKeyOf`),
 *  matched with `isSamePath` so a key spelt in another case or with other separators on win32 is
 *  still the project's.
 *
 *  **A malformed record is skipped**, not thrown on: the shape guard checks only that `records` is an
 *  array, so an entry that is not an object with a string `id` and `at` would otherwise fail the
 *  sort or the summary outside the caller's read refusal. A missing `changedFiles` reads as none. */
export function recordsFor(state: StoreShape, projectPath: string, platform: string = process.platform): WorkRecord[] {
  const key = Object.keys(state.projects).find((k) => isSamePath(k, projectPath, platform))
  if (key === undefined) return []
  return (state.projects[key].records as unknown[])
    .filter((r): r is WorkRecord => isObj(r) && typeof r.id === 'string' && typeof r.at === 'string')
    .map((r) => (Array.isArray(r.changedFiles) ? r : { ...r, changedFiles: [] }))
    .sort((a, b) => b.at.localeCompare(a.at))
}

export interface RecordSummary {
  id: string
  at: string
  /** The agent's short name for the work, or null before it wrote one. Never the request. */
  title: string | null
  request: string
  status: RecordStatus
  reason?: string
  source: RecordSource
  changedFiles: number
  verification: { status: Verification | 'passed' | 'unknown' } | null
}

/** One row of the list. `verification` falls back to the old `validation` field, as WorkRecord's own
 *  comment asks of every reader. */
export function recordSummary(r: WorkRecord): RecordSummary {
  const checked = r.verification ?? r.validation
  return {
    id: r.id,
    at: r.at,
    title: r.explanation?.title ?? null,
    request: r.request,
    status: r.status,
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    source: r.source,
    changedFiles: r.changedFiles.length,
    verification: checked ? { status: checked.status } : null
  }
}

/** The whole record: request, source, changed files, git, verification (or the old validation), Job
 *  tasks, status, reason and the explanation. */
export function recordDetail(r: WorkRecord): WorkRecord {
  return r
}
