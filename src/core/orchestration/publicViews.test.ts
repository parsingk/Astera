// The Job, Run and brief Task views the reads answer with (and the public events carry, SDK 1d).
import { describe, it, expect } from 'vitest'
import { briefTask, runView } from './publicViews'
import { emptyState } from './state'
import type { Task } from './types'

const task = (spec: string): Task => ({
  id: 't1',
  runId: 'run_1',
  title: 't',
  spec,
  deps: [],
  status: 'ready',
  consecutiveFailures: 0,
  createdAt: 'T',
  updatedAt: 'T'
})

describe('briefTask', () => {
  it('collapses whitespace and cuts the spec at 160 characters, marking the cut', () => {
    const long = `line one\n\n  line two\t${'x'.repeat(200)}`
    const out = briefTask(task(long))
    expect(out.spec).toBe(long.replace(/\s+/g, ' ').slice(0, 160))
    expect(out.spec_truncated).toBe(true)
    expect(out.id).toBe('t1')
  })

  it('marks a short spec as whole', () => {
    expect(briefTask(task('a  b'))).toMatchObject({ spec: 'a b', spec_truncated: false })
  })
})

describe('runView — GitHub lifecycle (G1)', () => {
  const policy = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
  const runOf = { id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: 'T' }
  // GitHub lifecycle G3c2: the Run's state follows its lifecycle Task
  it('carries the lifecycle Task’s state in github', () => {
    const lifecycleTask = { id: 'tsk_l', runId: runOf.id, kind: 'lifecycle' as const, title: 'GitHub', spec: 's', deps: [], status: 'validating' as const, consecutiveFailures: 0, createdAt: 'T', updatedAt: 'T' }
    const s = { ...emptyState(), jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', github: policy }], runs: [runOf], tasks: [lifecycleTask] }
    expect(runView(s, runOf).github).toMatchObject({ state: 'pr-ready' })
    const reviewing = { ...s, tasks: [{ ...lifecycleTask, status: 'reviewing' as const }] }
    expect(runView(reviewing, runOf).github).toMatchObject({ state: 'reviewing' })
  })

  it('carries github for a lifecycle Job’s Run, and nothing for any other', () => {
    const lifecycle = { ...emptyState(), jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', github: policy }], runs: [runOf] }
    expect(runView(lifecycle, runOf).github).toEqual({ state: 'unbound' })
    const plain = { ...emptyState(), jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T' }], runs: [runOf] }
    expect(runView(plain, runOf)).not.toHaveProperty('github')
  })
})
