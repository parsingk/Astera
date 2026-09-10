// Draining the queue of reports that arrived while the app was not running.
//
// The CLI writes one file per undelivered report (core/orchestration/pendingReports.ts). This reads
// them and hands them back to the server as if they had arrived over the socket, so a queued report
// takes exactly the path a live one does — the same authorization, the same idempotency, the same
// validation and review that follow a `worker_done`.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  parsePendingReport,
  pendingReportTempName,
  serializePendingReport,
  type PendingReport
} from '../../core/orchestration/pendingReports'

/** One report and the file it came out of, so the drain can clear it once it has been dealt with. */
export interface QueuedReport {
  /** Absolute path */
  file: string
  report: PendingReport
}

/** App starts a report is given before the drain stops trying to apply it.
 *
 *  **Three, because an attempt here is a whole app start rather than a retry in a loop.** A throw
 *  is either a passing condition (a locked file, a full disk) or a permanent one (a bug, a corrupt
 *  profile). Three starts span real time — minutes to days — which is generous for the passing
 *  kind, while a permanent one holds its Dispatch open for at most two extra starts before the
 *  Task is let go. Three is also the number this codebase already stops at when it has to stop
 *  trying (`FAILURE_LIMIT` in core/orchestration/types.ts); it is not imported, because a Task's
 *  consecutive failures and a queued report's boot attempts are different ceilings that should be
 *  able to move apart. */
export const MAX_APPLY_ATTEMPTS = 3

/** Writes the report back with its attempt count raised, under a temporary name first for the same
 *  reason the CLI does — the app can die at any point, and a half-written report is one the next
 *  start cannot read. Throws if it could not be written, which the caller reads as "the count
 *  cannot be recorded, so it cannot be bounded either". */
async function recordAttempt(file: string, report: PendingReport, attempts: number): Promise<void> {
  const tmp = pendingReportTempName(file)
  await fs.writeFile(tmp, serializePendingReport({ ...report, attempts }), 'utf8')
  await fs.rename(tmp, file)
}

/** Moves a file out of the reader's way without destroying it. The suffix is appended to the whole
 *  name, so what is left no longer ends in `.json` and `readPendingReports` never picks it up
 *  again — the same one-way door `OrchestrationStore`'s `.bak` is, and for the same reason: a file
 *  the app could not use is still the only copy of what a worker said.
 *
 *  Best effort, and it answers with the name it wrote so the caller can put it in the log: the file
 *  is the only remaining copy of what that worker reported, and a line that does not say where it
 *  went sends whoever reads it hunting through a folder. Null when even the rename failed, which the
 *  caller renders as no name rather than a wrong one. */
async function setAside(file: string, why: 'unreadable' | 'unapplied'): Promise<string | null> {
  const to = `${file}.${why}`
  return fs
    .rename(file, to)
    .then(() => path.basename(to))
    .catch(() => null)
}

/** Everything the queue folder holds, oldest attempt first.
 *
 *  Order is by file name, which is the moment each report was attempted (`pendingReportFileName`).
 *  Nothing on the list depends on the order — a second `worker_done` for one Dispatch is
 *  `alreadyReported` either way, and different Dispatches are independent — but the inbox reads in
 *  the order things happened, which is what a person going through it afterwards expects.
 *
 *  **A file it cannot read is set aside, not deleted.** A report this cannot read is not a report
 *  anyone knows is worthless — it may be a half-written file, or one this version does not
 *  understand. Renaming it out of the way stops it being retried and complained about at every
 *  start for as long as the profile lives, while leaving the evidence where a person can find it.
 *  A missing folder is the ordinary case, not a failure: it exists only once there has been
 *  something to queue. */
export async function readPendingReports(a: {
  dir: string
  log(m: string): void
}): Promise<QueuedReport[]> {
  const names = (await fs.readdir(a.dir).catch(() => [] as string[]))
    .filter((n) => n.endsWith('.json'))
    .sort()
  const out: QueuedReport[] = []
  for (const name of names) {
    const file = path.join(a.dir, name)
    const text = await fs.readFile(file, 'utf8').catch(() => null)
    const report = text === null ? null : parsePendingReport(text)
    if (!report) {
      a.log(`pending reports: setting aside ${name} — it is not a report this app can read`)
      await setAside(file, 'unreadable')
      continue
    }
    out.push({ file, report })
  }
  return out
}

/** Hands each report to `apply` in turn and clears the ones that are settled.
 *
 *  **A report's file goes only after it has been applied.** An app that dies in between applies that
 *  one report twice at the next start, which is why only replay-safe commands may be queued at all
 *  (`isQueueableReport`). The other order would lose the report instead, and losing reports is the
 *  thing this whole path exists to stop.
 *
 *  **A refusal clears the file; a throw keeps it, but not forever.** A refusal is the app having
 *  read the report and answered: `unknown dispatch`, or a Task that has moved on. That answer will
 *  be the same at every future start, so the file would sit there forever — the log line, which
 *  carries what the worker said, becomes the record instead. A throw is not an answer, so the
 *  report waits for the next start, with the attempt counted on the report itself.
 *
 *  **After `MAX_APPLY_ATTEMPTS` it is set aside.** Kept indefinitely, a report that throws every
 *  time is the one shape in this design with no way back: `reportedDispatchIdsOf` holds its
 *  Dispatch open at every start, so the Task never moves and recovery is never allowed to look at
 *  it, and there is no counter and no screen to see it on. Setting it aside ends that — the next
 *  start's cleanup closes the Dispatch and the reconciler is free to act — while the report itself
 *  stays on disk, and the log says loudly what was given up on.
 *
 *  One report failing never stops the ones behind it: they are separate workers on separate Tasks. */
export async function applyPendingReports(a: {
  queued: readonly QueuedReport[]
  apply(r: PendingReport): Promise<{ ok: boolean; detail: string }>
  log(m: string): void
}): Promise<{ applied: number; rejected: number; kept: number; gaveUp: number }> {
  let applied = 0
  let rejected = 0
  let kept = 0
  let gaveUp = 0
  for (const { file, report } of a.queued) {
    const where = `task=${String(report.args.taskId)} dispatch=${String(report.args.dispatchId)}`
    try {
      const r = await a.apply(report)
      if (r.ok) {
        applied++
        a.log(`pending reports: applied ${String(report.args.type)} ${where} — ${r.detail}`)
      } else {
        rejected++
        // The whole report goes into the line: once the file is gone this is all that is left of
        // what that worker reported, and someone will have to work out what happened from it.
        a.log(
          `pending reports: the app refused ${String(report.args.type)} ${where} — ${r.detail}. ` +
            `The report said: ${JSON.stringify(report.args)}`
        )
      }
      await fs.rm(file, { force: true }).catch(() => {})
    } catch (e) {
      const attempts = (report.attempts ?? 0) + 1
      // The count is written back before it is compared, so a rewrite that fails ends the loop
      // here rather than at some later start that can no longer tell how many there have been.
      const recorded = await recordAttempt(file, report, attempts)
        .then(() => true)
        .catch((err) => {
          a.log(`pending reports: could not record the attempt on ${where}: ${String(err)}`)
          return false
        })
      if (!recorded || attempts >= MAX_APPLY_ATTEMPTS) {
        gaveUp++
        const kept = await setAside(file, 'unapplied')
        // The file name goes in the line for the same reason the unreadable one names its file: the
        // report is still on disk and this is the only thing that says where. Naming it after the
        // move rather than before means the line cannot point at a name that was never written.
        a.log(
          `pending reports: giving up on ${where} after ${attempts} attempt(s) — the file is set ` +
            `aside${kept ? ` as ${kept}` : ''} and its Dispatch will be left to recovery at the ` +
            `next start. Last failure: ${String(e)}. The report said: ${JSON.stringify(report.args)}`
        )
      } else {
        kept++
        a.log(
          `pending reports: could not apply ${where}, attempt ${attempts} of ${MAX_APPLY_ATTEMPTS}, leaving it for the next start: ${String(e)}`
        )
      }
    }
  }
  return { applied, rejected, kept, gaveUp }
}
