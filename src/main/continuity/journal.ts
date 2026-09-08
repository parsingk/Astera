// The Job Continuity journal: an append-only record of what every Run went through, plus the
// deterministic checkpoints, in one SQLite file beside orchestration.json (P0 design §4). SQLite is
// Node's own `node:sqlite` — no native module, no rebuild; verified in this Electron's main process.
// Synchronous API (DatabaseSync): a write is one transition's worth of rows and happens before the
// projection is saved, so there is nothing to overlap with.
//
// orchestration.json stays the source of "what is the state now"; this file answers "what happened".
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { existsSync, renameSync } from 'node:fs'
import type { ContinuityEvent, ContinuityEventType } from '../../core/continuity/events'
import type { CheckpointKind } from '../../core/continuity/checkpointPolicy'
import type { Checkpoint } from '../../core/orchestration/checkpoint'

export const SCHEMA_VERSION = 1

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
  payload_json    TEXT NOT NULL
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
`

/** Opens (or creates) the file and brings it to the schema. Throws when the file is not a database. */
function open(filePath: string): DatabaseSync {
  const db = new DatabaseSync(filePath)
  try {
    // FULL, not NORMAL: writes happen once per state transition and the durability of an intent
    // record is the point (spec §6.1). WAL keeps readers (P1's reconciler) off the writer's lock.
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(SCHEMA)
    const meta = db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined
    if (!meta) db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(SCHEMA_VERSION)
    return db
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

  constructor(
    private readonly filePath: string,
    private readonly deps: ContinuityJournalDeps = {}
  ) {
    let db: DatabaseSync
    let recovered = false
    try {
      db = open(filePath)
    } catch (err) {
      const stamp = deps.now?.() ?? new Date().toISOString()
      moveAside(filePath, stamp)
      deps.log?.(`continuity journal could not be opened and was moved aside (${String(err)})`)
      db = open(filePath)
      recovered = true
    }
    this.db = db
    this.recovered = recovered
  }

  /** Appends in one transaction. A row whose idempotency key is already present is skipped — the
   *  same diff derived twice lands once. The conflict target is the key alone (not `INSERT OR
   *  IGNORE`, which would also swallow a NOT NULL violation and drop a bad event silently instead of
   *  failing the batch). Returns how many rows landed. */
  append(events: ContinuityEvent[]): number {
    if (events.length === 0) return 0
    const insert = this.db.prepare(
      `INSERT INTO journal_events
         (event_id, schema_version, run_id, task_id, dispatch_id, event_type, created_at, idempotency_key, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          JSON.stringify(e.payload)
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

  /** Both tables. Called when a Run is pruned (30-day TTL) or deleted, so the file stays bounded. */
  deleteRun(runId: string): void {
    this.db.exec('BEGIN')
    try {
      this.db.prepare('DELETE FROM journal_events WHERE run_id = ?').run(runId)
      this.db.prepare('DELETE FROM checkpoints WHERE run_id = ?').run(runId)
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
        .prepare(`${SELECT_EVENT} WHERE run_id = ? ORDER BY rowid`)
        // .all()'s typed return (Record<string, SQLOutputValue>[]) doesn't structurally overlap
        // RawEvent[] enough for a direct assertion (TS2352) the way the single-row .get() casts
        // below do; route through `unknown`, same as tsc's own suggestion.
        .all(runId) as unknown as RawEvent[]
    ).map(rowToEvent)
  }

  lastEvent(): JournalEventRow | null {
    const raw = this.db.prepare(`${SELECT_EVENT} ORDER BY rowid DESC LIMIT 1`).get() as RawEvent | undefined
    return raw ? rowToEvent(raw) : null
  }

  latestCheckpointFor(dispatchId: string): CheckpointRow | null {
    const raw = this.db
      .prepare(
        `SELECT checkpoint_id, run_id, task_id, dispatch_id, kind, created_at, state_json, git_head, worktree_path, native_session_id, handoff_ref
           FROM checkpoints WHERE dispatch_id = ? ORDER BY rowid DESC LIMIT 1`
      )
      .get(dispatchId) as RawCheckpoint | undefined
    if (!raw) return null
    return {
      checkpointId: raw.checkpoint_id,
      runId: raw.run_id,
      taskId: raw.task_id,
      dispatchId: raw.dispatch_id,
      kind: raw.kind as CheckpointKind,
      at: raw.created_at,
      state: JSON.parse(raw.state_json) as Checkpoint,
      gitHead: raw.git_head,
      worktreePath: raw.worktree_path,
      nativeSessionId: raw.native_session_id,
      handoffRef: raw.handoff_ref
    }
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

const SELECT_EVENT =
  'SELECT rowid AS sequence, event_id, schema_version, run_id, task_id, dispatch_id, event_type, created_at, idempotency_key, payload_json FROM journal_events'

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

const rowToEvent = (r: RawEvent): JournalEventRow => ({
  eventId: r.event_id,
  sequence: Number(r.sequence),
  schemaVersion: r.schema_version,
  runId: r.run_id,
  taskId: r.task_id,
  dispatchId: r.dispatch_id,
  type: r.event_type as ContinuityEventType,
  at: r.created_at,
  idempotencyKey: r.idempotency_key,
  payload: JSON.parse(r.payload_json) as Record<string, unknown>
})
