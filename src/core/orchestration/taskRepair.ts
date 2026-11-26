// A person's repair request on a Task (Phase 3 design §5 Part 1 item 4): which Tasks take one, and the findings it
// carries. The rule is the person's (2026-11-26): a failed Task; a Task blocked by its exhausted repairs, through that
// Gate's retry-once; and a completed Task only while nothing has moved on from it (its Run has not ended, no Task built on
// it has started, and the folder its last attempt worked in is still there). Everything else is refused with a reason
// the app turns into a new Job draft instead. Pure: the Host's command decides with it, the folder check is its caller's.
import { latestImplDispatch } from './convergence'
import type { OrchState } from './state'
import type { AskedFinding } from './types'

/** At most this many findings ride on one repair, each at most this long: a repair spec is a prompt, not a report. */
export const ASKED_FINDINGS_MAX = 20
export const ASKED_FINDING_TEXT_MAX = 300

export type RepairRefusal = 'unknown-task' | 'busy' | 'run-ended' | 'dependents-started' | 'folder-gone' | 'blocked-by-gate' | 'not-repairable'

export type RepairEligibility =
  | { ok: true; via: 'failed' | 'reopen' | 'exhausted-gate'; gateId?: string }
  | { ok: false; reason: RepairRefusal; detail: string }

/** The findings as they ride on the Dispatch: the first ASKED_FINDINGS_MAX, each on one line and cut. */
export function capAsked(asked: readonly AskedFinding[]): AskedFinding[] {
  return asked.slice(0, ASKED_FINDINGS_MAX).map((f) => {
    const one = f.text.replace(/\s+/g, ' ').trim()
    return { ref: f.ref, text: one.length > ASKED_FINDING_TEXT_MAX ? `${one.slice(0, ASKED_FINDING_TEXT_MAX - 1)}…` : one }
  })
}

const refuse = (reason: RepairRefusal, detail: string): RepairEligibility => ({ ok: false, reason, detail })

/** Whether the Task takes a person's repair request now, and how; `folderExists` answers for the folder its last
 *  implementation attempt worked in, which is where the repair runs (repair.ts repairTargetFor). */
export function repairEligibility(s: OrchState, taskId: string, folderExists: (path: string) => boolean): RepairEligibility {
  const task = s.tasks.find((t) => t.id === taskId)
  if (!task) return refuse('unknown-task', `no task ${taskId}`)
  const open = s.dispatches.find((d) => d.taskId === taskId && !d.outcome && !d.endedAt)
  if (open) return refuse('busy', `attempt ${open.id} is still open`)
  const run = task.runId !== undefined ? s.runs.find((r) => r.id === task.runId) : undefined
  if (!run) return refuse('not-repairable', 'the task belongs to no run')
  if (run.endedAt !== undefined) return refuse('run-ended', `run ${run.id} ended at ${run.endedAt}`)
  let via: 'failed' | 'reopen' | 'exhausted-gate'
  let gateId: string | undefined
  if (task.status === 'failed') via = 'failed'
  else if (task.status === 'blocked') {
    const open = s.gates.filter((g) => g.taskId === taskId && g.status === 'open')
    const exhausted = open.find((g) => g.kind === 'convergence-exhausted')
    const other = open.find((g) => g.kind !== 'convergence-exhausted')
    if (other) return refuse('blocked-by-gate', `question ${other.id} is open: ${other.question}`)
    if (!exhausted) return refuse('not-repairable', 'blocked with no open question')
    via = 'exhausted-gate'
    gateId = exhausted.id
  } else if (task.status === 'completed') {
    const started = s.tasks.find((t) => t.deps.includes(taskId) && t.status !== 'pending' && t.status !== 'ready')
    if (started) return refuse('dependents-started', `task ${started.id} (${started.title}) already started on its result`)
    via = 'reopen'
  } else return refuse('not-repairable', `the task is ${task.status}`)
  const last = latestImplDispatch(s, taskId)
  if (!last) return refuse('not-repairable', 'the task has no attempt to repair')
  if (!folderExists(last.cwd)) return refuse('folder-gone', `the folder of its last attempt is gone: ${last.cwd}`)
  return { ok: true, via, ...(gateId !== undefined ? { gateId } : {}) }
}
