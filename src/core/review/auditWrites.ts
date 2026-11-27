// The files the observe audit saw a Task's attempt write (Phase 3 Part 4): what raises an attribution from "recorded
// range" to "confirmed by observe audit". The audit keeps no Dispatch id and a roll changes the session id, so the
// Task and the attempt's window are what is asked. A record names a path relative to its session's folder, which is the
// attempt's folder and so the repo the range was read in; a record of several paths names only the first. Only in
// observe or enforce mode are there records: none answers null, never "nothing written".
import { queryRecords } from '../audit/store'

/** At most this many records are read for one attempt. */
const AUDIT_WRITES_MAX = 2000

export async function auditWriteTargets(
  profileDir: string,
  a: { taskId: string; since: string; until: string },
  query: typeof queryRecords = queryRecords
): Promise<ReadonlySet<string> | null> {
  let records
  try {
    records = await query(profileDir, { taskId: a.taskId, action: 'filesystem.write', since: a.since, until: a.until, limit: AUDIT_WRITES_MAX })
  } catch {
    return null
  }
  if (records.length === 0) return null
  return new Set(records.filter((r) => r.insideProject !== false).map((r) => r.target.replace(/ \(\+\d+\)$/, '')))
}
