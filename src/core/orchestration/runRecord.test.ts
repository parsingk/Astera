import { describe, it, expect, afterEach, vi } from 'vitest'
import { justFinished, runRecordInputOf, stampRunEnds } from './runRecord'
import { foldsCaseHere } from '../testPaths'
import { createJob, createTask, emptyState, jobOf, startJobRun, type OrchState } from './state'
import type { CheckResult, Task } from './types'
import type { RunGitHubState } from '../github/lifecycle'

const state = (tasks: { runId: string; status: string; consecutiveFailures?: number }[]): OrchState =>
  ({
    runs: [{ id: 'r1' }, { id: 'r2' }],
    tasks: tasks.map((t, i) => ({ id: `t${i}`, consecutiveFailures: 0, ...t }))
  }) as unknown as OrchState

/** `tasks` behind a proxy that counts how often the list is walked (filter, find, iteration). */
const counted = (s: OrchState): { state: OrchState; walks: () => number } => {
  let walks = 0
  const tasks = new Proxy(s.tasks, {
    get(target, key, recv) {
      if (key === 'filter' || key === 'find' || key === 'some' || key === 'every' || key === Symbol.iterator || key === 'forEach' || key === 'map') walks++
      return Reflect.get(target, key, recv)
    }
  })
  return { state: { ...s, tasks }, walks: () => walks }
}

// Second pass C2-3: on every commit the Host asked each Run's outcome twice, each a walk over every Task, so the work
// grew with runs × tasks of the whole retained history. The tasks are grouped once per state.
describe('justFinished cost', () => {
  it('walks each state\'s task list a fixed number of times, however many Runs there are', () => {
    const runs = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}` }))
    const tasks = runs.map((r, i) => ({ id: `t${i}`, runId: r.id, status: 'completed', consecutiveFailures: 0 }))
    const before = counted({ runs, tasks } as unknown as OrchState)
    const after = counted({ runs, tasks } as unknown as OrchState)
    justFinished(before.state, after.state)
    expect(before.walks()).toBeLessThanOrEqual(2)
    expect(after.walks()).toBeLessThanOrEqual(2)
  })
})

describe('justFinished', () => {
  it('돌고 있던 Run 이 끝나면 그것을 알린다', () => {
    const before = state([{ runId: 'r1', status: 'dispatched' }])
    const after = state([{ runId: 'r1', status: 'completed' }])
    expect(justFinished(before, after)).toEqual([{ runId: 'r1', outcome: 'completed' }])
  })

  it('실패로 끝난 것도 알린다 — 실패한 작업도 무엇을 했는지 남을 값이 있다', () => {
    const before = state([{ runId: 'r1', status: 'dispatched' }])
    const after = state([{ runId: 'r1', status: 'failed', consecutiveFailures: 3 }])
    expect(justFinished(before, after)).toEqual([{ runId: 'r1', outcome: 'failed' }])
  })

  // The state is recomputed every round (outcomeOf is derived). Catching the state rather than
  // the edge would record the same finished Run on every round, forever.
  it('이미 끝나 있던 Run 은 다시 알리지 않는다', () => {
    const s = state([{ runId: 'r1', status: 'completed' }])
    expect(justFinished(s, s)).toEqual([])
  })

  it('아직 도는 Run 은 알리지 않는다', () => {
    const before = state([{ runId: 'r1', status: 'pending' }])
    const after = state([{ runId: 'r1', status: 'dispatched' }])
    expect(justFinished(before, after)).toEqual([])
  })

  it('여러 Run 이 같은 회차에 끝나도 각각 알린다', () => {
    const before = state([{ runId: 'r1', status: 'dispatched' }, { runId: 'r2', status: 'dispatched' }])
    const after = state([{ runId: 'r1', status: 'completed' }, { runId: 'r2', status: 'completed' }])
    expect(justFinished(before, after).map((x) => x.runId).sort()).toEqual(['r1', 'r2'])
  })

  // A failure with retries left is not terminal — outcomeOf says so, and this pins that.
  it('재시도가 남은 실패는 끝난 것이 아니다', () => {
    const before = state([{ runId: 'r1', status: 'dispatched' }])
    const after = state([{ runId: 'r1', status: 'failed', consecutiveFailures: 1 }])
    expect(justFinished(before, after)).toEqual([])
  })
})

// Deferred minor b: when a Run's outcome became final, kept on the Run, so a later edit of a Task (its title, which
// moves updatedAt) does not move it
describe('stampRunEnds', () => {
  const T = '2026-10-23T03:00:00.000Z'
  const LATER = '2026-10-23T05:00:00.000Z'
  const run = (s: OrchState, id: string) => s.runs.find((r) => r.id === id) as { endedAt?: string }

  it('stamps a Run whose outcome became final on this commit with the commit’s time, completed or failed', () => {
    const before = state([{ runId: 'r1', status: 'dispatched' }, { runId: 'r2', status: 'dispatched' }])
    const after = state([{ runId: 'r1', status: 'completed' }, { runId: 'r2', status: 'failed', consecutiveFailures: 3 }])
    const stamped = stampRunEnds(before, after, T)
    expect(run(stamped, 'r1').endedAt).toBe(T)
    expect(run(stamped, 'r2').endedAt).toBe(T)
  })

  it('keeps the end through a later edit of a Task and through a writer that left it out', () => {
    const before = stampRunEnds(state([{ runId: 'r1', status: 'dispatched' }]), state([{ runId: 'r1', status: 'completed' }]), T)
    const edited = { ...before, tasks: before.tasks.map((t) => ({ ...t, title: 'renamed', updatedAt: LATER })) }
    expect(run(stampRunEnds(before, edited, LATER), 'r1').endedAt).toBe(T)
    // An app mirror that had not heard of it yet writes the Run without it
    const dropped = { ...edited, runs: edited.runs.map(({ ...r }) => (delete (r as { endedAt?: string }).endedAt, r)) }
    expect(run(stampRunEnds(before, dropped, LATER), 'r1').endedAt).toBe(T)
  })

  it('clears it when the Run runs again, and stamps the new end when it finishes again', () => {
    const ended = stampRunEnds(state([{ runId: 'r1', status: 'dispatched' }]), state([{ runId: 'r1', status: 'completed' }]), T)
    const reopened = { ...ended, tasks: [...ended.tasks, { id: 't9', runId: 'r1', status: 'ready', consecutiveFailures: 0 }] } as unknown as OrchState
    const running = stampRunEnds(ended, reopened, LATER)
    expect(run(running, 'r1')).not.toHaveProperty('endedAt')
    const again = { ...running, tasks: running.tasks.map((t) => ({ ...t, status: 'completed' as const })) }
    expect(run(stampRunEnds(running, again, LATER), 'r1').endedAt).toBe(LATER)
  })

  it('does not stamp a Run it did not see finish: one new to the commit, or one finished before ends were kept', () => {
    const finished = state([{ runId: 'r1', status: 'completed' }])
    expect(run(stampRunEnds(emptyState(), finished, T), 'r1')).not.toHaveProperty('endedAt')
    expect(run(stampRunEnds(finished, finished, T), 'r1')).not.toHaveProperty('endedAt')
  })

  it('hands back the same state when no Run’s end moved', () => {
    const s = state([{ runId: 'r1', status: 'dispatched' }])
    expect(stampRunEnds(s, s, T)).toBe(s)
  })
})

describe('runRecordInputOf', () => {
  // G5c final review M10: a reconverged Run that ends again is written up again, as the second carry it is; the lifecycle
  // Task `runs reconverge` superseded is not part of it
  it('leaves out a lifecycle Task that runs reconverge superseded', () => {
    const T = '2026-10-19T00:00:00.000Z'
    const life = (id: string, status: 'failed' | 'completed', createdAt: string) => ({
      id, runId: 'run_1', kind: 'lifecycle' as const, title: 'GitHub 전달', spec: 's', deps: ['tsk_a'], status, consecutiveFailures: 0, createdAt, updatedAt: createdAt
    })
    const s: OrchState = {
      ...emptyState(),
      jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: T, convergence: {} }],
      runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: T }],
      tasks: [
        { id: 'tsk_a', runId: 'run_1', title: 'a', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: T, updatedAt: T },
        life('tsk_l1', 'failed', '2026-10-19T01:00:00.000Z'),
        life('tsk_l2', 'completed', '2026-10-19T02:00:00.000Z')
      ]
    }
    const r = runRecordInputOf(s, 'run_1')!
    expect(r.taskIds).toEqual(['tsk_a', 'tsk_l2'])
    expect(r.tasks.map((t) => t.outcome)).toEqual(['completed', 'completed'])
    expect(r.validation).toEqual({ status: 'passed' })
  })

  const finished = (): { s: OrchState; runId: string } => {
    const job = createJob(emptyState(), { objective: 'x'.repeat(70), cwd: 'D:/p' }, '2026-10-02T10:00:00.000Z')
    if (!job.ok) throw new Error(job.error)
    const run = startJobRun(job.state, job.value.id, '2026-10-02T10:00:00.000Z')
    if (!run.ok) throw new Error(run.error)
    let s = run.state
    for (const title of ['a', 'b']) {
      const t = createTask(s, { runId: run.value.id, title, spec: 's', deps: [] }, '2026-10-02T10:00:00.000Z')
      if (!t.ok) throw new Error(t.error)
      s = t.state
    }
    const files = [['src/a.ts', 'src/b.ts'], ['src/b.ts']]
    s = { ...s, tasks: s.tasks.map((t, i) => ({ ...t, status: 'completed', filesModified: files[i] })) } as OrchState
    return { s, runId: run.value.id }
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  // Plugin 4d review M2: a Job made from a ticket is named in How It Works as its card names it; the request stays the
  // objective, which the write-up is made from
  it('names a Job made from a ticket by the ticket’s title, and keeps its objective', () => {
    const { s, runId } = finished()
    const titled = { ...s, jobs: s.jobs.map((j) => ({ ...j, source: { id: 'astera-linear-source', itemId: 'ENG-1', label: 'Linear ENG-1', title: 'Fix login' } })) }
    const r = runRecordInputOf(titled, runId)
    expect(r?.jobName).toBe('Fix login')
    expect(r?.objective).toBe('x'.repeat(70))
  })

  // The app's inline construction in ipc.ts before it moved here, field for field.
  it('builds what the app built inline, with the Job cwd as the project', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T11:00:00.000Z'))
    const { s, runId } = finished()
    const run = s.runs.find((r) => r.id === runId)!
    const tasks = s.tasks.filter((t) => t.runId === runId)
    const job = jobOf(s, run)!
    expect(runRecordInputOf(s, runId)).toEqual({
      projectPath: job.cwd,
      runId,
      jobName: job.objective.slice(0, 60),
      objective: job.objective,
      at: '2026-10-02T11:00:00.000Z',
      taskIds: tasks.map((t) => t.id),
      tasks: tasks.map((t) => ({ title: t.title, outcome: t.status })),
      changedFiles: ['src/a.ts', 'src/b.ts'],
      validation: { status: 'passed' }
    })
  })

  it('a failed Run is validation failed', () => {
    const { s, runId } = finished()
    const failed = { ...s, tasks: s.tasks.map((t, i) => (i === 0 ? { ...t, status: 'failed', consecutiveFailures: 3 } : t)) } as OrchState
    expect(runRecordInputOf(failed, runId)?.validation).toEqual({ status: 'failed' })
  })

  it('a Run with its own worktree gives that folder as workDir', () => {
    const { s, runId } = finished()
    const withWt = { ...s, runs: s.runs.map((r) => (r.id === runId ? { ...r, worktree: 'D:/p/.wt/r1' } : r)) } as OrchState
    const input = runRecordInputOf(withWt, runId)!
    expect(input.workDir).toBe('D:/p/.wt/r1')
    expect(input.projectPath).toBe('D:/p')
  })

  it('a Run without a worktree, or one whose worktree is the project folder, has no workDir', () => {
    const { s, runId } = finished()
    expect(runRecordInputOf(s, runId)).not.toHaveProperty('workDir')
    const same = { ...s, runs: s.runs.map((r) => (r.id === runId ? { ...r, worktree: 'D:/p' } : r)) } as OrchState
    expect(runRecordInputOf(same, runId)).not.toHaveProperty('workDir')
  })

  // A parallel Run: its tasks ran in Task worktrees, and the Run worktree holds no work.
  const withDispatches = (s: OrchState, runId: string, cwds: (string | null)[]): OrchState => {
    const tasks = s.tasks.filter((t) => t.runId === runId)
    const dispatches = cwds.map((cwd, i) => ({
      id: `d${i}`,
      taskId: tasks[i % tasks.length].id,
      cwd: cwd ?? 'D:/p/.wt/open',
      startedAt: '2026-10-02T10:00:00.000Z',
      ...(cwd !== null ? { endedAt: '2026-10-02T10:30:00.000Z' } : {})
    }))
    return {
      ...s,
      runs: s.runs.map((r) => (r.id === runId ? { ...r, worktree: 'D:/p/.wt/r1' } : r)),
      dispatches
    } as unknown as OrchState
  }

  it('when every finished dispatch ran in one other folder, that folder is workDir', () => {
    const { s, runId } = finished()
    // the open dispatch (null: not finished) does not count
    const st = withDispatches(s, runId, ['D:/p/.wt/t1', 'd:/P/.wt/T1', null])
    const expected = foldsCaseHere ? 'D:/p/.wt/t1' : 'D:/p/.wt/r1'
    expect(runRecordInputOf(st, runId)?.workDir).toBe(expected)
    expect(runRecordInputOf(withDispatches(s, runId, ['D:/p/.wt/t1', 'D:/p/.wt/t1']), runId)?.workDir).toBe('D:/p/.wt/t1')
  })

  it('when finished dispatches ran in different folders, or there are none, the run root is workDir', () => {
    const { s, runId } = finished()
    expect(runRecordInputOf(withDispatches(s, runId, ['D:/p/.wt/t1', 'D:/p/.wt/t2']), runId)?.workDir).toBe('D:/p/.wt/r1')
    expect(runRecordInputOf(withDispatches(s, runId, []), runId)?.workDir).toBe('D:/p/.wt/r1')
  })

  it('no Run, or a Run with no Job, builds nothing', () => {
    const { s, runId } = finished()
    expect(runRecordInputOf(s, 'nope')).toBeNull()
    expect(runRecordInputOf({ ...s, jobs: [] }, runId)).toBeNull()
  })
})

// GitHub lifecycle G8 (spec §40): a lifecycle Run's record says where the work came from and went, and what verified it,
// as the Run's state stood when it finished. What did not happen is `skipped`, never passed.
describe('runRecordInputOf: a GitHub lifecycle Run', () => {
  const T = '2026-10-19T00:00:00.000Z'
  const HEAD = 'c'.repeat(40)
  const POLICY = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
  const SOURCE = { id: 'github', itemId: '12', label: 'GitHub #12', title: 'Fix login', url: 'https://github.com/o/r/issues/12' }
  const BINDING = {
    repository: 'o/r', number: 34, url: 'https://github.com/o/r/pull/34', baseBranch: 'main', headBranch: 'astera/x', createdByAstera: true, boundAt: T
  }
  const OPEN = { state: 'open' as const, isDraft: true, baseBranch: 'main' }
  const ordinary: Task = {
    id: 'tsk_a', runId: 'run_1', title: 'a', spec: 's', deps: [], validateConfigIds: ['cfg_test'], status: 'completed', consecutiveFailures: 0, createdAt: T, updatedAt: T
  }
  const lifecycle = (over: Partial<Task> = {}): Task => ({
    id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub 전달', spec: 's', deps: ['tsk_a'], validateConfigIds: ['cfg_test', 'github:ci'],
    reviewRequested: true, status: 'completed', consecutiveFailures: 0, createdAt: T, updatedAt: T,
    checks: [
      { configId: 'cfg_test', name: 'test', status: 'passed' },
      { configId: 'github:ci', name: 'GitHub CI', status: 'passed' }
    ],
    ...over
  })
  const ci = (verdict: 'passed' | 'failed' | 'pending' | 'none', sha = HEAD): NonNullable<RunGitHubState['ci']> =>
    ({ sha, basis: 'required', verdict, checks: [], changedAt: T })
  const lifecycleState = (o: { task?: Task | null; github?: Partial<Omit<RunGitHubState, 'seq' | 'log'>> | null; source?: boolean } = {}): OrchState => ({
    ...emptyState(),
    jobs: [{ id: 'job_1', objective: 'o', cwd: 'D:/p', createdAt: T, github: POLICY, ...(o.source === false ? {} : { source: SOURCE }) }],
    runs: [
      {
        id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: T,
        ...(o.github === null ? {} : { githubState: { binding: BINDING, headSha: HEAD, lastPushedSha: HEAD, pr: OPEN, ci: ci('passed'), ...o.github, log: [], seq: 0 } })
      }
    ],
    tasks: o.task === null ? [ordinary] : [ordinary, o.task ?? lifecycle()]
  })
  const MERGE_READY = {
    pullRequestNumber: 34, headSha: HEAD, localChecksPassed: true, requiredCiPassed: true, reviewPassed: true, unresolvedQuestions: 0, ciChecks: [], evaluatedAt: T
  }

  // G8 final review I1: the watch withdraws merge-ready by recording `invalidated` and keeps the evidence, and the Run's
  // GitHub block reads it as holding only while nothing withdrew it, its head is the PR's head and the PR is open
  it('merge-ready withdrawn since, of an earlier head, or of a pull request no longer open, is not merge-ready', () => {
    const ready = (github: Partial<Omit<RunGitHubState, 'seq' | 'log'>>): boolean | undefined =>
      runRecordInputOf(lifecycleState({ github: { mergeReady: MERGE_READY, ...github } }), 'run_1')?.github?.mergeReady
    expect(ready({ invalidated: { reason: 'head-changed', at: T } })).toBe(false)
    expect(ready({ headSha: 'd'.repeat(40) })).toBe(false)
    expect(ready({ pr: { ...OPEN, state: 'closed' } })).toBe(false)
  })

  it('a lifecycle Task that did not complete is not merge-ready, whatever evidence an earlier carry left', () => {
    const task = lifecycle({ status: 'failed' })
    expect(runRecordInputOf(lifecycleState({ task, github: { mergeReady: MERGE_READY } }), 'run_1')?.github?.mergeReady).toBe(false)
  })

  // G8 final review M1: before the lifecycle Task, the local checks that ran are the ordinary Tasks' own
  it('an ordinary Task whose local check failed, before the lifecycle Task, has local failed', () => {
    const failed = { ...ordinary, status: 'failed' as const, checks: [{ configId: 'cfg_test', name: 'test', status: 'failed' as const }] }
    const s = { ...lifecycleState({ task: null, github: null }), tasks: [failed] }
    expect(runRecordInputOf(s, 'run_1')?.github?.local).toBe('failed')
  })

  it('a merge-ready Run names its issue and pull request, and its local checks, CI at the head, and review passed', () => {
    expect(runRecordInputOf(lifecycleState({ github: { mergeReady: MERGE_READY } }), 'run_1')?.github).toEqual({
      source: { label: 'GitHub #12', url: 'https://github.com/o/r/issues/12' },
      pr: { number: 34, url: 'https://github.com/o/r/pull/34' },
      local: 'passed',
      ci: { status: 'passed', sha: HEAD },
      review: 'passed',
      mergeReady: true
    })
  })

  it('a Run whose review passed but was not merge-ready says so', () => {
    const r = runRecordInputOf(lifecycleState({ github: { invalidated: { reason: 'question-open', at: T } } }), 'run_1')
    expect(r?.github?.review).toBe('passed')
    expect(r?.github?.mergeReady).toBe(false)
  })

  it('a Run that failed in CI has CI failed at the head and no review', () => {
    const task = lifecycle({
      status: 'failed',
      checks: [
        { configId: 'cfg_test', name: 'test', status: 'passed' },
        { configId: 'github:ci', name: 'GitHub CI', status: 'failed' }
      ]
    })
    const g = runRecordInputOf(lifecycleState({ task, github: { ci: ci('failed') } }), 'run_1')?.github
    expect(g).toMatchObject({ local: 'passed', ci: { status: 'failed', sha: HEAD }, review: 'skipped', mergeReady: false })
  })

  it('a local check that failed, timed out or could not be made is failed; one not run or skipped is skipped', () => {
    const local = (status: CheckResult['status'], skipped?: true): string | undefined =>
      runRecordInputOf(
        lifecycleState({ task: lifecycle({ status: 'failed', checks: [{ configId: 'cfg_test', name: 'test', status, ...(skipped ? { skipped } : {}) }] }) }),
        'run_1'
      )?.github?.local
    expect(local('failed')).toBe('failed')
    expect(local('timed-out')).toBe('failed')
    expect(local('error')).toBe('failed')
    expect(local('not-run')).toBe('skipped')
    expect(local('not-run', true)).toBe('skipped')
  })

  it('a local check with no result in the last round is not passed', () => {
    const task = lifecycle({ status: 'failed', validateConfigIds: ['cfg_test', 'cfg_lint', 'github:ci'] })
    expect(runRecordInputOf(lifecycleState({ task }), 'run_1')?.github?.local).toBe('skipped')
  })

  it('a review that found blocking issues is failed', () => {
    const task = lifecycle({ status: 'failed', reviewIssues: [{ severity: 'high', title: 't', blocking: true }] as Task['reviewIssues'] })
    expect(runRecordInputOf(lifecycleState({ task }), 'run_1')?.github?.review).toBe('failed')
  })

  it('a lifecycle Task a person moved to completed past its policy is not a review passed', () => {
    const task = lifecycle({ completionOverride: { reason: 'r', at: T } })
    expect(runRecordInputOf(lifecycleState({ task }), 'run_1')?.github?.review).toBe('skipped')
  })

  it('CI of an older commit, or still pending, is not CI of the head', () => {
    expect(runRecordInputOf(lifecycleState({ github: { ci: ci('passed', 'd'.repeat(40)) } }), 'run_1')?.github?.ci).toEqual({ status: 'skipped' })
    expect(runRecordInputOf(lifecycleState({ github: { ci: ci('pending') } }), 'run_1')?.github?.ci).toEqual({ status: 'skipped' })
  })

  it('a head a person let go on without CI says so', () => {
    const g = runRecordInputOf(lifecycleState({ github: { ci: ci('none'), ciOverride: { sha: HEAD, at: T } } }), 'run_1')?.github
    expect(g?.ci).toEqual({ status: 'skipped', sha: HEAD, noCi: true })
  })

  it('a Run that failed before its lifecycle Task has nothing passed', () => {
    const failedFirst = { ...lifecycleState({ task: null, github: null }), tasks: [{ ...ordinary, status: 'failed' as const }] }
    expect(runRecordInputOf(failedFirst, 'run_1')?.github).toEqual({
      source: { label: 'GitHub #12', url: 'https://github.com/o/r/issues/12' },
      local: 'skipped',
      ci: { status: 'skipped' },
      review: 'skipped',
      mergeReady: false
    })
  })

  it('a Run with no local check to run has no local line', () => {
    const task = lifecycle({ validateConfigIds: ['github:ci'], checks: [{ configId: 'github:ci', name: 'GitHub CI', status: 'passed' }] })
    const s = lifecycleState({ task })
    const noChecks = { ...s, tasks: s.tasks.map((t) => (t.id === 'tsk_a' ? { ...t, validateConfigIds: [] } : t)) }
    expect(runRecordInputOf(noChecks, 'run_1')?.github).not.toHaveProperty('local')
    const noLifecycle = { ...noChecks, tasks: [{ ...noChecks.tasks[0], status: 'failed' as const }] }
    expect(runRecordInputOf(noLifecycle, 'run_1')?.github).not.toHaveProperty('local')
  })

  it('a lifecycle Job made by hand has no source line', () => {
    expect(runRecordInputOf(lifecycleState({ source: false }), 'run_1')?.github).not.toHaveProperty('source')
  })

  it('a Job without the lifecycle has no GitHub evidence, even one made from an issue', () => {
    const s = lifecycleState()
    const plain = { ...s, jobs: s.jobs.map(({ github: _g, ...j }) => j) }
    expect(runRecordInputOf(plain, 'run_1')).not.toHaveProperty('github')
  })
})
