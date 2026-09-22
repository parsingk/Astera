// The one-time migration for the launch on which orchestration stopped being a setting (ruling F62).
//
// **What it is for.** While orchestration was a toggle, turning it *off* did not tear anything down —
// it only made five guards stand still: the scheduler, the schedule-template tick, the recovery boot
// sweep, the per-Dispatch reconcile, and the queued-report drain. So a profile that was switched off
// mid-flight still holds, in its state file, running Runs with `ready` Tasks, armed schedule
// templates, and Dispatches nothing ever finished. Those five guards are gone and the server now
// starts unconditionally, so without this the person's next launch would dispatch workers, fire
// schedules and spawn replacements — spending their accounts and landing commits on the strength of
// a decision they made months ago in the other direction.
//
// **Pause rather than a notice**, because the two mistakes are not the same size: one click undoes a
// pause, and nothing undoes a turn somebody's account paid for.
//
// **Only the flags.** `pauseSchedule` and `runs-stop` also close open Dispatches; this does not.
// A worker that is genuinely still running is work already paid for, and its result still has
// somewhere to land — closing its Dispatch here would throw that away to prevent nothing.
import type { OrchState } from './state'
import { outcomeOf } from './view'

export interface AlwaysOnPause {
  state: OrchState
  /** Run ids newly paused, for the log line. */
  runs: string[]
  /** Scheduled Job ids newly paused, for the log line. */
  jobs: string[]
}

/**
 * Sets `paused` on the work the old toggle was holding still, and answers what it touched.
 *
 * **Runs** — every Run that owns at least one Task and has not finished (`outcomeOf` is `running`).
 * `run.paused` is read by all four things that would otherwise act on it: `slotsToFill` (via
 * `appDriven`), `interruptedResumes`, the recovery reconciler's `candidates`, and `pausedForTask`.
 * A Run with no Tasks is skipped — there is nothing in it to dispatch, and pausing it would put a
 * resume button on an empty Run.
 *
 * **Scheduled Jobs** — the template, not a Run, so `job.paused` is the field and `firesDue` is what
 * reads it. `pendingStart` templates are skipped: they are drafts nobody has started, `firesDue`
 * already refuses to arm them, and pausing one would offer to resume something that never ran.
 *
 * Anything already paused is left alone and is not reported, so the log line counts what this
 * actually changed. Returns the same state object when there is nothing to do, so the caller can
 * skip the write.
 */
export function pauseWorkParkedByTheToggle(s: OrchState): AlwaysOnPause {
  const runs = s.runs
    .filter(
      (r) =>
        r.paused !== true &&
        s.tasks.some((t) => t.runId === r.id) &&
        outcomeOf(s, r.id) === 'running'
    )
    .map((r) => r.id)
  const jobs = s.jobs
    .filter((j) => j.schedule !== undefined && j.paused !== true && j.pendingStart !== true)
    .map((j) => j.id)
  if (runs.length === 0 && jobs.length === 0) return { state: s, runs, jobs }
  const runIds = new Set(runs)
  const jobIds = new Set(jobs)
  return {
    state: {
      ...s,
      runs: s.runs.map((r) => (runIds.has(r.id) ? { ...r, paused: true } : r)),
      jobs: s.jobs.map((j) => (jobIds.has(j.id) ? { ...j, paused: true } : j))
    },
    runs,
    jobs
  }
}
