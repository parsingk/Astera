// A Job records the controller that made it, and revoking that controller pauses its scheduled Jobs until a person on
// this computer resumes them (remote governance design §8.1 to §8.4; the person's decision P2: pause, not delete).
import { describe, it, expect } from 'vitest'
import { handleCommand, type OrchServerDeps } from './command'
import { createJob, createTask, emptyState, startJobRun, type OrchState } from './state'
import { APP_CALLER, HOST_CALLER } from '../host/driver'
import type { ControllerKind, ControllerPrincipal } from '../host/orchProtocol'
import { absPath } from '../testPaths'

const NOW = '2026-11-01T00:00:00.000Z'
const ROOT = absPath('p')
const DAILY = { kind: 'daily' as const, time: '09:00' }

const makeDeps = (): OrchServerDeps & { released: string[] } => {
  const box: { state: OrchState } = { state: { ...emptyState(), projects: [{ id: 'prj_p', path: ROOT, name: 'p', addedAt: NOW }] } }
  const released: string[] = []
  return {
    released,
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 'sess1', cwd: ROOT, specPath: 'spec.md' }),
    releaseWorker: async (a: { dispatchId: string }) => {
      released.push(a.dispatchId)
    },
    listAccounts: () => [{ id: 'acc1', label: 'One', provider: 'claude' as const }],
    readWorker: async () => '',
    now: () => NOW
  } as unknown as OrchServerDeps & { released: string[] }
}

type Caller = Parameters<typeof handleCommand>[1]
const controller = (kind: ControllerKind = 'person', clientId = 'cli_1', name = 'laptop'): Caller => ({
  sessionId: '',
  role: 'controller',
  principal: { clientId, name, permission: 'full-control', kind, surface: 'desktop' } satisfies ControllerPrincipal
})
const HOST: Caller = { sessionId: HOST_CALLER }
const APP: Caller = { sessionId: APP_CALLER, role: 'app' }
const PERSON_SHELL: Caller = { sessionId: '', role: 'cli' }
const AGENT_SHELL: Caller = { sessionId: 'ses_agent', role: 'cli' }

const REFUSAL = (jobId: string): string =>
  `job ${jobId} was paused because the pairing of laptop, which made it, was revoked; only a person on this computer can resume it`

/** A scheduled Job cli_1 made, with one Run of it, paused by the Host's revoke of cli_1. */
const revokedJob = async (): Promise<{ deps: ReturnType<typeof makeDeps>; jobId: string; runId: string }> => {
  const deps = makeDeps()
  const made = await handleCommand(deps, controller(), 'jobs-create', { objective: 'o', cwd: ROOT, schedule: DAILY })
  expect(made.status, JSON.stringify(made.body)).toBe(200)
  const jobId = deps.getState().jobs[0].id
  const fired = startJobRun(deps.getState(), jobId, NOW)
  if (!fired.ok) throw new Error(fired.error)
  await deps.setState(fired.state)
  const paused = await handleCommand(deps, HOST, 'run-pause', { run: jobId, revokedBy: { clientId: 'cli_1', name: 'laptop' } })
  expect(paused.status, JSON.stringify(paused.body)).toBe(200)
  return { deps, jobId, runId: fired.value.id }
}

/** A ready Task in the Run, as a fire's copy of the plan would be */
const taskIn = async (deps: OrchServerDeps, runId: string): Promise<string> => {
  const made = createTask(deps.getState(), { runId, title: 't', spec: 's', deps: [] }, NOW)
  if (!made.ok) throw new Error(made.error)
  await deps.setState(made.state)
  return made.value.id
}

describe('a Job records the controller that made it (remote governance design §8.1)', () => {
  it('jobs-create from a controller with a schedule records createdBy with its client id and name', async () => {
    const deps = makeDeps()
    const r = await handleCommand(deps, controller(), 'jobs-create', { objective: 'o', cwd: ROOT, schedule: DAILY })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(deps.getState().jobs[0].createdBy).toEqual({ kind: 'controller', clientId: 'cli_1', name: 'laptop' })
  })

  it('run-create from a controller records it too', async () => {
    const deps = makeDeps()
    const r = await handleCommand(deps, controller('agent', 'cli_2', 'desk'), 'run-create', { objective: 'o', cwd: ROOT, auto: true })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
    expect(deps.getState().jobs[0].createdBy).toEqual({ kind: 'controller', clientId: 'cli_2', name: 'desk' })
  })

  it("a Job made by the app or a person's shell records no createdBy", async () => {
    const deps = makeDeps()
    for (const caller of [APP, PERSON_SHELL, AGENT_SHELL, HOST])
      expect((await handleCommand(deps, caller, 'jobs-create', { objective: 'o', cwd: ROOT, schedule: DAILY })).status).toBe(200)
    expect(deps.getState().jobs).toHaveLength(4)
    for (const job of deps.getState().jobs) expect(job.createdBy).toBeUndefined()
  })

  // No other command sets a schedule (§8.1): a schedule given to them is not read, so a Job a controller made without one
  // never becomes one its revoke would have to pause
  it('task-update, run-start and run-resume given a schedule argument leave the Job unscheduled', async () => {
    const deps = makeDeps()
    await handleCommand(deps, controller(), 'run-create', { objective: 'o', cwd: ROOT, auto: true })
    const jobId = deps.getState().jobs[0].id
    const task = await handleCommand(deps, controller(), 'task-create', { account: 'acc1', runId: jobId, title: 't', spec: 's' })
    expect(task.status, JSON.stringify(task.body)).toBe(200)
    const taskId = (task.body as { id: string }).id
    await handleCommand(deps, controller(), 'task-update', { id: taskId, status: 'blocked', schedule: DAILY })
    await handleCommand(deps, controller(), 'run-start', { run: jobId, schedule: DAILY })
    await handleCommand(deps, controller(), 'run-resume', { run: jobId, schedule: DAILY })
    expect(deps.getState().jobs[0].schedule).toBeUndefined()
  })
})

describe('run-pause from the Host after a revoke (remote governance design §8.2)', () => {
  it('run-pause from the Host with revokedBy pauses the Job and its Runs and stamps pausedBy', async () => {
    const { deps, jobId, runId } = await revokedJob()
    const job = deps.getState().jobs.find((j) => j.id === jobId)!
    expect(job.paused).toBe(true)
    expect(job.pausedBy).toEqual({ reason: 'controller-revoked', clientId: 'cli_1', name: 'laptop', at: NOW })
    expect(deps.getState().runs.find((r) => r.id === runId)?.paused).toBe(true)
  })

  it('revokedBy from anyone but the Host is refused 400', async () => {
    const deps = makeDeps()
    await handleCommand(deps, APP, 'jobs-create', { objective: 'o', cwd: ROOT, schedule: DAILY })
    const jobId = deps.getState().jobs[0].id
    for (const caller of [APP, PERSON_SHELL, AGENT_SHELL, controller()]) {
      const r = await handleCommand(deps, caller, 'run-pause', { run: jobId, revokedBy: { clientId: 'cli_1', name: 'laptop' } })
      expect(r.status, JSON.stringify(caller)).toBe(400)
    }
    expect(deps.getState().jobs[0].paused).toBeUndefined()
    expect(deps.getState().jobs[0].pausedBy).toBeUndefined()
  })
})

describe('a revoked-paused Job is resumed only by a person on this computer (remote governance design §8.2)', () => {
  it("a controller's run-resume of a revoked-paused Job is 403 controller-revoked", async () => {
    const { deps, jobId } = await revokedJob()
    // A person's controller too: the pairing that made it is gone, and resuming is for this computer
    for (const kind of ['person', 'agent', 'unsaid'] as const) {
      const r = await handleCommand(deps, controller(kind, 'cli_9', 'other'), 'run-resume', { run: jobId })
      expect([r.status, r.body], kind).toEqual([403, { error: REFUSAL(jobId), reason: 'controller-revoked' }])
    }
    expect(deps.getState().jobs[0].paused).toBe(true)
  })

  it('the same for run-start, run-spawn and jobs-run', async () => {
    const { deps, jobId, runId } = await revokedJob()
    const runsBefore = deps.getState().runs.length
    for (const [cmd, args] of [
      ['run-start', { run: jobId }],
      ['run-start', { run: runId }],
      ['run-spawn', { run: jobId }],
      ['jobs-run', { id: jobId }]
    ] as const) {
      const r = await handleCommand(deps, controller(), cmd, { ...args })
      expect([r.status, r.body], `${cmd} ${JSON.stringify(args)}`).toEqual([403, { error: REFUSAL(jobId), reason: 'controller-revoked' }])
    }
    expect(deps.getState().runs).toHaveLength(runsBefore)
  })

  // The controller's ruling C3: pauseSchedule pauses every Run of the Job, and runs-resume clears a Run's flag, so a
  // revoked Job's Run is refused to a controller there too, and on runs-reconverge, both on the control list
  it('runs-resume and runs-reconverge of a Run of it are refused the same way', async () => {
    const { deps, jobId, runId } = await revokedJob()
    for (const cmd of ['runs-resume', 'runs-reconverge'] as const) {
      const r = await handleCommand(deps, controller(), cmd, { id: runId })
      expect([r.status, r.body], cmd).toEqual([403, { error: REFUSAL(jobId), reason: 'controller-revoked' }])
    }
    expect(deps.getState().runs.find((x) => x.id === runId)?.paused).toBe(true)
  })

  it("an agent's shell is refused the same way, a person's shell and the app resume it", async () => {
    const { deps, jobId, runId } = await revokedJob()
    for (const [cmd, args] of [
      ['run-resume', { run: jobId }],
      ['runs-resume', { id: runId }]
    ] as const) {
      const r = await handleCommand(deps, AGENT_SHELL, cmd, { ...args })
      expect([r.status, r.body], cmd).toEqual([403, { error: REFUSAL(jobId), reason: 'controller-revoked' }])
    }
    for (const caller of [PERSON_SHELL, APP]) {
      const again = await revokedJob()
      const r = await handleCommand(again.deps, caller, 'run-resume', { run: again.jobId })
      expect(r.status, JSON.stringify(r.body)).toBe(200)
      const job = again.deps.getState().jobs[0]
      expect(job.paused).toBeUndefined()
      expect(job.pausedBy).toBeUndefined()
      // Its Run stays paused, as after any resume of a schedule; a person takes it back with runs-resume
      expect((await handleCommand(again.deps, caller, 'runs-resume', { id: again.runId })).status).toBe(200)
    }
  })

  // Ruling R7-1: one Task of the Job set going again is the Job set going again
  it('worker-start on a Task of a revoked-paused Run is refused to a controller and an agent', async () => {
    const { deps, jobId, runId } = await revokedJob()
    const taskId = await taskIn(deps, runId)
    for (const caller of [controller('person', 'cli_2', 'desk'), AGENT_SHELL]) {
      const r = await handleCommand(deps, caller, 'worker-start', { task: taskId, agent: 'claude', account: 'acc1', worktree: 'current' })
      expect([r.status, r.body], JSON.stringify(caller)).toEqual([403, { error: REFUSAL(jobId), reason: 'controller-revoked' }])
    }
    expect(deps.getState().dispatches).toHaveLength(0)
  })

  it('gate-resolve that reopens a Task of it is refused the same way, and mark-failed is not', async () => {
    const { deps, jobId, runId } = await revokedJob()
    const taskId = await taskIn(deps, runId)
    // A Task blocked on a question, as a Gate leaves it
    const st = deps.getState()
    await deps.setState({
      ...st,
      tasks: st.tasks.map((t) => (t.id === taskId ? { ...t, status: 'blocked' as const } : t)),
      gates: [{ id: 'gate_1', runId, taskId, question: 'q', status: 'open', createdAt: NOW }]
    })
    for (const caller of [controller(), AGENT_SHELL]) {
      const r = await handleCommand(deps, caller, 'gate-resolve', { id: 'gate_1', resolution: 'try again' })
      expect([r.status, r.body], JSON.stringify(caller)).toEqual([403, { error: REFUSAL(jobId), reason: 'controller-revoked' }])
    }
    expect(deps.getState().gates[0].status).toBe('open')
    const failed = await handleCommand(deps, controller(), 'gate-resolve', { id: 'gate_1', resolution: 'mark-failed' })
    expect(failed.status, JSON.stringify(failed.body)).toBe(200)
  })

  it("a person's own pause does not refuse worker-start this way", async () => {
    const deps = makeDeps()
    await handleCommand(deps, controller(), 'jobs-create', { objective: 'o', cwd: ROOT, schedule: DAILY })
    const jobId = deps.getState().jobs[0].id
    const fired = startJobRun(deps.getState(), jobId, NOW)
    if (!fired.ok) throw new Error(fired.error)
    await deps.setState(fired.state)
    expect((await handleCommand(deps, PERSON_SHELL, 'run-pause', { run: jobId })).status).toBe(200)
    const taskId = await taskIn(deps, fired.value.id)
    const r = await handleCommand(deps, controller(), 'worker-start', { task: taskId, agent: 'claude', account: 'acc1', worktree: 'current' })
    expect((r.body as { reason?: unknown }).reason).not.toBe('controller-revoked')
  })

  // Ruling R7-5: the person reviews a revoked Job before it goes
  it('run-delete of a revoked-paused Job is refused to a controller and an agent, and a person deletes it', async () => {
    const { deps, jobId } = await revokedJob()
    for (const caller of [controller(), AGENT_SHELL]) {
      const r = await handleCommand(deps, caller, 'run-delete', { id: jobId })
      expect([r.status, r.body], JSON.stringify(caller)).toEqual([403, { error: REFUSAL(jobId), reason: 'controller-revoked' }])
    }
    expect(deps.getState().jobs).toHaveLength(1)
    expect((await handleCommand(deps, PERSON_SHELL, 'run-delete', { id: jobId })).status).toBe(200)
    expect(deps.getState().jobs).toHaveLength(0)
  })

  it("a person's pause and resume of an ordinary scheduled Job are unchanged", async () => {
    const deps = makeDeps()
    await handleCommand(deps, controller(), 'jobs-create', { objective: 'o', cwd: ROOT, schedule: DAILY })
    const jobId = deps.getState().jobs[0].id
    // Paused by a person, not by a revoke: its maker's controller resumes it as before
    expect((await handleCommand(deps, PERSON_SHELL, 'run-pause', { run: jobId })).status).toBe(200)
    expect(deps.getState().jobs[0]).toMatchObject({ paused: true })
    expect(deps.getState().jobs[0].pausedBy).toBeUndefined()
    expect((await handleCommand(deps, controller(), 'run-resume', { run: jobId })).status).toBe(200)
    expect(deps.getState().jobs[0].paused).toBeUndefined()
  })
})

// Ruling R7-4: a fire waits on the profile store (and on the coordinator's idle check); a pause that lands meanwhile
// must not be fired past
describe('a scheduled fire and a pause that lands while it waits', () => {
  it('run-spawn --unless-running re-reads the Job after its awaits and skips it once paused', async () => {
    const deps = makeDeps()
    const made = createJob(deps.getState(), { objective: 'o', cwd: ROOT, schedule: DAILY, agentProfileId: 'ap_1' }, NOW)
    if (!made.ok) throw new Error(made.error)
    await deps.setState(made.state)
    const jobId = made.value.id
    deps.readAgentProfiles = async () => {
      // The revoke's pause commits while the fire reads the store
      await deps.setState({ ...deps.getState(), jobs: deps.getState().jobs.map((j) => (j.id === jobId ? { ...j, paused: true } : j)) })
      return {
        version: 1,
        profiles: [{ id: 'ap_1', name: 'P', status: 'active', accountIds: ['acc1'], mcpExclude: [], permission: 'inherit', sandbox: false, createdAt: NOW, updatedAt: NOW }]
      } as never
    }
    const r = await handleCommand(deps, HOST, 'run-spawn', { run: jobId, unlessRunning: true })
    expect([r.status, (r.body as { paused?: unknown }).paused], JSON.stringify(r.body)).toEqual([409, true])
    expect(deps.getState().runs).toHaveLength(0)
  })
})
