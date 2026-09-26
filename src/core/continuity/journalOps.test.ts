import { describe, it, expect } from 'vitest'
import { JOURNAL_OPS_MAX, parseJournalOps } from './journalOps'

const event = { runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', type: 'RECOVERY_DETECTED', at: '2026-09-26T10:00:00.000Z', idempotencyKey: 'k', payload: {} }
const start = { recoveryActionId: 'rca_1', runId: 'run_1', taskId: 'tsk_1', dispatchId: 'dsp_1', strategy: 'redispatch', class: 'safe', reason: 'r', at: '2026-09-26T10:00:00.000Z' }

describe('parseJournalOps (journal-append, J3)', () => {
  it('takes the three ops in order and drops any actor the sender put on an event', () => {
    const parsed = parseJournalOps([
      { op: 'events', events: [{ ...event, actor: { surface: 'host' } }] },
      { op: 'recovery-start', row: start },
      { op: 'recovery-finish', id: 'rca_1', status: 'completed', at: '2026-09-26T10:01:00.000Z', details: { newDispatchId: 'dsp_2' } }
    ])
    expect('ops' in parsed && parsed.ops.map((o) => o.op)).toEqual(['events', 'recovery-start', 'recovery-finish'])
    expect('ops' in parsed && (parsed.ops[0] as { events: { actor?: unknown }[] }).events[0].actor).toBeUndefined()
  })
  it('refuses what it cannot write, naming the op', () => {
    expect(parseJournalOps(undefined)).toEqual({ error: expect.stringMatching(/ops/) })
    expect(parseJournalOps([])).toEqual({ error: expect.stringMatching(/ops/) })
    expect(parseJournalOps(Array.from({ length: JOURNAL_OPS_MAX + 1 }, () => ({ op: 'events', events: [event] })))).toEqual({ error: expect.any(String) })
    expect(parseJournalOps([{ op: 'events', events: [{ ...event, type: 'TASK_EXPLODED' }] }])).toEqual({ error: expect.stringMatching(/op 0/) })
    expect(parseJournalOps([{ op: 'recovery-start', row: { ...start, recoveryActionId: undefined } }])).toEqual({ error: expect.stringMatching(/op 0/) })
    expect(parseJournalOps([{ op: 'recovery-finish', id: 'rca_1', status: 'maybe', at: 'x' }])).toEqual({ error: expect.stringMatching(/op 0/) })
    expect(parseJournalOps([{ op: 'drop-table' }])).toEqual({ error: expect.stringMatching(/op 0/) })
  })
})
