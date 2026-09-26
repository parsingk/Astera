// Test fixtures: another connection holding a journal file's lock, so a test can meet SQLITE_BUSY the way a
// second process would (final review I2). Nothing outside tests imports this file.
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'

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
