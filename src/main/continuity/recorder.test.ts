import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ContinuityJournal } from './journal'
import { ContinuityRecorder, type ContinuityJournalPort } from './recorder'
import { emptyState, type OrchState } from '../../core/orchestration/state'
import type { Dispatch, Run, Task } from '../../core/orchestration/types'
import type { HandoffLookup } from '../../core/handoff/types'
import { makeRepo, gitSync } from '../../core/worktrees/testRepo'

let dir: string
let repo: string
// node:sqlite's DatabaseSync keeps the file open (and, on Windows, locked for delete) until close()
// is called — journal.test.ts closes every journal it creates for the same reason. recorder() below
// registers each real ContinuityJournal it opens here so this hook can close it before the temp dir
// it lives in is removed, without every `it` (kept verbatim from the brief) having to do it itself.
const openJournals: ContinuityJournal[] = []
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-recorder-'))
  repo = await makeRepo('astera-recorder-repo-')
})
afterEach(async () => {
  for (const j of openJournals) {
    try {
      j.close()
    } catch {
      /* already closed by the test itself */
    }
  }
  openJournals.length = 0
  await fs.rm(dir, { recursive: true, force: true })
  await fs.rm(repo, { recursive: true, force: true })
})

const NOW = '2026-09-08T10:00:00.000Z'
const run = (): Run => ({ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: NOW })
const task = (status: Task['status'] = 'dispatched'): Task => ({
  id: 'tsk_1', runId: 'run_1', title: 'Auth refactor', spec: 's', deps: [], status, consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW
})
const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: 'dsp_1', taskId: 'tsk_1', provider: 'claude', accountId: 'acc', sessionId: 'sess-1', cwd: repo, specPath: 's', startedAt: NOW, workerState: 'ready', retained: false, ...over
})
const state = (d: Dispatch | null, t: Task = task()): OrchState => ({ ...emptyState(), runs: [run()], tasks: [t], dispatches: d ? [d] : [] })

let files = 0
/** `journal` in the result is always the real one (for assertions); `over.journal` replaces what the
 *  recorder is handed, for the failure tests. Each recorder gets its own file. */
function recorder(over: { journal?: ContinuityJournalPort; smart?: boolean; handoffFound?: boolean } = {}): {
  r: ContinuityRecorder
  journal: ContinuityJournal
  logs: string[]
} {
  const journal = new ContinuityJournal(path.join(dir, `c${++files}.sqlite`))
  openJournals.push(journal)
  const logs: string[] = []
  const r = new ContinuityRecorder({
    journal: over.journal ?? journal,
    log: (m) => logs.push(m),
    now: () => NOW,
    smartResume: () => over.smart ?? false,
    handoffLookup: (): HandoffLookup =>
      over.handoffFound ? { state: 'found', memo: {} as never } : { state: 'none' }
  })
  return { r, journal, logs }
}

describe('ContinuityRecorder.record', () => {
  it('journals the derived events and returns them', () => {
    const { r, journal } = recorder()
    const events = r.record(state(null, task('ready')), state(dispatch({ sessionId: 'pending:ab' })))
    expect(events.map((e) => e.type)).toEqual(['TASK_STARTED', 'ATTEMPT_START_REQUESTED'])
    expect(journal.eventsFor('run_1').map((e) => e.type)).toEqual(['TASK_STARTED', 'ATTEMPT_START_REQUESTED'])
  })

  it('a journal that throws is logged and does not throw out (design §6)', () => {
    const broken: ContinuityJournalPort = {
      append: () => { throw new Error('disk full') },
      saveCheckpoint: () => { throw new Error('disk full') },
      deleteRun: () => {},
      eventsFor: () => [],
      lastEvent: () => null,
      close: () => {}
    }
    const { r, logs } = recorder({ journal: broken })
    expect(() => r.record(state(null, task('ready')), state(dispatch()))).not.toThrow()
    expect(logs.some((l) => l.includes('disk full') && l.includes('ATTEMPT_START_REQUESTED'))).toBe(true)
  })

  it('a Run that vanished from the projection has its rows deleted', () => {
    const { r, journal } = recorder()
    r.record(emptyState(), state(dispatch()))
    expect(journal.eventsFor('run_1').length).toBeGreaterThan(0)
    r.record(state(dispatch()), emptyState())
    expect(journal.eventsFor('run_1')).toEqual([])
  })
})

describe('ContinuityRecorder.checkpoint', () => {
  it('after ATTEMPT_STARTED writes a row with the worktree HEAD and a CHECKPOINT_CREATED event', async () => {
    const { r, journal } = recorder()
    const prev = state(dispatch({ sessionId: 'pending:ab' }))
    const next = state(dispatch())
    const events = r.record(prev, next)
    await r.checkpoint(events, next)
    const row = journal.latestCheckpointFor('dsp_1')
    expect(row).toMatchObject({ kind: 'attempt-started', worktreePath: repo, nativeSessionId: null, handoffRef: null })
    expect(row?.gitHead).toBe(gitSync(repo, ['rev-parse', 'HEAD']).trim())
    expect(row?.state).toMatchObject({ version: 1, runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1' })
    expect(journal.eventsFor('run_1').map((e) => e.type)).toContain('CHECKPOINT_CREATED')
  })

  it('a worktree that is not a repository yields a checkpoint without git', async () => {
    const { r, journal } = recorder()
    const next = state(dispatch({ cwd: path.join(dir, 'nowhere') }))
    await r.checkpoint(r.record(state(dispatch({ sessionId: 'pending:ab', cwd: path.join(dir, 'nowhere') })), next), next)
    expect(journal.latestCheckpointFor('dsp_1')?.gitHead).toBeNull()
  })

  it('handoffRef is null unless Smart Resume is on and a memo exists', async () => {
    const cases: Array<[boolean, boolean, string | null]> = [[false, true, null], [true, false, null], [true, true, 'sess-1']]
    for (const [smart, found, expected] of cases) {
      const { r, journal } = recorder({ smart, handoffFound: found })
      const next = state(dispatch())
      await r.checkpoint(r.record(state(dispatch({ sessionId: 'pending:ab' })), next), next)
      expect(journal.latestCheckpointFor('dsp_1')?.handoffRef).toBe(expected)
      journal.close()
    }
  })

  it('a lost attempt gets no checkpoint', async () => {
    const { r, journal } = recorder()
    const live = state(dispatch())
    const lost = state(dispatch({ endedAt: NOW, workerState: 'outcome_unknown' }))
    await r.checkpoint(r.record(live, lost), lost)
    expect(journal.latestCheckpointFor('dsp_1')).toBeNull()
  })

  it('a throwing handoff lookup is logged, not thrown, and writes no row', async () => {
    const journal = new ContinuityJournal(path.join(dir, 'throwing-handoff.sqlite'))
    openJournals.push(journal)
    const logs: string[] = []
    const r = new ContinuityRecorder({
      journal,
      log: (m) => logs.push(m),
      now: () => NOW,
      smartResume: () => true,
      handoffLookup: () => {
        throw new Error('memo store exploded')
      }
    })
    const next = state(dispatch())
    await expect(r.checkpoint(r.record(state(dispatch({ sessionId: 'pending:ab' })), next), next)).resolves.toBeUndefined()
    expect(journal.latestCheckpointFor('dsp_1')).toBeNull()
    expect(logs.some((l) => l.includes('memo store exploded'))).toBe(true)
  })
})

describe('ContinuityRecorder.enable', () => {
  it('writes one baseline per open real dispatch and one CONTINUITY_ENABLED per run', async () => {
    const { r, journal } = recorder()
    const s: OrchState = {
      ...emptyState(),
      runs: [run(), { id: 'run_2', objective: 'o2', cwd: 'D:/q', createdAt: NOW }],
      tasks: [task(), { ...task(), id: 'tsk_2', runId: 'run_2' }, { ...task(), id: 'tsk_3', runId: 'run_2' }],
      dispatches: [
        dispatch(),
        dispatch({ id: 'dsp_2', taskId: 'tsk_2', sessionId: 'sess-2' }),
        dispatch({ id: 'dsp_3', taskId: 'tsk_3', sessionId: 'pending:zz' }),
        dispatch({ id: 'dsp_4', taskId: 'tsk_1', sessionId: 'sess-old', endedAt: NOW, outcome: 'succeeded' })
      ]
    }
    await r.enable(s)
    expect(journal.eventsFor('run_1').map((e) => e.type)).toEqual(['CONTINUITY_ENABLED', 'CHECKPOINT_CREATED'])
    expect(journal.eventsFor('run_2').map((e) => e.type)).toEqual(['CONTINUITY_ENABLED', 'CHECKPOINT_CREATED'])
    expect(journal.latestCheckpointFor('dsp_1')?.kind).toBe('baseline')
    expect(journal.latestCheckpointFor('dsp_2')?.kind).toBe('baseline')
    expect(journal.latestCheckpointFor('dsp_3')).toBeNull()
    expect(journal.latestCheckpointFor('dsp_4')).toBeNull()
  })
})

describe('ContinuityRecorder reads', () => {
  it('lostEventsFor maps ATTEMPT_LOST to a runtime-lost Timeline event with the task title', () => {
    const { r } = recorder()
    const live = state(dispatch())
    const lost = state(dispatch({ endedAt: NOW, workerState: 'outcome_unknown' }))
    r.record(live, lost)
    expect(r.lostEventsFor('run_1', lost)).toEqual([
      expect.objectContaining({ at: NOW, kind: 'runtime-lost', taskId: 'tsk_1', taskTitle: 'Auth refactor', summary: '' })
    ])
    expect(r.lostEventsFor('run_9', lost)).toEqual([])
  })

  it('recoveryEventsFor turns a selected strategy into one Timeline row', () => {
    const { r, journal } = recorder()
    journal.append([
      {
        runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', type: 'RECOVERY_STRATEGY_SELECTED',
        at: NOW, idempotencyKey: 'k1', payload: { strategy: 'resume-native', reason: 'the provider session can be resumed' }
      }
    ])
    expect(r.recoveryEventsFor('run_1', state(dispatch()))).toEqual([
      expect.objectContaining({ at: NOW, kind: 'recovery', taskId: 'tsk_1', taskTitle: 'Auth refactor', summary: 'resume-native' })
    ])
  })

  it('reportSkew logs when the last journal event names a dispatch the projection lacks', () => {
    const { r, logs } = recorder()
    r.record(state(null, task('ready')), state(dispatch({ sessionId: 'pending:ab' })))
    r.reportSkew(state(null, task('ready')))
    expect(logs.some((l) => l.includes('skew') && l.includes('dsp_1'))).toBe(true)
    logs.length = 0
    r.reportSkew(state(dispatch({ sessionId: 'pending:ab' })))
    expect(logs).toEqual([])
  })
})
