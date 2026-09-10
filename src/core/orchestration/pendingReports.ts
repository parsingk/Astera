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
import type { Dispatch } from './types'

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
  return queueableReportProblem(a) === null && a.cmd === 'send'
}

/**
 * Why this report cannot be queued, in words a worker can act on, or null when it can.
 *
 * The distinction matters because the two answers reach the worker differently. A command that is
 * not a report at all gets the transport's own reason, which is the truth for it: the app is not
 * there. A report whose fields are wrong gets **this** instead, because "the app is not running" is
 * useless to an agent that is one missing flag away from a report the app would have taken. It could
 * fix that itself, and only if it is told.
 */
export function queueableReportProblem(a: {
  cmd: string
  args: Record<string, unknown>
}): string | null {
  if (a.cmd !== 'send') return 'not a report'
  const type = a.args.type
  if (typeof type !== 'string' || !QUEUEABLE_TYPES.has(type)) return 'not a report'
  if (typeof a.args.taskId !== 'string' || a.args.taskId.length === 0)
    return '--task-id is required to record this report while the app is closed'
  if (typeof a.args.dispatchId !== 'string' || a.args.dispatchId.length === 0)
    return '--dispatch-id is required to record this report while the app is closed'
  return type === 'worker_done' ? workerDoneFieldError(a.args) : null
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
  return `${a.queuedAt.replace(/[:.]/g, '')}-${a.nonce}${REPORT_SUFFIX}`
}

/** What a finished report is named, and what `readPendingReports` picks up. */
const REPORT_SUFFIX = '.json'
const WORKING_SUFFIX = '.tmp'

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
  return `${fileName}${WORKING_SUFFIX}`
}

/** How old a working file has to be before nothing could still be writing it.
 *
 *  **An hour, against a write that takes a millisecond.** The write itself is one synchronous
 *  `writeFileSync` of a few hundred bytes followed by a same-directory rename — there is no
 *  network in it, no lock to wait on, and nothing that blocks on the app being up. An hour is four
 *  orders of magnitude of headroom for a machine paging badly or a filesystem stalling, and it is
 *  still short enough that a person who has to look in this folder does not find years of debris.
 *  It is a cutoff of the same kind as `RUN_TTL_MS`, which is how this codebase already decides that
 *  something on disk is dead. */
export const WORKING_FILE_TTL_MS = 60 * 60 * 1000

/** Is this leftover working file certainly nobody's.
 *
 *  A process killed between the write and the rename leaves `<name>.json.tmp` behind for good: the
 *  reader only picks up `.json`, so the file is never read, never applied, never counted and never
 *  removed. Both writers can leave one — the CLI's `writePendingReport` and the drain's own
 *  attempt-count rewrite.
 *
 *  **The rule is age, and the reason is that age cannot be wrong about a write in flight.** The
 *  other rule that does not guess is to put the writing process's id in the name and sweep only
 *  when that process is gone. It was not taken: a pid says nothing after a reboot, where the whole
 *  table is reused and a stale pid reads as alive forever — so the very leak this is fixing would
 *  become permanent for exactly the crash that causes it most often. It also asks the app to probe
 *  another process's liveness on two platforms to answer a question a timestamp answers outright.
 *
 *  **Anything it cannot judge survives.** A name that is not a working file, an age that does not
 *  make sense because the clock moved or the stat was odd — all false. Deleting a report in flight
 *  is the one failure this whole mechanism exists to prevent, and a file left behind costs a few
 *  hundred bytes until the next start looks again. */
export function isAbandonedWorkingFile(a: {
  name: string
  /** Epoch ms, as `fs.Stats.mtimeMs` gives it. */
  modifiedAt: number
  now: number
}): boolean {
  // A report's working name, not any temporary name: both writers rename a `.json` into place, so
  // that is the whole of what they can leave behind. Something else's scratch file in this folder
  // was not put there by this design and is not this function's to judge.
  if (!a.name.endsWith(`${REPORT_SUFFIX}${WORKING_SUFFIX}`)) return false
  if (!Number.isFinite(a.modifiedAt)) return false
  return a.now - a.modifiedAt >= WORKING_FILE_TTL_MS
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

/** Of the Dispatches the restart cleanup left open, the ones a queued report is the **only** reason
 *  for — so the drain can undo that one reason, and nothing else, when it turns out it cannot
 *  deliver the report after all.
 *
 *  **Why this is not just `reportedDispatchIdsOf` again.** `OrchestrationStore.load` leaves a
 *  Dispatch open for three reasons and a report is only one of them. A session the Host still runs
 *  is a worker that is demonstrably alive: writing its Dispatch off makes recovery's `isLost` read
 *  it as lost and start a second agent in the worktree the first one is still in, which is the
 *  failure the whole Host handshake exists to prevent — and a worker deliberately stays alive after
 *  reporting, so "alive and reported" is an ordinary state, not a contradiction. `'unknown'` is not
 *  evidence of anything, so nothing is named for that boot at all.
 *
 *  What is left is exactly the set the cleanup would have written off but for the report. Handing
 *  one of these back is putting the boot where it would have been. */
export function dispatchesHeldOnlyByReport(a: {
  dispatches: readonly Dispatch[]
  reported: ReadonlySet<string>
  alive: ReadonlySet<string> | 'unknown' | undefined
}): Set<string> {
  const out = new Set<string>()
  if (a.alive === 'unknown') return out
  for (const d of a.dispatches) {
    if (d.endedAt) continue
    if (!a.reported.has(d.id)) continue
    if (a.alive?.has(d.sessionId)) continue
    out.add(d.id)
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
