// Which sandbox a Task's checks run in (Task K). The person decided (2026-10-29) that the validation of a sandboxed Job
// runs inside the same kind of sandbox its workers ran in: the checks run the files the workers edited (a package.json
// script, a test file, a build script), and outside it they would run as the person. The kind is the one the workers'
// sessions actually started with, recorded on their Dispatches (Dispatch.sandboxKind), not the profile's switch today,
// as a chain keeps the sandbox state it started with.
//
// - An ordinary Task: its own implementers (a reviewer only reads them, and has a sandbox of its own, review.ts).
// - A lifecycle Task's merged check: every Dispatch of the Run, since the merged tree holds all their work (Q3).
// - The latest sandboxed attempt names the CLI and the account the check runs under; a real sandbox wins over deny rules.
// - Claude Code on Windows has no sandbox, only deny rules for its file tools, so its workers' shells ran as the person;
//   its checks run as today and say so (`deny-only`, the person's Q1).
// - Work a sandboxed session made (Task.sandboxed, Job.sandboxed: final fix pass C3), from before the kind was recorded:
//   its latest attempt, in the kind its CLI gets on this OS. A profile's switch from then is not known here.
import { sandboxKindOf } from '../../sandbox/coverage'
import type { Provider } from '../../providers/meta'
import { isLifecycleTask } from '../lifecycleTask'
import { workSandboxed, type OrchState } from '../state'
import type { Dispatch, Task } from '../types'
import type { SandboxKind } from '../../types'

export type CheckSandbox = { kind: 'sandbox'; provider: Provider; accountId: string } | { kind: 'deny-only' }

/** The attempts whose kind a Task's checks follow: a lifecycle Task's every Dispatch of its Run, else its own
 *  implementers. */
function attemptsOf(s: OrchState, task: Task): Dispatch[] {
  if (!isLifecycleTask(task)) return s.dispatches.filter((d) => d.taskId === task.id && !d.review)
  const ofRun = new Set(s.tasks.filter((t) => t.runId !== undefined && t.runId === task.runId).map((t) => t.id))
  return s.dispatches.filter((d) => ofRun.has(d.taskId))
}

const latest = (ds: readonly Dispatch[]): Dispatch | undefined => [...ds].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1)

/** The sandbox `task`'s checks run in, or null for none: its workers ran unsandboxed. `platform` decides the kind of work
 *  a sandboxed session made before the kind was recorded. */
export function checkSandboxOf(s: OrchState, task: Task, platform: string): CheckSandbox | null {
  const attempts = attemptsOf(s, task)
  const boxed = latest(attempts.filter((d) => d.sandboxKind === 'sandbox'))
  if (boxed) return { kind: 'sandbox', provider: boxed.provider, accountId: boxed.accountId }
  if (attempts.some((d) => d.sandboxKind === 'deny-only')) return { kind: 'deny-only' }
  if (attempts.some((d) => d.sandboxKind !== undefined) || !workSandboxed(s, task)) return null
  const last = latest(attempts)
  if (!last) return null
  return sandboxKindOf(last.provider, platform) === 'sandbox' ? { kind: 'sandbox', provider: last.provider, accountId: last.accountId } : { kind: 'deny-only' }
}

/** What a started worker's Dispatch records of its session's protection: the kind the spawn reported, or for a session
 *  reused rather than spawned (`--terminal`, a repair typed into the session that did the work) the kind an earlier
 *  Dispatch of that session recorded, since a session keeps the protection it started with. Nothing for none. */
export function startedSandboxKind(s: OrchState, started: { sessionId: string; sandboxKind?: SandboxKind }): { sandboxKind?: SandboxKind } {
  const kind = started.sandboxKind ?? s.dispatches.filter((d) => d.sessionId === started.sessionId && d.sandboxKind !== undefined).at(-1)?.sandboxKind
  return kind ? { sandboxKind: kind } : {}
}

/** Whether any of the attempts `task`'s checks follow ran sandboxed, deny rules only included: its reviewer then starts
 *  in its own CLI's sandbox too (Task K part 3). Work a sandboxed session made is the worker start's own rule
 *  (workerStart.ts). */
export function workRanSandboxed(s: OrchState, task: Task): boolean {
  return attemptsOf(s, task).some((d) => d.sandboxKind !== undefined)
}
