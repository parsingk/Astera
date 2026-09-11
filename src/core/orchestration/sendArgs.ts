// What `send` refuses to work without.
//
// The server's own `send` handler is the authority on this, and this file is that check lifted out
// of it so a second caller can ask the same question before the server is reachable. Only
// `worker_done` is here, because it is the only `send` whose required fields are unconditional: the
// live handler fills a missing `dispatchId` on the other types from the session's open Dispatch,
// which is an inference no caller outside the server can make.

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** The message the server answers a `send --type worker_done` with, or null if it has everything it
 *  needs. **Called by the server itself**, so the two can never disagree — the reason it lives here
 *  rather than being copied is that the pending-reports queue has to decide, with no server to ask,
 *  whether a report would be accepted. Queueing one that would not be accepted is worse than
 *  failing: it answers the worker "recorded", holds its Dispatch open through the next restart
 *  cleanup, and then gets refused, leaving the Task stalled by a typo the worker could have fixed.
 *
 *  The identifiers are asked for before the outcome so the first thing missing is the first thing
 *  said. */
export function workerDoneFieldError(args: Record<string, unknown>): string | null {
  if (!str(args.taskId) || !str(args.dispatchId)) return '--task-id and --dispatch-id are required'
  const outcome = str(args.outcome)
  if (outcome !== 'succeeded' && outcome !== 'failed') return '--outcome must be succeeded|failed'
  return null
}
