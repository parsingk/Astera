// The app's window on the journal the Host writes (Host journal J1, P13). Read-only: a separate
// connection opened with { readOnly: true }, which never creates the file and never runs the schema
// step, so an app in front of a journal-writing Host can never be its second writer.
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import {
  SELECT_CHECKPOINT,
  hasColumn,
  rowToCheckpoint,
  rowToEvent,
  selectEvents,
  setBusyTimeout,
  type CheckpointRow,
  type JournalEventRow,
  type RawCheckpoint,
  type RawEvent
} from './journal'

export class JournalReader {
  private db: DatabaseSync | null = null
  /** How many times a handle was opened: `changeMark` restarts with a new connection. */
  private opens = 0
  constructor(
    private readonly filePath: string,
    private readonly deps: { busyTimeoutMs?: number } = {}
  ) {}

  /** Opened at the first read that finds the file; a missing file is no rows, and is asked again next time. */
  private handle(): DatabaseSync | null {
    if (this.db) return this.db
    if (!existsSync(this.filePath)) return null
    const db = new DatabaseSync(this.filePath, { readOnly: true })
    // A lock the writer holds for a moment is waited out (final review I2); one held past the timeout is a
    // failed read, which throws (P13). Nothing here ever moves the file.
    try {
      setBusyTimeout(db, this.deps.busyTimeoutMs)
    } catch (err) {
      db.close()
      throw err
    }
    this.db = db
    this.opens += 1
    return db
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

  /** A value that changes whenever the file changed since the last call on this connection: another
   *  connection committed (`PRAGMA data_version`), or this reader opened a new connection. Deletes count
   *  too. null while the file does not exist. Cheap: it reads no table (final review M2). */
  changeMark(): string | null {
    const db = this.handle()
    if (!db) return null
    const row = db.prepare('PRAGMA data_version').get() as Record<string, number>
    return `${this.opens}:${Object.values(row)[0]}`
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
