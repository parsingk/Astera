import { describe, it, expect } from 'vitest'
import { JOURNAL_EVENTS_MAX, JOURNAL_OPS_MAX, JOURNAL_PAYLOAD_MAX_BYTES, parseJournalOps } from './journalOps'

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

  // Review 4-5 M-2: the bounds on what one call may carry.
  it('refuses an event whose payload is over 64 KiB of JSON, and a recovery finish whose details are', () => {
    const fits = { blob: 'x'.repeat(JOURNAL_PAYLOAD_MAX_BYTES - 20) }
    expect(parseJournalOps([{ op: 'events', events: [{ ...event, payload: fits }] }])).toHaveProperty('ops')
    const over = { blob: 'x'.repeat(JOURNAL_PAYLOAD_MAX_BYTES) }
    expect(parseJournalOps([{ op: 'events', events: [{ ...event, payload: over }] }])).toEqual({ error: expect.stringMatching(/op 0: event 0: payload .*65536/) })
    // Counted in bytes, not characters: a character outside ASCII is more than one.
    const wide = { blob: '가'.repeat(Math.ceil(JOURNAL_PAYLOAD_MAX_BYTES / 3)) }
    expect(parseJournalOps([{ op: 'events', events: [{ ...event, payload: wide }] }])).toEqual({ error: expect.stringMatching(/payload/) })
    expect(parseJournalOps([{ op: 'recovery-finish', id: 'rca_1', status: 'failed', at: 'x', details: over }])).toEqual({ error: expect.stringMatching(/op 0: details/) })
  })
  it('refuses more than 64 events in one call, however they are spread over the ops', () => {
    expect(JOURNAL_EVENTS_MAX).toBe(64)
    const eight = { op: 'events', events: Array.from({ length: 8 }, () => event) }
    expect(parseJournalOps(Array.from({ length: 8 }, () => eight))).toHaveProperty('ops')
    expect(parseJournalOps([...Array.from({ length: 8 }, () => eight), { op: 'events', events: [event] }])).toEqual({ error: expect.stringMatching(/64 events/) })
    expect(parseJournalOps([{ op: 'events', events: Array.from({ length: 65 }, () => event) }])).toEqual({ error: expect.any(String) })
  })
  it('refuses an empty idempotency key', () => {
    expect(parseJournalOps([{ op: 'events', events: [{ ...event, idempotencyKey: '' }] }])).toEqual({ error: expect.stringMatching(/op 0: event 0: idempotencyKey/) })
  })
})
