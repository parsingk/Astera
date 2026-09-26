// The app's window on the journal the Host writes (Host journal J1, P13). Read-only: a separate
// connection opened with { readOnly: true }, which never creates the file and never runs the schema
// step, so an app in front of a journal-writing Host can never be its second writer.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  SELECT_CHECKPOINT,
  SELECT_RECOVERY_ACTION,
  hasColumn,
  hasTable,
  rowToCheckpoint,
  rowToEvent,
  rowToRecoveryAction,
  selectEvents,
  type CheckpointRow,
  type JournalEventRow,
  type RawCheckpoint,
  type RawEvent,
  type RawRecoveryAction,
  type RecoveryActionRow
} from './journal'

export class JournalReader {
  private db: DatabaseSync | null = null
  constructor(
    private readonly filePath: string,
    private readonly deps: { log?(message: string): void } = {}
  ) {}

  /** Opened at the first read that finds the file; a missing file is no rows, and is asked again next time. */
  private handle(): DatabaseSync | null {
    if (this.db) return this.db
    if (!existsSync(this.filePath)) return null
    this.db = new DatabaseSync(this.filePath, { readOnly: true })
    return this.db
  }

  /** Asked per read, not once: the Host may migrate the file to v3 while this connection is open. */
  private events(db: DatabaseSync): string {
    return selectEvents(hasColumn(db, 'journal_events', 'actor_json'))
  }

  /** [] while the file does not exist; throws on a failed read (the reconciler reads a throw as "cannot say"). */
  eventsFor(runId: string): JournalEventRow[] {
    const db = this.handle()
    if (!db) return []
    return (db.prepare(`${this.events(db)} WHERE run_id = ? ORDER BY rowid`).all(runId) as unknown as RawEvent[]).map(
      rowToEvent
    )
  }

  lastEvent(): JournalEventRow | null {
    const db = this.handle()
    if (!db) return null
    const raw = db.prepare(`${this.events(db)} ORDER BY rowid DESC LIMIT 1`).get() as RawEvent | undefined
    return raw ? rowToEvent(raw) : null
  }

  firstCheckpointFor(dispatchId: string): CheckpointRow | null {
    return this.checkpointFor(dispatchId, 'ASC')
  }

  latestCheckpointFor(dispatchId: string): CheckpointRow | null {
    return this.checkpointFor(dispatchId, 'DESC')
  }

  private checkpointFor(dispatchId: string, order: 'ASC' | 'DESC'): CheckpointRow | null {
    const db = this.handle()
    if (!db) return null
    const raw = db
      .prepare(`${SELECT_CHECKPOINT} WHERE dispatch_id = ? ORDER BY rowid ${order} LIMIT 1`)
      .get(dispatchId) as RawCheckpoint | undefined
    return raw ? rowToCheckpoint(raw) : null
  }

  /** No rows, logged, on a file with no recovery_actions table (a version 1 file whose upgrade failed). */
  recoveryActionsFor(runId: string): RecoveryActionRow[] {
    const db = this.handle()
    if (!db) return []
    if (!hasTable(db, 'recovery_actions')) {
      this.deps.log?.('journal has no recovery_actions table (an older file whose upgrade failed); no recovery actions to read')
      return []
    }
    return (
      db.prepare(`${SELECT_RECOVERY_ACTION} WHERE run_id = ? ORDER BY rowid`).all(runId) as unknown as RawRecoveryAction[]
    ).map(rowToRecoveryAction)
  }

  /** null while the file does not exist. */
  schemaVersion(): number | null {
    const db = this.handle()
    if (!db) return null
    return (db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined)?.version ?? null
  }

  /** Test-only: runs `sql` on this connection, to prove it refuses writes. */
  execForTest(sql: string): void {
    const db = this.handle()
    if (!db) throw new Error('no journal file yet')
    db.exec(sql)
  }

  close(): void {
    this.db?.close()
    this.db = null
  }
}
