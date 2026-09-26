// `tasks dispatch --id <taskId>` (CLI spec §18): a person or a script asks the driver to place one
// ready Task now. The command layer judges whether it may be placed at all; the placing itself is the
// driver's (`dispatchTask`, the Host's dispatch loop: exec/dispatchLoop.ts `dispatchOne`), through the
// same slot the loop fills.
import { describe, it, expect, vi } from 'vitest'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'

const NOW = '2026-09-26T00:00:00.000Z'

const makeDeps = (extra: Partial<OrchServerDeps> = {}): OrchServerDeps & { state: () => OrchState } => {
  const box = { state: emptyState() }
  return {
    state: () => box.state,
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 'sess_w', cwd: 'D:/p', specPath: 'S' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc_c', label: 'C', provider: 'claude' as const }],
    readWorker: async () => '',
    now: () => NOW,
    ...extra
  } as OrchServerDeps & { state: () => OrchState }
}

const call = (deps: OrchServerDeps, cmd: string, args: Record<string, unknown> = {}, sessionId = '') =>
  handleCommand(deps, { sessionId }, cmd, args)

/** A running Run with one ready Task, placed by nobody. */
const seeded = async (extra: Partial<OrchServerDeps> = {}) => {
  const dispatchTask = vi.fn(async (taskId: string) => ({
    status: 200,
    body: { taskId, runId: 'r', dispatchId: 'dsp_1', sessionId: 'sess_w', cwd: 'D:/wt', specPath: 'S' }
  }))
  const deps = makeDeps({ dispatchTask, ...extra })
  await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
  const runId = deps.state().runs.at(-1)!.id
  const t = await call(deps, 'task-create', { run: runId, title: 't', spec: 's', account: 'acc_c' })
  const taskId = (t.body as { id: string }).id
  return { deps, runId, taskId, dispatchTask }
}

const error = (r: { body: unknown }): string => (r.body as { error: string }).error

describe('tasks dispatch — who may place one ready Task now', () => {
  it('asks the driver to place it, and answers what the driver answered', async () => {
    const { deps, taskId, dispatchTask } = await seeded()
    const r = await call(deps, 'tasks-dispatch', { id: taskId })
    expect(r.status).toBe(200)
    expect(dispatchTask).toHaveBeenCalledWith(taskId)
    expect(r.body).toMatchObject({ taskId, dispatchId: 'dsp_1' })
  })

  it('needs an id (2) that names a Task (4)', async () => {
    const { deps, dispatchTask } = await seeded()
    expect((await call(deps, 'tasks-dispatch')).status).toBe(400)
    expect((await call(deps, 'tasks-dispatch', { id: 'tsk_nope' })).status).toBe(404)
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it('refuses a Task that is not ready, saying what it is (6)', async () => {
    const { deps, taskId, dispatchTask } = await seeded()
    await call(deps, 'task-update', { id: taskId, status: 'failed' })
    const r = await call(deps, 'tasks-dispatch', { id: taskId })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('failed')
    expect(error(r)).toContain('not ready')
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it('refuses a paused Run (6), pointing at runs resume', async () => {
    const { deps, runId, taskId, dispatchTask } = await seeded()
    await call(deps, 'runs-stop', { id: runId })
    const r = await call(deps, 'tasks-dispatch', { id: taskId })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('paused')
    expect(error(r)).toContain('runs resume')
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it('refuses a Run that is not running: a Job not started yet (6)', async () => {
    const dispatchTask = vi.fn()
    const deps = makeDeps({ dispatchTask })
    const job = await call(deps, 'jobs-create', { objective: 'o', cwd: 'D:/p' })
    const jobId = (job.body as { id: string }).id
    // A run of a Job still marked pendingStart: nothing has started it.
    const s = deps.state()
    await deps.setState({
      ...s,
      runs: [...s.runs, { id: 'run_x', jobId, ordinal: 1, createdAt: NOW }],
      tasks: [
        ...s.tasks,
        { id: 'tsk_x', runId: 'run_x', jobId, title: 't', spec: 's', deps: [], status: 'ready', accountIds: ['acc_c'], consecutiveFailures: 0, createdAt: NOW, updatedAt: NOW }
      ]
    })
    const r = await call(deps, 'tasks-dispatch', { id: 'tsk_x' })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('not running')
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it('refuses a coordinator-driven Run (6): its coordinator places its Tasks', async () => {
    const { deps, runId, taskId, dispatchTask } = await seeded()
    const s = deps.state()
    await deps.setState({ ...s, runs: s.runs.map((r) => (r.id === runId ? { ...r, coordinatorSessionId: 'coord_1' } : r)) })
    const r = await call(deps, 'tasks-dispatch', { id: taskId })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('coordinator')
    expect(error(r)).toContain('coord_1')
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it('refuses a Run whose coordinator is still starting (6)', async () => {
    const { deps, runId, taskId, dispatchTask } = await seeded()
    const s = deps.state()
    await deps.setState({ ...s, runs: s.runs.map((r) => (r.id === runId ? { ...r, coordinatorStartingAt: NOW } : r)) })
    expect((await call(deps, 'tasks-dispatch', { id: taskId })).status).toBe(409)
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it('refuses a Task of a Job plan, which belongs to no run (6)', async () => {
    const dispatchTask = vi.fn()
    const deps = makeDeps({ dispatchTask })
    const job = await call(deps, 'jobs-create', { objective: 'o', cwd: 'D:/p' })
    const t = await call(deps, 'tasks-add', { job: (job.body as { id: string }).id, spec: 's', account: 'acc_c' })
    const r = await call(deps, 'tasks-dispatch', { id: (t.body as { id: string }).id })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('jobs run')
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it('refuses a Run at its concurrency limit (6)', async () => {
    const { deps, runId, taskId, dispatchTask } = await seeded()
    const other = await call(deps, 'task-create', { run: runId, title: 'u', spec: 's', account: 'acc_c' })
    await call(deps, 'worker-start', { task: (other.body as { id: string }).id, agent: 'claude', account: 'acc_c', worktree: 'current' })
    const s = deps.state()
    await deps.setState({ ...s, jobs: s.jobs.map((j) => ({ ...j, concurrency: 1 })) })
    const r = await call(deps, 'tasks-dispatch', { id: taskId })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('concurrency limit')
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it('is refused to a worker session (5), as worker-start is', async () => {
    const { deps, runId, taskId, dispatchTask } = await seeded()
    const other = await call(deps, 'task-create', { run: runId, title: 'u', spec: 's', account: 'acc_c' })
    await call(deps, 'worker-start', { task: (other.body as { id: string }).id, agent: 'claude', account: 'acc_c', worktree: 'current' })
    expect((await call(deps, 'tasks-dispatch', { id: taskId }, 'sess_w')).status).toBe(403)
    expect(dispatchTask).not.toHaveBeenCalled()
  })

  it('a caller with no driver to ask (not the Host) is 6', async () => {
    const { deps, taskId } = await seeded({ dispatchTask: undefined })
    const r = await call(deps, 'tasks-dispatch', { id: taskId })
    expect(r.status).toBe(409)
    expect(error(r)).toContain('Host')
  })
})
