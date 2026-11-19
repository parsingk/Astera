import { describe, it, expect, vi } from 'vitest'
import { stampRunReports } from './stamp'
import { emptyState, type OrchState } from '../orchestration/state'
import type { JobRun, Task, TaskStatus } from '../orchestration/types'
import type { RunReport } from './types'

const T0 = '2026-11-15T09:00:00.000Z'
const task = (status: TaskStatus): Task =>
  ({ id: 't1', runId: 'run_1', jobId: 'job_1', title: 'Task', spec: '', deps: [], status, consecutiveFailures: 0, createdAt: T0, updatedAt: T0 }) as Task
const world = (status: TaskStatus, run: Partial<JobRun> = {}): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'Ship it', cwd: '/w' } as never],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: T0, ...run } as JobRun],
  tasks: [task(status)]
})
const OLD = { version: 1, runId: 'old' } as unknown as RunReport
const OTHER = { version: 1, runId: 'other' } as unknown as RunReport

describe('stampRunReports', () => {
  it('the commit that finishes a Run stores its report', () => {
    const spent = vi.fn(() => [])
    const out = stampRunReports(world('dispatched'), world('completed'), { spent })
    expect(out.runs[0].report?.runId).toBe('run_1')
    expect(spent).toHaveBeenCalledTimes(1)
  })

  it('spent is not read when nothing finishes', () => {
    const spent = vi.fn(() => [])
    stampRunReports(world('dispatched'), world('dispatched'), { spent })
    stampRunReports(world('completed', { report: OLD }), world('completed', { report: OLD }), { spent })
    expect(spent).not.toHaveBeenCalled()
  })

  it('a finished Run keeps the report it had, whatever next carries', () => {
    const prev = world('completed', { report: OLD })
    expect(stampRunReports(prev, world('completed'), {}).runs[0].report).toBe(OLD)
    expect(stampRunReports(prev, world('completed', { report: OTHER }), {}).runs[0].report).toBe(OLD)
  })

  it('a finished Run with no report does not take one from the writer', () => {
    expect(stampRunReports(world('completed'), world('completed', { report: OTHER }), {}).runs[0].report).toBeUndefined()
  })

  it('a Run that runs again drops its report', () => {
    const out = stampRunReports(world('completed', { report: OLD }), world('dispatched', { report: OLD }), {})
    expect(out.runs[0]).not.toHaveProperty('report')
  })

  it('the put that stands in for the load keeps what it carries', () => {
    const out = stampRunReports(emptyState(), world('completed', { report: OLD }), { standsInForLoad: true })
    expect(out.runs[0].report).toBe(OLD)
    expect(stampRunReports(emptyState(), world('completed', { report: OLD }), {}).runs[0].report).toBeUndefined()
  })

  it('the same object back when nothing moved', () => {
    const s = world('completed', { report: OLD })
    expect(stampRunReports(s, s, {})).toBe(s)
    const running = world('dispatched')
    expect(stampRunReports(running, running, {})).toBe(running)
  })
})
