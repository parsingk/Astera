// Stores a finished Run's report on the Run, inside the commit that finishes it (run report design C9). Beside
// `stampRunEnds` (runRecord.ts), which keeps a Run's end the same way: the Host runs every commit through both.
import { outcomeOfTasks } from '../orchestration/running'
import { justFinished, tasksByOwner } from '../orchestration/runRecord'
import type { OrchState } from '../orchestration/state'
import type { SpentTokens } from '../orchestration/publicViews'
import { buildRunReport } from './build'

/**
 * `next` with each Run's `report` kept true: built on the Run whose outcome became final on this commit
 * (`justFinished`), and only then, so `spent` is read only when a Run finishes. A Run that stays finished keeps the
 * report `prev` held, whatever the writer sent (an app mirror lacks what the Host stamped, and it must not invent one);
 * a Run that runs again drops it. A put that stands in for the load (`standsInForLoad`: `prev` holds nothing) keeps what
 * its Runs carry. The same state back when nothing moved.
 */
export function stampRunReports(
  prev: OrchState,
  next: OrchState,
  o: { spent?: () => readonly SpentTokens[]; standsInForLoad?: boolean } = {}
): OrchState {
  const nextTasks = tasksByOwner(next)
  const prevRuns = new Map(prev.runs.map((r) => [r.id, r]))
  const finished = new Set(justFinished(prev, next).map((f) => f.runId))
  // Read once for every Run this commit finishes, and not at all otherwise
  let spent: readonly SpentTokens[] | undefined
  let changed = false
  const runs = next.runs.map((run) => {
    let report = run.report
    if (outcomeOfTasks(nextTasks.get(run.id) ?? []) === 'running') report = undefined
    else if (finished.has(run.id) && prevRuns.has(run.id)) {
      // A Run `prev` does not hold reads as "was running" (no Tasks), so only a Run it held can have just finished
      spent ??= o.spent?.()
      report = buildRunReport(next, run.id, spent ? { spent } : {}) ?? undefined
    } else {
      const before = prevRuns.get(run.id)
      if (before !== undefined) report = before.report
      else if (o.standsInForLoad !== true) report = undefined
    }
    if (report === run.report) return run
    changed = true
    const { report: _was, ...rest } = run
    return report === undefined ? rest : { ...rest, report }
  })
  return changed ? { ...next, runs } : next
}
