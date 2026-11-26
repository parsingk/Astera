// A person's repair request on a Task (Phase 3 design §5 Part 1 item 4): which Tasks take one, and the findings it
// carries. The rule is the person's (2026-11-26): a failed Task; a Task blocked by its exhausted repairs, through that
// Gate's retry-once; and a completed Task only while nothing has moved on from it (its Run has not ended, no Task built on
// it, down the whole chain, has started). For every one, the folder its last attempt worked in must still be there and
// no other Task's attempt may be working in it (final review I2: a second agent never starts beside another). Everything
// else is refused with a reason the app turns into a new Job draft instead. Pure: the Host's command decides with it, the
// folder check is its caller's.
import { maskForAgent } from '../context/contextRef'
import { isSamePath } from '../files/tree'
import { latestImplDispatch } from './convergence'
import type { OrchState } from './state'
import type { AskedFinding, RepairRefusal } from './types'

/** At most this many findings ride on one repair, each at most this long: a repair spec is a prompt, not a report. */
export const ASKED_FINDINGS_MAX = 20
export const ASKED_FINDING_TEXT_MAX = 300

export type RepairEligibility =
  | { ok: true; via: 'failed' | 'reopen' | 'exhausted-gate'; gateId?: string }
  | { ok: false; reason: RepairRefusal; detail: string }

/** The findings as they ride on the Dispatch: one per reference, the first ASKED_FINDINGS_MAX, each on one line, masked
 *  as every excerpt handed to an agent is (maskForAgent), then cut. */
export function capAsked(asked: readonly AskedFinding[]): AskedFinding[] {
  const seen = new Set<string>()
  const unique = asked.filter((f) => !seen.has(f.ref) && (seen.add(f.ref), true))
  return unique.slice(0, ASKED_FINDINGS_MAX).map((f) => {
    const one = maskForAgent(f.text.replace(/\s+/g, ' ').trim()).text
    return { ref: f.ref, text: one.length > ASKED_FINDING_TEXT_MAX ? `${one.slice(0, ASKED_FINDING_TEXT_MAX - 1)}…` : one }
  })
}

/** Every Task built on `taskId`, down the whole chain (an integration Task included: its deps are the Tasks it merges). */
function builtOn(s: OrchState, taskId: string): OrchState['tasks'] {
  const found = new Map<string, OrchState['tasks'][number]>()
  let frontier = [taskId]
  while (frontier.length > 0) {
    const next: string[] = []
    for (const t of s.tasks)
      if (!found.has(t.id) && t.id !== taskId && t.deps.some((d) => frontier.includes(d))) {
        found.set(t.id, t)
        next.push(t.id)
      }
    frontier = next
  }
  return [...found.values()]
}

/**
 * The state a person's repair opens on (final review I1): the Task ready, and every Task built on it that was ready back
 * to pending, so the loop places none of them on the result being repaired; recomputeReady promotes them again once the
 * Task completes. The Task's own move is past the transition table, as mark-failed's is.
 */
export function readyForRepair(s: OrchState, taskId: string, now: string): OrchState {
  const demote = new Set(builtOn(s, taskId).filter((t) => t.status === 'ready').map((t) => t.id))
  return {
    ...s,
    tasks: s.tasks.map((t) =>
      t.id === taskId ? { ...t, status: 'ready' as const, updatedAt: now } : demote.has(t.id) ? { ...t, status: 'pending' as const, updatedAt: now } : t
    )
  }
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
    // The person put "its Run has not ended" on a completed Task only (final review I5)
    if (run.endedAt !== undefined) return refuse('run-ended', `run ${run.id} ended at ${run.endedAt}`)
    const started = builtOn(s, taskId).find((t) => t.status !== 'pending' && t.status !== 'ready')
    if (started) return refuse('dependents-started', `task ${started.id} (${started.title}) already started on its result`)
    via = 'reopen'
  } else return refuse('not-repairable', `the task is ${task.status}`)
  const last = latestImplDispatch(s, taskId)
  if (!last) return refuse('not-repairable', 'the task has no attempt to repair')
  if (!folderExists(last.cwd)) return refuse('folder-gone', `the folder of its last attempt is gone: ${last.cwd}`)
  const neighbour = s.dispatches.find((d) => d.taskId !== taskId && !d.outcome && !d.endedAt && isSamePath(d.cwd, last.cwd))
  if (neighbour) return refuse('folder-in-use', `task ${neighbour.taskId} is working in ${last.cwd}`)
  return { ok: true, via, ...(gateId !== undefined ? { gateId } : {}) }
}
