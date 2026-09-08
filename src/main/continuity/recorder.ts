// The one object the orchestration wiring talks to for Job Continuity (P0 design §5–§9): it turns a
// state transition into journal rows, decides and writes checkpoints, handles the mid-run enable, and
// reads the rows the Timeline shows. Every entry point swallows journal failures into the log —
// a broken journal must never stop a Job (design §6).
import type { JobEvent } from '../../core/types'
import type { OrchState } from '../../core/orchestration/state'
import { buildCheckpoint } from '../../core/orchestration/checkpoint'
import { deriveEvents, type ContinuityEvent } from '../../core/continuity/events'
import { checkpointsFor, type CheckpointKind } from '../../core/continuity/checkpointPolicy'
import type { HandoffLookup } from '../../core/handoff/types'
import { readGitSummary, type GitSummaryDeps } from '../gitSummary'
import type { CheckpointRow, JournalEventRow, NewCheckpointRow } from './journal'

/** What the recorder needs from the journal. ContinuityJournal satisfies it; tests hand in a fake. */
export interface ContinuityJournalPort {
  append(events: ContinuityEvent[]): number
  saveCheckpoint(row: NewCheckpointRow): CheckpointRow
  deleteRun(runId: string): void
  eventsFor(runId: string): JournalEventRow[]
  lastEvent(): JournalEventRow | null
  close(): void
}

export interface ContinuityRecorderDeps {
  journal: ContinuityJournalPort
  log(message: string): void
  /** ISO clock. Injected for determinism; the wiring leaves it out. */
  now?(): string
  /** git adapter for readGitSummary — test injection, the wiring leaves it out. */
  git?: GitSummaryDeps['git']
  /** Whether Smart Resume is on. Read per checkpoint, not captured: the setting can change. */
  smartResume(): boolean
  /** The handoff memo store's lookup, by app session id. Consulted only when smartResume() is true. */
  handoffLookup?(sessionId: string): HandoffLookup
}

const isPlaceholder = (sessionId: string): boolean => sessionId.startsWith('pending:')

export class ContinuityRecorder {
  constructor(private readonly deps: ContinuityRecorderDeps) {}

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString()
  }

  private append(events: ContinuityEvent[]): void {
    if (events.length === 0) return
    try {
      this.deps.journal.append(events)
    } catch (err) {
      this.deps.log(
        `continuity: journal append failed, ${events.length} event(s) lost (${events.map((e) => e.type).join(', ')}): ${String(err)}`
      )
    }
  }

  /** Journals the transition prev → next and returns the events so the caller can ask for
   *  checkpoints. Runs that vanished from the projection (TTL prune, run-delete) have their rows
   *  deleted here: the diff is the one place both paths pass through. */
  record(prev: OrchState, next: OrchState, at: string = this.now()): ContinuityEvent[] {
    let events: ContinuityEvent[] = []
    try {
      events = deriveEvents(prev, next, at)
    } catch (err) {
      this.deps.log(`continuity: derive failed: ${String(err)}`)
      return []
    }
    this.append(events)
    const kept = new Set(next.runs.map((r) => r.id))
    for (const run of prev.runs) {
      if (kept.has(run.id)) continue
      try {
        this.deps.journal.deleteRun(run.id)
      } catch (err) {
        this.deps.log(`continuity: deleteRun ${run.id} failed: ${String(err)}`)
      }
    }
    return events
  }

  /** An event that is not a state change (prompt hand-off, and the like). */
  note(event: ContinuityEvent): void {
    this.append([event])
  }

  /** Checkpoints for the transitions in `events`, read from `state` — the committed next state.
   *  Async because git is asked; the wiring fires and forgets after the save. */
  async checkpoint(events: ContinuityEvent[], state: OrchState): Promise<void> {
    for (const { dispatchId, kind } of checkpointsFor(events, state))
      await this.writeCheckpoint(state, dispatchId, kind)
  }

  /** The toggle turned on while Runs are active (spec §3.6): one baseline per open real Dispatch and
   *  one CONTINUITY_ENABLED per Run that has one. No history is invented. */
  async enable(state: OrchState): Promise<void> {
    const now = this.now()
    const open = state.dispatches.filter((d) => !d.endedAt && !isPlaceholder(d.sessionId))
    const runIds = new Set<string>()
    for (const d of open) {
      const runId = state.tasks.find((t) => t.id === d.taskId)?.runId
      if (runId) runIds.add(runId)
    }
    this.append(
      [...runIds].map((runId) => ({
        runId,
        type: 'CONTINUITY_ENABLED' as const,
        at: now,
        idempotencyKey: `CONTINUITY_ENABLED:${runId}:${now}`,
        payload: {}
      }))
    )
    for (const d of open) await this.writeCheckpoint(state, d.id, 'baseline')
  }

  /** The journal rows the Timeline shows (design §9): each ATTEMPT_LOST as a 'runtime-lost' line. */
  lostEventsFor(runId: string, state: OrchState): JobEvent[] {
    try {
      const titleOf = new Map(state.tasks.map((t) => [t.id, t.title]))
      return this.deps.journal
        .eventsFor(runId)
        .filter((e) => e.type === 'ATTEMPT_LOST')
        .map((e) => ({
          at: e.at,
          // Task 12 of the P0 plan adds 'runtime-lost' to JobEventKind and drops this cast
          kind: 'runtime-lost' as unknown as JobEvent['kind'],
          sourceId: e.eventId,
          ...(e.taskId ? { taskId: e.taskId, taskTitle: titleOf.get(e.taskId) } : {}),
          summary: String(e.payload.workerState ?? '')
        }))
    } catch (err) {
      this.deps.log(`continuity: eventsFor ${runId} failed: ${String(err)}`)
      return []
    }
  }

  /** P0 detects, P1 acts: a crash between the journal append and the JSON rename leaves the journal
   *  one transition ahead. Logged at boot so the gap is visible (design §5 "Ordering guarantee"). */
  reportSkew(state: OrchState): void {
    try {
      const last = this.deps.journal.lastEvent()
      if (!last?.dispatchId) return
      if (state.dispatches.some((d) => d.id === last.dispatchId)) return
      this.deps.log(
        `continuity: journal/projection skew — last event ${last.type} names dispatch ${last.dispatchId}, which the projection does not have`
      )
    } catch (err) {
      this.deps.log(`continuity: skew check failed: ${String(err)}`)
    }
  }

  close(): void {
    try {
      this.deps.journal.close()
    } catch {
      /* closing a broken journal is not news */
    }
  }

  private async writeCheckpoint(state: OrchState, dispatchId: string, kind: CheckpointKind): Promise<void> {
    const dispatch = state.dispatches.find((d) => d.id === dispatchId)
    const task = dispatch && state.tasks.find((t) => t.id === dispatch.taskId)
    if (!dispatch || !task) return
    // null when the folder is gone or not a repository — the checkpoint is still worth its other columns
    const git = await readGitSummary(dispatch.cwd, this.deps.git ? { git: this.deps.git } : {})
    const now = this.now()
    const checkpoint = buildCheckpoint(state, { dispatchId, git, now })
    if (!checkpoint) return
    const handoffRef =
      this.deps.smartResume() && this.deps.handoffLookup?.(dispatch.sessionId).state === 'found'
        ? dispatch.sessionId
        : null
    try {
      const row = this.deps.journal.saveCheckpoint({
        runId: task.runId,
        taskId: task.id,
        dispatchId,
        kind,
        at: now,
        state: checkpoint,
        gitHead: git?.head ?? null,
        worktreePath: dispatch.cwd,
        nativeSessionId: dispatch.nativeSessionId ?? null,
        handoffRef
      })
      this.deps.journal.append([
        {
          runId: task.runId,
          taskId: task.id,
          dispatchId,
          type: 'CHECKPOINT_CREATED',
          at: now,
          idempotencyKey: `CHECKPOINT_CREATED:${row.checkpointId}`,
          payload: { checkpointId: row.checkpointId, kind, gitHead: git?.head ?? null }
        }
      ])
    } catch (err) {
      this.deps.log(`continuity: checkpoint ${kind} for ${dispatchId} failed: ${String(err)}`)
    }
  }
}
