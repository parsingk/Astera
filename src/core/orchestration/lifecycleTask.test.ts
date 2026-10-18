// The Run-level lifecycle Task (GitHub lifecycle design §3.2): added in the same write as the last ordinary
// completion of a lifecycle Run, never otherwise.
import { describe, it, expect } from 'vitest'
import { emptyState, type OrchState } from './state'
import type { Task } from './types'
import { GITHUB_CI_CHECK } from '../github/lifecycle'
import { LIFECYCLE_TASK_TITLE, isLifecycleTask, openLifecycleTaskOf, withLifecycleTask } from './lifecycleTask'

const NOW = '2026-10-18T00:00:00.000Z'
const POLICY = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, runId: 'run_1', title: id, spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW, ...over
})
const state = (tasks: Task[], github: boolean = true): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'o', cwd: '/repo', createdAt: NOW, convergence: {}, ...(github ? { github: POLICY } : {}) }],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW, worktree: '/wt/run' }],
  tasks
})

describe('withLifecycleTask', () => {
  it('adds a ready lifecycle Task once every ordinary Task of a lifecycle Run is completed', () => {
    const s = withLifecycleTask(state([task('a', { validateConfigIds: ['lint', 'test'] }), task('b', { validateConfigId: 'test' })]), 'run_1', NOW)
    const added = s.tasks.find(isLifecycleTask)!
    expect(added).toMatchObject({
      kind: 'lifecycle', runId: 'run_1', status: 'ready', deps: ['a', 'b'], title: LIFECYCLE_TASK_TITLE,
      validateConfigIds: ['lint', 'test', GITHUB_CI_CHECK], reviewRequested: true, consecutiveFailures: 0
    })
    expect(added.parentId).toBeUndefined()
    expect(added.accountIds).toBeUndefined()
  })

  it('changes nothing for a Run whose Job has no lifecycle, an ordinary Task not completed, or a lifecycle Task already there', () => {
    const plain = state([task('a')], false)
    expect(withLifecycleTask(plain, 'run_1', NOW)).toBe(plain)
    const running = state([task('a'), task('b', { status: 'validating' })])
    expect(withLifecycleTask(running, 'run_1', NOW)).toBe(running)
    // Review Focus 1: a Task that ended failed for good fails the Run as today
    const failed = state([task('a'), task('b', { status: 'failed', consecutiveFailures: 3 })])
    expect(withLifecycleTask(failed, 'run_1', NOW)).toBe(failed)
    const once = withLifecycleTask(state([task('a')]), 'run_1', NOW)
    expect(withLifecycleTask(once, 'run_1', NOW)).toBe(once)
    const empty = state([])
    expect(withLifecycleTask(empty, 'run_1', NOW)).toBe(empty)
    expect(withLifecycleTask(plain, undefined, NOW)).toBe(plain)
  })

  it('reads only the Run’s own Tasks, not the Job’s definitions', () => {
    const s = state([task('a'), task('def', { runId: undefined, jobId: 'job_1', status: 'pending' })])
    expect(withLifecycleTask(s, 'run_1', NOW).tasks.find(isLifecycleTask)?.deps).toEqual(['a'])
  })
})

describe('openLifecycleTaskOf', () => {
  it('is the lifecycle Task while it is neither completed nor terminally failed', () => {
    const s = withLifecycleTask(state([task('a')]), 'run_1', NOW)
    const id = s.tasks.find(isLifecycleTask)!.id
    expect(openLifecycleTaskOf(s, 'run_1')?.id).toBe(id)
    const done = { ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, status: 'completed' as const } : t)) }
    expect(openLifecycleTaskOf(done, 'run_1')).toBeUndefined()
    expect(openLifecycleTaskOf(s, 'run_other')).toBeUndefined()
  })
})
