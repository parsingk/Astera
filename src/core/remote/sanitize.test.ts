import { describe, it, expect } from 'vitest'
import { sanitizeForController } from './sanitize'
import { emptyState } from '../orchestration/state'

describe('sanitizeForController (remote runtime design §3.6, D10.2)', () => {
  it('drops every check output body and keeps its length, leaving the rest of the state as it was', () => {
    const s = { ...emptyState(), tasks: [{ id: 't1', checks: [{ configId: 'c', name: 'test', status: 'failed', outputTail: 'boom'.repeat(10) }] }] } as never
    const out = sanitizeForController(s) as unknown as { tasks: Array<{ checks: Array<Record<string, unknown>> }> }
    expect(out.tasks[0].checks[0]).toEqual({ configId: 'c', name: 'test', status: 'failed', outputTailLength: 40 })
    expect((s as { tasks: Array<{ checks: Array<{ outputTail?: string }> }> }).tasks[0].checks[0].outputTail).toBe('boom'.repeat(10))
  })
  // Remote governance ruling R7-3: one controller is not shown another's pairing
  it("drops a Job's createdBy and pausedBy, and leaves the Host's own state as it was", () => {
    const job = {
      id: 'job_1',
      paused: true,
      createdBy: { kind: 'controller', clientId: 'cli_1', name: 'laptop' },
      pausedBy: { reason: 'controller-revoked', clientId: 'cli_1', name: 'laptop', at: 'T' }
    }
    // Ruling R18-1: a Job made here records { here: true }, which is not shown either
    const s = { ...emptyState(), jobs: [job, { id: 'job_2' }, { id: 'job_3', createdBy: { here: true } }] } as never
    const out = sanitizeForController(s) as unknown as { jobs: Array<Record<string, unknown>> }
    expect(out.jobs).toEqual([{ id: 'job_1', paused: true }, { id: 'job_2' }, { id: 'job_3' }])
    expect((s as { jobs: Array<Record<string, unknown>> }).jobs[0].createdBy).toEqual(job.createdBy)
  })
  it('leaves a task with no checks untouched', () => {
    const s = { ...emptyState(), tasks: [{ id: 't1' }] } as never
    expect(sanitizeForController(s)).toEqual(s)
  })
})
