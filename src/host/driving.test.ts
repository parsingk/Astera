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
import { APP_LEFT_GRACE_MS, createHostDriving, type HostDriving } from './driving'
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
  /** A Job with a one-minute schedule, written as every scheduled Job on disk is: no autoDispatch,
   *  no pendingStart (R2). */
  scheduledJob?: boolean
  /** That Job has one definition Task, with an account, which each fire copies into its Run. */
  scheduledTask?: boolean
  /** That Job's coordinator account. */
  scheduledCoordinator?: string
  /** A file in orch/specs that nothing names. */
  staleSpec?: boolean
  /** What checks.lang() reads, when it differs from langNow's first value. */
  langOnRead?: Lang
  /** Two finished scheduled child Runs, each with a registered worktree the loop's clean-up reaps. */
  reapableChildren?: boolean
  /** An open Dispatch whose worker still runs, with its spec file on disk. */
  openDispatchSpec?: boolean
  /** Run_1 has a live coordinator (`coord-1`, a pty in the registry) with unread upward mail older than
   *  COORDINATOR_NUDGE_MS. */
  sleepingCoordinator?: boolean
  /** Every restart Gate the tick asks for is refused (interruptStalledTask answers not interrupted). */
  refuseGates?: boolean
}

/** Under the test's own folder (review m7): never a literal path, should the fake ever resolve one. */
const childWorktrees = (): string[] => [path.join(dir, 'wt-child-1'), path.join(dir, 'wt-child-2')]

function fixture(o: RigOpts): OrchState {
  const jobs: Job[] = [{ id: 'job_1', objective: 'o', cwd: dir, createdAt: NOW, concurrency: 1, autoDispatch: true }]
  if (o.scheduledJob)
    jobs.push({
      id: 'job_sched',
      objective: 'every minute',
      cwd: dir,
      createdAt: NOW,
      schedule: { kind: 'interval', minutes: 1 },
      ...(o.scheduledCoordinator ? { coordinatorAccountId: o.scheduledCoordinator } : {})
    })
  const tasks: Task[] = []
  if (o.scheduledTask) {
    const { runId: _none, ...def } = task({ id: 'tsk_def', jobId: 'job_sched', status: 'pending' })
    tasks.push(def as Task)
  }
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
  if (o.openDispatchSpec) {
    tasks.push(task({ id: 'tsk_live', status: 'dispatched' }))
    dispatches.push(dispatch({ id: 'dsp_live', taskId: 'tsk_live', sessionId: 'ses_live', workerState: 'ready' }))
  }
  const runs: OrchState['runs'] = [
    { id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: NOW, worktree: wt, ...(o.sleepingCoordinator ? { coordinatorSessionId: 'coord-1' } : {}) }
  ]
  const messages: OrchState['messages'] = o.sleepingCoordinator
    ? [{ id: 'msg_up', runId: 'run_1', type: 'status', subject: 's', body: 'b', answered: false, createdAt: new Date(NOW_MS - 120_000).toISOString() }]
    : []
  if (o.reapableChildren) {
    jobs.push({ id: 'job_rc', objective: 'scheduled', cwd: dir, createdAt: NOW, schedule: { kind: 'interval', minutes: 60 } })
    childWorktrees().forEach((w, i) => {
      runs.push({ id: `run_rc${i}`, jobId: 'job_rc', ordinal: i + 1, createdAt: NOW, worktree: w })
      tasks.push(task({ id: `tsk_rc${i}`, runId: `run_rc${i}`, jobId: 'job_rc', status: 'completed' }))
    })
  }
  return { ...emptyState(), jobs, runs, tasks, dispatches, messages }
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
  if (o.openDispatchSpec) {
    await fs.mkdir(specsDir, { recursive: true })
    await fs.writeFile(path.join(specsDir, 'dsp_live.md'), 'the spec a live worker reads', 'utf8')
  }

  const server = { app: false, keeps: false }
  const coordinator = { busy: false as boolean | null }
  const typed: Array<[string, string]> = []
  const typeInto = vi.fn((id: string, text: string) => {
    typed.push([id, text])
    return true
  })
  /** While set, every settings read waits in `heldReads` until the test releases it. */
  const gateReads = { hold: false }
  const heldReads: Array<() => void> = []
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
    aliveSessionIds: () =>
      new Set([...(o.openRepairWithoutSpec ? ['pending:rep'] : []), ...(o.openDispatchSpec ? ['ses_live'] : []), ...(o.sleepingCoordinator ? ['coord-1'] : [])]),
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
  /** Runs inside drainOnce, before the real one: what the world does while the drain is on disk. */
  const drainHook = { during: (): void => {} }
  const drainOnce = vi.fn(async () => {
    drainHook.during()
    return orch.drainOnce()
  })
  const handled: string[] = []
  const handle = vi.fn((cmd: string, args: Record<string, unknown>) => {
    handled.push(cmd)
    return orch.handle(cmd, args)
  })
  const resumeSweep = vi.fn()
  /** HostChecks.stopForeignValidations (Task 14 round 2): resolves at once unless a test holds it. */
  const foreign = { hold: null as Promise<number> | null }
  const stopForeignValidations = vi.fn(() => foreign.hold ?? Promise.resolve(0))
  const startRepair = vi.fn()
  /** HostChecks.checking: the Tasks this Host's checks hold (a queued or running validation, a review
   *  start in flight, or a foreign validation run still alive in its folder). */
  const checkingIds = new Set<string>()
  const checking = vi.fn((id: string) => checkingIds.has(id))
  let langNow: Lang = 'en'
  const lang = vi.fn(async () => {
    if (o.langOnRead) langNow = o.langOnRead
    return langNow
  })
  let gateFailure: Error | null = null
  let tickFn: (() => void) | null = null
  let everyMs: number | null = null
  const clock = { now: NOW_MS }
  /** What the profile's app.pid names now (liveAppPid): null for none. */
  const appPid = { value: null as number | null }
  /** While `hold` is set, the app-left grace waits in `pending` until `fireGrace`. */
  const grace = { hold: false, pending: [] as Array<{ ms: number; fn: () => void; cancelled: boolean }> }
  const reaped: string[] = []
  const reapHook = { onReap: (_p: string): void => {} }
  const driving = createHostDriving({
    profileDir: dir,
    orch: { handle, internalDeps: () => orch.internalDeps(), loaded: () => orch.loaded(), drainOnce, state: () => orch.state() },
    server: { hasApp: () => server.app, appsKeep: () => server.keeps },
    spawner: { sessionBusy: (id) => (id === 'coord-1' ? coordinator.busy : null), typeInto, isRetiring: () => spawner.retiring, inFlight: () => spawner.inFlightCount },
    worktrees: {
      fork: async () => wt,
      integrate: async () => ({ kind: 'merged', uncommitted: 0 }),
      reap: async (p) => {
        reaped.push(p)
        reapHook.onReap(p)
        return true
      },
      isRegistered: (p) => childWorktrees().includes(p)
    },
    checks: { resumeSweep, stopForeignValidations, checking, accounts: async () => [ACCOUNT], loginStatus: async () => true, langNow: () => langNow, lang },
    startRepair,
    registry: {
      sessionPty: (id) => (o.sleepingCoordinator && id === 'coord-1' ? 'pty-coord' : null),
      list: () =>
        o.openDispatchSpec ? [{ id: 'pty-live', pid: 1, alive: true, meta: { kind: 'session', id: 'ses_live', restore: {} } }] : []
    },
    specsDir,
    log: (m) => logs.push(m),
    nowMs: () => clock.now,
    appPid: () => appPid.value,
    ...(o.refuseGates
      ? { interruptStalled: (st: OrchState) => ({ state: st, interrupted: null, resume: null, stuck: true }) }
      : {}),
    // The app-left grace: runs at once (the next macrotask) unless a test holds it to fire by hand.
    after: (ms, fn) => {
      const entry = { ms, fn, cancelled: false }
      if (grace.hold) grace.pending.push(entry)
      else setTimeout(() => {
        if (!entry.cancelled) fn()
      }, 0)
      return () => {
        entry.cancelled = true
      }
    },
    every: (ms, fn) => {
      everyMs = ms
      tickFn = fn
      return () => {
        tickFn = null
      }
    },
    readGate: async (p): Promise<DispatchGate> => {
      if (gateReads.hold) await new Promise<void>((r) => heldReads.push(r))
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
    local,
    server,
    spawner,
    logs,
    resumeSweep,
    stopForeignValidations,
    foreign,
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
    grace,
    appPid,
    /** Fires every held grace that was not cancelled; answers how many it fired. */
    fireGrace: (): number => {
      const live = grace.pending.splice(0).filter((e) => !e.cancelled)
      for (const e of live) e.fn()
      return live.length
    },
    tickFn: () => tickFn,
    repairDispatchId: 'dsp_rep',
    reaped: () => reaped,
    drainHook,
    coordinator,
    typed: () => typed,
    gateReads,
    /** Releases the i-th held settings read (in the order they were asked). */
    releaseRead: (i: number) => heldReads[i](),
    heldReads: () => heldReads.length,
    liveSpecPath: path.join(specsDir, 'dsp_live.md'),
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
    checkingIds,
    /** A non-convergence Task left `validating` or `reviewing` after the load, its implementation
     *  Dispatch reported and closed: what a closed app's check, or a forwarded start nobody ran, leaves. */
    putStalled: async (id: string, status: 'validating' | 'reviewing'): Promise<void> => {
      const s = orch.state()
      await orch.internalDeps().setState({
        ...s,
        tasks: [...s.tasks, task({ id, status })],
        dispatches: [...s.dispatches, dispatch({ id: `dsp_${id}`, taskId: id, outcome: 'succeeded', endedAt: NOW, workerState: 'stopped' })]
      })
    },
    statusOf: (id: string) => orch.state().tasks.find((t) => t.id === id)?.status,
    touch: async (id: string): Promise<void> => {
      const s = orch.state()
      await orch.internalDeps().setState({ ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, updatedAt: '2026-09-25T00:00:09.000Z' } : t)) })
    },
    gates: () => openGates(),
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
  // R5 (replaces D2's "only with an app attached"): the process that drives fires, app or no app.
  it('fires schedules on a tick while it drives, with no app attached, and only arms on the first tick (R5, R17)', async () => {
    const h = await rig({ scheduledJob: true })
    await h.load()
    expect(h.driving.status()).toEqual({ driver: 'host', appAttached: false })
    await h.tickNow()
    expect(h.handled()).not.toContain('run-spawn') // the first tick arms
    h.clock += 61_000
    await h.tickNow()
    expect(h.handled().filter((c) => c === 'run-spawn')).toHaveLength(1)
    // An app attaching that yields changes nothing: the Host still drives, and still fires.
    h.server.app = true
    h.driving.appsChanged()
    h.clock += 61_000
    await h.tickNow()
    expect(h.handled().filter((c) => c === 'run-spawn')).toHaveLength(2)
  })

  // U1 with no app (R5): the fired Run starts headless, the way `jobs run` starts one.
  it('with no app, places the fired Run of an old on-disk scheduled Job that has no coordinator account (U1, R2)', async () => {
    const h = await rig({ scheduledJob: true, scheduledTask: true })
    await h.load()
    await h.tickNow()
    h.clock += 61_000
    await h.tickNow()
    const child = h.orch.state().runs.find((r) => r.jobId === 'job_sched')!
    // The fire's placement is the tick's own kick, run fire-and-forget (driving.ts's `kick`): under
    // load a fixed settle() is not always enough for it to land, so this waits for it instead. Waits
    // on the startWorker call itself, not the Task's status: openDispatch commits 'dispatched' before
    // startWorker is even called (command.ts), so status alone would resolve one microtask early.
    await vi.waitFor(() => expect(h.local.startWorker).toHaveBeenCalled())
    const copy = h.orch.state().tasks.find((t) => t.runId === child.id)!
    expect(h.local.startWorker).toHaveBeenCalledWith(expect.objectContaining({ taskId: copy.id }))
    expect(copy.status).toBe('dispatched')
    expect(h.local.startCoordinator).not.toHaveBeenCalled()
  })

  it('with no app, starts the fired Run’s own coordinator when the Job has a coordinator account (U1)', async () => {
    const h = await rig({ scheduledJob: true, scheduledTask: true, scheduledCoordinator: 'accA' })
    await h.load()
    await h.tickNow()
    h.clock += 61_000
    await h.tickNow()
    await h.settle()
    const child = h.orch.state().runs.find((r) => r.jobId === 'job_sched')!
    expect(h.local.startCoordinator).toHaveBeenCalledTimes(1)
    expect(h.local.startCoordinator).toHaveBeenCalledWith(expect.objectContaining({ runId: child.id, accountId: 'accA' }))
    expect(child.coordinatorSessionId).toBe('ses_coord')
    // One driver per Run: the loop places nothing of it.
    const copy = h.orch.state().tasks.find((t) => t.runId === child.id)!
    expect(copy.status).toBe('ready')
  })

  // The other half of "never both" is the app's timer, which only arms while a Host that announced
  // dispatch is connected (appTimerTick, src/main/orchestration/yieldDispatch.test.ts). This is the
  // Host's half: it fires exactly while it drives, and not while an attached app keeps dispatch, which is
  // exactly when that app's own timer fires. Across the three cases one due time fires one run.
  it('fires one run per due time whoever is attached: never beside an app that keeps dispatch (R5)', async () => {
    const h = await rig({ scheduledJob: true })
    await h.load()
    /** What the app's own timer fires: only an app that keeps dispatch drives, and so fires. */
    let appFires = 0
    const due = async (): Promise<void> => {
      h.clock += 61_000
      await h.tickNow()
      if (h.server.app && h.server.keeps) appFires++
    }
    const total = (): number => h.handled().filter((c) => c === 'run-spawn').length + appFires
    await h.tickNow() // arms
    await due() // no app
    expect(total()).toBe(1)
    h.server.app = true // a yielding app
    h.driving.appsChanged()
    await due()
    expect(total()).toBe(2)
    h.server.keeps = true // an app that keeps dispatch
    h.driving.appsChanged()
    await due()
    expect(h.handled().filter((c) => c === 'run-spawn')).toHaveLength(2)
    expect(total()).toBe(3)
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
    expect(h.reaped()).toEqual([childWorktrees()[0]])
    expect(h.logs.join('\n')).toMatch(/left for the process that drives now/)
  })
  it('reaps every finished child worktree while it keeps the drive', async () => {
    const h = await rig({ reapableChildren: true })
    await h.load()
    await vi.waitFor(() => expect([...new Set(h.reaped())].sort()).toEqual([...childWorktrees()].sort()))
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

// Review of Task 12 (review-task-12.md), the fix round.
describe('createHostDriving — review round 1', () => {
  // I1: the gate starts unread, and an unread gate parks unless an app keeps dispatch (N2, §4.6).
  it('keeps a parked profile parked when a yielding app says hello before the first settings read (I1)', async () => {
    const h = await rig({ readyTasks: 1, settings: { orchestrationEnabled: false } })
    h.server.app = true // a new app: attached, yields dispatch
    h.driving.appsChanged()
    expect(h.driving.drives()).toBe(false)
    expect(h.driving.status().driver).toBe('parked')
    await h.settle()
    expect(h.driving.drives()).toBe(false)
  })
  it('still answers app at once for an app that keeps dispatch, before any read (I1)', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.app = true
    h.server.keeps = true
    h.driving.appsChanged()
    expect(h.driving.status().driver).toBe('app')
  })
  // I1, second half: a superseded driver() answers from its own read, never from `last`.
  it('never hands the load’s drain check a host it did not read (I1)', async () => {
    const h = await rig({ readyTasks: 0, queuedReport: true })
    await h.tickNow() // gate read once: migrated, before any load
    await h.writeSettings({ orchAlwaysOnMigrated: false }) // now the profile is parked
    h.gateReads.hold = true
    const loading = h.orch.call({ cmd: 'jobs-list', args: {}, sessionId: '' }) // the load asks mayDrain → driver()
    await vi.waitFor(() => expect(h.heldReads()).toBe(1))
    h.driving.appsChanged() // a yielding app's hello: last = host from the gate read before, then a kick reads again
    await vi.waitFor(() => expect(h.heldReads()).toBe(2))
    h.gateReads.hold = false
    h.releaseRead(0) // the load's read finishes first, superseded by the kick's
    await loading
    h.releaseRead(1)
    await h.settle()
    expect(await h.queuedReports()).toHaveLength(1)
    expect(h.driving.status().driver).toBe('parked')
  })
  // I2: the handover asks again after its drain.
  it('runs no resume sweep when an app that keeps dispatch attaches during the handover’s drain (I2)', async () => {
    const h = await rig({ readyTasks: 1 })
    h.server.keeps = true
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    h.drainHook.during = () => {
      h.server.keeps = true
      h.server.app = true
      h.driving.appsChanged()
    }
    h.server.keeps = false
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.drainOnce).toHaveBeenCalledTimes(1))
    await h.settle()
    expect(h.resumeSweep).not.toHaveBeenCalled()
    expect(h.workerStarts()).toBe(0)
  })
  it('starts no repair, so opens no Gate, when the Host starts retiring during the handover’s drain (I2, R15)', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.server.keeps = true
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    h.drainHook.during = () => {
      h.spawner.retiring = true
    }
    h.server.keeps = false
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.drainOnce).toHaveBeenCalledTimes(1))
    await h.settle()
    expect(h.startRepair).not.toHaveBeenCalled()
    expect(h.resumeSweep).not.toHaveBeenCalled()
    expect(h.orch.state().gates).toEqual([])
  })
  // I3/M1: every change back to host hands over again.
  it('hands over again after a host → app → host flap: a second sweep and a second belt start (I3)', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    await h.load()
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledTimes(1))
    expect(h.resumeSweep).toHaveBeenCalledTimes(1)
    h.server.keeps = true
    h.server.app = true
    h.driving.appsChanged() // an old app attaches
    h.server.keeps = false
    h.server.app = false
    h.driving.appsChanged() // and leaves
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledTimes(2))
    expect(h.resumeSweep).toHaveBeenCalledTimes(2)
  })
  // Task 14 review I3: a yielding app leaving does not change the driver, so no handover runs; the
  // validation or review that app was running itself (recovery, D8) would then never be re-driven.
  it('runs the resume sweep once when a yielding app leaves while the Host drives (Task 14 I3)', async () => {
    const h = await rig({ readyTasks: 0 })
    await h.load()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(1))
    h.server.app = true // a new app attaches and yields: the driver stays host
    h.driving.appsChanged()
    await h.settle()
    expect(h.resumeSweep).toHaveBeenCalledTimes(1)
    h.server.app = false // and leaves
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(2))
    expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left')
    await h.settle()
    expect(h.resumeSweep).toHaveBeenCalledTimes(2)
  })
  // Task 14 round 2: the app's own validation run may still be live in this Host's registry, and the
  // sweep would start a second check in the same folder beside it. The foreign runs are killed, and
  // their exits awaited, before the sweep.
  it('kills the app’s leftover validation runs and waits for them before the sweep (Task 14 round 2)', async () => {
    const h = await rig({ readyTasks: 0 })
    await h.load()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(1))
    h.server.app = true
    h.driving.appsChanged()
    await h.settle()
    expect(h.stopForeignValidations).toHaveBeenCalledTimes(1) // the load's handover, with no app attached (final review I2)
    let release: (n: number) => void = () => {}
    h.foreign.hold = new Promise<number>((r) => {
      release = r
    })
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.stopForeignValidations).toHaveBeenCalledTimes(2))
    await h.settle()
    expect(h.resumeSweep).toHaveBeenCalledTimes(1)
    release(1)
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(2))
    expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left')
  })
  it('kills nothing when an app is attached again by the time the sweep runs (Task 14 round 2)', async () => {
    const h = await rig({ readyTasks: 0 })
    h.appPid.value = 4242 // the same app, by app.pid (the tidy's review)
    await h.load()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(1))
    h.server.app = true
    h.driving.appsChanged()
    await h.settle()
    h.server.app = false
    h.driving.appsChanged()
    h.server.app = true // back within the same turn, before the chained sweep runs
    await h.settle()
    expect(h.stopForeignValidations).toHaveBeenCalledTimes(1) // the load's handover only
  })
  it('runs no such sweep when the Host is retiring as the app leaves (Task 14 I3)', async () => {
    const h = await rig({ readyTasks: 0 })
    await h.load()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(1))
    h.server.app = true
    h.driving.appsChanged()
    await h.settle()
    h.spawner.retiring = true
    h.server.app = false
    h.driving.appsChanged()
    await h.settle()
    expect(h.resumeSweep).toHaveBeenCalledTimes(1)
  })

  // I3/M2: before a load the state in memory is empty, and a sweep over it would take every spec.
  it('a tick before any load deletes no spec file, not even one a live worker reads (I3)', async () => {
    const h = await rig({ openDispatchSpec: true })
    await h.tickNow()
    expect(h.orch.loaded()).toBe(false)
    expect(existsSync(h.liveSpecPath)).toBe(true)
    await h.load()
    await h.tickNow()
    expect(existsSync(h.liveSpecPath)).toBe(true) // loaded: its Dispatch is open, so it is kept
  })
  // I3/M3: the tick nudges a sleeping coordinator through the Host's registry and spawner.
  it('the tick types into a sleeping coordinator’s live pty, and leaves a busy one alone (I3)', async () => {
    const h = await rig({ sleepingCoordinator: true })
    await h.load()
    h.coordinator.busy = true
    await h.tickNow()
    expect(h.typed()).toEqual([])
    h.coordinator.busy = false
    await h.tickNow()
    expect(h.typed().map(([id]) => id)).toEqual(['coord-1', 'coord-1'])
    expect(h.typed()[0][1]).toMatch(/unread message/)
  })
})

// The final review of S4+S5, I2: the handover after an older app leaves runs the resume sweep, and that
// app's validation run may still be live in this Host's registry.
describe('createHostDriving — the handover stops a gone app’s checks (final review I2)', () => {
  // I2: an older app's validation run is a pty in this Host's registry and outlives it. The handover's
  // sweep must not start a second check beside it.
  it('kills an older app’s leftover validation runs and waits for them before the handover’s sweep (I2)', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.keeps = true
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    let release: (n: number) => void = () => {}
    h.foreign.hold = new Promise<number>((r) => {
      release = r
    })
    h.server.keeps = false
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.stopForeignValidations).toHaveBeenCalledTimes(1))
    await h.settle()
    expect(h.resumeSweep).not.toHaveBeenCalled()
    release(1)
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(1))
  })

  it('kills nothing at a handover with an app still attached (I2)', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.keeps = true
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    h.server.keeps = false // the old app left, a new one that yields stays
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(1))
    expect(h.stopForeignValidations).not.toHaveBeenCalled()
  })
})

describe('createHostDriving — a yielding app leaving (final review M1)', () => {
  // M1: a repair an app opened and never started is stranded when that app, yielding, leaves.
  it('starts an open repair Dispatch that has no spec yet when a yielding app leaves (M1)', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    expect(h.startRepair).not.toHaveBeenCalled()
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledWith({ dispatchId: h.repairDispatchId }))
    expect(h.startRepair).toHaveBeenCalledTimes(1)
  })
})

// The final review of S4+S5, I1: a non-convergence Task left validating or reviewing with nothing
// checking it is stuck for good (its Run counts as running, so the Host never idles and `host stop`
// refuses). The Host opens the load's own restart Gate for it, armed at the handover and when an app
// leaves, and confirmed on a tick at least STALL_CONFIRM_MS later with the Task unchanged and still
// held by no check: the Host's own worker_done may be between its commit and its check's start.
describe('createHostDriving — a Task nobody is checking (final review I1)', () => {
  it('gates a Task an older app left validating, on a tick after the handover, with the load’s question', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.keeps = true
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.putStalled('tsk_v', 'validating')
    await h.settle()
    h.server.keeps = false
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalled())
    await h.settle()
    await h.tickNow()
    expect(h.gates()).toHaveLength(0) // armed, not yet confirmed
    h.clock = NOW_MS + 6_000
    await h.tickNow()
    expect(h.statusOf('tsk_v')).toBe('blocked')
    expect(h.gates()).toHaveLength(1)
    expect(h.openGateQuestion()).toMatch(/검증이 중단되었습니다/)
    await h.tickNow()
    expect(h.gates()).toHaveLength(1) // once
  })

  it('gates a Task left reviewing when a yielding app leaves (the app-left path)', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.app = true // yields: the Host drives
    await h.load()
    h.driving.appsChanged()
    await h.putStalled('tsk_r', 'reviewing')
    await h.settle()
    h.clock = NOW_MS + 6_000
    await h.tickNow()
    expect(h.gates()).toHaveLength(0) // nothing armed while an app is attached
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left'))
    await h.settle()
    h.clock = NOW_MS + 12_000
    await h.tickNow()
    expect(h.statusOf('tsk_r')).toBe('blocked')
    expect(h.openGateQuestion()).toMatch(/검토가 중단되었습니다/)
  })

  it('never gates a Task this Host is checking', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.putStalled('tsk_v', 'validating')
    h.checkingIds.add('tsk_v')
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left'))
    await h.settle()
    h.clock = NOW_MS + 6_000
    await h.tickNow()
    expect(h.statusOf('tsk_v')).toBe('validating')
    expect(h.gates()).toHaveLength(0)
  })

  it('does not gate a Task that moved between the arming and the tick, nor one a check took up meanwhile', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.putStalled('tsk_a', 'validating')
    await h.putStalled('tsk_b', 'validating')
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left'))
    await h.settle()
    await h.touch('tsk_a')
    h.checkingIds.add('tsk_b')
    h.clock = NOW_MS + 6_000
    await h.tickNow()
    expect(h.gates()).toHaveLength(0)
  })

  it('gates nothing once an app is attached again before the tick', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.putStalled('tsk_v', 'validating')
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left'))
    await h.settle()
    h.server.app = true
    h.driving.appsChanged()
    await h.settle()
    h.clock = NOW_MS + 6_000
    await h.tickNow()
    expect(h.gates()).toHaveLength(0)
  })
})

// S4+S5 tidy, item 1 (re-review R-m3 a): a tick that briefly finds the Host not driving clears every
// armed Task. The arming is redone on each later tick that may start work with no app attached, so the
// Task is still gated, and still only after STALL_CONFIRM_MS unchanged.
describe('createHostDriving — the restart Gate is armed again on a driving tick (S4+S5 tidy)', () => {
  it('re-arms a Task after a tick that found the Host not driving, and gates it a confirmed tick later', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.putStalled('tsk_v', 'validating')
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left'))
    await h.settle()
    h.spawner.retiring = true // a tick that does not drive: the armed Task is dropped
    h.clock = NOW_MS + 6_000
    await h.tickNow()
    expect(h.gates()).toHaveLength(0)
    h.spawner.retiring = false
    h.clock = NOW_MS + 7_000
    await h.tickNow() // armed again here
    expect(h.gates()).toHaveLength(0)
    h.clock = NOW_MS + 11_000 // 4 s on: not yet
    await h.tickNow()
    expect(h.gates()).toHaveLength(0)
    h.clock = NOW_MS + 12_500
    await h.tickNow()
    expect(h.statusOf('tsk_v')).toBe('blocked')
    expect(h.gates()).toHaveLength(1)
  })

  it('arms a Task that stalls while the Host drives with no drive change at all', async () => {
    const h = await rig({ readyTasks: 0 })
    await h.load()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(1))
    await h.putStalled('tsk_r', 'reviewing') // after the handover's arming
    await h.settle()
    await h.tickNow()
    expect(h.gates()).toHaveLength(0)
    h.clock = NOW_MS + 6_000
    await h.tickNow()
    expect(h.statusOf('tsk_r')).toBe('blocked')
  })

  it('arms nothing on a tick with an app attached', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.putStalled('tsk_v', 'validating')
    await h.settle()
    await h.tickNow()
    h.clock = NOW_MS + 6_000
    await h.tickNow()
    h.clock = NOW_MS + 12_000
    await h.tickNow()
    expect(h.statusOf('tsk_v')).toBe('validating')
    expect(h.gates()).toHaveLength(0)
  })

  // Item 2 (re-review R-m3 b): a gone app's validation run that survives its kill holds its Task, so
  // nothing is armed at the app leaving. Once the run exits, the next driving tick arms it.
  it('arms a Task once the foreign run that held it has gone, and gates it a confirmed tick later', async () => {
    const h = await rig({ readyTasks: 0 })
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.putStalled('tsk_v', 'validating')
    h.checkingIds.add('tsk_v') // the foreign run in its folder is still alive
    h.server.app = false
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left'))
    await h.settle()
    h.clock = NOW_MS + 6_000
    await h.tickNow()
    expect(h.gates()).toHaveLength(0)
    h.checkingIds.delete('tsk_v') // it exits
    h.clock = NOW_MS + 7_000
    await h.tickNow()
    expect(h.gates()).toHaveLength(0)
    h.clock = NOW_MS + 13_000
    await h.tickNow()
    expect(h.statusOf('tsk_v')).toBe('blocked')
  })
})

// S4+S5 tidy, item 3 (re-review R-m4): a socket that drops while its app lives reads as that app
// leaving. The Host waits APP_LEFT_GRACE_MS before it takes up what the app left, so a person's
// retry-once the app was starting is not started a second time by the belt.
describe('createHostDriving — the app-left grace (S4+S5 tidy)', () => {
  it('starts no repair, kills nothing and sweeps nothing when the same app is back within the grace', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.appPid.value = 4242 // app.pid names the live app, before and after the drop
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    const sweepsBefore = h.resumeSweep.mock.calls.length // the load's handover swept once
    h.grace.hold = true
    h.server.app = false // the socket drops
    h.driving.appsChanged()
    await h.settle()
    expect(h.grace.pending.map((e) => e.ms)).toEqual([APP_LEFT_GRACE_MS])
    h.server.app = true // and the same app reconnects
    h.driving.appsChanged()
    expect(h.fireGrace()).toBe(0)
    await h.settle()
    expect(h.startRepair).not.toHaveBeenCalled()
    expect(h.stopForeignValidations).not.toHaveBeenCalled()
    expect(h.resumeSweep).toHaveBeenCalledTimes(sweepsBefore)
  })

  it('takes up what a really gone app left once the grace has passed', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    h.grace.hold = true
    h.server.app = false
    h.driving.appsChanged()
    await h.settle()
    expect(h.startRepair).not.toHaveBeenCalled() // not before the grace
    expect(h.fireGrace()).toBe(1)
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledWith({ dispatchId: h.repairDispatchId }))
    expect(h.startRepair).toHaveBeenCalledTimes(1)
    expect(h.stopForeignValidations).toHaveBeenCalledTimes(1)
    expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left')
  })

  // Review of the tidy, Important: `system.relaunch` quits and starts a new instance at once. The new
  // one yields, so it skips its own resume sweep; the gone instance's steps must still run.
  it('runs the gone app’s steps once when a new instance (another pid) attaches within the grace', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.appPid.value = 4242
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    const sweepsBefore = h.resumeSweep.mock.calls.length
    h.grace.hold = true
    h.server.app = false // the old instance quits
    h.appPid.value = null
    h.driving.appsChanged()
    await h.settle()
    h.appPid.value = 5151 // the relaunched instance
    h.server.app = true
    h.driving.appsChanged()
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledWith({ dispatchId: h.repairDispatchId }))
    expect(h.stopForeignValidations).toHaveBeenCalledTimes(1)
    expect(h.stopForeignValidations).toHaveBeenCalledWith({ startedBefore: NOW_MS })
    expect(h.resumeSweep).toHaveBeenCalledTimes(sweepsBefore + 1)
    expect(h.fireGrace()).toBe(0) // decided at the attach, not again at the grace's end
    await h.settle()
    expect(h.startRepair).toHaveBeenCalledTimes(1)
  })

  it('runs the steps after the grace when the app really quit (app.pid gone), and not before', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.appPid.value = 4242
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    h.grace.hold = true
    h.server.app = false
    h.appPid.value = null
    h.driving.appsChanged()
    await h.settle()
    expect(h.startRepair).not.toHaveBeenCalled()
    expect(h.fireGrace()).toBe(1)
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledTimes(1))
    expect(h.stopForeignValidations).toHaveBeenCalledWith()
  })

  it('leaves the steps to a same-pid app whose socket stays down past the grace', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.appPid.value = 4242
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    h.grace.hold = true
    h.server.app = false
    h.driving.appsChanged()
    await h.settle()
    expect(h.fireGrace()).toBe(1)
    await h.settle()
    expect(h.startRepair).not.toHaveBeenCalled()
    expect(h.stopForeignValidations).not.toHaveBeenCalled()
  })

  // Last round (a): a same-pid app that stays detached past the grace and then quits without
  // reconnecting. Its kept steps run on the next tick with no app attached once app.pid no longer
  // names it.
  it('runs the kept steps once on a no-app tick after the kept app has gone without reconnecting', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.appPid.value = 4242
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    h.grace.hold = true
    h.server.app = false
    h.driving.appsChanged()
    await h.settle()
    expect(h.fireGrace()).toBe(1) // same pid: kept
    await h.tickNow()
    await h.settle()
    expect(h.startRepair).not.toHaveBeenCalled()
    h.appPid.value = null // it quits
    await h.tickNow()
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledTimes(1))
    expect(h.stopForeignValidations).toHaveBeenCalledTimes(1)
    expect(h.stopForeignValidations).toHaveBeenCalledWith()
    expect(h.resumeSweep).toHaveBeenLastCalledWith('an app left')
    await h.tickNow()
    await h.settle()
    expect(h.startRepair).toHaveBeenCalledTimes(1) // once
    expect(h.stopForeignValidations).toHaveBeenCalledTimes(1)
  })

  it('drops the kept steps when that same app reconnects later', async () => {
    const h = await rig({ openRepairWithoutSpec: true })
    h.appPid.value = 4242
    h.server.app = true
    await h.load()
    h.driving.appsChanged()
    await h.settle()
    h.grace.hold = true
    h.server.app = false
    h.driving.appsChanged()
    await h.settle()
    expect(h.fireGrace()).toBe(1)
    h.server.app = true // the same app, back after the grace
    h.driving.appsChanged()
    await h.settle()
    h.server.app = false // it quits for good; its own leave is decided afresh
    h.appPid.value = null
    h.driving.appsChanged()
    await h.settle()
    expect(h.fireGrace()).toBe(1)
    await vi.waitFor(() => expect(h.startRepair).toHaveBeenCalledTimes(1))
    await h.tickNow()
    await h.settle()
    expect(h.startRepair).toHaveBeenCalledTimes(1)
  })

  // Review minor: a Task armed before an app attached must not be gated inside a later grace.
  it('drops the arming when an app attaches, so a later grace gates nothing armed before it', async () => {
    const h = await rig({ readyTasks: 0 })
    await h.load()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(1))
    await h.putStalled('tsk_v', 'validating')
    await h.tickNow() // armed at NOW
    h.server.app = true
    h.driving.appsChanged()
    await h.settle()
    h.grace.hold = true
    h.server.app = false
    h.driving.appsChanged()
    await h.settle()
    h.clock = NOW_MS + 6_000 // past STALL_CONFIRM_MS since that arming, inside the grace
    await h.tickNow()
    expect(h.statusOf('tsk_v')).toBe('validating')
    expect(h.gates()).toHaveLength(0)
  })
})

// Review minor: a refused restart Gate is remembered, so it is not asked and logged on every tick.
describe('createHostDriving — a refused restart Gate (S4+S5 tidy)', () => {
  it('asks once for a Task whose Gate was refused, and again only once the Task changes', async () => {
    const h = await rig({ readyTasks: 0, refuseGates: true })
    await h.load()
    await vi.waitFor(() => expect(h.resumeSweep).toHaveBeenCalledTimes(1))
    await h.putStalled('tsk_v', 'validating')
    const refusals = () => h.logs.filter((m) => m.includes('task=tsk_v') && m.includes('was refused')).length
    await h.tickNow()
    for (const at of [6_000, 12_000, 18_000, 24_000]) {
      h.clock = NOW_MS + at
      await h.tickNow()
    }
    expect(refusals()).toBe(1)
    await h.touch('tsk_v')
    for (const at of [30_000, 36_000]) {
      h.clock = NOW_MS + at
      await h.tickNow()
    }
    expect(refusals()).toBe(2)
  })
})
