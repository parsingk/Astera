import { describe, it, expect } from 'vitest'
import type { OrchState } from './state'
import { ASKED_FINDINGS_MAX, ASKED_FINDING_TEXT_MAX, capAsked, repairEligibility } from './taskRepair'

// Phase 3 Part 1 (design §5 Part 1 item 4, the person's rule of 2026-11-26): which Tasks take a person's repair request
type T = { id: string; status: string; deps?: string[] }
function state(o: { task: T; others?: T[]; runEnded?: boolean; gates?: { id: string; kind?: string; status: string }[]; open?: boolean; noAttempt?: boolean }): OrchState {
  const dispatches = o.noAttempt
    ? []
    : [
        { id: 'd1', taskId: o.task.id, cwd: 'F:/wt/t1', startedAt: '2026-11-26T01:00:00Z', outcome: 'succeeded', endedAt: '2026-11-26T01:10:00Z' },
        { id: 'd2', taskId: o.task.id, cwd: 'F:/wt/review', startedAt: '2026-11-26T01:20:00Z', review: true, outcome: 'succeeded', endedAt: '2026-11-26T01:30:00Z' },
        ...(o.open ? [{ id: 'd3', taskId: o.task.id, cwd: 'F:/wt/t1', startedAt: '2026-11-26T02:00:00Z' }] : [])
      ]
  return {
    jobs: [{ id: 'j1', objective: 'x', cwd: 'F:/repo' }],
    runs: [{ id: 'r1', jobId: 'j1', ordinal: 1, ...(o.runEnded ? { endedAt: '2026-11-26T03:00:00Z' } : {}) }],
    tasks: [o.task, ...(o.others ?? [])].map((t) => ({ runId: 'r1', title: t.id, deps: [], ...t })),
    dispatches,
    gates: (o.gates ?? []).map((g) => ({ runId: 'r1', taskId: o.task.id, question: 'q', createdAt: 'T', ...g })),
    messages: [],
    deliveries: [],
    projects: []
  } as unknown as OrchState
}
const there = (): boolean => true

describe('repairEligibility', () => {
  it('takes a failed Task', () => {
    expect(repairEligibility(state({ task: { id: 't1', status: 'failed' } }), 't1', there)).toEqual({ ok: true, via: 'failed' })
  })

  it('takes a Task blocked by its exhausted repairs, through that Gate', () => {
    const s = state({ task: { id: 't1', status: 'blocked' }, gates: [{ id: 'g1', kind: 'convergence-exhausted', status: 'open' }] })
    expect(repairEligibility(s, 't1', there)).toEqual({ ok: true, via: 'exhausted-gate', gateId: 'g1' })
  })

  it('refuses a Task blocked by another question, naming it', () => {
    const s = state({ task: { id: 't1', status: 'blocked' }, gates: [{ id: 'g1', kind: 'convergence-exhausted', status: 'open' }, { id: 'g2', status: 'open' }] })
    expect(repairEligibility(s, 't1', there)).toMatchObject({ ok: false, reason: 'blocked-by-gate', detail: expect.stringContaining('g2') })
  })

  it('reopens a completed Task while its Run has not ended and nothing built on it has started', () => {
    const s = state({ task: { id: 't1', status: 'completed' }, others: [{ id: 't2', status: 'ready', deps: ['t1'] }] })
    expect(repairEligibility(s, 't1', there)).toEqual({ ok: true, via: 'reopen' })
  })

  it('refuses a completed Task of a Run that ended', () => {
    expect(repairEligibility(state({ task: { id: 't1', status: 'completed' }, runEnded: true }), 't1', there)).toMatchObject({ ok: false, reason: 'run-ended' })
  })

  it('refuses a completed Task a later Task already started on', () => {
    const s = state({ task: { id: 't1', status: 'completed' }, others: [{ id: 't2', status: 'dispatched', deps: ['t1'] }] })
    expect(repairEligibility(s, 't1', there)).toMatchObject({ ok: false, reason: 'dependents-started', detail: expect.stringContaining('t2') })
  })

  it('refuses a Task whose last attempt’s folder is gone, asking about that folder and not the review’s', () => {
    const asked: string[] = []
    const gone = (p: string): boolean => (asked.push(p), false)
    expect(repairEligibility(state({ task: { id: 't1', status: 'failed' } }), 't1', gone)).toMatchObject({ ok: false, reason: 'folder-gone', detail: expect.stringContaining('F:/wt/t1') })
    expect(asked).toEqual(['F:/wt/t1'])
  })

  it('refuses a Task with an attempt still open, one waiting on a verdict, and one never worked on', () => {
    expect(repairEligibility(state({ task: { id: 't1', status: 'failed' }, open: true }), 't1', there)).toMatchObject({ ok: false, reason: 'busy' })
    for (const status of ['pending', 'ready', 'dispatched', 'validating', 'reviewing'])
      expect(repairEligibility(state({ task: { id: 't1', status } }), 't1', there), status).toMatchObject({ ok: false, reason: 'not-repairable' })
    expect(repairEligibility(state({ task: { id: 't1', status: 'failed' }, noAttempt: true }), 't1', there)).toMatchObject({ ok: false, reason: 'not-repairable' })
  })

  it('answers an unknown Task', () => {
    expect(repairEligibility(state({ task: { id: 't1', status: 'failed' } }), 'nope', there)).toMatchObject({ ok: false, reason: 'unknown-task' })
  })
})

describe('capAsked', () => {
  it('keeps at most ASKED_FINDINGS_MAX findings, each text cut to ASKED_FINDING_TEXT_MAX on one line', () => {
    const many = Array.from({ length: ASKED_FINDINGS_MAX + 5 }, (_, i) => ({ ref: `check:t1:${String(i).padStart(12, '0')}`, text: `line one\nline two ${'x'.repeat(400)}` }))
    const kept = capAsked(many)
    expect(kept).toHaveLength(ASKED_FINDINGS_MAX)
    expect(kept[0].text.length).toBeLessThanOrEqual(ASKED_FINDING_TEXT_MAX)
    expect(kept[0].text.startsWith('line one line two')).toBe(true)
    expect(kept[0].text.endsWith('…')).toBe(true)
  })
})
