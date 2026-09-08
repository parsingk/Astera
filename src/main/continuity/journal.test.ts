import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ContinuityJournal, SCHEMA_VERSION } from './journal'
import type { ContinuityEvent } from '../../core/continuity/events'

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

  it('deleteRun removes that run’s events and checkpoints only', () => {
    const j = new ContinuityJournal(file())
    j.append([ev('JOB_RUN_STARTED', 'a', 'run_1'), ev('JOB_RUN_STARTED', 'b', 'run_2')])
    j.saveCheckpoint({ runId: 'run_1', taskId: 't', dispatchId: 'd1', kind: 'baseline', at: 'x', state: {} as never, gitHead: null, worktreePath: null, nativeSessionId: null, handoffRef: null })
    j.saveCheckpoint({ runId: 'run_2', taskId: 't', dispatchId: 'd2', kind: 'baseline', at: 'x', state: {} as never, gitHead: null, worktreePath: null, nativeSessionId: null, handoffRef: null })
    j.deleteRun('run_1')
    expect(j.eventsFor('run_1')).toEqual([])
    expect(j.eventsFor('run_2')).toHaveLength(1)
    expect(j.latestCheckpointFor('d1')).toBeNull()
    expect(j.latestCheckpointFor('d2')).not.toBeNull()
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
})

describe('ContinuityJournal schema 2', () => {
  it('creates at version 2 and reports itself usable', () => {
    const j = new ContinuityJournal(file())
    expect(j.usable).toBe(true)
    expect(j.schemaVersion()).toBe(2)
    j.close()
  })

  it('migrates a version 1 file in place, keeping its rows', () => {
    const j1 = new ContinuityJournal(file())
    j1.append([ev('JOB_RUN_STARTED', 'a')])
    // pretend this file was written by the previous release
    j1.setSchemaVersionForTest(1)
    j1.close()
    const j2 = new ContinuityJournal(file())
    expect(j2.schemaVersion()).toBe(2)
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
