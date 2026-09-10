// Draining the queue of reports that arrived while the app was not running.
//
// The CLI writes one file per undelivered report (core/orchestration/pendingReports.ts). This reads
// them and hands them back to the server as if they had arrived over the socket, so a queued report
// takes exactly the path a live one does — the same authorization, the same idempotency, the same
// validation and review that follow a `worker_done`.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parsePendingReport, type PendingReport } from '../../core/orchestration/pendingReports'

/** One report and the file it came out of, so the drain can clear it once it has been dealt with. */
export interface QueuedReport {
  /** Absolute path */
  file: string
  report: PendingReport
}

/** Moves a file out of the reader's way without destroying it. The suffix is appended to the whole
 *  name, so what is left no longer ends in `.json` and `readPendingReports` never picks it up
 *  again — the same one-way door `OrchestrationStore`'s `.bak` is, and for the same reason: a file
 *  the app could not use is still the only copy of what a worker said.
 *
 *  Best effort. If even the rename fails there is nothing further to try, and the caller has
 *  already logged what the file was. */
async function setAside(file: string, why: 'unreadable' | 'unapplied'): Promise<void> {
  await fs.rename(file, `${file}.${why}`).catch(() => {})
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
 *  **A refusal clears the file; a throw keeps it.** A refusal is the app having read the report and
 *  answered: `unknown dispatch`, or a Task that has moved on. That answer will be the same at every
 *  future start, so the file would sit there forever — the log line, which carries what the worker
 *  said, becomes the record instead. A throw is not an answer, so the report waits for the next
 *  start.
 *
 *  One report failing never stops the ones behind it: they are separate workers on separate Tasks. */
export async function applyPendingReports(a: {
  queued: readonly QueuedReport[]
  apply(r: PendingReport): Promise<{ ok: boolean; detail: string }>
  log(m: string): void
}): Promise<{ applied: number; rejected: number; kept: number }> {
  let applied = 0
  let rejected = 0
  let kept = 0
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
      kept++
      a.log(`pending reports: could not apply ${where}, leaving it for the next start: ${String(e)}`)
    }
  }
  return { applied, rejected, kept }
}
