// A Job records the controller that made it, and revoking that controller pauses its scheduled Jobs until a person on
// this computer resumes them (remote governance design §8.1 to §8.4; the person's decision P2: pause, not delete).
import { describe, it, expect } from 'vitest'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, startJobRun, type OrchState } from './state'
import { APP_CALLER, HOST_CALLER } from '../host/driver'
import type { ControllerKind, ControllerPrincipal } from '../host/orchProtocol'
import { absPath } from '../testPaths'

const NOW = '2026-11-01T00:00:00.000Z'
const ROOT = absPath('p')
const DAILY = { kind: 'daily', time: '09:00' }

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
