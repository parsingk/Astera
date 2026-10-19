// The public events one commit makes (SDK spec §6, SDK 1d), derived from the state before it and the state after it.
// Pure: no clock, no files; the Host's event log (src/host/eventLog.ts) stamps, numbers and keeps them.
//
// **Only what changed is looked at.** The state is replaced on every commit and never mutated (stateMemo.ts), so an
// object that is the same object in both states did not change, and an array that is the same array holds no change.
// A commit that moves one Task costs a pass over the arrays that moved, and the completion state and Run outcome
// only of the Tasks and Runs it touched; never the O(Runs × Tasks) of asking every Run. **And a state that is all new**
// (an app's `state-put` arrives from a socket, every object fresh) stays linear: each Task's Gates and Dispatches, and
// each Run's Tasks, are gathered once per derive, never searched for each (final review Minor 4).
//
// **A Task starts when its worker has a session.** A start commits a `pending:` placeholder Dispatch first and the
// real session after, and a start that fails rolls both back; so `task.started` and `completion.repair_started` wait
// for the real session, and a start that never happened says nothing (final review Minor 5).
//
// **Payloads are the public DTOs** of the objects, built by the views the reads use (publicViews.ts,
// runCompletion.ts) and shaped by the package's own rules (shapeEvent), so an event says what a read of the same
// object would. A Task is the brief one and carries no check output: an event is a notification, and `get` reads
// the whole object.
import { JOB_FIELDS, shapeEvent, type EventType } from '../publicContract'
import { briefTask, jobView, latestRunOf, runView } from './publicViews'
import { outcomeOfTasks } from './running'
import { countedCheck, findingsCounted, taskCompletionOf, taskCompletionState, type CompletionState } from './runCompletion'
import type { OrchState } from './state'
import { isGitHubGateKind, isPlaceholderSessionId, type Dispatch, type Gate, type Job, type JobRun, type Task } from './types'
import type { GitHubLogKind, RunGitHubState } from '../github/lifecycle'

/** One event before the log gives it an id, a sequence and a time. */
export interface EventDraft {
  type: EventType
  projectId?: string
  jobId?: string
  runId?: string
  taskId?: string
  /** A session event's session (plugin Phase 3); never set by a commit's derive. */
  sessionId?: string
  payload: unknown
}

const byId = <T extends { id: string }>(xs: readonly T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]))

/** A Job's public fields as one comparable string: `job.updated` is about these, never the derived ones. */
const publicKey = (job: Job): string => JSON.stringify(JOB_FIELDS.map((f) => job[f]))

/** A completion round under way: the checks or the review. */
const ROUND: ReadonlySet<CompletionState> = new Set(['checking', 'rechecking', 'reviewing'])

/** The completion events of one Task's move from `was` to `now`, in order. A round that fails and starts a repair
 *  gives `completion.failed` then `completion.repair_started`; one that runs out gives `completion.failed` then
 *  `completion.exhausted`. */
function completionTypes(was: CompletionState, now: CompletionState): EventType[] {
  const out: EventType[] = []
  if (ROUND.has(was) && !ROUND.has(now) && now !== 'converged') out.push('completion.failed')
  if (now === 'checking') out.push('completion.started')
  if (now === 'fixing' || now === 'fixing-review') out.push('completion.repair_started')
  if (now === 'converged') out.push('completion.converged')
  if (now === 'exhausted') out.push('completion.exhausted')
  return out
}

/** A Task as an event carries it: brief, and its checks without their output, their findings counted (5d). */
const taskPayload = (t: Task): Record<string, unknown> => ({
  ...briefTask(t),
  ...(t.checks !== undefined ? { checks: t.checks.map(({ outputTail: _output, ...check }) => countedCheck(check)) } : {})
})

/** Each Task's Gates and Dispatches in one state, gathered once. */
interface ByTask {
  gates: Map<string, Gate[]>
  dispatches: Map<string, Dispatch[]>
}
const groupBy = <T>(xs: readonly T[], key: (x: T) => string | undefined): Map<string, T[]> => {
  const out = new Map<string, T[]>()
  for (const x of xs) {
    const k = key(x)
    if (k === undefined) continue
    const list = out.get(k)
    if (list) list.push(x)
    else out.set(k, [x])
  }
  return out
}
const byTaskOf = (s: OrchState): ByTask => ({ gates: groupBy(s.gates, (g) => g.taskId), dispatches: groupBy(s.dispatches, (d) => d.taskId) })

/** The state as one Task's completion reads it: `taskCompletionState` and `repairCountOf` look at that Task's Gates
 *  and Dispatches only, so the same answer comes from a state that holds only those. */
const narrowed = (s: OrchState, by: ByTask, taskId: string): OrchState => ({ ...s, gates: by.gates.get(taskId) ?? [], dispatches: by.dispatches.get(taskId) ?? [] })

/** The open worker of a Task, as `taskCompletionState` finds it: not ended, not a review. */
const openWorkerOf = (ds: readonly Dispatch[]): Dispatch | undefined => ds.find((d) => d.endedAt === undefined && !d.review)

/** Whether a worker is at work on the Task: it is dispatched and its open worker has a real session. */
const working = (t: Task, ds: readonly Dispatch[]): boolean => {
  const open = t.status === 'dispatched' ? openWorkerOf(ds) : undefined
  return open !== undefined && !isPlaceholderSessionId(open.sessionId)
}

/** The completion state the events follow: `taskCompletionState`, except that a worker still waiting for its session
 *  has not started (`working`, `fixing` and `fixing-review` read as `not-started` until it has one). */
const eventState = (s: OrchState, by: ByTask, t: Task): CompletionState => {
  const own = narrowed(s, by, t.id)
  const state = taskCompletionState(own, t)
  if (state !== 'working' && state !== 'fixing' && state !== 'fixing-review') return state
  const open = openWorkerOf(own.dispatches)
  return open !== undefined && isPlaceholderSessionId(open.sessionId) ? 'not-started' : state
}

const GITHUB_EVENT: Record<GitHubLogKind, EventType> = {
  'pr-bound': 'github.pr_bound',
  'pr-created': 'github.pr_created',
  'head-changed': 'github.head_changed',
  'ci-passed': 'github.ci_passed',
  'ci-failed': 'github.ci_failed',
  'ci-rerun': 'github.ci_rerun_requested',
  'source-changed': 'github.source_changed'
}

/** The GitHub events a Run's record gained in one commit: its log entries numbered past the last one it had. */
export function githubEventsOf(prev: RunGitHubState | undefined, next: RunGitHubState | undefined): EventType[] {
  if (next === undefined || next === prev) return []
  const seen = prev?.seq ?? 0
  return next.log.filter((e) => e.seq > seen).map((e) => GITHUB_EVENT[e.kind])
}

export function derivePublicEvents(prev: OrchState, next: OrchState): EventDraft[] {
  if (prev === next) return []
  const out: EventDraft[] = []
  /** The ids an event about this Run (and Task) names: its Job's, and that Job's project. */
  const idsOf = (runId: string, taskId?: string): Omit<EventDraft, 'type' | 'payload'> => {
    const jobId = next.runs.find((r) => r.id === runId)?.jobId
    const projectId = jobId === undefined ? undefined : next.jobs.find((j) => j.id === jobId)?.projectId
    return {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(jobId !== undefined ? { jobId } : {}),
      runId,
      ...(taskId !== undefined ? { taskId } : {})
    }
  }
  const push = (type: EventType, ids: Omit<EventDraft, 'type' | 'payload'>, payload: unknown): void => {
    out.push({ type, ...ids, payload: (shapeEvent({ type, payload }) as { payload: unknown }).payload })
  }
  const jobEvent = (type: EventType, job: Job): void =>
    push(type, { ...(job.projectId !== undefined ? { projectId: job.projectId } : {}), jobId: job.id }, jobView(next, job, latestRunOf(next, job)))
  const runEvent = (type: EventType, run: JobRun): void => push(type, idsOf(run.id), runView(next, run))

  if (prev.jobs !== next.jobs) {
    const before = byId(prev.jobs)
    for (const job of next.jobs) {
      const was = before.get(job.id)
      if (was === job) continue
      if (was === undefined) jobEvent('job.created', job)
      else if (publicKey(was) !== publicKey(job)) jobEvent('job.updated', job)
    }
  }

  const runsBefore = prev.runs === next.runs ? null : new Set(prev.runs.map((r) => r.id))
  if (runsBefore !== null) for (const run of next.runs) if (!runsBefore.has(run.id)) runEvent('run.started', run)

  if (prev.runs !== next.runs) {
    const runBefore = byId(prev.runs)
    for (const run of next.runs) {
      const was = runBefore.get(run.id)
      if (was === run) continue
      for (const type of githubEventsOf(was?.githubState, run.githubState)) runEvent(type, run)
    }
  }

  const tasksMoved = prev.tasks !== next.tasks
  const gatesMoved = prev.gates !== next.gates
  const dispatchesMoved = prev.dispatches !== next.dispatches
  /** The Runs whose Tasks this commit changed, added or removed: the only ones whose outcome can have moved. */
  const runsTouched = new Set<string>()
  if (tasksMoved || gatesMoved || dispatchesMoved) {
    const tasksBefore = byId(prev.tasks)
    const tasksNow = tasksMoved ? byId(next.tasks) : tasksBefore
    // A Task's start and completion state read its Gates and Dispatches too, so a Task named by a Gate or Dispatch
    // that changed is asked even when its own object did not change. The order: changed Tasks as the state has them,
    // then the ones a Gate or Dispatch named.
    const affected = new Set<string>()
    if (tasksMoved) {
      for (const t of next.tasks) {
        const was = tasksBefore.get(t.id)
        if (was === t) continue
        affected.add(t.id)
        if (t.runId !== undefined) runsTouched.add(t.runId)
        if (was?.runId !== undefined) runsTouched.add(was.runId)
      }
      for (const t of prev.tasks) if (!tasksNow.has(t.id) && t.runId !== undefined) runsTouched.add(t.runId)
    }
    const touchedBy = <T extends { id: string; taskId: string }>(before: readonly T[], now: readonly T[]): void => {
      const was = byId(before)
      for (const x of now) if (was.get(x.id) !== x) affected.add(x.taskId)
      const present = new Set(now.map((x) => x.id))
      for (const x of before) if (!present.has(x.id)) affected.add(x.taskId)
    }
    if (gatesMoved) touchedBy(prev.gates, next.gates)
    if (dispatchesMoved) touchedBy(prev.dispatches, next.dispatches)

    if (affected.size > 0) {
      const byBefore = byTaskOf(prev)
      const byNow = gatesMoved || dispatchesMoved ? byTaskOf(next) : byBefore
      /** The affected Tasks of a Run, both states in hand. */
      const pairs: Array<{ t: Task & { runId: string }; was: Task | undefined }> = []
      for (const id of affected) {
        const t = tasksNow.get(id)
        if (t !== undefined && t.runId !== undefined) pairs.push({ t: t as Task & { runId: string }, was: tasksBefore.get(id) })
      }

      for (const { t, was } of pairs) {
        const startedNow = working(t, byNow.dispatches.get(t.id) ?? [])
        const startedBefore = was !== undefined && working(was, byBefore.dispatches.get(t.id) ?? [])
        if (startedNow && !startedBefore) push('task.started', idsOf(t.runId, t.id), taskPayload(t))
        if (was?.status === t.status) continue
        if (t.status === 'completed') push('task.completed', idsOf(t.runId, t.id), taskPayload(t))
        else if (t.status === 'failed') push('task.failed', idsOf(t.runId, t.id), taskPayload(t))
      }

      for (const { t, was } of pairs) {
        const from = was === undefined ? 'not-started' : eventState(prev, byBefore, was)
        const to = eventState(next, byNow, t)
        if (from === to) continue
        // A check that could not be made (plugin Phase 5 C9) ends no round in failure: the question it opens says the
        // Task waits, and its answer starts the checks again (5a final review M2)
        // Nor does a GitHub question (GitHub lifecycle G3b2): it holds the round's wait while a person answers
        const unavailable =
          to === 'waiting-for-user' && (byNow.gates.get(t.id) ?? []).some((g) => g.status === 'open' && (g.kind === 'check-unavailable' || isGitHubGateKind(g.kind)))
        const types = completionTypes(from, to).filter((x) => !(unavailable && x === 'completion.failed'))
        if (types.length === 0) continue
        const payload = findingsCounted(taskCompletionOf(narrowed(next, byNow, t.id), t))
        for (const type of types) push(type, idsOf(t.runId, t.id), payload)
      }
    }
  }

  if (gatesMoved) {
    const before = byId(prev.gates)
    for (const g of next.gates) {
      const was = before.get(g.id)
      if (was === g) continue
      if (was === undefined && g.status === 'open') push('question.created', idsOf(g.runId, g.taskId), g)
      if (g.status === 'resolved' && was?.status !== 'resolved') push('question.answered', idsOf(g.runId, g.taskId), g)
    }
  }

  // Last, so a Run's ending follows the Task events that ended it. Only a Run in both states: one new in this commit
  // has its run.started, and one removed by it has no ending to tell.
  if (runsTouched.size > 0) {
    const before = runsBefore ?? new Set(prev.runs.map((r) => r.id))
    const now = byId(next.runs)
    // Each Run's Tasks gathered once: outcomeOf would search every Task for each Run.
    const tasksBefore = groupBy(prev.tasks, (t) => t.runId)
    const tasksNow = groupBy(next.tasks, (t) => t.runId)
    for (const runId of runsTouched) {
      const run = now.get(runId)
      if (run === undefined || !before.has(runId) || outcomeOfTasks(tasksBefore.get(runId) ?? []) !== 'running') continue
      const outcome = outcomeOfTasks(tasksNow.get(runId) ?? [])
      if (outcome === 'completed') runEvent('run.completed', run)
      else if (outcome === 'failed') runEvent('run.failed', run)
    }
  }
  return out
}
