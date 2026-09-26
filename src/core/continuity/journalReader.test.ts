import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ContinuityJournal } from './journal'
import { JournalReader } from './journalReader'
import { holdLock, holdLockFor } from './sqliteLockFixtures'
import type { ContinuityEvent } from './events'

let dir: string
const open: Array<{ close(): void }> = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-journal-reader-'))
})
afterEach(async () => {
  for (const o of open.splice(0)) o.close()
  await fs.rm(dir, { recursive: true, force: true })
})
const file = (): string => path.join(dir, 'continuity.sqlite')
const ev = (key: string): ContinuityEvent => ({
  runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', type: 'TASK_STARTED', at: '2026-09-26T10:00:00.000Z',
  idempotencyKey: key, payload: {}, actor: { surface: 'host' }
})
const reader = (): JournalReader => {
  const r = new JournalReader(file())
  open.push(r)
  return r
}
const writer = (): ContinuityJournal => {
  const w = new ContinuityJournal(file())
  open.push(w)
  return w
}

describe('JournalReader (P13)', () => {
  it('reads nothing for a file that does not exist yet, creates nothing, and sees the file once it exists', () => {
    const r = reader()
    expect(r.eventsFor('run_1')).toEqual([])
    expect(r.firstCheckpointFor('dsp_1')).toBeNull()
    expect(r.lastEvent()).toBeNull()
    expect(r.schemaVersion()).toBeNull()
    expect(existsSync(file())).toBe(false)
    writer().append([ev('a')])
    expect(r.eventsFor('run_1').map((e) => [e.idempotencyKey, e.actor])).toEqual([['a', { surface: 'host' }]])
  })

  it('sees what the writer appends after the reader opened (WAL)', () => {
    const w = writer()
    w.append([ev('a')])
    const r = reader()
    expect(r.eventsFor('run_1')).toHaveLength(1)
    w.append([ev('b')])
    expect(r.eventsFor('run_1').map((e) => e.idempotencyKey)).toEqual(['a', 'b'])
    expect(r.lastEvent()?.idempotencyKey).toBe('b')
  })

  it('reads a v2 file without migrating it: actor null, and the file stays at version 2', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(file())
    raw.exec(
      "CREATE TABLE schema_meta (version INTEGER NOT NULL); INSERT INTO schema_meta VALUES (2);" +
        'CREATE TABLE journal_events (event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, run_id TEXT NOT NULL, task_id TEXT, dispatch_id TEXT, event_type TEXT NOT NULL, created_at TEXT NOT NULL, idempotency_key TEXT UNIQUE, payload_json TEXT NOT NULL);' +
        "INSERT INTO journal_events VALUES ('e1', 2, 'run_1', 'tsk_1', 'dsp_1', 'ATTEMPT_LOST', '2026-09-08T10:00:00.000Z', 'k1', '{}');"
    )
    raw.close()
    const r = reader()
    expect(r.eventsFor('run_1')).toEqual([expect.objectContaining({ eventId: 'e1', type: 'ATTEMPT_LOST', actor: null })])
    expect(r.schemaVersion()).toBe(2)
    r.close()
    open.splice(open.indexOf(r), 1)
    const check = new DatabaseSync(file())
    const cols = (check.prepare('PRAGMA table_info(journal_events)').all() as { name: string }[]).map((c) => c.name)
    check.close()
    expect(cols).not.toContain('actor_json')
  })

  it('refuses to write: the connection is read-only', () => {
    writer().append([ev('a')])
    const r = reader()
    r.eventsFor('run_1')
    // A reader has no schema step to be tricked into, and the connection itself refuses a write.
    expect(() => r.execForTest('DELETE FROM journal_events')).toThrow(/readonly/i)
  })

  // Final review I2: the reader waits out a lock the writer holds for a moment (busy_timeout), and a lock
  // held past it is a failed read (P13: it throws), never a reason to touch the file.
  it('waits out a lock another connection holds for a moment', async () => {
    const w = new ContinuityJournal(file())
    w.append([ev('a')])
    w.close()
    const held = await holdLockFor(file(), 300)
    const r = reader()
    expect(r.eventsFor('run_1')).toHaveLength(1)
    await held.done
  })

  it('a lock held past its timeout throws after waiting for it, and the next read after it is let go works', () => {
    const w = new ContinuityJournal(file())
    w.append([ev('a')])
    w.close()
    const r = new JournalReader(file(), { busyTimeoutMs: 100 })
    open.push(r)
    const lock = holdLock(file())
    try {
      const t0 = Date.now()
      expect(() => r.eventsFor('run_1')).toThrow(/database is locked/)
      // It waited for the lock before it gave up: the timeout is set on this connection.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(90)
    } finally {
      lock.release()
    }
    expect(r.eventsFor('run_1')).toHaveLength(1)
    expect(existsSync(file())).toBe(true)
  })
})

/** A version 1 file whose upgrade failed before recovery_actions was made: an index squats on the
 *  table's name, so the schema step throws there and the file is kept as v1 left it (Task 7 carry). */
const writeFailedV1File = async (at: string): Promise<void> => {
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(at)
  raw.exec(`
CREATE TABLE schema_meta (version INTEGER NOT NULL);
CREATE TABLE journal_events (event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, run_id TEXT NOT NULL,
  task_id TEXT, dispatch_id TEXT, event_type TEXT NOT NULL, created_at TEXT NOT NULL, idempotency_key TEXT UNIQUE,
  payload_json TEXT NOT NULL);
CREATE INDEX recovery_actions ON journal_events(run_id);
INSERT INTO schema_meta (version) VALUES (1);
`)
  raw.close()
}

describe('JournalReader on a v1 file whose upgrade failed (Task 7 carry)', () => {
  it('answers recoveryActionsFor with no rows and a log line instead of throwing', async () => {
    await writeFailedV1File(file())
    const logs: string[] = []
    const r = new JournalReader(file(), { log: (m) => logs.push(m) })
    open.push(r)
    expect(r.recoveryActionsFor('run_1')).toEqual([])
    expect(logs.some((l) => /recovery_actions/.test(l))).toBe(true)
    expect(r.eventsFor('run_1')).toEqual([])
  })
})
