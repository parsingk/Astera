// Test fixtures for a journal file: another connection holding its lock, so a test can meet SQLITE_BUSY the
// way a second process would (final review I2), and raw reads of what no production code reads back (the
// recovery_actions rows, the schema stamp). Nothing outside tests imports this file.
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import type { RecoveryActionRow } from './journal'

/** Holds the file's lock from this thread until `release()`. Every other connection's open or read meets
 *  SQLITE_BUSY meanwhile, after its busy timeout. The file must already be a WAL database. */
export function holdLock(file: string): { release(): void } {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA locking_mode = EXCLUSIVE')
  db.exec('BEGIN EXCLUSIVE')
  return {
    release: () => {
      db.exec('ROLLBACK')
      db.close()
    }
  }
}

const HOLDER = `
const { DatabaseSync } = require('node:sqlite')
const { workerData, parentPort } = require('node:worker_threads')
const db = new DatabaseSync(workerData.file)
db.exec('PRAGMA locking_mode = EXCLUSIVE')
db.exec('BEGIN EXCLUSIVE')
parentPort.postMessage('held')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.ms)
db.exec('ROLLBACK')
db.close()
`

/** Holds the file's lock from another thread for `ms`, then lets it go. Resolves once the lock is held, so
 *  a synchronous open or read on this thread right after meets it and has to wait. `done` settles when the
 *  holder has let go and exited. */
export async function holdLockFor(file: string, ms: number): Promise<{ done: Promise<void> }> {
  const worker = new Worker(HOLDER, { eval: true, workerData: { file, ms } })
  const done = new Promise<void>((resolve, reject) => {
    worker.once('error', reject)
    worker.once('exit', () => resolve())
  })
  await new Promise<void>((resolve, reject) => {
    worker.once('message', () => resolve())
    worker.once('error', reject)
  })
  return { done }
}

/** The file's recovery_actions rows for a Run, in insertion order, read on a connection of their own. The
 *  app writes these rows and nothing in it reads them back, so a test reads them here. */
export function recoveryActionsIn(file: string, runId: string): RecoveryActionRow[] {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const rows = db
      .prepare(
        'SELECT recovery_action_id, run_id, task_id, dispatch_id, strategy, class, reason, status, started_at, completed_at, details_json FROM recovery_actions WHERE run_id = ? ORDER BY rowid'
      )
      .all(runId) as Record<string, string | null>[]
    return rows.map((r) => ({
      recoveryActionId: String(r.recovery_action_id),
      runId: String(r.run_id),
      taskId: String(r.task_id),
      dispatchId: String(r.dispatch_id),
      strategy: String(r.strategy),
      class: String(r.class),
      reason: String(r.reason),
      status: r.status as RecoveryActionRow['status'],
      startedAt: String(r.started_at),
      completedAt: r.completed_at,
      details: r.details_json ? (JSON.parse(r.details_json) as Record<string, unknown>) : null
    }))
  } finally {
    db.close()
  }
}

/** The version stamped in the file's schema_meta, read on a connection of its own; null with no stamp. */
export function schemaVersionIn(file: string): number | null {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare('SELECT version FROM schema_meta LIMIT 1').get() as { version: number } | undefined
    return row?.version ?? null
  } finally {
    db.close()
  }
}
