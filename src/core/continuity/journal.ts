// The Job Continuity journal: an append-only record of what every Run went through, plus the
// deterministic checkpoints, in one SQLite file beside orchestration.json (P0 design §4). SQLite is
// Node's own `node:sqlite` — no native module, no rebuild; verified in this Electron's main process.
// Synchronous API (DatabaseSync): a write is one transition's worth of rows and happens before the
// projection is saved, so there is nothing to overlap with.
//
// orchestration.json stays the source of "what is the state now"; this file answers "what happened".
// Lives in core/continuity since the Host journal (Task 1), so the Host writes with the same code the app did.
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import type { ContinuityEvent, ContinuityEventType } from './events'
import { actorFromJson, type JournalActor } from './actor'
import type { CheckpointKind } from './checkpointPolicy'
import type { Checkpoint } from '../orchestration/checkpoint'

export const SCHEMA_VERSION = 3

export interface JournalEventRow {
  eventId: string
  /** rowid: monotonic per file, the order recovery reads in. */
  sequence: number
  schemaVersion: number
  runId: string
  taskId: string | null
  dispatchId: string | null
  type: ContinuityEventType
  at: string
  idempotencyKey: string | null
  payload: Record<string, unknown>
  /** Who acted (J4). Null for a row written before v3, or one whose actor this build cannot read (P4). */
  actor: JournalActor | null
}

export interface CheckpointRow {
  checkpointId: string
  runId: string
  taskId: string
  dispatchId: string
  kind: CheckpointKind
  at: string
  /** The deterministic Checkpoint (core/orchestration/checkpoint.ts), as built. */
  state: Checkpoint
  gitHead: string | null
  worktreePath: string | null
  nativeSessionId: string | null
  /** The handoff memo's session key when Smart Resume is on and a memo exists; else null (spec §12.2). */
  handoffRef: string | null
}

export type NewCheckpointRow = Omit<CheckpointRow, 'checkpointId'>

export interface RecoveryActionRow {
  recoveryActionId: string
  runId: string
  taskId: string
  dispatchId: string
  strategy: string
  class: string
  reason: string
  status: 'selected' | 'completed' | 'failed'
  startedAt: string
  completedAt: string | null
  details: Record<string, unknown> | null
}
export type NewRecoveryActionRow = Omit<
  RecoveryActionRow,
  'recoveryActionId' | 'status' | 'startedAt' | 'completedAt' | 'details'
> & {
  at: string
  /** Kept when given, else a fresh UUID. The app mints it (P14) so a row it sends through the Host can
   *  be returned synchronously and finished later under the same id. */
  recoveryActionId?: string
}

export interface ContinuityJournalDeps {
  log?(message: string): void
  now?(): string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS journal_events (
  event_id        TEXT PRIMARY KEY,
  schema_version  INTEGER NOT NULL,
  run_id          TEXT NOT NULL,
  task_id         TEXT,
  dispatch_id     TEXT,
  event_type      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  payload_json    TEXT NOT NULL,
  actor_json      TEXT
);
CREATE INDEX IF NOT EXISTS journal_events_run ON journal_events(run_id);
CREATE TABLE IF NOT EXISTS checkpoints (
  checkpoint_id     TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  task_id           TEXT NOT NULL,
  dispatch_id       TEXT NOT NULL,
  kind              TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  state_json        TEXT NOT NULL,
  git_head          TEXT,
  worktree_path     TEXT,
  native_session_id TEXT,
  handoff_ref       TEXT
);
CREATE INDEX IF NOT EXISTS checkpoints_dispatch ON checkpoints(dispatch_id);
CREATE TABLE IF NOT EXISTS recovery_actions (
  recovery_action_id TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  dispatch_id  TEXT NOT NULL,
  strategy     TEXT NOT NULL,
  class        TEXT NOT NULL,
  reason       TEXT NOT NULL,
  status       TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  completed_at TEXT,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS recovery_actions_run ON recovery_actions(run_id);
`

/** Whether `table` has `column`. PRAGMA table_info answers on any file, a v2 one included. */
export const hasColumn = (db: DatabaseSync, table: string, column: string): boolean =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column)

interface OpenResult {
  db: DatabaseSync
  version: number
}

/** Opens (or creates) the file and brings it to the schema. Throws when the file is not a database. */
function open(filePath: string): OpenResult {
  const db = new DatabaseSync(filePath)
  try {
    // FULL, not NORMAL: writes happen once per state transition and the durability of an intent
    // record is the point (spec §6.1). WAL keeps readers (P1's reconciler) off the writer's lock.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA foreign_keys = ON')
    // **The version is read before the schema is applied.** `CREATE TABLE IF NOT EXISTS` is not a
    // no-op against a file from a future build that renamed or dropped one of these tables: it
    // silently creates an empty one of ours beside it, and "a file at a newer version is left
    // untouched" would already be false by the time the version was read. sqlite_master answers on
    // any database, including a fresh one that has no tables at all.
    const hasMeta = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
      .get() as { name: string } | undefined
    const meta = hasMeta
      ? (db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined)
      : undefined
    if (meta && meta.version > SCHEMA_VERSION) return { db, version: meta.version }
    // A fresh file is born at v3. On a v1 file the CREATE TABLE IF NOT EXISTS adds what version 2
    // added (recovery_actions); it does not touch an existing journal_events, hence the step below.
    db.exec(SCHEMA)
    // v3 (Host journal J4): who acted. A v2 table gains the column empty, so its rows read as actor
    // null; nothing is inferred for them. In one transaction with the stamp, so a crash between the two
    // cannot leave a v2 stamp on a v3 table or the reverse.
    db.exec('BEGIN')
    try {
      if (!hasColumn(db, 'journal_events', 'actor_json')) db.exec('ALTER TABLE journal_events ADD COLUMN actor_json TEXT')
      if (!meta) db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION)
      else if (meta.version < SCHEMA_VERSION) db.prepare('UPDATE schema_meta SET version = ?').run(SCHEMA_VERSION)
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err
    }
    return { db, version: SCHEMA_VERSION }
  } catch (err) {
    try {
      db.close()
    } catch {
      /* the open itself may have failed half-way */
    }
    throw err
  }
}

/** The .bak policy of store.ts, with a timestamp: losing a journal is worth keeping evidence of. */
function moveAside(filePath: string, stamp: string): void {
  const suffix = `.corrupt-${stamp.replace(/[:.]/g, '-')}`
  for (const p of [filePath, `${filePath}-wal`, `${filePath}-shm`])
    if (existsSync(p)) renameSync(p, `${p}${suffix}`)
}

export class ContinuityJournal {
  private readonly db: DatabaseSync
  /** True when the file could not be opened as a database and was moved aside (design §4). */
  readonly recovered: boolean
  /** False when the file is intact but was written by a newer build (a higher schema version):
   *  it is left untouched and every write becomes a no-op (a journal problem must never stop a Job). */
  readonly usable: boolean
  private readonly version: number

  constructor(
    private readonly filePath: string,
    private readonly deps: ContinuityJournalDeps = {}
  ) {
    let opened: OpenResult
    let recovered = false
    try {
      opened = open(filePath)
    } catch (err) {
      const stamp = deps.now?.() ?? new Date().toISOString()
      moveAside(filePath, stamp)
      deps.log?.(`continuity journal could not be opened and was moved aside (${String(err)})`)
      opened = open(filePath)
      recovered = true
    }
    this.db = opened.db
    this.version = opened.version
    this.recovered = recovered
    this.usable = opened.version <= SCHEMA_VERSION
    if (!this.usable)
      deps.log?.(`journal written by a newer build (version ${opened.version}); journaling is off for this session`)
  }

  /** Appends in one transaction. A row whose idempotency key is already present is skipped — the
   *  same diff derived twice lands once. The conflict target is the key alone (not `INSERT OR
   *  IGNORE`, which would also swallow a NOT NULL violation and drop a bad event silently instead of
   *  failing the batch). Returns how many rows landed. */
  append(events: ContinuityEvent[]): number {
    if (!this.usable || events.length === 0) return 0
    const insert = this.db.prepare(
      `INSERT INTO journal_events
         (event_id, schema_version, run_id, task_id, dispatch_id, event_type, created_at, idempotency_key, payload_json, actor_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`
    )
    this.db.exec('BEGIN')
    let inserted = 0
    try {
      for (const e of events) {
        const r = insert.run(
          randomUUID(),
          SCHEMA_VERSION,
          e.runId,
          e.taskId ?? null,
          e.dispatchId ?? null,
          e.type,
          e.at,
          e.idempotencyKey,
          JSON.stringify(e.payload),
          e.actor ? JSON.stringify(e.actor) : null
        )
        inserted += Number(r.changes)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err
    }
    return inserted
  }

  saveCheckpoint(row: NewCheckpointRow): CheckpointRow {
    const checkpointId = randomUUID()
    if (this.usable)
      this.db
        .prepare(
          `INSERT INTO checkpoints
             (checkpoint_id, run_id, task_id, dispatch_id, kind, created_at, state_json, git_head, worktree_path, native_session_id, handoff_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          checkpointId,
          row.runId,
          row.taskId,
          row.dispatchId,
          row.kind,
          row.at,
          JSON.stringify(row.state),
          row.gitHead,
          row.worktreePath,
          row.nativeSessionId,
          row.handoffRef
        )
    return { checkpointId, ...row }
  }

  /** A recovery attempt selected for a Run, before it is known to succeed or fail (recovery work to
   *  follow). Inserted with `status: 'selected'`; `finishRecoveryAction` closes it out. */
  startRecoveryAction(row: NewRecoveryActionRow): RecoveryActionRow {
    const recoveryActionId = row.recoveryActionId ?? randomUUID()
    const stored: RecoveryActionRow = {
      recoveryActionId,
      runId: row.runId,
      taskId: row.taskId,
      dispatchId: row.dispatchId,
      strategy: row.strategy,
      class: row.class,
      reason: row.reason,
      status: 'selected',
      startedAt: row.at,
      completedAt: null,
      details: null
    }
    if (this.usable)
      this.db
        .prepare(
          `INSERT INTO recovery_actions
             (recovery_action_id, run_id, task_id, dispatch_id, strategy, class, reason, status, started_at, completed_at, details_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
        )
        .run(recoveryActionId, row.runId, row.taskId, row.dispatchId, row.strategy, row.class, row.reason, 'selected', row.at)
    return stored
  }

  /** Closes a recovery action out. Takes `at` as an argument — this class holds no clock, every
   *  other write already takes its time from the caller. */
  finishRecoveryAction(id: string, status: 'completed' | 'failed', at: string, details?: Record<string, unknown>): void {
    if (!this.usable) return
    this.db
      .prepare('UPDATE recovery_actions SET status = ?, completed_at = ?, details_json = ? WHERE recovery_action_id = ?')
      .run(status, at, details ? JSON.stringify(details) : null, id)
  }

  recoveryActionsFor(runId: string): RecoveryActionRow[] {
    return (
      this.db
        .prepare(`${SELECT_RECOVERY_ACTION} WHERE run_id = ? ORDER BY rowid`)
        .all(runId) as unknown as RawRecoveryAction[]
    ).map(rowToRecoveryAction)
  }

  /** Every table that names a Run. Called when a Run is pruned (30-day TTL) or deleted, so the file
   *  stays bounded — the same three tables sweepOrphans clears, for the same reason. */
  deleteRun(runId: string): void {
    if (!this.usable) return
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM journal_events WHERE run_id = ?').run(runId)
      this.db.prepare('DELETE FROM checkpoints WHERE run_id = ?').run(runId)
      this.db.prepare('DELETE FROM recovery_actions WHERE run_id = ?').run(runId)
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err
    }
  }

  eventsFor(runId: string): JournalEventRow[] {
    return (
      this.db
        .prepare(`${selectEvents(true)} WHERE run_id = ? ORDER BY rowid`)
        // .all()'s typed return (Record<string, SQLOutputValue>[]) doesn't structurally overlap
        // RawEvent[] enough for a direct assertion (TS2352) the way the single-row .get() casts
        // below do; route through `unknown`, same as tsc's own suggestion.
        .all(runId) as unknown as RawEvent[]
    ).map(rowToEvent)
  }

  lastEvent(): JournalEventRow | null {
    const raw = this.db.prepare(`${selectEvents(true)} ORDER BY rowid DESC LIMIT 1`).get() as RawEvent | undefined
    return raw ? rowToEvent(raw) : null
  }

  latestCheckpointFor(dispatchId: string): CheckpointRow | null {
    return this.checkpointFor(dispatchId, 'DESC')
  }

  /** The earliest checkpoint of a dispatch — the baseline recovery resumes from — as opposed to
   *  `latestCheckpointFor`'s most recent one. Same query, `rowid` ascending instead of descending. */
  firstCheckpointFor(dispatchId: string): CheckpointRow | null {
    return this.checkpointFor(dispatchId, 'ASC')
  }

  private checkpointFor(dispatchId: string, order: 'ASC' | 'DESC'): CheckpointRow | null {
    const raw = this.db
      .prepare(`${SELECT_CHECKPOINT} WHERE dispatch_id = ? ORDER BY rowid ${order} LIMIT 1`)
      .get(dispatchId) as RawCheckpoint | undefined
    return raw ? rowToCheckpoint(raw) : null
  }

  /** One-shot cleanup: deletes every row in all three tables whose `run_id` the projection no longer
   *  knows about (a Run vanished from orchestration.json without going through `deleteRun`). Returns
   *  how many distinct runs were swept, not how many rows. */
  sweepOrphans(knownRunIds: ReadonlySet<string>): number {
    if (!this.usable) return 0
    const runIds = this.db
      .prepare(
        `SELECT run_id FROM journal_events
         UNION SELECT run_id FROM checkpoints
         UNION SELECT run_id FROM recovery_actions`
      )
      .all() as { run_id: string }[]
    const orphans = runIds.map((r) => r.run_id).filter((id) => !knownRunIds.has(id))
    if (orphans.length === 0) return 0
    this.db.exec('BEGIN')
    try {
      const deleteEvents = this.db.prepare('DELETE FROM journal_events WHERE run_id = ?')
      const deleteCheckpoints = this.db.prepare('DELETE FROM checkpoints WHERE run_id = ?')
      const deleteRecoveryActions = this.db.prepare('DELETE FROM recovery_actions WHERE run_id = ?')
      for (const runId of orphans) {
        deleteEvents.run(runId)
        deleteCheckpoints.run(runId)
        deleteRecoveryActions.run(runId)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* the original error is the one worth reporting */
      }
      throw err
    }
    return orphans.length
  }

  /** The schema version this file was opened at (post-migration, or the newer version this class
   *  refused to touch). */
  schemaVersion(): number {
    return this.version
  }

  /** Test-only: stamps `schema_meta` to `v` so a test can produce a file as if written by another
   *  release, which there is otherwise no way to do. */
  setSchemaVersionForTest(v: number): void {
    this.db.prepare('UPDATE schema_meta SET version = ?').run(v)
  }

  /** For tests and diagnostics: `journal_mode`, `synchronous`. */
  pragma(name: 'journal_mode' | 'synchronous'): string | number {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, string | number>
    return Object.values(row)[0]
  }

  close(): void {
    this.db.close()
  }
}

const SELECT_EVENT_COLUMNS =
  'SELECT rowid AS sequence, event_id, schema_version, run_id, task_id, dispatch_id, event_type, created_at, idempotency_key, payload_json'

/** The events SELECT prefix. `withActor` is false only for a v2 file the read-only reader must not
 *  migrate (it has no actor_json column); the writer always passes true, its file is v3 once opened. */
export function selectEvents(withActor: boolean): string {
  return `${SELECT_EVENT_COLUMNS}${withActor ? ', actor_json' : ''} FROM journal_events`
}

export const SELECT_CHECKPOINT =
  'SELECT checkpoint_id, run_id, task_id, dispatch_id, kind, created_at, state_json, git_head, worktree_path, native_session_id, handoff_ref FROM checkpoints'

export const SELECT_RECOVERY_ACTION =
  'SELECT recovery_action_id, run_id, task_id, dispatch_id, strategy, class, reason, status, started_at, completed_at, details_json FROM recovery_actions'

export type { RawEvent, RawCheckpoint, RawRecoveryAction }

interface RawEvent {
  sequence: number
  event_id: string
  schema_version: number
  run_id: string
  task_id: string | null
  dispatch_id: string | null
  event_type: string
  created_at: string
  idempotency_key: string | null
  payload_json: string
  /** Absent when read with `selectEvents(false)` (a v2 file). */
  actor_json?: string | null
}
interface RawCheckpoint {
  checkpoint_id: string
  run_id: string
  task_id: string
  dispatch_id: string
  kind: string
  created_at: string
  state_json: string
  git_head: string | null
  worktree_path: string | null
  native_session_id: string | null
  handoff_ref: string | null
}
interface RawRecoveryAction {
  recovery_action_id: string
  run_id: string
  task_id: string
  dispatch_id: string
  strategy: string
  class: string
  reason: string
  status: string
  started_at: string
  completed_at: string | null
  details_json: string | null
}

export const rowToEvent = (r: RawEvent): JournalEventRow => ({
  eventId: r.event_id,
  sequence: Number(r.sequence),
  schemaVersion: r.schema_version,
  runId: r.run_id,
  taskId: r.task_id,
  dispatchId: r.dispatch_id,
  type: r.event_type as ContinuityEventType,
  at: r.created_at,
  idempotencyKey: r.idempotency_key,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>,
  actor: actorFromJson(r.actor_json)
})

export const rowToCheckpoint = (r: RawCheckpoint): CheckpointRow => ({
  checkpointId: r.checkpoint_id,
  runId: r.run_id,
  taskId: r.task_id,
  dispatchId: r.dispatch_id,
  kind: r.kind as CheckpointKind,
  at: r.created_at,
  state: JSON.parse(r.state_json) as Checkpoint,
  gitHead: r.git_head,
  worktreePath: r.worktree_path,
  nativeSessionId: r.native_session_id,
  handoffRef: r.handoff_ref
})

export const rowToRecoveryAction = (r: RawRecoveryAction): RecoveryActionRow => ({
  recoveryActionId: r.recovery_action_id,
  runId: r.run_id,
  taskId: r.task_id,
  dispatchId: r.dispatch_id,
  strategy: r.strategy,
  class: r.class,
  reason: r.reason,
  status: r.status as RecoveryActionRow['status'],
  startedAt: r.started_at,
  completedAt: r.completed_at,
  details: r.details_json ? (JSON.parse(r.details_json) as Record<string, unknown>) : null
})
