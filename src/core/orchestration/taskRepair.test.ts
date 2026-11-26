import { describe, it, expect } from 'vitest'
import type { OrchState } from './state'
import { ASKED_FINDINGS_MAX, ASKED_FINDING_TEXT_MAX, capAsked, readyForRepair, repairEligibility } from './taskRepair'

// Phase 3 Part 1 (design §5 Part 1 item 4, the person's rule of 2026-11-26): which Tasks take a person's repair request
type T = { id: string; status: string; deps?: string[] }
function state(o: {
  task: T
  others?: T[]
  runEnded?: boolean
  gates?: { id: string; kind?: string; status: string }[]
  open?: boolean
  noAttempt?: boolean
  /** An open attempt of another Task, in this folder */
  otherIn?: { taskId: string; cwd: string }
}): OrchState {
  const dispatches = o.noAttempt
    ? []
    : [
        { id: 'd1', taskId: o.task.id, cwd: 'F:/wt/t1', startedAt: '2026-11-26T01:00:00Z', outcome: 'succeeded', endedAt: '2026-11-26T01:10:00Z' },
        { id: 'd2', taskId: o.task.id, cwd: 'F:/wt/review', startedAt: '2026-11-26T01:20:00Z', review: true, outcome: 'succeeded', endedAt: '2026-11-26T01:30:00Z' },
        ...(o.open ? [{ id: 'd3', taskId: o.task.id, cwd: 'F:/wt/t1', startedAt: '2026-11-26T02:00:00Z' }] : []),
        ...(o.otherIn ? [{ id: 'd9', taskId: o.otherIn.taskId, cwd: o.otherIn.cwd, startedAt: '2026-11-26T02:30:00Z' }] : [])
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

  // Final review I5: the person put "its Run has not ended" on a completed Task only; a failed one of an ended Run (a
  // one-Task Job that failed three times) goes back to its own checks
  it('takes a failed Task of a Run that ended', () => {
    expect(repairEligibility(state({ task: { id: 't1', status: 'failed' }, runEnded: true }), 't1', there)).toEqual({ ok: true, via: 'failed' })
  })

  // Final review I1: "no Task built on it has started" reads down the whole chain, the integration Task included
  it('refuses a completed Task when a Task two steps down already started', () => {
    const s = state({ task: { id: 't1', status: 'completed' }, others: [{ id: 't2', status: 'pending', deps: ['t1'] }, { id: 't3', status: 'validating', deps: ['t2'] }] })
    expect(repairEligibility(s, 't1', there)).toMatchObject({ ok: false, reason: 'dependents-started', detail: expect.stringContaining('t3') })
  })

  // Final review I2: a second agent never starts in a folder an agent is working in (a concurrency-1 Run shares one)
  it('refuses while another Task’s attempt works in the folder the repair would run in', () => {
    const s = state({ task: { id: 't1', status: 'completed' }, others: [{ id: 't4', status: 'dispatched' }], otherIn: { taskId: 't4', cwd: 'F:/wt/t1/' } })
    expect(repairEligibility(s, 't1', there)).toMatchObject({ ok: false, reason: 'folder-in-use', detail: expect.stringContaining('t4') })
    const elsewhere = state({ task: { id: 't1', status: 'completed' }, others: [{ id: 't4', status: 'dispatched' }], otherIn: { taskId: 't4', cwd: 'F:/wt/t4' } })
    expect(repairEligibility(elsewhere, 't1', there)).toEqual({ ok: true, via: 'reopen' })
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

// Final review I1: reopening a completed Task takes back the ready Tasks built on it, so none starts on the result being
// repaired; they come back when it completes again
describe('readyForRepair', () => {
  it('sets the Task ready and every Task built on it that was ready back to pending', () => {
    const s = state({
      task: { id: 't1', status: 'completed' },
      others: [{ id: 't2', status: 'ready', deps: ['t1'] }, { id: 't3', status: 'pending', deps: ['t2'] }, { id: 't5', status: 'ready' }]
    })
    const next = readyForRepair(s, 't1', '2026-11-26T09:00:00Z')
    expect(Object.fromEntries(next.tasks.map((t) => [t.id, t.status]))).toEqual({ t1: 'ready', t2: 'pending', t3: 'pending', t5: 'ready' })
    expect(next.tasks.find((t) => t.id === 't2')?.updatedAt).toBe('2026-11-26T09:00:00Z')
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

  // Final review M7 and M6: the person's words are masked as every excerpt is, and one reference rides once
  it('masks a secret a finding carries and keeps one entry per reference', () => {
    const kept = capAsked([
      { ref: 'check:t1:aaaaaaaaaaaa', text: 'error a.ts:3 Lint: TOKEN=abcdef1234567890xyz leaked' },
      { ref: 'check:t1:aaaaaaaaaaaa', text: 'error a.ts:3 Lint: TOKEN=abcdef1234567890xyz leaked' }
    ])
    expect(kept).toHaveLength(1)
    expect(kept[0].text).not.toContain('abcdef1234567890xyz')
  })
})
