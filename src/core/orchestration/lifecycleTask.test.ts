// The Run-level lifecycle Task (GitHub lifecycle design §3.2): added in the same write as the last ordinary
// completion of a lifecycle Run, never otherwise.
import { describe, it, expect } from 'vitest'
import { emptyState, type OrchState } from './state'
import type { Task } from './types'
import { GITHUB_CI_CHECK } from '../github/lifecycle'
import { LIFECYCLE_TASK_TITLE, isLifecycleTask, lifecycleBriefOf, lifecycleRepairFacts, openLifecycleTaskOf, withLifecycleTask } from './lifecycleTask'

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

// GitHub lifecycle G3c1 (design §4.8): what a lifecycle repair is told, from the Run's GitHub record
describe('lifecycleRepairFacts', () => {
  const A = 'a'.repeat(40)
  const B = 'b'.repeat(40)
  const failedCi = { configId: GITHUB_CI_CHECK, name: 'GitHub CI', status: 'failed' as const, summary: 'test (test): x' }
  const withGitHub = (checks: Task['checks']): OrchState => {
    const s = withLifecycleTask(state([task('a')]), 'run_1', NOW)
    return {
      ...s,
      tasks: s.tasks.map((t) => (isLifecycleTask(t) ? { ...t, checks } : t)),
      runs: s.runs.map((r) => ({
        ...r,
        githubState: {
          binding: { repository: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', baseBranch: 'main', headBranch: 'u/a', createdByAstera: true, boundAt: NOW },
          lastPushedSha: B,
          ci: { sha: B, basis: 'all-reported' as const, verdict: 'failed' as const, failing: 'test', checks: [], changedAt: NOW, failure: { check: 'test', externalId: 'run:1', class: 'test' as const, summary: 'test (test): x', diagnostics: [] } },
          log: [
            { seq: 1, at: '2026-10-17T00:00:00.000Z', kind: 'ci-failed' as const, sha: 'f'.repeat(40), check: 'old' },
            { seq: 2, at: NOW, kind: 'ci-failed' as const, sha: A, check: 'lint', class: 'lint' as const },
            { seq: 3, at: NOW, kind: 'ci-failed' as const, sha: B, check: 'test', class: 'test' as const }
          ],
          seq: 3
        }
      }))
    }
  }

  it('gives the pull request, the pushed head, the failing check and the earlier failures of this lifecycle Task', () => {
    const s = withGitHub([failedCi])
    const facts = lifecycleRepairFacts(s, s.tasks.find(isLifecycleTask)!)
    expect(facts).toEqual({
      pr: { number: 12, url: 'https://github.com/o/r/pull/12' },
      head: B,
      failing: { check: 'test', class: 'test', summary: 'test (test): x' },
      earlier: [{ sha: A, check: 'lint', class: 'lint' }]
    })
  })

  // G3c1 final review M5: the carrier's own failure (uncommitted, no commits) is not the CI failure read earlier
  it('names no failing CI check when this round’s GitHub CI result is not the one CI gave', () => {
    const s = withGitHub([{ configId: GITHUB_CI_CHECK, name: 'GitHub CI', status: 'failed', summary: "The Run's branch has 1 uncommitted change; Astera pushes commits only. Commit it." }])
    expect(lifecycleRepairFacts(s, s.tasks.find(isLifecycleTask)!).failing).toBeUndefined()
  })

  it('names no failing CI check when this round failed a local check', () => {
    const s = withGitHub([{ configId: 'lint', name: 'lint', status: 'failed', exitCode: 1 }, { configId: GITHUB_CI_CHECK, name: 'GitHub CI', status: 'not-run' }])
    expect(lifecycleRepairFacts(s, s.tasks.find(isLifecycleTask)!).failing).toBeUndefined()
  })
})

// G3c1 final review I1: a lifecycle repair and review are asked to satisfy the Run's objective, not a placeholder
describe('lifecycleBriefOf', () => {
  it('is the Run’s objective and its Tasks', () => {
    const s = withLifecycleTask(state([task('a', { title: 'Add login', spec: 'Users sign in with a password.\nMore detail.' }), task('b', { title: 'Add logout', spec: 'Users sign out.' })]), 'run_1', NOW)
    const brief = lifecycleBriefOf({ ...s, jobs: s.jobs.map((j) => ({ ...j, objective: 'Accounts for the shop' })) }, s.tasks.find(isLifecycleTask)!)
    expect(brief.title).toContain('Accounts for the shop')
    expect(brief.spec).toContain('Accounts for the shop')
    expect(brief.spec).toContain('- Add login: Users sign in with a password.')
    expect(brief.spec).toContain('- Add logout: Users sign out.')
    expect(brief.spec).not.toContain('워커가 없는 Task')
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
