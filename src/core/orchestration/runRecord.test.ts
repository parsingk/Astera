import { describe, it, expect, afterEach, vi } from 'vitest'
import { justFinished, runRecordInputOf } from './runRecord'
import { createJob, createTask, emptyState, jobOf, startJobRun, type OrchState } from './state'

const state = (tasks: { runId: string; status: string; consecutiveFailures?: number }[]): OrchState =>
  ({
    runs: [{ id: 'r1' }, { id: 'r2' }],
    tasks: tasks.map((t, i) => ({ id: `t${i}`, consecutiveFailures: 0, ...t }))
  }) as unknown as OrchState

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

describe('runRecordInputOf', () => {
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

  it('no Run, or a Run with no Job, builds nothing', () => {
    const { s, runId } = finished()
    expect(runRecordInputOf(s, 'nope')).toBeNull()
    expect(runRecordInputOf({ ...s, jobs: [] }, runId)).toBeNull()
  })
})
