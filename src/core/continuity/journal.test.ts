import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ContinuityJournal, SCHEMA_VERSION, isBusyError, isCorruptionError } from './journal'
import { holdLock, holdLockFor } from './sqliteLockFixtures'
import type { ContinuityEvent } from './events'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-journal-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})
const file = (): string => path.join(dir, 'continuity.sqlite')

const ev = (type: ContinuityEvent['type'], key: string, runId = 'run_1'): ContinuityEvent => ({
  runId,
  taskId: 'tsk_1',
  dispatchId: 'dsp_1',
  type,
  at: '2026-09-08T10:00:00.000Z',
  idempotencyKey: key,
  payload: { n: 1 }
})

describe('ContinuityJournal', () => {
  it('opens with WAL and full sync and creates the schema', () => {
    const j = new ContinuityJournal(file())
    expect(j.recovered).toBe(false)
    expect(String(j.pragma('journal_mode')).toLowerCase()).toBe('wal')
    expect(Number(j.pragma('synchronous'))).toBe(2) // FULL
    expect(j.eventsFor('run_1')).toEqual([])
    j.close()
  })

  it('appends in order, sequence ascending, payload round-tripping', () => {
    const j = new ContinuityJournal(file())
    expect(j.append([ev('JOB_RUN_STARTED', 'a'), ev('TASK_STARTED', 'b'), ev('ATTEMPT_STARTED', 'c')])).toBe(3)
    const rows = j.eventsFor('run_1')
    expect(rows.map((r) => r.type)).toEqual(['JOB_RUN_STARTED', 'TASK_STARTED', 'ATTEMPT_STARTED'])
    expect(rows[0].sequence).toBeLessThan(rows[1].sequence)
    expect(rows[1].sequence).toBeLessThan(rows[2].sequence)
    expect(rows[0]).toMatchObject({ schemaVersion: SCHEMA_VERSION, runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', payload: { n: 1 } })
    expect(rows[0].eventId).toMatch(/^[0-9a-f-]{36}$/)
    expect(j.lastEvent()?.type).toBe('ATTEMPT_STARTED')
    j.close()
  })

  it('the same idempotency key is inserted once', () => {
    const j = new ContinuityJournal(file())
    j.append([ev('JOB_RUN_STARTED', 'a')])
    expect(j.append([ev('JOB_RUN_STARTED', 'a'), ev('TASK_STARTED', 'b')])).toBe(1)
    expect(j.eventsFor('run_1')).toHaveLength(2)
    j.close()
  })

  it('an append is one transaction: nothing lands when one row is invalid', () => {
    const j = new ContinuityJournal(file())
    const bad = { ...ev('TASK_STARTED', 'b'), runId: null as unknown as string }
    expect(() => j.append([ev('JOB_RUN_STARTED', 'a'), bad])).toThrow()
    expect(j.eventsFor('run_1')).toEqual([])
    j.close()
  })

  it('survives close and reopen', () => {
    const a = new ContinuityJournal(file())
    a.append([ev('JOB_RUN_STARTED', 'a')])
    a.close()
    const b = new ContinuityJournal(file())
    expect(b.eventsFor('run_1')).toHaveLength(1)
    b.close()
  })

  it('saves checkpoints and reads the latest per dispatch', () => {
    const j = new ContinuityJournal(file())
    const row = (at: string, gitHead: string) =>
      j.saveCheckpoint({
        runId: 'run_1',
        taskId: 'tsk_1',
        dispatchId: 'dsp_1',
        kind: 'attempt-started',
        at,
        state: { version: 1, createdAt: at } as never,
        gitHead,
        worktreePath: 'D:/wt',
        nativeSessionId: null,
        handoffRef: null
      })
    const first = row('2026-09-08T10:00:00.000Z', 'aaa')
    const second = row('2026-09-08T10:05:00.000Z', 'bbb')
    expect(first.checkpointId).not.toBe(second.checkpointId)
    expect(j.latestCheckpointFor('dsp_1')).toMatchObject({ checkpointId: second.checkpointId, gitHead: 'bbb', state: { version: 1 } })
    expect(j.latestCheckpointFor('dsp_9')).toBeNull()
    j.close()
  })

  it('deleteRun removes that run’s events, checkpoints and recovery actions only', () => {
    const j = new ContinuityJournal(file())
    j.append([ev('JOB_RUN_STARTED', 'a', 'run_1'), ev('JOB_RUN_STARTED', 'b', 'run_2')])
    j.saveCheckpoint({ runId: 'run_1', taskId: 't', dispatchId: 'd1', kind: 'baseline', at: 'x', state: {} as never, gitHead: null, worktreePath: null, nativeSessionId: null, handoffRef: null })
    j.saveCheckpoint({ runId: 'run_2', taskId: 't', dispatchId: 'd2', kind: 'baseline', at: 'x', state: {} as never, gitHead: null, worktreePath: null, nativeSessionId: null, handoffRef: null })
    j.startRecoveryAction({ runId: 'run_1', taskId: 't', dispatchId: 'd1', strategy: 'redispatch', class: 'safe', reason: 'r', at: 'x' })
    j.startRecoveryAction({ runId: 'run_2', taskId: 't', dispatchId: 'd2', strategy: 'redispatch', class: 'safe', reason: 'r', at: 'x' })
    j.deleteRun('run_1')
    expect(j.eventsFor('run_1')).toEqual([])
    expect(j.eventsFor('run_2')).toHaveLength(1)
    expect(j.latestCheckpointFor('d1')).toBeNull()
    expect(j.latestCheckpointFor('d2')).not.toBeNull()
    expect(j.recoveryActionsFor('run_1')).toEqual([])
    expect(j.recoveryActionsFor('run_2')).toHaveLength(1)
    j.close()
  })

  it('a file that is not a database is moved aside and a fresh one opened', async () => {
    await fs.writeFile(file(), 'this is not sqlite', 'utf8')
    const logs: string[] = []
    const j = new ContinuityJournal(file(), { log: (m) => logs.push(m), now: () => '2026-09-08T10:00:00.000Z' })
    expect(j.recovered).toBe(true)
    expect(j.eventsFor('run_1')).toEqual([])
    j.append([ev('JOB_RUN_STARTED', 'a')])
    expect(j.eventsFor('run_1')).toHaveLength(1)
    const names = await fs.readdir(dir)
    expect(names.some((n) => n.startsWith('continuity.sqlite.corrupt-'))).toBe(true)
    expect(logs.some((l) => l.includes('moved aside'))).toBe(true)
    j.close()
  })

  // Final review I2: a lock is not corruption. Another process (the app's reader, the Host's writer) can
  // hold the file for a moment; the open waits it out (busy_timeout) instead of moving a healthy file aside.
  it('waits out a lock another connection holds for a moment, and keeps the file and its rows', async () => {
    const first = new ContinuityJournal(file())
    first.append([ev('JOB_RUN_STARTED', 'a')])
    first.close()
    const held = await holdLockFor(file(), 300)
    const j = new ContinuityJournal(file())
    expect(j.recovered).toBe(false)
    expect(j.eventsFor('run_1')).toHaveLength(1)
    j.close()
    await held.done
    expect((await fs.readdir(dir)).filter((n) => n.includes('.corrupt-'))).toEqual([])
  })

  it('a lock held past the timeout leaves the file where it is: the open throws, and a later open finds the rows', async () => {
    const first = new ContinuityJournal(file())
    first.append([ev('JOB_RUN_STARTED', 'a')])
    first.close()
    const lock = holdLock(file())
    const logs: string[] = []
    try {
      expect(() => new ContinuityJournal(file(), { log: (m) => logs.push(m), busyTimeoutMs: 20 })).toThrow(/database is locked/)
    } finally {
      lock.release()
    }
    expect((await fs.readdir(dir)).filter((n) => n.includes('.corrupt-'))).toEqual([])
    expect(logs.some((l) => l.includes('moved aside'))).toBe(false)
    const j = new ContinuityJournal(file())
    expect(j.eventsFor('run_1')).toHaveLength(1)
    j.close()
  })

  it('tells corruption from a lock by the SQLite error code', () => {
    const sqliteError = (errcode: number): Error => Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errcode })
    expect(isCorruptionError(sqliteError(11))).toBe(true) // SQLITE_CORRUPT
    expect(isCorruptionError(sqliteError(26))).toBe(true) // SQLITE_NOTADB
    expect(isCorruptionError(sqliteError(11 | (1 << 8)))).toBe(true) // SQLITE_CORRUPT_VTAB, an extended code
    expect(isCorruptionError(sqliteError(5))).toBe(false) // SQLITE_BUSY
    expect(isCorruptionError(sqliteError(6))).toBe(false) // SQLITE_LOCKED
    expect(isCorruptionError(new Error('EISDIR'))).toBe(false)
    expect(isBusyError(sqliteError(5))).toBe(true)
    expect(isBusyError(sqliteError(5 | (1 << 8)))).toBe(true) // SQLITE_BUSY_RECOVERY
    expect(isBusyError(sqliteError(6))).toBe(true)
    expect(isBusyError(sqliteError(26))).toBe(false)
  })
})

describe('ContinuityJournal schema 2', () => {
  it('creates at the current version and reports itself usable', () => {
    const j = new ContinuityJournal(file())
    expect(j.usable).toBe(true)
    expect(j.schemaVersion()).toBe(SCHEMA_VERSION)
    j.close()
  })

  it('migrates a version 1 file in place, keeping its rows', () => {
    const j1 = new ContinuityJournal(file())
    j1.append([ev('JOB_RUN_STARTED', 'a')])
    // pretend this file was written by the previous release
    j1.setSchemaVersionForTest(1)
    j1.close()
    const j2 = new ContinuityJournal(file())
    expect(j2.schemaVersion()).toBe(SCHEMA_VERSION)
    expect(j2.eventsFor('run_1')).toHaveLength(1)
    expect(j2.recoveryActionsFor('run_1')).toEqual([])
    j2.close()
  })

  it('refuses a file from a newer build instead of touching it', () => {
    const j1 = new ContinuityJournal(file())
    j1.setSchemaVersionForTest(99)
    j1.close()
    const logs: string[] = []
    const j2 = new ContinuityJournal(file(), { log: (m) => logs.push(m) })
    expect(j2.usable).toBe(false)
    expect(j2.recovered).toBe(false) // the file is intact, not moved aside
    expect(j2.append([ev('JOB_RUN_STARTED', 'b')])).toBe(0)
    expect(logs.some((l) => l.includes('newer'))).toBe(true)
    j2.close()
  })

  // `CREATE TABLE IF NOT EXISTS` is not a no-op against a file whose future build renamed or dropped
  // one of these tables: it silently creates an empty one of ours beside it. So the version has to be
  // read before the schema is applied, not after.
  it('leaves a newer-version file its own tables, creating none of ours', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(file())
    raw.exec('CREATE TABLE schema_meta (version INTEGER NOT NULL)')
    raw.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(99)
    raw.exec('CREATE TABLE journal_entries (entry_id TEXT PRIMARY KEY)') // what version 99 renamed it to
    raw.close()

    const j = new ContinuityJournal(file())
    expect(j.usable).toBe(false)
    expect(j.schemaVersion()).toBe(99)
    j.close()

    const after = new DatabaseSync(file())
    const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
      .map((r) => r.name)
    after.close()
    expect(tables).toContain('journal_entries')
    expect(tables).not.toContain('journal_events')
    expect(tables).not.toContain('checkpoints')
    expect(tables).not.toContain('recovery_actions')
  })

  it('records a recovery action and closes it', () => {
    const j = new ContinuityJournal(file())
    const row = j.startRecoveryAction({
      runId: 'run_1',
      taskId: 'tsk_1',
      dispatchId: 'dsp_1',
      strategy: 'resume-native',
      class: 'safe',
      reason: 'the provider session can be resumed',
      at: '2026-09-09T10:00:00.000Z'
    })
    expect(row.status).toBe('selected')
    j.finishRecoveryAction(row.recoveryActionId, 'completed', '2026-09-09T10:00:01.000Z', { newDispatchId: 'dsp_2' })
    const [stored] = j.recoveryActionsFor('run_1')
    expect(stored).toMatchObject({ status: 'completed', strategy: 'resume-native', details: { newDispatchId: 'dsp_2' } })
    expect(stored.completedAt).not.toBeNull()
    j.close()
  })

  it('returns the first checkpoint of a dispatch, not the latest', () => {
    const j = new ContinuityJournal(file())
    const row = (at: string, gitHead: string) =>
      j.saveCheckpoint({
        runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', kind: 'attempt-started', at,
        state: {} as never, gitHead, worktreePath: 'D:/wt', nativeSessionId: null, handoffRef: null
      })
    row('2026-09-09T10:00:00.000Z', 'aaa')
    row('2026-09-09T10:05:00.000Z', 'bbb')
    expect(j.firstCheckpointFor('dsp_1')?.gitHead).toBe('aaa')
    expect(j.latestCheckpointFor('dsp_1')?.gitHead).toBe('bbb')
    expect(j.firstCheckpointFor('dsp_9')).toBeNull()
    j.close()
  })

  it('sweeps the rows of runs the projection no longer has', () => {
    const j = new ContinuityJournal(file())
    j.append([ev('JOB_RUN_STARTED', 'a', 'run_1'), ev('JOB_RUN_STARTED', 'b', 'run_2')])
    j.startRecoveryAction({
      runId: 'run_2', taskId: 't', dispatchId: 'd', strategy: 'review', class: 'review',
      reason: 'r', at: '2026-09-09T10:00:00.000Z'
    })
    expect(j.sweepOrphans(new Set(['run_1']))).toBe(1)
    expect(j.eventsFor('run_2')).toEqual([])
    expect(j.recoveryActionsFor('run_2')).toEqual([])
    expect(j.eventsFor('run_1')).toHaveLength(1)
    j.close()
  })
})

/** The schema as version 2 shipped it, to make a file an older build left behind. */
const V2_SCHEMA = `
CREATE TABLE schema_meta (version INTEGER NOT NULL);
CREATE TABLE journal_events (event_id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, run_id TEXT NOT NULL,
  task_id TEXT, dispatch_id TEXT, event_type TEXT NOT NULL, created_at TEXT NOT NULL, idempotency_key TEXT UNIQUE,
  payload_json TEXT NOT NULL);
CREATE TABLE checkpoints (checkpoint_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL, state_json TEXT NOT NULL, git_head TEXT,
  worktree_path TEXT, native_session_id TEXT, handoff_ref TEXT);
CREATE TABLE recovery_actions (recovery_action_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL, strategy TEXT NOT NULL, class TEXT NOT NULL, reason TEXT NOT NULL, status TEXT NOT NULL,
  started_at TEXT NOT NULL, completed_at TEXT, details_json TEXT);
`
const writeV2File = async (): Promise<void> => {
  const { DatabaseSync } = await import('node:sqlite')
  const raw = new DatabaseSync(file())
  raw.exec(V2_SCHEMA)
  raw.prepare('INSERT INTO schema_meta (version) VALUES (2)').run()
  raw
    .prepare(
      `INSERT INTO journal_events (event_id, schema_version, run_id, task_id, dispatch_id, event_type, created_at, idempotency_key, payload_json)
       VALUES ('e1', 2, 'run_1', 'tsk_1', 'dsp_1', 'TASK_STARTED', '2026-09-08T10:00:00.000Z', 'k1', '{}')`
    )
    .run()
  raw.close()
}

describe('ContinuityJournal v3 (Host journal J4)', () => {
  it('writes who acted and reads it back, null where no actor was given', () => {
    const j = new ContinuityJournal(file())
    j.append([
      { ...ev('TASK_STARTED', 'a'), actor: { surface: 'cli' } },
      { ...ev('TASK_COMPLETED', 'b'), actor: { surface: 'agent', sessionId: 'ses_1' } },
      ev('JOB_RUN_PAUSED', 'c')
    ])
    expect(j.eventsFor('run_1').map((e) => e.actor)).toEqual([{ surface: 'cli' }, { surface: 'agent', sessionId: 'ses_1' }, null])
    expect(j.schemaVersion()).toBe(3)
    expect(SCHEMA_VERSION).toBe(3)
    j.close()
  })

  it('migrates a v2 file in place: its rows stay, read as actor null, and new rows carry one', async () => {
    await writeV2File()
    const j = new ContinuityJournal(file())
    expect(j.usable).toBe(true)
    expect(j.recovered).toBe(false)
    expect(j.schemaVersion()).toBe(3)
    expect(j.eventsFor('run_1')).toEqual([expect.objectContaining({ eventId: 'e1', schemaVersion: 2, actor: null })])
    expect(j.append([{ ...ev('TASK_COMPLETED', 'k2'), actor: { surface: 'host' } }])).toBe(1)
    expect(j.eventsFor('run_1').map((e) => e.actor)).toEqual([null, { surface: 'host' }])
    j.close()
  })

  // The column and the stamp move together or not at all: a failure between them (here a trigger that
  // refuses the stamp, standing in for a crash) leaves the file exactly as v2 left it. A failed upgrade
  // is not a corrupt file: it stays where it is, readable, and this session writes nothing to it.
  it('a v3 step that fails midway leaves the v2 file in place, readable and unwritten, moving nothing aside', async () => {
    await writeV2File()
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(file())
    raw.exec("CREATE TRIGGER no_stamp BEFORE UPDATE ON schema_meta BEGIN SELECT RAISE(ABORT, 'crash midway'); END")
    raw.close()
    const logs: string[] = []
    const j = new ContinuityJournal(file(), { log: (m) => logs.push(m), now: () => '2026-09-26T10:00:00.000Z' })
    expect(j.recovered).toBe(false)
    expect(j.usable).toBe(false)
    expect(j.schemaVersion()).toBe(2)
    expect(logs.some((l) => l.includes('crash midway'))).toBe(true)
    expect(j.eventsFor('run_1')).toEqual([expect.objectContaining({ eventId: 'e1', actor: null })])
    expect(j.lastEvent()).toEqual(expect.objectContaining({ eventId: 'e1' }))
    expect(j.append([{ ...ev('TASK_COMPLETED', 'k2'), actor: { surface: 'host' } }])).toBe(0)
    j.close()
    expect((await fs.readdir(dir)).filter((n) => n.includes('.corrupt-'))).toEqual([])
    const old = new DatabaseSync(file())
    const cols = (old.prepare('PRAGMA table_info(journal_events)').all() as { name: string }[]).map((c) => c.name)
    const version = (old.prepare('SELECT version FROM schema_meta').get() as { version: number }).version
    const rows = old.prepare('SELECT event_id FROM journal_events').all() as { event_id: string }[]
    old.close()
    expect(cols).not.toContain('actor_json')
    expect(version).toBe(2)
    expect(rows.map((r) => r.event_id)).toEqual(['e1'])
  })

  it('reads an actor it cannot parse as null rather than failing the read', async () => {
    const j = new ContinuityJournal(file())
    j.append([ev('TASK_STARTED', 'a')])
    j.close()
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(file())
    raw.prepare("UPDATE journal_events SET actor_json = '{\"surface\":\"robot\"}'").run()
    raw.close()
    const again = new ContinuityJournal(file())
    expect(again.eventsFor('run_1')[0].actor).toBeNull()
    again.close()
  })

  it('keeps the recovery action id a caller minted (P14)', () => {
    const j = new ContinuityJournal(file())
    const row = j.startRecoveryAction({
      recoveryActionId: 'rca_app_1', runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1',
      strategy: 'redispatch', class: 'safe', reason: 'r', at: '2026-09-09T10:00:00.000Z'
    })
    expect(row.recoveryActionId).toBe('rca_app_1')
    j.finishRecoveryAction('rca_app_1', 'completed', '2026-09-09T10:01:00.000Z', { newDispatchId: 'dsp_2' })
    expect(j.recoveryActionsFor('run_1')).toEqual([expect.objectContaining({ recoveryActionId: 'rca_app_1', status: 'completed' })])
    j.close()
  })
})

// Review 4-5: one journal-append call is one transaction (one fsync), each of its ops isolated inside it.
describe('ContinuityJournal.transaction', () => {
  it('commits every write inside it at once: another connection sees none of them before the end', () => {
    const j = new ContinuityJournal(file())
    const other = new ContinuityJournal(file())
    let seenInside = -1
    j.transaction(() => {
      j.append([ev('JOB_RUN_STARTED', 'a')])
      j.startRecoveryAction({ recoveryActionId: 'rca_1', runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', strategy: 's', class: 'safe', reason: 'r', at: 'x' })
      seenInside = other.eventsFor('run_1').length
    })
    expect(seenInside).toBe(0)
    expect(other.eventsFor('run_1')).toHaveLength(1)
    expect(other.recoveryActionsFor('run_1')).toHaveLength(1)
    other.close()
    j.close()
  })

  it('a nested one that throws undoes only its own writes, and the outer one still commits', () => {
    const j = new ContinuityJournal(file())
    const bad = { ...ev('TASK_STARTED', 'b'), runId: null as unknown as string }
    j.transaction(() => {
      j.append([ev('JOB_RUN_STARTED', 'a')])
      expect(() => j.transaction(() => j.append([ev('TASK_STARTED', 'c'), bad]))).toThrow()
      j.append([ev('TASK_COMPLETED', 'd')])
    })
    expect(j.eventsFor('run_1').map((e) => e.idempotencyKey)).toEqual(['a', 'd'])
    j.close()
  })

  it('an outer one that throws undoes everything inside it', () => {
    const j = new ContinuityJournal(file())
    expect(() =>
      j.transaction(() => {
        j.append([ev('JOB_RUN_STARTED', 'a')])
        throw new Error('stop')
      })
    ).toThrow('stop')
    expect(j.eventsFor('run_1')).toEqual([])
    j.append([ev('JOB_RUN_STARTED', 'a')])
    expect(j.eventsFor('run_1')).toHaveLength(1)
    j.close()
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

describe('ContinuityJournal on a v1 file whose upgrade failed (Task 7 carry)', () => {
  it('answers recoveryActionsFor with no rows and a log line instead of throwing', async () => {
    await writeFailedV1File(file())
    const logs: string[] = []
    const j = new ContinuityJournal(file(), { log: (m) => logs.push(m) })
    try {
      expect(j.usable).toBe(false)
      expect(j.schemaVersion()).toBe(1)
      logs.length = 0
      expect(j.recoveryActionsFor('run_1')).toEqual([])
      expect(logs.some((l) => /recovery_actions/.test(l))).toBe(true)
    } finally {
      j.close()
    }
  })
})
