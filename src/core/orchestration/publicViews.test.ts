// The Job, Run and brief Task views the reads answer with (and the public events carry, SDK 1d).
import { describe, it, expect } from 'vitest'
import { briefTask, runView } from './publicViews'
import { emptyState, type OrchState } from './state'
import type { Gate, Task } from './types'

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

  // Final review M2: which Task, which question and which Dispatch the Run's state reads
  describe('reads the Run’s latest lifecycle Task and the question open on it', () => {
    const lifecycleTask: Task = { id: 'tsk_l', runId: runOf.id, kind: 'lifecycle', title: 'GitHub', spec: 's', deps: [], status: 'validating', consecutiveFailures: 0, createdAt: 'T2', updatedAt: 'T2' }
    const gate = (over: Partial<Gate>): Gate => ({ id: 'g1', runId: runOf.id, taskId: 'tsk_l', question: 'q', status: 'open', createdAt: 'T', ...over })
    const stateWith = (over: Partial<OrchState>): OrchState => ({
      ...emptyState(),
      jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', github: policy }],
      runs: [runOf],
      tasks: [lifecycleTask],
      ...over
    })
    const rows: [string, Partial<OrchState>, string][] = [
      ['a question answered earlier holds nothing', { gates: [gate({ status: 'resolved', resolution: 'wait' })] }, 'pr-ready'],
      ['a question open on another Task of the Run is not this one’s', { gates: [gate({ taskId: 'tsk_other' })] }, 'pr-ready'],
      ['a question open on it', { tasks: [{ ...lifecycleTask, status: 'blocked' }], gates: [gate({ kind: 'github-no-ci' })] }, 'waiting-for-user'],
      ['its budget ran out', { tasks: [{ ...lifecycleTask, status: 'blocked' }], gates: [gate({ kind: 'convergence-exhausted' })] }, 'exhausted'],
      [
        'an earlier lifecycle Task failed, the latest validates',
        { tasks: [{ ...lifecycleTask, id: 'tsk_old', status: 'failed', createdAt: 'T1' }, lifecycleTask] },
        'pr-ready'
      ],
      ['a repair whose worker is gone, no Dispatch open', { tasks: [{ ...lifecycleTask, status: 'dispatched' }] }, 'repairing'],
      // G4: the question past the rerun budget
      ['a question offering a CI rerun', { tasks: [{ ...lifecycleTask, status: 'blocked' }], gates: [gate({ kind: 'github-ci-outside', options: ['rerun', 'wait', 'mark-failed'] })] }, 'ci-infrastructure-failure']
    ]
    it.each(rows)('%s', (_name, over, state) => {
      expect(runView(stateWith(over), runOf).github).toMatchObject({ state })
    })
  })

  // GitHub lifecycle G5b: a completed lifecycle Task lets the record speak, merge-ready included
  it('carries merge-ready once the lifecycle Task completed', () => {
    const H = 'e'.repeat(40)
    const gs = {
      binding: { repository: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', baseBranch: 'develop', headBranch: 'u/a', createdByAstera: true, boundAt: 'T' },
      headSha: H,
      pr: { state: 'open' as const, isDraft: true, baseBranch: 'develop' },
      ci: { sha: H, basis: 'all-reported' as const, verdict: 'passed' as const, changedAt: 'T', checks: [] },
      mergeReady: { pullRequestNumber: 12, headSha: H, localChecksPassed: true, requiredCiPassed: true, reviewPassed: true, unresolvedQuestions: 0, ciChecks: [], evaluatedAt: 'T' },
      log: [],
      seq: 0
    }
    const run = { ...runOf, githubState: gs }
    const done: Task = { id: 'tsk_l', runId: runOf.id, kind: 'lifecycle', title: 'GitHub', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: 'T', updatedAt: 'T' }
    const s = { ...emptyState(), jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', github: policy }], runs: [run], tasks: [done] }
    expect(runView(s, run).github).toMatchObject({ state: 'merge-ready', mergeReady: { headSha: H, evaluatedAt: 'T' } })
  })

  it('carries github for a lifecycle Job’s Run, and nothing for any other', () => {
    const lifecycle = { ...emptyState(), jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T', github: policy }], runs: [runOf] }
    expect(runView(lifecycle, runOf).github).toEqual({ state: 'unbound' })
    const plain = { ...emptyState(), jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: 'T' }], runs: [runOf] }
    expect(runView(plain, runOf)).not.toHaveProperty('github')
  })
})
