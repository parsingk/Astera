// The recovery reconciler (P1 design §6): the piece that finds a lost worker, asks decide.ts for a
// strategy, journals the decision, and hands it to execute.ts. Nothing here decides or carries out a
// strategy — those live in core/recovery/decide.ts and main/recovery/execute.ts, the same split the
// orchestration guide draws between "what happened", "what to do" and "doing it".
import type { OrchState } from '../../core/orchestration/state'
import type { Dispatch } from '../../core/orchestration/types'
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

/** Every dispatched Task whose Run is live (not paused, not a schedule template) and whose last
 *  attempt was lost — one seed per Task, the most recent lost Dispatch when it has had several, and
 *  none at all when the Task already has an open Dispatch (a fresh attempt is already running). */
export function candidates(state: OrchState): LostAttemptSeed[] {
  const runs = new Map(state.runs.map((r) => [r.id, r]))
  const out: LostAttemptSeed[] = []
  for (const task of state.tasks) {
    if (task.status !== 'dispatched') continue
    const run = runs.get(task.runId)
    if (!run || run.paused === true || run.schedule !== undefined) continue
    const own = state.dispatches.filter((d) => d.taskId === task.id)
    if (own.some((d) => d.endedAt === undefined)) continue
    const lost = own.filter(isLost)
    if (lost.length === 0) continue
    const latest = lost.reduce((a, b) => (b.startedAt > a.startedAt ? b : a))
    out.push({ runId: task.runId, taskId: task.id, dispatch: latest })
  }
  return out
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

  private async recoverOne(seed: LostAttemptSeed): Promise<void> {
    const { runId, taskId, dispatch } = seed
    const now = this.deps.now()
    const journal = this.deps.journal

    const events = this.note('eventsFor', [] as JournalEventRow[], () => journal.eventsFor(runId))
    const promptConfirmed = events.some(
      (e) => e.type === 'PROMPT_WRITE_CONFIRMED' && e.dispatchId === dispatch.id
    )
    const checkpoint = this.note('firstCheckpointFor', null as CheckpointRow | null, () =>
      journal.firstCheckpointFor(dispatch.id)
    )
    const baseHead = checkpoint?.gitHead ?? null

    const state = this.deps.getState()
    const task = state.tasks.find((t) => t.id === taskId)
    const run = task && state.runs.find((r) => r.id === task.runId)
    if (!task || !run)
      // candidates() built this seed from a Task whose runId resolved to a live Run; both should
      // still be there a moment later. If not, there is nothing left to recover.
      throw new Error(`recovery: task ${taskId} or its run vanished before it could be recovered`)

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
        mk('RECOVERY_STRATEGY_SELECTED', {
          strategy: decision.strategy,
          class: decision.class,
          reason: decision.reason
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
  }

  /** Sweeps every candidate once, one at a time — two recoveries spawning at once would fight over
   *  the concurrency limit. Returns how many attempts it acted on, not how many it fixed: a failure
   *  still counts, and is isolated so it cannot stop the rest of the sweep. */
  async reconcileAll(): Promise<number> {
    let count = 0
    for (const seed of candidates(this.deps.getState())) {
      try {
        await this.recoverOne(seed)
        count++
      } catch (err) {
        this.deps.log(`recovery: reconcile failed for dispatch ${seed.dispatch.id}: ${String(err)}`)
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
    await this.recoverOne(seed)
  }
}
