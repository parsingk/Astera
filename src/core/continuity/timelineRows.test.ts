import { describe, it, expect } from 'vitest'
import { journalTimeline, lostRowsOf, recoveryRowsOf } from './timelineRows'
import type { JournalEventRow } from './journal'
import { stateFromLegacy } from '../orchestration/legacyState'

const NOW = '2026-09-26T10:00:00.000Z'
const row = (over: Partial<JournalEventRow>): JournalEventRow => ({
  eventId: 'evt_1', sequence: 1, schemaVersion: 3, runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1',
  type: 'ATTEMPT_LOST', at: NOW, idempotencyKey: 'k', payload: {}, actor: { surface: 'host' }, ...over
})
const state = stateFromLegacy({
  runs: [{ id: 'run_1', objective: 'o', cwd: 'D:/p', createdAt: NOW }],
  tasks: [{ id: 'tsk_1', runId: 'run_1', title: 'Auth refactor', spec: 's', deps: [], status: 'dispatched', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }],
  dispatches: []
})

describe('the journal rows the timeline shows', () => {
  it('a lost attempt is a runtime-lost line with its Task title', () => {
    expect(lostRowsOf([row({})], state)).toEqual([
      { at: NOW, kind: 'runtime-lost', sourceId: 'evt_1', taskId: 'tsk_1', taskTitle: 'Auth refactor', summary: '' }
    ])
  })
  it('a strategy decision is a recovery line: the strategy, and the reason in the reader language', () => {
    const decided = row({ eventId: 'evt_2', type: 'RECOVERY_STRATEGY_SELECTED', payload: { strategy: 'redispatch', reason: 'the English reason' } })
    expect(recoveryRowsOf([decided], state, 'en')).toEqual([expect.objectContaining({ kind: 'recovery', summary: 'redispatch', body: 'the English reason' })])
  })
  it('keeps nothing else, lost rows first', () => {
    const rows = [row({ eventId: 'a', type: 'RECOVERY_STRATEGY_SELECTED', payload: { strategy: 'review' } }), row({ eventId: 'b' }), row({ eventId: 'c', type: 'TASK_STARTED' })]
    expect(journalTimeline(rows, state, 'en').map((e) => e.sourceId)).toEqual(['b', 'a'])
  })
})
