// The recovery reconciler (P1 design §6): the piece that finds a lost worker, asks decide.ts for a
// strategy, journals the decision, and hands it to execute.ts. Nothing here decides or carries out a
// strategy — those live in core/recovery/decide.ts and main/recovery/execute.ts, the same split the
// orchestration guide draws between "what happened", "what to do" and "doing it".
import type { OrchState } from '../../core/orchestration/state'
import { DEFAULT_CONCURRENCY, type Dispatch } from '../../core/orchestration/types'
import type { GitFacts, LostAttempt, RecoveryDecision } from '../../core/recovery/types'
import { decideRecovery } from '../../core/recovery/decide'
import type { ContinuityEvent, ContinuityEventType } from '../../core/continuity/events'
import type { CheckpointRow, ContinuityJournal, JournalEventRow, RecoveryActionRow } from '../continuity/journal'
import type { ExecuteResult } from './execute'

/** What `candidates` found, before a decision has been asked for. */
export interface LostAttemptSeed {
  runId: string
  taskId: string
  /** The Dispatch that was lost — the new attempt (if any) links back to it through `retryOf`. */
  dispatch: Dispatch
}

export interface ReconcilerDeps {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
  journal: ContinuityJournal
  readGitFacts(cwd: string): Promise<GitFacts>
  smartResume(): boolean
  execute(a: { attempt: LostAttempt; decision: RecoveryDecision; state: OrchState; now: string }): Promise<ExecuteResult>
  log(m: string): void
  /** ISO clock. The journal holds no clock of its own — every write takes its time from the caller. */
  now(): string
}

/** A Dispatch this sweep can act on: closed on its own (no `closedBy` — a person's stop, abandon or
 *  pause is left alone), and with no reported outcome. */
const isLost = (d: Dispatch): boolean =>
  d.endedAt !== undefined && d.outcome === undefined && d.closedBy === undefined

/** Every dispatched Task whose Run is live (not paused, not a schedule template) and whose most
 *  recent Dispatch was lost — one seed per Task, and none at all when the Task already has an open
 *  Dispatch (a fresh attempt is already running).
 *
 *  **The most recent Dispatch, then the lost test — not the most recent lost one.** Filtering the
 *  person-closed attempts out first would reach past a stop to an older crash: a worker crashes, the
 *  boot sweep restarts it, the person stops the restart they did not want, and the next boot
 *  recovers the original attempt anyway. That is exactly what `Dispatch.closedBy` exists to prevent,
 *  and through `worker-abandon` it would put a second agent in a worktree whose resources may still
 *  be live. */
export function candidates(state: OrchState): LostAttemptSeed[] {
  const runs = new Map(state.runs.map((r) => [r.id, r]))
  const out: LostAttemptSeed[] = []
  for (const task of state.tasks) {
    if (task.status !== 'dispatched') continue
    const run = runs.get(task.runId)
    // The scheduler's own three Run gates, copied whole. `pendingStart` is the one that looks
    // redundant — it is a one-way gate `startRun` clears, so a Run holding it cannot have dispatched
    // anything to lose. schedule.ts refuses that inference for its own gates all the same, because
    // orchestration.json outlives the process and is hand-edited, and recovery is a second door into
    // starting workers: it holds to the same standard.
    if (!run || run.paused === true || run.schedule !== undefined || run.pendingStart === true) continue
    const own = state.dispatches.filter((d) => d.taskId === task.id)
    // A `dispatched` Task always has one — openDispatch writes the Dispatch and the status together.
    // The guard is here because orchestration.json outlives the process and is hand-edited, the same
    // reason schedule.ts refuses to infer a Task's account from the command that made it.
    if (own.length === 0) continue
    if (own.some((d) => d.endedAt === undefined)) continue
    const latest = own.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
    if (!isLost(latest)) continue
    out.push({ runId: task.runId, taskId: task.id, dispatch: latest })
  }
  return out
}

/** Recovery is a second door into starting workers, so it obeys the scheduler's concurrency rule too
 *  (the `room` calculation in core/orchestration/schedule.ts's slotsToFill). Several lost Tasks in one
 *  Run would otherwise all restart at once, and in a Run whose Tasks dispatch into the Run root they
 *  would land in the same folder. A candidate with no room is left for the next trigger. */
const hasRoom = (state: OrchState, runId: string): boolean => {
  const run = state.runs.find((r) => r.id === runId)
  if (!run) return false
  const openHere = state.dispatches.filter(
    (d) => !d.outcome && !d.endedAt && state.tasks.find((t) => t.id === d.taskId)?.runId === runId
  ).length
  return openHere < (run.concurrency ?? DEFAULT_CONCURRENCY)
}

export class RecoveryReconciler {
  constructor(private readonly deps: ReconcilerDeps) {}

  /** Swallows a journal failure into the log and returns `fallback` — a journal problem must never
   *  block a Job, the discipline `ContinuityRecorder`'s `append` already follows. */
  private note<T>(label: string, fallback: T, fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      this.deps.log(`recovery: ${label} failed: ${String(err)}`)
      return fallback
    }
  }

  /** Carries one seed all the way through, or returns false having done nothing at all — the caller
   *  counts only what it acted on. */
  private async recoverOne(seed: LostAttemptSeed): Promise<boolean> {
    const { runId, taskId, dispatch } = seed
    const now = this.deps.now()
    const journal = this.deps.journal

    // null, not [] — a read that failed is not a read that found nothing. decide.ts reads a `false`
    // here as positive evidence that the prompt never left the app; null is "we cannot say".
    const events = this.note('eventsFor', null as JournalEventRow[] | null, () => journal.eventsFor(runId))
    const promptConfirmed =
      events === null
        ? null
        : events.some((e) => e.type === 'PROMPT_WRITE_CONFIRMED' && e.dispatchId === dispatch.id)

    // The journal witnesses every attempt it was on for (ATTEMPT_START_REQUESTED at the very least),
    // so rows that name this dispatch are the evidence recovery reasons from. None of them, on a read
    // that worked, means the attempt happened while the toggle was off or before this journal file
    // existed — there is nothing to reason from, and guessing would restart work nobody recorded.
    // This is what bounds the first sweep after the toggle is switched on: store.load()'s restart
    // cleanup closes every open Dispatch as outcome_unknown, so without it every Task any past crash
    // ever stranded inside the 30-day TTL would be decided from an empty record.
    if (events !== null && !events.some((e) => e.dispatchId === dispatch.id)) {
      this.deps.log(
        `recovery: no journal rows for dispatch ${dispatch.id} — the attempt predates this journal, leaving it alone`
      )
      return false
    }

    const checkpoint = this.note('firstCheckpointFor', null as CheckpointRow | null, () =>
      journal.firstCheckpointFor(dispatch.id)
    )
    const baseHead = checkpoint?.gitHead ?? null

    const state = this.deps.getState()
    const task = state.tasks.find((t) => t.id === taskId)
    const run = task && state.runs.find((r) => r.id === task.runId)
    if (!task || !run) {
      // candidates() built this seed from a Task whose runId resolved to a live Run; both should
      // still be there a moment later. If not, there is nothing left to recover — logged and
      // returned rather than thrown, the same failure shape executeRecovery uses for an unknown
      // task or run, and reconcileOne has nothing here to catch a throw with.
      this.deps.log(`recovery: task ${taskId} or its run vanished before it could be recovered`)
      return false
    }

    const attempt: LostAttempt = {
      runId,
      taskId,
      dispatchId: dispatch.id,
      provider: dispatch.provider,
      accountId: dispatch.accountId,
      cwd: dispatch.cwd,
      nativeSessionId: dispatch.nativeSessionId ?? checkpoint?.nativeSessionId ?? undefined,
      promptConfirmed,
      baseHead,
      hasValidateConfig: task.validateConfigId !== undefined,
      appDriven: run.autoDispatch === true
    }

    const git = await this.deps.readGitFacts(dispatch.cwd)
    const decision = decideRecovery({ attempt, git, smartResume: this.deps.smartResume() })

    const mk = (type: ContinuityEventType, payload: Record<string, unknown>): ContinuityEvent => ({
      runId,
      taskId,
      dispatchId: dispatch.id,
      type,
      at: now,
      idempotencyKey: `${type}:${dispatch.id}:${now}`,
      payload
    })

    this.note('append', 0, () =>
      journal.append([
        mk('RECOVERY_DETECTED', {
          provider: attempt.provider,
          accountId: attempt.accountId,
          cwd: attempt.cwd,
          promptConfirmed: attempt.promptConfirmed,
          baseHead: attempt.baseHead,
          nativeSessionId: attempt.nativeSessionId ?? null,
          git
        }),
        // Both halves of the sentence: the English one the file keeps, and the key the Timeline
        // renders in the reader's language. A row read by a build that no longer has the key still
        // has the English one to fall back on (ContinuityRecorder's reasonText).
        mk('RECOVERY_STRATEGY_SELECTED', {
          strategy: decision.strategy,
          class: decision.class,
          reason: decision.reason,
          reasonKey: decision.reasonMessage.key,
          ...(decision.reasonMessage.params ? { reasonParams: decision.reasonMessage.params } : {})
        })
      ])
    )

    const action = this.note('startRecoveryAction', null as RecoveryActionRow | null, () =>
      journal.startRecoveryAction({
        runId,
        taskId,
        dispatchId: dispatch.id,
        strategy: decision.strategy,
        class: decision.class,
        reason: decision.reason,
        at: now
      })
    )

    const requested: ContinuityEvent[] =
      decision.strategy === 'resume-native'
        ? [mk('RECOVERY_NATIVE_RESUME_REQUESTED', { strategy: decision.strategy })]
        : decision.strategy === 'smart-resume'
          ? [mk('RECOVERY_SMART_RESUME_REQUESTED', { strategy: decision.strategy })]
          : []
    if (requested.length > 0) this.note('append', 0, () => journal.append(requested))

    let result: ExecuteResult
    try {
      result = await this.deps.execute({ attempt, decision, state: this.deps.getState(), now })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.deps.log(`recovery: execute threw for dispatch ${dispatch.id}: ${message}`)
      result = { ok: false, error: message }
    }

    const outcome: ContinuityEvent[] = []
    if (result.ok) {
      if (decision.strategy === 'resume-native')
        outcome.push(mk('RECOVERY_NATIVE_RESUME_SUCCEEDED', { strategy: decision.strategy }))
      else if (decision.strategy === 'smart-resume')
        outcome.push(mk('RECOVERY_SMART_RESUME_SUCCEEDED', { strategy: decision.strategy }))
      else if (decision.strategy === 'redispatch')
        outcome.push(mk('RECOVERY_TASK_RESTARTED', { strategy: decision.strategy }))
      else if (decision.strategy === 'review')
        outcome.push(mk('RECOVERY_REQUIRES_REVIEW', { strategy: decision.strategy }))
      // recheck: no strategy-specific event — RECOVERY_STRATEGY_SELECTED already named it.
      outcome.push(mk('RECOVERY_COMPLETED', { strategy: decision.strategy }))
    } else {
      if (decision.strategy === 'resume-native')
        outcome.push(mk('RECOVERY_NATIVE_RESUME_FAILED', { strategy: decision.strategy, error: result.error }))
      else if (decision.strategy === 'smart-resume')
        outcome.push(mk('RECOVERY_SMART_RESUME_FAILED', { strategy: decision.strategy, error: result.error }))
      outcome.push(mk('RECOVERY_FAILED', { strategy: decision.strategy, error: result.error }))
    }
    this.note('append', 0, () => journal.append(outcome))

    if (action) {
      const details = result.ok ? { newDispatchId: result.newDispatchId ?? null } : { error: result.error }
      this.note('finishRecoveryAction', undefined, () =>
        journal.finishRecoveryAction(action.recoveryActionId, result.ok ? 'completed' : 'failed', now, details)
      )
    }
    return true
  }

  /** Sweeps every candidate once, one at a time — two recoveries spawning at once would fight over
   *  the concurrency limit. Returns how many attempts it acted on, not how many it fixed: a failure
   *  still counts, and is isolated so it cannot stop the rest of the sweep.
   *
   *  The initial list is only the sweep's agenda, not a fact still true by the time it is reached —
   *  each recovery awaits an executor that takes real time and changes the state, so a person can
   *  stop or abandon a worker further down the agenda while an earlier one is still being recovered.
   *  Re-checking against a fresh `candidates(getState())` right before acting is what stops that
   *  Dispatch from being restarted behind their back; a seed no longer present there is skipped
   *  without counting, and it is the fresh seed that is acted on, not the stale one.
   *
   *  An attempt recoverOne itself declines (no journal rows name it) is not counted either — it
   *  returns before anything is journaled or executed. */
  async reconcileAll(): Promise<number> {
    let count = 0
    for (const seed of candidates(this.deps.getState())) {
      const fresh = candidates(this.deps.getState()).find((c) => c.dispatch.id === seed.dispatch.id)
      if (!fresh) continue
      // The concurrency limit binds recovery too (hasRoom above) — a candidate with no room is left
      // for the next trigger, not counted as acted on.
      if (!hasRoom(this.deps.getState(), fresh.runId)) continue
      try {
        if (await this.recoverOne(fresh)) count++
      } catch (err) {
        this.deps.log(`recovery: reconcile failed for dispatch ${fresh.dispatch.id}: ${String(err)}`)
      }
    }
    return count
  }

  /** The same path for one Dispatch, used when a worker is found lost outside a full sweep (a
   *  process exit the app observes live). Re-reads the state so a Dispatch that is no longer a
   *  candidate (already reopened, already closed by a person) is quietly skipped. */
  async reconcileOne(dispatchId: string): Promise<void> {
    const seed = candidates(this.deps.getState()).find((c) => c.dispatch.id === dispatchId)
    if (!seed) return
    // Same concurrency gate as reconcileAll — a single lost worker found live is still a second
    // door into starting one, and the Run it belongs to may already be at its limit.
    if (!hasRoom(this.deps.getState(), seed.runId)) return
    await this.recoverOne(seed)
  }
}
