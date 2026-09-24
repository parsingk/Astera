// createHostDriving (driving.ts) — the long-lived Host drives Jobs with the app closed (§4.1, §4.3,
// D2, D6, R15–R17, R22).
//
// **Over a real createHostOrch on a temp profile whose onLoaded is the driving's onLoaded**, so the
// load itself triggers the after-load pass (B2) and every command runs through the real handleCommand.
// Its onCommit and mayDrain are wired the way the Host's composition wires them (Task 13):
// `onCommit: () => driving.kick(...)` and `mayDrain: async () => (await driving.driver()) === 'host'`.
// The fakes are only what starts a process (the spawner's startWorker), the server (`app`, `keeps`),
// the worktrees, the checks and the belt's startRepair; `every` is captured so the test runs the tick.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHostDriving, type HostDriving } from './driving'
import { createHostOrch, type HostOrch } from './orch'
import type { HostLocal } from './spawner'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { Dispatch, Job, Task } from '../core/orchestration/types'
import { readDispatchGate, type DispatchGate } from '../core/host/driver'
import { ORCH_FIRE_TICK_MS } from '../core/orchestration/exec/dispatchLoop'
import { pendingReportFileName, pendingReportsDirIn, serializePendingReport } from '../core/orchestration/pendingReports'
import type { Lang } from '../core/i18n'
import type { Account } from '../core/types'

const NOW = '2026-09-25T00:00:00.000Z'
const NOW_MS = Date.parse(NOW)
const ACCOUNT: Account = { id: 'accA', label: 'a', configDir: '/cfg/accA', color: '#000', createdAt: NOW, provider: 'claude' }

let dir: string
let wt: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-hostdriving-'))
  wt = path.join(dir, 'wt')
  await fs.mkdir(wt, { recursive: true })
  await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify({ accounts: [ACCOUNT] }), 'utf8')
})
const rigs: HostDriving[] = []
afterEach(async () => {
  for (const r of rigs.splice(0)) r.dispose()
  await fs.rm(dir, { recursive: true, force: true })
})

const task = (over: Partial<Task> & Pick<Task, 'id'>): Task => ({
  runId: 'run_1',
  jobId: 'job_1',
  title: over.id,
  spec: 's',
  deps: [],
  status: 'ready',
  accountIds: ['accA'],
  consecutiveFailures: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over
})
const dispatch = (over: Partial<Dispatch> & Pick<Dispatch, 'id' | 'taskId'>): Dispatch => ({
  provider: 'claude',
  accountId: 'accA',
  sessionId: 'ses_gone',
  cwd: wt,
  specPath: path.join(dir, 'orch', 'specs', `${over.id}.md`),
  startedAt: NOW,
  workerState: 'outcome_unknown',
  retained: false,
  ...over
})

interface RigOpts {
  readyTasks?: number
  /** app-settings.json as a whole; the default carries the migration marker. */
  settings?: Record<string, unknown>
  /** A worker_done waiting in pending-reports (for a Dispatch in no Run here). */
  queuedReport?: boolean
  /** An open repair Dispatch whose start never happened (specPath ''), on a Task that is validating. */
  openRepairWithoutSpec?: boolean
  /** A dispatched Task whose latest Dispatch ended with no outcome and no closedBy, in a Run with no coordinator. */
  lostDispatch?: boolean
  /** A Job with a one-minute schedule. */
  scheduledJob?: boolean
  /** A file in orch/specs that nothing names. */
  staleSpec?: boolean
  /** What checks.lang() reads, when it differs from langNow's first value. */
  langOnRead?: Lang
  /** Two finished scheduled child Runs, each with a registered worktree the loop's clean-up reaps. */
  reapableChildren?: boolean
}

const CHILD_WORKTREES = ['/wt-child-1', '/wt-child-2']

function fixture(o: RigOpts): OrchState {
  const jobs: Job[] = [{ id: 'job_1', objective: 'o', cwd: dir, createdAt: NOW, concurrency: 1, autoDispatch: true }]
  if (o.scheduledJob) jobs.push({ id: 'job_sched', objective: 'every minute', cwd: dir, createdAt: NOW, schedule: { kind: 'interval', minutes: 1 } })
  const tasks: Task[] = []
  for (let i = 0; i < (o.readyTasks ?? 0); i++) tasks.push(task({ id: `tsk_${i}` }))
  const dispatches: Dispatch[] = []
  if (o.lostDispatch) {
    tasks.push(task({ id: 'tsk_lost', status: 'dispatched' }))
    dispatches.push(dispatch({ id: 'dsp_lost', taskId: 'tsk_lost', endedAt: NOW }))
  }
  if (o.openRepairWithoutSpec) {
    tasks.push(task({ id: 'tsk_rep', status: 'validating' }))
    dispatches.push(dispatch({ id: 'dsp_rep', taskId: 'tsk_rep', sessionId: 'pending:rep', specPath: '', repair: 'check-failure', workerState: 'ready' }))
  }
  const runs: OrchState['runs'] = [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW, worktree: wt }]
  if (o.reapableChildren) {
    jobs.push({ id: 'job_rc', objective: 'scheduled', cwd: dir, createdAt: NOW, schedule: { kind: 'interval', minutes: 60 } })
    CHILD_WORKTREES.forEach((w, i) => {
      runs.push({ id: `run_rc${i}`, jobId: 'job_rc', ordinal: i + 1, createdAt: NOW, worktree: w })
      tasks.push(task({ id: `tsk_rc${i}`, runId: `run_rc${i}`, jobId: 'job_rc', status: 'completed' }))
    })
  }
  return { ...emptyState(), jobs, runs, tasks, dispatches }
}

async function rig(o: RigOpts = {}) {
  const state = fixture(o)
  await fs.writeFile(path.join(dir, 'orchestration.json'), JSON.stringify(state), 'utf8')
  let settings: Record<string, unknown> = o.settings ?? { orchAlwaysOnMigrated: true }
  const writeSettings = async (patch: Record<string, unknown>): Promise<void> => {
    settings = { ...settings, ...patch }
    await fs.writeFile(path.join(dir, 'app-settings.json'), JSON.stringify(settings), 'utf8')
  }
  await writeSettings({})
  if (o.queuedReport) {
    const queue = pendingReportsDirIn(dir)
    await fs.mkdir(queue, { recursive: true })
    await fs.writeFile(
      path.join(queue, pendingReportFileName({ queuedAt: NOW, nonce: 'aaaaaaaa' })),
      serializePendingReport({
        queuedAt: NOW,
        sessionId: 'ses_elsewhere',
        cmd: 'send',
        args: { type: 'worker_done', taskId: 'tsk_elsewhere', dispatchId: 'dsp_elsewhere', outcome: 'succeeded', subject: 's', body: 'b' }
      }),
      'utf8'
    )
  }
  const specsDir = path.join(dir, 'orch', 'specs')
  const staleSpecPath = path.join(specsDir, 'stale-worker.md')
  if (o.staleSpec) {
    await fs.mkdir(specsDir, { recursive: true })
    await fs.writeFile(staleSpecPath, 'spec nobody reads', 'utf8')
  }

  const server = { app: false, keeps: false }
  const spawner = { retiring: false, inFlightCount: 0 }
  const logs: string[] = []
  let starts = 0
  let commitsKick = true
  const box: { driving: HostDriving | null } = { driving: null }
  const local: HostLocal = {
    owns: () => true,
    startWorker: vi.fn(async () => ({ sessionId: `ses_${starts++}`, cwd: wt, specPath: path.join(specsDir, `w${starts}.md`) })),
    startCoordinator: vi.fn(async () => ({ sessionId: 'ses_coord' })),
    releaseWorker: vi.fn(async () => {}),
    readWorker: vi.fn(async () => ''),
    probeLimit: vi.fn(async () => null),
    readReviewFile: vi.fn(async () => null),
    makeRunWorktree: vi.fn(async () => wt),
    mergeWorktrees: vi.fn(async () => ({ ok: true as const, merged: [], uncommitted: 0 })),
    removeWorktrees: vi.fn(async () => ({ failed: [] }))
  }
  const orch: HostOrch = createHostOrch({
    profileDir: dir,
    version: '9.9.9',
    now: () => NOW,
    hostStartedAt: () => NOW,
    runningSessions: () => 0,
    // The repair's placeholder is kept open through the load, as if its start were still to come.
    aliveSessionIds: () => new Set(o.openRepairWithoutSpec ? ['pending:rep'] : []),
    act: async () => ({}),
    hasApp: () => server.app,
    onState: () => {},
    log: (m) => logs.push(m),
    sessions: { listSessions: async () => [], readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }), sendSession: async () => {}, readChat: async () => [], sendChat: async () => {}, serial: (_id, run) => run() },
    local,
    onCommit: () => {
      if (commitsKick) box.driving?.kick('a commit')
    },
    mayDrain: async () => (await box.driving!.driver()) === 'host',
    onLoaded: () => box.driving?.onLoaded()
  })
  const drainOnce = vi.fn(() => orch.drainOnce())
  const handled: string[] = []
  const handle = vi.fn((cmd: string, args: Record<string, unknown>) => {
    handled.push(cmd)
    return orch.handle(cmd, args)
  })
  const resumeSweep = vi.fn()
  const startRepair = vi.fn()
  let langNow: Lang = 'en'
  const lang = vi.fn(async () => {
    if (o.langOnRead) langNow = o.langOnRead
    return langNow
  })
  let gateFailure: Error | null = null
  let tickFn: (() => void) | null = null
  let everyMs: number | null = null
  const clock = { now: NOW_MS }
  const reaped: string[] = []
  const reapHook = { onReap: (_p: string): void => {} }
  const driving = createHostDriving({
    profileDir: dir,
    orch: { handle, internalDeps: () => orch.internalDeps(), loaded: () => orch.loaded(), drainOnce, state: () => orch.state() },
    server: { hasApp: () => server.app, appsKeep: () => server.keeps },
    spawner: { sessionBusy: () => null, typeInto: () => true, isRetiring: () => spawner.retiring, inFlight: () => spawner.inFlightCount },
    worktrees: {
      fork: async () => wt,
      integrate: async () => ({ kind: 'merged', uncommitted: 0 }),
      reap: async (p) => {
        reaped.push(p)
        reapHook.onReap(p)
        return true
      },
      isRegistered: (p) => CHILD_WORKTREES.includes(p)
    },
    checks: { resumeSweep, accounts: async () => [ACCOUNT], loginStatus: async () => true, langNow: () => langNow, lang },
    startRepair,
    registry: { sessionPty: () => null, list: () => [] },
    specsDir,
    log: (m) => logs.push(m),
    nowMs: () => clock.now,
    every: (ms, fn) => {
      everyMs = ms
      tickFn = fn
      return () => {
        tickFn = null
      }
    },
    readGate: async (p): Promise<DispatchGate> => {
      if (gateFailure) {
        const e = gateFailure
        gateFailure = null
        throw e
      }
      return readDispatchGate(p)
    }
  })
  box.driving = driving
  rigs.push(driving)

  /** Lets fire-and-forget work (a kick, the after-load pass) run out. For the negative assertions. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 10))
  }
  const openGates = () => orch.state().gates.filter((g) => g.status === 'open')
  return {
    orch,
    driving,
    server,
    spawner,
    logs,
    resumeSweep,
    startRepair,
    drainOnce,
    lang,
    get clock() {
      return clock.now
    },
    set clock(v: number) {
      clock.now = v
    },
    everyMs: () => everyMs,
    tickFn: () => tickFn,
    repairDispatchId: 'dsp_rep',
    reaped: () => reaped,
    reapHook,
    workerStarts: () => starts,
    handled: () => handled,
    settle,
    load: async () => {
      await orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' })
      await settle()
    },
    tickNow: () => driving.tick(),
    writeSettings,
    gateRejectsOnce: (e: Error) => {
      gateFailure = e
    },
    addReadyTaskBehindTheHostsBack: async () => {
      commitsKick = false
      try {
        const s = orch.state()
        await orch.internalDeps().setState({ ...s, tasks: [...s.tasks, task({ id: 'tsk_late' })] })
      } finally {
        commitsKick = true
      }
    },
    queuedReports: async () => (await fs.readdir(pendingReportsDirIn(dir)).catch((): string[] => [])).filter((f) => f.endsWith('.json')),
    specExists: async () => existsSync(staleSpecPath),
    taskStatus: () => orch.state().tasks.find((t) => t.id === 'tsk_lost')?.status,
    openGateQuestion: () => openGates()[0]?.question ?? ''
  }
}

describe('createHostDriving', () => {
  // B2: no manual kick — the load itself triggers the pass.
  it('drives nothing before the load, and runs its first pass when a call loads (R3, B2)', async () => {
    const h = await rig({ readyTasks: 1 })
    await h.settle()
    expect(h.workerStarts()).toBe(0)
    await h.orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' }) // a CLI call loads
    await vi.waitFor(() => expect(h.workerStarts()).toBe(1))
    expect(h.resumeSweep).toHaveBeenCalledWith(expect.stringMatching(/loaded/))
  })
  it('the tick runs the loop too, so a ready Task is picked up with nobody committing (B2)', async () => {
    const h = await rig({ readyTasks: 0 })
    await h.load()
    await h.addReadyTaskBehindTheHostsBack() // writes through orch.internalDeps().setState with onCommit disabled
    await h.settle()
    expect(h.workerStarts()).toBe(0)
    await h.tickNow()
    await vi.waitFor(() => expect(h.workerStarts()).toBe(1))
  })
  it('ticks every ORCH_FIRE_TICK_MS through its timer, and stops it at dispose', async () => {
    const h = await rig({ readyTasks: 0 })
    expect(h.everyMs()).toBe(ORCH_FIRE_TICK_MS)
    expect(h.tickFn()).not.toBeNull()
    h.driving.dispose()
    expect(h.tickFn()).toBeNull()
  })
  it('parks on an unmigrated profile: no slot, no drain, no sweep, and status says parked (§4.6)', async () => {
    const h = await rig({ readyTasks: 1, settings: { orchestrationEnabled: false } })
    await h.load()
    h.driving.kick('test')
    await h.settle()
    expect(h.workerStarts()).toBe(0)
    expect(h.resumeSweep).not.toHaveBeenCalled()
    expect(h.drainOnce).not.toHaveBeenCalled()
    expect(h.driving.status()).toEqual({ driver: 'parked', appAttached: false })
  })
  // N4: the migrating launch leaves the queue alone, and so does the Host on that change.
  it('notices the migration marker at the next tick and starts, but does not drain on that change (R2, N4)', async () => {
    const h = await rig({ readyTasks: 1, settings: { orchestrationEnabled: false }, queuedReport: true })
    await h.load()
    await h.writeSettings({ orchAlwaysOnMigrated: true })
    await h.tickNow()
    await vi.waitFor(() => expect(h.workerStarts()).toBe(1))
    expect(h.drainOnce).not.toHaveBeenCalled()
    expect(await h.queuedReports()).toHaveLength(1)
  })
  it('stands back while an app keeps dispatch, and on its leaving drains, sweeps and runs a pass (§4.3)', async () => {
    const h = await rig({ readyTasks: 1 })
    h.server.keeps = true
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    expect(h.workerStarts()).toBe(0)
    expect(h.resumeSweep).not.toHaveBeenCalled()
    h.server.keeps = false
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.workerStarts()).toBe(1))
    expect(h.drainOnce).toHaveBeenCalledTimes(1)
    expect(h.resumeSweep).toHaveBeenCalledWith(expect.stringMatching(/Host/))
  })
  // N1: drives() flips in the same turn the socket's close is recorded.
  it('flips drives() synchronously on appsChanged, before any file is read', async () => {
    const h = await rig({ readyTasks: 0 })
    await h.load()
    await h.tickNow() // last gate: migrated
    h.server.keeps = true
    h.server.app = true
    h.driving.appsChanged()
    expect(h.driving.drives()).toBe(false)
    h.server.keeps = false
    h.server.app = false
    h.driving.appsChanged()
    expect(h.driving.drives()).toBe(true)
  })
  it('on the handover to host, starts an open repair Dispatch that has no spec yet (N1)', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.server.keeps = true
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    expect(h.startRepair).not.toHaveBeenCalled()
    h.server.keeps = false
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledWith({ dispatchId: h.repairDispatchId }))
    expect(h.startRepair).toHaveBeenCalledTimes(1)
  })
  // The belt starts nothing with an app still attached: that repair may be a person's retry-once the
  // app is starting itself (R20), and performRepair has no in-flight guard of its own.
  it('leaves an open repair Dispatch to an app that is still attached at the handover', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.server.keeps = true
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    h.server.keeps = false // an old app left; a new one (yields dispatch) stays attached
    h.driving.appsChanged()
    await h.settle()
    expect(h.driving.drives()).toBe(true)
    expect(h.startRepair).not.toHaveBeenCalled()
  })
  it('starts parked: drives() is false before the first computation (N2)', async () => {
    const h = await rig({ readyTasks: 0 })
    expect(h.driving.drives()).toBe(false)
    expect(h.driving.status().driver).toBe('parked')
  })
  it('drives nothing while the Host is leaving (R15)', async () => {
    const h = await rig({ readyTasks: 1 })
    h.spawner.retiring = true
    await h.load()
    h.driving.kick('test')
    await h.tickNow()
    await h.settle()
    expect(h.workerStarts()).toBe(0)
  })
  // Carry (Task 11): a Host whose first contact is an accepted state-put never loads, so onLoaded
  // never fires. The commit's kick is what hands it over.
  it('runs a pass, drains and sweeps on a Host whose first contact is an accepted state-put', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.app = true // the app that sends it is attached, and yields dispatch
    // A tick before any state is in memory computes 'host' already, so the put's kick is no change of
    // driver: the handover must still run, because this is the first time the Host holds a state.
    await h.tickNow()
    expect(h.driving.drives()).toBe(true)
    expect(h.resumeSweep).not.toHaveBeenCalled()
    const put = await h.orch.call({
      cmd: 'state-put',
      args: { state: fixture({ readyTasks: 1 }), version: 0 },
      sessionId: '',
      from: { role: 'app', toOthers: () => {} }
    })
    expect(put.status).toBe(200)
    await vi.waitFor(() => expect(h.workerStarts()).toBe(1))
    expect(h.drainOnce).toHaveBeenCalledTimes(1)
    expect(h.resumeSweep).toHaveBeenCalledTimes(1)
  })
  // Carry (Task 9): langNow otherwise stays the OS locale for the Host's life.
  it('reads the language at each computation, so the Gate it writes next is in the profile’s language', async () => {
    const h = await rig({ lostDispatch: true, langOnRead: 'ko' })
    await h.load()
    await vi.waitFor(() => expect(h.taskStatus()).toBe('blocked'))
    expect(h.lang).toHaveBeenCalled()
    expect(h.openGateQuestion()).toContain('Astera 가 열려 있지 않은 동안')
  })
  // Review Focus 3, D6/R16.
  it('gates a Task whose worker was lost, when no app is attached and its Run has no coordinator', async () => {
    const h = await rig({ lostDispatch: true })
    await h.load()
    await vi.waitFor(() => expect(h.taskStatus()).toBe('blocked'))
    expect(h.openGateQuestion()).toMatch(/lost/i)
    expect(h.openGateQuestion()).toContain('dsp_lost')
  })
  it('leaves that Task to the app’s reconciler while an app is attached (D8)', async () => {
    const h = await rig({ lostDispatch: true })
    h.server.app = true // a new app: attached, yields dispatch
    await h.load()
    h.driving.kick('test')
    await h.settle()
    expect(h.taskStatus()).toBe('dispatched')
  })
  it('fires schedules only on a tick with an app attached, and only arms on the first such tick (D2, R17)', async () => {
    const h = await rig({ scheduledJob: true })
    await h.load()
    await h.tickNow()
    h.clock += 61_000
    await h.tickNow()
    expect(h.handled()).not.toContain('run-spawn') // no app: never fires
    h.server.app = true
    await h.tickNow()
    expect(h.handled()).not.toContain('run-spawn') // first tick with an app: arms
    h.clock += 61_000
    await h.tickNow()
    expect(h.handled()).toContain('run-spawn')
  })
  // Carry (Task 8 m6): fireTick does not ask mayStart, so the tick must.
  it('fires no schedule while it does not drive, even with an app attached, and re-arms when it drives again', async () => {
    const h = await rig({ scheduledJob: true })
    h.server.app = true
    await h.load()
    await h.tickNow() // arms
    h.server.keeps = true // an app that keeps dispatch drives now
    h.driving.appsChanged()
    h.clock += 61_000
    await h.tickNow()
    expect(h.handled()).not.toContain('run-spawn')
    h.server.keeps = false
    h.driving.appsChanged()
    await h.tickNow() // the arming it held is gone: this tick only arms again
    expect(h.handled()).not.toContain('run-spawn')
  })
  it('sweeps stale spec files on a tick only with no app attached and no spawn in flight (R22)', async () => {
    const h = await rig({ staleSpec: true })
    await h.load()
    h.spawner.inFlightCount = 1
    await h.tickNow()
    expect(await h.specExists()).toBe(true)
    h.spawner.inFlightCount = 0
    h.server.app = true
    await h.tickNow()
    expect(await h.specExists()).toBe(true)
    h.server.app = false
    await h.tickNow()
    expect(await h.specExists()).toBe(false)
  })
  // The two-writers risk (Task 8 m5): the loop asks once before its clean-up loop; each reap is asked
  // again, so an app that takes the drive after the first reap finds the Host removing nothing more.
  it('reaps no further worktree once the drive has moved to an app mid clean-up', async () => {
    const h = await rig({ reapableChildren: true })
    h.reapHook.onReap = () => {
      h.server.keeps = true
      h.server.app = true
      h.driving.appsChanged()
    }
    await h.load()
    await vi.waitFor(() => expect(h.reaped()).toHaveLength(1))
    await h.settle()
    expect(h.reaped()).toEqual([CHILD_WORKTREES[0]])
    expect(h.logs.join('\n')).toMatch(/left for the process that drives now/)
  })
  it('reaps every finished child worktree while it keeps the drive', async () => {
    const h = await rig({ reapableChildren: true })
    await h.load()
    await vi.waitFor(() => expect([...new Set(h.reaped())].sort()).toEqual([...CHILD_WORKTREES].sort()))
  })
  // B6: the seam is what can make the body throw.
  it('a tick whose body throws is logged, and the next tick still runs (constraint 14)', async () => {
    const h = await rig({ readyTasks: 0 })
    await h.load()
    h.gateRejectsOnce(new Error('disk gone'))
    await expect(h.tickNow()).resolves.toBeUndefined()
    expect(h.logs.join('\n')).toMatch(/tick failed/)
    await expect(h.tickNow()).resolves.toBeUndefined()
    expect(h.driving.status().driver).toBe('host')
  })
})
