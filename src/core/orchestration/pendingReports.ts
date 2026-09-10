// A report a worker could not deliver, written down instead of lost.
//
// The Host keeps workers running after the app closes, so a worker can finish its Task while there
// is no server to report to. Before this, `astera send --type worker_done` printed `request failed`
// and exited 1: the work was done, the record of it was gone, and the agent was left to guess what a
// failed command meant. The CLI now writes such a report into a file in the profile and says so; the
// app applies it at the next start.
//
// This module holds the decisions and the file format, with no filesystem in it: `src/cli/run.ts`
// writes, `src/main/orchestration/pendingDrain.ts` reads and applies.
import path from 'node:path'
import { workerDoneFieldError } from './sendArgs'

/** Folder beside the info file the CLI already reads (orch-info.json). One file per report rather
 *  than one appended log: two workers can finish at the same moment with the app gone, and two
 *  processes appending to one file can interleave into a line neither of them wrote. */
export const PENDING_REPORTS_DIR = 'pending-reports'

/** The queue lives beside `ASTERA_INFO`, which is the only path the CLI is given. The app reaches
 *  the same folder through `<userData>/orch`, where it writes that info file. */
export function pendingReportsDirFrom(infoPath: string): string {
  return path.join(path.dirname(infoPath), PENDING_REPORTS_DIR)
}

/** Message types a worker may leave behind in a file.
 *
 *  **Two entries, and the shortness is the point.** A queued command is one nobody answers until the
 *  app starts again, so the only thing that can go on this list is a command whose whole content is
 *  a report — the worker says what happened and then stops. Everything else must keep failing as it
 *  did: `ask` blocks for an answer and a file cannot answer it; `check`, `inbox` and `worker-read`
 *  read state that only a running app has; the run-*, task-* and worker-* commands are the
 *  coordinator's, and the coordinator is not running either.
 *
 *  These two are exactly what the coordinator writes into a worker's own instructions — the
 *  reporting obligation and the escalation line of `buildSpecFile` — which is the whole of what a
 *  worker is ever told to run unprompted. `status` and `heartbeat` are omitted deliberately: nothing
 *  tells a worker to send them, and a queue file is a poor place for news that was only ever
 *  incidental.
 *
 *  **Replay safety, which is what earns a place here.** The drain deletes a report's file only after
 *  applying it, so an app that dies in between applies that one report twice on the next start. A
 *  `worker_done` for an already-closed Dispatch comes back as the idempotent `alreadyReported`
 *  (`applyWorkerDone`), so it costs nothing. An `escalation` only appends a message, so a replay
 *  costs one duplicate line in the inbox — no state moves, and a person reads it once. Nothing that
 *  could act twice belongs here. */
const QUEUEABLE_TYPES = new Set(['worker_done', 'escalation'])

/** Is this the kind of command a file can stand in for, **and would the app accept it**.
 *
 *  The second half matters as much as the first. A report the server would refuse must fail now,
 *  the way it does today, so the worker sees the error and can correct itself. Queued instead, it
 *  would be answered "recorded, do not send it again", hold its Dispatch open through the next
 *  restart cleanup (`reportedDispatchIdsOf`), and then be refused by the drain — leaving that Task
 *  stalled for the rest of the app session over a missing `--outcome`. Worse than the failure it
 *  replaced.
 *
 *  `worker_done`'s fields are checked by the same function the server checks them with, so the two
 *  cannot drift. The Task and the Dispatch are then required of **both** types, which is stricter
 *  than the live path: the server fills a missing `dispatchId` on an escalation from the session's
 *  open Dispatch, and by the time a queue is drained there may be no open Dispatch to read it from
 *  — the worker's session died with the Host, or the restart cleanup closed it. An escalation with
 *  no `dispatchId` could therefore only ever be refused, and one with no `taskId` would be posted
 *  into whichever Run happened to be the most recent. */
export function isQueueableReport(a: { cmd: string; args: Record<string, unknown> }): boolean {
  if (a.cmd !== 'send') return false
  const type = a.args.type
  if (typeof type !== 'string' || !QUEUEABLE_TYPES.has(type)) return false
  if (typeof a.args.taskId !== 'string' || a.args.taskId.length === 0) return false
  if (typeof a.args.dispatchId !== 'string' || a.args.dispatchId.length === 0) return false
  return type !== 'worker_done' || workerDoneFieldError(a.args) === null
}

/** One undelivered report, as it sits on disk. `sessionId` is the worker's `ASTERA_SESSION`: the
 *  drain hands it back to the server as the caller, so the ownership check the live path makes
 *  ("cannot report for another dispatch") is made on the queued path too, unchanged. */
export interface PendingReport {
  /** ISO. Only for the record and for ordering — the outcome does not depend on it. */
  queuedAt: string
  sessionId: string
  cmd: string
  args: Record<string, unknown>
  /** How many app starts have tried to apply this and been thrown out of. Absent on a report the
   *  CLI has just written; the drain writes it back so the count survives the restart, because
   *  that is the only place it can live — the app that would hold it in memory is the app that is
   *  about to be gone. Its ceiling is the drain's (`MAX_APPLY_ATTEMPTS`). */
  attempts?: number
}

/** `<queuedAt>-<nonce>.json`, sortable by name because the timestamp is ISO with its punctuation
 *  removed — `:` is not a legal file name character on win32. The nonce keeps two reports queued in
 *  the same millisecond from being one file. */
export function pendingReportFileName(a: { queuedAt: string; nonce: string }): string {
  return `${a.queuedAt.replace(/[:.]/g, '')}-${a.nonce}.json`
}

/** The name a report is written under before it is renamed into place.
 *
 *  **The rename is what makes the queue safe to read at any moment.** The window this whole path
 *  exists for is the app not running, and the moment the app comes back is exactly the moment it
 *  reads the queue — so a worker can be writing its report as the drain lists the folder. Written
 *  in place, that report could be read half-finished; written here and renamed, it is either
 *  absent or whole. Same shape as `OrchestrationStore`'s own writes.
 *
 *  It must not end in `.json`, which is the only thing `readPendingReports` picks up. */
export function pendingReportTempName(fileName: string): string {
  return `${fileName}.tmp`
}

export function serializePendingReport(r: PendingReport): string {
  return JSON.stringify(r)
}

/** Null for anything that is not a report this module wrote. The file was written by a process that
 *  could be killed mid-write, and a half-written file must not stop the rest of the queue — the
 *  caller logs and discards a null. The command is re-checked against the list: a hand-edited file
 *  must not become a way to make the app run something at boot that no worker could have queued. */
export function parsePendingReport(text: string): PendingReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const r = parsed as Record<string, unknown>
  if (typeof r.queuedAt !== 'string' || typeof r.sessionId !== 'string') return null
  if (typeof r.cmd !== 'string') return null
  if (typeof r.args !== 'object' || r.args === null || Array.isArray(r.args)) return null
  const args = r.args as Record<string, unknown>
  if (!isQueueableReport({ cmd: r.cmd, args })) return null
  // A count that is not a whole number is read as no count rather than as a reason to throw the
  // report away — it only costs the report one more attempt than it should have had.
  const attempts =
    typeof r.attempts === 'number' && Number.isInteger(r.attempts) && r.attempts > 0
      ? r.attempts
      : undefined
  return {
    queuedAt: r.queuedAt,
    sessionId: r.sessionId,
    cmd: r.cmd,
    args,
    ...(attempts === undefined ? {} : { attempts })
  }
}

/** Dispatches a queued report already speaks for, so the restart cleanup can leave them open.
 *
 *  **Only a completion report counts.** `worker_done` is a worker saying its attempt ended; closing
 *  that Dispatch as `outcome_unknown` before the report is applied would throw the report away
 *  (`applyWorkerDone` answers `alreadyReported` for a Dispatch that already has `endedAt`) and hand
 *  the recovery reconciler a worker it reads as lost. An `escalation` says the opposite — the worker
 *  is stuck and still there — so a Dispatch held open on the strength of one would hide a genuinely
 *  lost worker from recovery for as long as the file sat there. */
export function reportedDispatchIdsOf(entries: readonly PendingReport[]): Set<string> {
  const out = new Set<string>()
  for (const e of entries) {
    if (e.args.type !== 'worker_done') continue
    if (typeof e.args.dispatchId === 'string' && e.args.dispatchId.length > 0)
      out.add(e.args.dispatchId)
  }
  return out
}

/** What the CLI prints in place of the server's answer.
 *
 *  **Recorded, not applied — and both halves have to land.** An agent told plainly that it succeeded
 *  may go on to do something that depends on state that has not moved, and one told plainly that it
 *  failed retries or gives up on work that is actually finished. So the body says the report is
 *  safe, says nothing has changed yet, and says not to send it again. It is deliberately not shaped
 *  like a server reply: no `ok`, no `sent`, no `error`.
 *
 *  **One notice answers both kinds of report, so it says nothing about what to do next.** After a
 *  `worker_done` the next step is to stop, and the spec file's reporting obligation already says so;
 *  after an `escalation` the worker is stuck and still has the work in front of it. A line telling
 *  it that its work here was finished would be false for half of the reports it is printed for.
 *
 *  **What it says about when it will be applied is hedged on purpose.** "The next time the app
 *  starts" was not true: the drain only runs on a start that has orchestration on, and whether it
 *  is on is not something the worker can see. And the reason not to re-send is that the app
 *  already has the report, not that a re-send would fail — once the app is back a re-send works
 *  perfectly well, and an agent that tries it and finds the notice wrong has no reason to believe
 *  the rest of it. */
export function undeliveredReportNotice(a: { path: string }): string {
  return JSON.stringify({
    queued: true,
    applied: false,
    path: a.path,
    note:
      'The app was not running, so this report could not be delivered. It has been written to the file ' +
      'named above, and the app applies it at the next start that has orchestration on. Nothing in ' +
      'the job has changed yet, so do not act as if this report had taken effect. Do not send it ' +
      'again either: the app already has it, and a second copy is only a second copy.'
  })
}
