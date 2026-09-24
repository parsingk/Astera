// §9.3's two-process rig (S4+S5 design §9.3; plan R7, N11, B1, B5): the Host drives Jobs with no app.
//
// **The Host side is the one index.ts builds, through `composeHostDriving`** (N11), over a real
// `createHostOrch` on a temp profile (the real handleCommand, the real store, the real pending-report
// drain), a real `PtyRegistry` over a fake pty spawn (the checks' validation runs open there, and the
// test ends them), and a real `createHostWorktrees` over a temp profile and a temp git repo (so the loop's
// Run fork and a Task's own fork are real git worktrees whose paths the registry really lists — B5).
//
// **The other side is the app, as the F54 rig has it** (`commitHook.test.ts`): not a process, but what
// that process says. A legacy app is `state-get` and a `state-put` quoting the version it last saw; its
// attaching is the fake server's `app`/`keeps` flipped, followed by the server's `onAppsChanged` hook.
//
// The fakes are only what starts a process: the spawner's worker start (which records the call and
// registers a live session pty in the real registry, so `sessionAlive` and repair's same-session target
// see it), and the pty spawn itself. Nothing here launches an agent, a shell or a validation command.
//
// **Portable:** every path comes from `tempDir`/`path.join`, git runs through the S3 fixtures, and every
// wait is a bounded `vi.waitFor` or a quiescence check — no fixed sleep decides an assertion.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeHostDriving, type HostDrivingWiring } from './drivingWiring'
import { createHostOrch, type HostOrch } from './orch'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry } from './procRegistry'
import { createHostWorktrees } from './worktrees'
import type { HostLocal, HostSpawner } from './spawner'
import { makeRepo, gitSync, tempDir } from '../core/worktrees/testRepo'
import { readDispatchGate } from '../core/host/driver'
import { HostRetiring } from '../core/host/hostRetiring'
import { refusedBeforeActing, type OrchCaller } from '../core/host/orchProtocol'
import { openDispatch, type OrchState } from '../core/orchestration/state'
import { outcomeOf } from '../core/orchestration/view'
import type { Provider } from '../core/types'

const NOW = '2026-09-25T00:00:00.000Z'
/** Every wait is bounded: long enough for real git on a loaded Windows runner, short enough to fail. */
const WAIT = { timeout: 20_000, interval: 20 }
const until = <T>(fn: () => T | Promise<T>): Promise<T> => vi.waitFor(fn, WAIT)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

interface RigOpts {
  tasks: number
  /** Each Task after the first depends on the one before it. */
  chained?: boolean
  concurrency?: number
  /** The run configurations every Task validates with. */
  validate?: string[]
  /** package.json's `test` script, committed in the repo (never run: the pty spawn is fake). */
  testScript?: string
  convergence?: { maxFixAttempts?: number }
  /** Every Task asks for a review by another provider. */
  review?: boolean
  /** The accounts' providers, in order; the Tasks run on the first. */
  accounts?: Provider[]
  /** B1: the checks' first loginStatus call runs `spawner.closeAndSettle(0)` before answering. */
  retireOnFirstLoginCheck?: boolean
  /** B1: the first worktree fork (the loop's Run fork, inside a slot) does the same before it forks. */
  retireOnFirstFork?: boolean
}

interface Spawn {
  dispatchId: string
  taskId: string
  sessionId: string
  provider: Provider
  accountId: string
  worktree: string
  terminal?: string
  cwd: string
  specPath: string
}

type FakePty = RegistryPty & { exit(code: number): void }

async function rig(o: RigOpts) {
  const profileDir = await tempDir('astera-hostdrive-profile-')
  const home = await tempDir('astera-hostdrive-home-')
  const repo = await makeRepo('astera-hostdrive-repo-')
  cleanups.push(async () => {
    for (const d of [profileDir, home, repo]) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  // The seed run configuration `seed:npm:test` comes from the project's package.json, and every worktree
  // is a checkout of the repo, so it is committed.
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'rig', scripts: { test: o.testScript ?? 'node -e "process.exit(0)"' } }))
  gitSync(repo, ['add', 'package.json'])
  gitSync(repo, ['commit', '-m', 'package.json'])

  // The profile: the migration marker (the Host may drive, F62), a worktrees root of the test's own, and
  // accounts logged in by their providers' own markers (C8's one login rule, read for real).
  await fs.writeFile(path.join(profileDir, 'app-settings.json'), JSON.stringify({ orchAlwaysOnMigrated: true }))
  await fs.writeFile(path.join(profileDir, 'worktrees.json'), JSON.stringify({ root: path.join(home, 'wt'), items: [] }))
  const providers = o.accounts ?? ['claude']
  const accounts = await Promise.all(
    providers.map(async (provider, i) => {
      const id = `acc_${provider}_${i}`
      const configDir = path.join(home, 'cfg', id)
      await fs.mkdir(configDir, { recursive: true })
      await fs.writeFile(path.join(configDir, provider === 'codex' ? 'auth.json' : '.credentials.json'), '{}')
      return { id, label: id, configDir, color: '#888', createdAt: NOW, provider }
    })
  )
  await fs.writeFile(path.join(profileDir, 'accounts.json'), JSON.stringify({ accounts }))

  const logs: string[] = []
  const log = (m: string): void => {
    logs.push(m)
  }
  /** How many of the driver's awaits are under way right now — its settings reads, its commands, its
   *  git and its worker starts. `settle` waits for none, so a quiet stretch inside a slow git fork is
   *  not taken for a finished pass. */
  let busy = 0
  const track =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      busy += 1
      try {
        return await fn(...args)
      } finally {
        busy -= 1
      }
    }

  // The pty spawn: nothing runs. Each pty's pid is unique, so the registry's entries map back to it.
  const ptys = new Map<number, FakePty>()
  let nextPid = 7000
  const registry = new PtyRegistry({
    spawn: () => {
      let onExit: (e: { exitCode: number }) => void = () => {}
      const pty: FakePty = {
        pid: nextPid++,
        onData: () => {},
        onExit: (cb) => {
          onExit = cb
        },
        write() {},
        resize() {},
        kill: () => pty.exit(1),
        pause() {},
        resume() {},
        exit: (code) => onExit({ exitCode: code })
      }
      ptys.set(pty.pid, pty)
      return pty
    },
    log
  })
  const procs = new ProcRegistry({ spawn: () => ({ pid: 1, onData() {}, onExit() {}, write() {}, kill() {} }), log })

  /** The server: a legacy app attaching is `app` and `keeps` both true (an app with no `yields` keeps
   *  every duty, R1). */
  const server = {
    app: false,
    keeps: false,
    hasApp: () => server.app,
    appsKeep: (_duty: string) => server.app && server.keeps,
    broadcast: () => {}
  }
  const box: { orch: HostOrch | null; wiring: HostDrivingWiring | null } = { orch: null, wiring: null }
  const orchOf = (): HostOrch => box.orch!

  const worktrees = createHostWorktrees({
    profileDir,
    homeDir: home,
    ptys: registry,
    procs,
    getState: () => orchOf().state(),
    broadcast: () => {},
    log,
    app: { hasApp: () => server.app, act: async () => { throw new Error('the rig’s app answers no act') } },
    closeTimeoutMs: 500,
    pollMs: 10
  })
  await worktrees.load()
  worktrees.fork = track(worktrees.fork)
  worktrees.integrate = track(worktrees.integrate)
  worktrees.reap = track(worktrees.reap)

  // The spawner: records each start and opens its session pty in the real registry. Refuses once it has
  // started to retire, exactly as the real one does (refused before acting, so worker-start rolls back
  // and answers 409 with `retry`).
  const spawns: Spawn[] = []
  let retiring = false
  const local: HostLocal = {
    owns: () => true,
    startWorker: track(async (a: Parameters<HostLocal['startWorker']>[0]) => {
      if (retiring) throw refusedBeforeActing(new HostRetiring())
      const cwd =
        a.terminal !== undefined
          ? (a.terminalCwd ?? a.runCwd)
          : a.worktree === 'new'
            ? await worktrees.fork({ repoPath: a.runCwd, name: a.name ?? a.taskId })
            : a.worktree === 'current'
              ? a.runCwd
              : a.worktree
      const sessionId = a.terminal ?? `ses_${spawns.length + 1}`
      if (a.terminal === undefined) {
        const opened = registry.open({
          id: `pty_${sessionId}`,
          file: 'agent',
          args: [],
          opts: { cwd, cols: 80, rows: 24, env: {} },
          meta: { kind: 'session', id: sessionId, restore: {} }
        })
        if (!opened.ok) throw new Error(opened.error)
      }
      // The spec is written where the real spawner writes it (review of S4+S5, M7): the tick's sweep
      // meets the same files in the same folder, so a rule that deletes a live one fails here.
      const specPath = path.join(profileDir, 'orch', 'specs', `${a.dispatchId}.md`)
      await fs.mkdir(path.dirname(specPath), { recursive: true })
      await fs.writeFile(specPath, `the rig's spec for ${a.taskId}`)
      spawns.push({ dispatchId: a.dispatchId, taskId: a.taskId, sessionId, provider: a.provider, accountId: a.accountId, worktree: a.worktree, terminal: a.terminal, cwd, specPath })
      return { sessionId, cwd, specPath }
    }),
    startCoordinator: async () => ({ sessionId: 'ses_coord' }),
    releaseWorker: async () => {},
    readWorker: async () => '',
    probeLimit: async () => null,
    // The real spawner's body: a missing file is null, any other failure throws.
    readReviewFile: async (p) => {
      try {
        return await fs.readFile(p, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    makeRunWorktree: (a) => worktrees.makeRunWorktree(a),
    mergeWorktrees: (runCwd, paths) => worktrees.mergeWorktrees(runCwd, paths),
    removeWorktrees: (paths) => worktrees.removeWorktrees(paths)
  }
  const spawner = {
    ...local,
    inFlight: () => 0,
    closeAndSettle: async () => {
      retiring = true
    },
    trackedSessions: () => spawns.length,
    sessionBusy: () => null,
    typeInto: () => false,
    isRetiring: () => retiring
  } satisfies HostSpawner

  const wiring = composeHostDriving({
    profileDir,
    platform: process.platform,
    env: { PATH: process.env.PATH },
    registry,
    spawner,
    worktrees,
    orch: orchOf,
    server: () => server,
    log,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    // No tick: every pass here comes from a load, a commit or an app coming or going.
    every: () => () => {},
    readGate: track((p: string) => readDispatchGate(p))
  })
  box.wiring = wiring

  const orch = createHostOrch({
    profileDir,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => NOW,
    runningSessions: () => registry.liveCount(),
    aliveSessionIds: () => new Set(registry.list().filter((e) => e.alive && e.meta?.kind === 'session').map((e) => e.meta!.id)),
    act: async () => {
      throw new Error('the rig’s app answers no act')
    },
    hasApp: () => server.app,
    onState: () => {},
    log,
    sessions: {
      listSessions: async () => [],
      readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
      sendSession: async () => {},
      readChat: async () => [],
      sendChat: async () => {},
      serial: (_id, run) => run()
    },
    local: spawner,
    specsDir: path.join(profileDir, 'orch', 'specs'),
    worktrees,
    ...wiring.orchHooks
  })
  box.orch = orch
  const handle = orch.handle
  orch.handle = track((cmd: string, args: Record<string, unknown>) => handle(cmd, args))

  // B1's two moments: before the slot loop's per-slot check (the login lookup), and inside a slot (the
  // Run fork, which is after the check and before worker-start).
  if (o.retireOnFirstLoginCheck) {
    const real = wiring.checks.loginStatus
    let first = true
    wiring.checks.loginStatus = async (id) => {
      if (first) {
        first = false
        await spawner.closeAndSettle()
      }
      return real(id)
    }
  }
  if (o.retireOnFirstFork) {
    const real = worktrees.fork
    let first = true
    worktrees.fork = async (a) => {
      if (first) {
        first = false
        await spawner.closeAndSettle()
      }
      return real(a)
    }
  }

  const cliCaller: OrchCaller = { role: 'cli', toOthers: () => {} }
  const appCaller: OrchCaller = { role: 'app', toOthers: () => {} }
  const cli = (cmd: string, args: Record<string, unknown>, sessionId = '') => orch.call({ cmd, args, sessionId, from: cliCaller })
  const ok = async (cmd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await cli(cmd, args)
    if (r.status !== 200) throw new Error(`rig: ${cmd} answered ${r.status} ${JSON.stringify(r.body)}`)
    return r.body as Record<string, unknown>
  }

  // The Job and its definition Tasks, through the real commands.
  const job = await ok('jobs-create', {
    objective: 'the rig',
    cwd: repo,
    concurrency: o.concurrency ?? 1,
    ...(o.convergence ? { convergence: true, ...(o.convergence.maxFixAttempts ? { maxFixAttempts: o.convergence.maxFixAttempts } : {}) } : {})
  })
  const jobId = job.id as string
  let previous: string | null = null
  for (let i = 0; i < o.tasks; i++) {
    const task = await ok('tasks-add', {
      job: jobId,
      title: `task ${i + 1}`,
      spec: `do part ${i + 1}`,
      account: accounts[0].id,
      ...(o.chained && previous ? { deps: [previous] } : {}),
      ...(o.validate ? { validate: o.validate.join(',') } : {}),
      ...(o.review ? { review: true } : {})
    })
    previous = task.id as string
  }

  const state = (): OrchState => orch.state()
  const latestRunId = (): string => {
    const runs = state().runs.filter((r) => r.jobId === jobId).sort((a, b) => a.ordinal - b.ordinal)
    const run = runs.at(-1)
    if (!run) throw new Error('rig: the Job has no run yet')
    return run.id
  }
  const runPtys = () => registry.list().filter((e) => e.meta?.kind === 'run')

  /** The rig is quiet: nothing it can see has moved for a few turns in a row. For the assertions that
   *  something did **not** happen, where there is no event to wait for. Bounded like every wait. */
  const settle = async (): Promise<void> => {
    const mark = (): string => JSON.stringify([busy, logs.length, spawns.length, registry.list().length, state()])
    let last = mark()
    let still = 0
    await until(async () => {
      await new Promise((r) => setTimeout(r, 15))
      const now = mark()
      still = busy === 0 && now === last ? still + 1 : 0
      last = now
      expect(still).toBeGreaterThanOrEqual(8)
    })
  }

  // Teardown in `leave()`'s order (review of Task 13, m4): the driver stops, the spawner retires, the
  // ptys end, and whatever those exits start runs out before the folders are removed.
  cleanups.push(async () => {
    wiring.dispose()
    await spawner.closeAndSettle()
    registry.killAll()
    await settle().catch(() => {})
  })

  return {
    orch,
    wiring,
    registry,
    spawner,
    task: (id: string) => state().tasks.find((t) => t.id === id)!,
    /** The run's only Task (the rigs below that ask have one). */
    get onlyTaskId() {
      const tasks = state().tasks.filter((t) => t.runId === latestRunId())
      if (tasks.length !== 1) throw new Error(`rig: the run has ${tasks.length} Tasks`)
      return tasks[0].id
    },
    repairDispatches: () => state().dispatches.filter((d) => d.repair !== undefined),
    server,
    logs,
    jobId,
    repo,
    get runId() {
      return latestRunId()
    },
    /** The run's Task no Dispatch was opened for. */
    get secondTaskId() {
      const s = state()
      const t = s.tasks.find((x) => x.runId === latestRunId() && !s.dispatches.some((d) => d.taskId === x.id))
      if (!t) throw new Error('rig: every Task of the run has a Dispatch')
      return t.id
    },
    cli,
    spawns: () => spawns,
    settle,
    openGates: () => state().gates.filter((g) => g.status === 'open'),
    runOutcome: () => outcomeOf(state(), latestRunId()),
    runPtys,
    /** Ends the newest validation run's pty with this exit code. */
    exitRunPty: (code: number) => {
      const entry = runPtys().at(-1)
      if (!entry) throw new Error('rig: no run pty')
      ptys.get(entry.pid)!.exit(code)
    },
    /** The worker `s` reports, as its own `astera send` does. */
    workerReports: async (s: Spawn, outcome: 'succeeded' | 'failed') => {
      const r = await cli(
        'send',
        { type: 'worker_done', taskId: s.taskId, dispatchId: s.dispatchId, outcome, subject: 'done', body: 'the rig’s worker is done' },
        s.sessionId
      )
      if (r.status !== 200) throw new Error(`rig: worker_done answered ${r.status} ${JSON.stringify(r.body)}`)
    },
    /** A legacy app's mirror: the state and the version it fills itself with. */
    appStateGet: async (): Promise<{ state: OrchState; version: number }> => {
      const r = await orch.call({ cmd: 'state-get', args: {}, sessionId: '', from: appCaller })
      return r.body as { state: OrchState; version: number }
    },
    /** A legacy app's own dispatch: openDispatch on its mirror, then `state-put` quoting that mirror's
     *  version — what an app from before S4 does with the Task its loop picked. */
    appPutsDispatchFor: async (seen: { state: OrchState; version: number }, taskId: string) => {
      const opened = openDispatch(
        seen.state,
        { taskId, provider: 'claude', accountId: accounts[0].id, sessionId: 'pending:legacy', cwd: repo, specPath: '' },
        NOW
      )
      if (!opened.ok) throw new Error(`rig: the legacy app could not open a Dispatch: ${opened.error}`)
      return orch.call({ cmd: 'state-put', args: { state: opened.state, version: seen.version }, sessionId: '', from: appCaller })
    }
  }
}

// Real git per test: the suite's 10 s default is raised so a bounded wait (WAIT) fails first, with its message.
describe('the Host drives with no app (§9.3)', { timeout: 40_000 }, () => {
  it('drives a two-Task chain to completed with no app (§9.3)', async () => {
    const h = await rig({ tasks: 2, chained: true })
    await h.cli('jobs-run', { id: h.jobId })
    for (let i = 0; i < 2; i++) {
      await until(() => expect(h.spawns()).toHaveLength(i + 1))
      await h.workerReports(h.spawns()[i], 'succeeded')
    }
    await until(() => expect(h.runOutcome()).toBe('completed'))
    expect(h.spawns()).toHaveLength(2)
  })

  // Review Focus 2.
  it('a legacy app attaching mid-run: the Host starts no new slot, and the app’s own start is refused before it spawns', async () => {
    const h = await rig({ tasks: 2, chained: false, concurrency: 1 })
    await h.cli('jobs-run', { id: h.jobId })
    await until(() => expect(h.spawns()).toHaveLength(1))
    const seen = await h.appStateGet() // the legacy app's mirror and version
    h.server.app = true
    h.server.keeps = true
    h.wiring.serverHooks.onAppsChanged()
    await h.workerReports(h.spawns()[0], 'succeeded') // frees the slot; the Host must not fill it
    await h.settle()
    expect(h.spawns()).toHaveLength(1)
    const refused = await h.appPutsDispatchFor(seen, h.secondTaskId) // openDispatch on the stale mirror, state-put with its version
    expect(refused.status).toBe(409)
    expect(h.spawns()).toHaveLength(1) // the list of spawns is the Tasks started, never one more
  })

  // B1: the Host turns to retiring between the loop's mayStart() and worker-start (inside a slot's
  // awaits: the Run fork). The refusal arrives through handle() as 409 + retry, and the activation stops.
  it('a spawner that starts retiring between mayStart and worker-start gates nothing', async () => {
    const h = await rig({ tasks: 2, chained: false, concurrency: 2, retireOnFirstFork: true })
    await h.cli('jobs-run', { id: h.jobId })
    await until(() => expect(h.logs.join('\n')).toMatch(/the Host is leaving/))
    await h.settle()
    expect(h.spawns()).toHaveLength(0)
    expect(h.openGates()).toHaveLength(0)
  })

  // B1, the earlier moment: retiring during the login lookup is caught by the per-slot check itself, so
  // no worker-start is even asked for.
  it('a spawner that starts retiring during the login lookup starts and gates nothing', async () => {
    const h = await rig({ tasks: 2, chained: false, concurrency: 2, retireOnFirstLoginCheck: true })
    await h.cli('jobs-run', { id: h.jobId })
    await h.settle()
    expect(h.spawns()).toHaveLength(0)
    expect(h.openGates()).toHaveLength(0)
  })

  it('validation pass, headless: the check runs in the Host and the Task completes', async () => {
    const h = await rig({ tasks: 1, validate: ['seed:npm:test'], testScript: 'node -e "process.exit(0)"' })
    await h.cli('jobs-run', { id: h.jobId })
    await until(() => expect(h.spawns()).toHaveLength(1))
    await h.workerReports(h.spawns()[0], 'succeeded')
    await until(() => expect(h.runPtys()).toHaveLength(1))
    h.exitRunPty(0)
    await until(() => expect(h.runOutcome()).toBe('completed'))
  })

  it('validation fail with repair, headless: a repair worker starts, and a second failure exhausts to a Gate the wait ends on', async () => {
    const h = await rig({ tasks: 1, validate: ['seed:npm:test'], convergence: { maxFixAttempts: 1 } })
    await h.cli('jobs-run', { id: h.jobId })
    await until(() => expect(h.spawns()).toHaveLength(1))
    await h.workerReports(h.spawns()[0], 'succeeded')
    await until(() => expect(h.runPtys()).toHaveLength(1))
    h.exitRunPty(1)
    await until(() => expect(h.spawns()).toHaveLength(2)) // the repair worker
    await h.workerReports(h.spawns()[1], 'succeeded')
    await until(() => expect(h.runPtys()).toHaveLength(2))
    h.exitRunPty(1)
    const waited = await h.cli('runs-wait', { id: h.runId, timeoutMs: 5_000 })
    expect(waited.body).toMatchObject({ state: 'waiting' })
  })

  it('review with a second provider, headless', async () => {
    const h = await rig({ tasks: 1, review: true, accounts: ['claude', 'codex'] })
    await h.cli('jobs-run', { id: h.jobId })
    await until(() => expect(h.spawns()).toHaveLength(1))
    await h.workerReports(h.spawns()[0], 'succeeded')
    await until(() => expect(h.spawns()).toHaveLength(2))
    expect(h.spawns()[1]).toMatchObject({ provider: 'codex', worktree: 'current' })
    await h.workerReports(h.spawns()[1], 'succeeded')
    await until(() => expect(h.runOutcome()).toBe('completed'))
  })

  // The review of S4+S5, C1: a convergence reviewer writes its verdict beside its spec a few seconds
  // before it reports. A tick landing in that gap (no app attached, no spawn in flight) must leave the
  // verdict where `worker-done` reads it, so a blocking finding on a "succeeded" report still blocks.
  it('a tick between the reviewer writing its verdict and reporting keeps the verdict, and its blocking finding is honoured (C1)', async () => {
    const h = await rig({ tasks: 1, review: true, accounts: ['claude', 'codex'], convergence: { maxFixAttempts: 1 } })
    await h.cli('jobs-run', { id: h.jobId })
    await until(() => expect(h.spawns()).toHaveLength(1))
    await h.workerReports(h.spawns()[0], 'succeeded')
    await until(() => expect(h.spawns()).toHaveLength(2))
    const reviewer = h.spawns()[1]
    await until(() => expect(h.orch.state().dispatches.find((x) => x.id === reviewer.dispatchId)?.specPath).toBe(reviewer.specPath))
    const verdict = `${reviewer.specPath}.review.json`
    await fs.writeFile(verdict, JSON.stringify({ issues: [{ severity: 'high', title: 'the rig found a blocking bug' }] }))
    await h.settle()
    await h.wiring.driving.tick()
    expect(readFileSync(verdict, 'utf8')).toMatch(/blocking bug/)
    await h.workerReports(reviewer, 'succeeded')
    await until(() => expect(h.task(h.onlyTaskId).status).not.toBe('reviewing'))
    expect(h.runOutcome()).not.toBe('completed')
    expect(JSON.stringify(h.task(h.onlyTaskId))).toMatch(/the rig found a blocking bug/)
  })

  it('a validation guard allows a registered task worktree, through worktrees.paths() (B5)', async () => {
    const h = await rig({ tasks: 1, validate: ['seed:npm:test'], concurrency: 2 }) // concurrency 2: the task runs in its own worktree
    await h.cli('jobs-run', { id: h.jobId })
    await until(() => expect(h.spawns()).toHaveLength(1))
    expect(h.spawns()[0].worktree).toBe('new')
    await h.workerReports(h.spawns()[0], 'succeeded')
    await until(() => expect(h.runPtys()).toHaveLength(1)) // not a Gate: the fork's path is allowed
    expect(h.openGates()).toHaveLength(0)
  })

  // The review of Task 12, m6: a retiring Host stops driving at once, not only once its server closes.
  it('once disposed (retire has started), a commit, a load and an app leaving start nothing, and it owns none of the S5 names', async () => {
    const h = await rig({ tasks: 1 })
    await h.settle()
    expect(h.wiring.orchHooks.drive.owns()).toBe(true) // the migrated profile with no app: the Host drives
    h.wiring.dispose()
    expect(h.wiring.orchHooks.drive.owns()).toBe(false)
    await h.cli('jobs-run', { id: h.jobId })
    h.wiring.serverHooks.onAppsChanged()
    await h.settle()
    expect(h.spawns()).toHaveLength(0)
    expect(await h.wiring.orchHooks.mayDrain()).toBe(false)
  })

  // The ruling on Task 13 (review I1): a leaving Host starts no validation. A worker_done reaching it on a
  // socket that was already connected leaves the Task validating, for the successor to restart
  // (convergence) or gate (otherwise).
  it('a worker_done after dispose starts no validation and leaves the Task validating (I1)', async () => {
    const h = await rig({ tasks: 1, validate: ['seed:npm:test'], convergence: { maxFixAttempts: 1 } })
    await h.cli('jobs-run', { id: h.jobId })
    await until(() => expect(h.spawns()).toHaveLength(1))
    h.wiring.dispose()
    await h.workerReports(h.spawns()[0], 'succeeded')
    await h.settle()
    expect(h.task(h.onlyTaskId).status).toBe('validating')
    expect(h.runPtys()).toHaveLength(0)
    expect(h.openGates()).toHaveLength(0)
  })

  // The ruling on Task 13 (review I2), in leave()'s order: dispose, closeAndSettle, killAll. The kill's
  // exit is not the check's result, so nothing is recorded: no failed check, no repair, no Gate.
  it('a validation running when the Host leaves is not recorded as failed: the Task stays validating (I2)', async () => {
    const h = await rig({ tasks: 1, validate: ['seed:npm:test'], convergence: { maxFixAttempts: 1 } })
    await h.cli('jobs-run', { id: h.jobId })
    await until(() => expect(h.spawns()).toHaveLength(1))
    await h.workerReports(h.spawns()[0], 'succeeded')
    await until(() => expect(h.runPtys()).toHaveLength(1))
    h.wiring.dispose()
    await h.spawner.closeAndSettle()
    h.registry.killAll()
    await h.settle()
    const task = h.task(h.onlyTaskId)
    expect(task.status).toBe('validating')
    expect(task.checks ?? []).toEqual([])
    expect(h.repairDispatches()).toHaveLength(0)
    expect(h.openGates()).toHaveLength(0)
  })

  it('index.ts disposes the driving as the first step of leaving, before it stops accepting (m6)', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
    const leave = src.slice(src.indexOf('const leave = '))
    expect(leave.indexOf('wiring?.dispose()')).toBeGreaterThan(-1)
    expect(leave.indexOf('wiring?.dispose()')).toBeLessThan(leave.indexOf('server.stopAccepting()'))
  })

  it('announces dispatch exactly when it announces spawn, and index.ts builds the driving through composeHostDriving (R7, N11)', () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8')
    expect(src).toMatch(/features:\s*spawner\s*\?\s*\[HOST_FEATURE_SPAWN,\s*HOST_FEATURE_WORKTREES,\s*HOST_FEATURE_DISPATCH\]\s*:\s*\[\]/)
    expect(src).toMatch(/composeHostDriving\(/)
    // The two spreads (review m2), each inside the deps of the call it belongs to: the rig spreads the
    // hooks itself, so without these a Host that never drives would leave every test above green.
    const orchCall = src.slice(src.indexOf('createHostOrch({'), src.indexOf('createHostExits('))
    expect(orchCall).toMatch(/\.\.\.\(wiring\?\.orchHooks \?\? \{\}\)/)
    const serverAt = src.indexOf('startHostServer({')
    const serverCall = src.slice(serverAt, src.indexOf('ADDRESS_TAKEN', serverAt))
    expect(serverCall).toMatch(/\.\.\.\(wiring\?\.serverHooks \?\? \{\}\)/)
  })
})
