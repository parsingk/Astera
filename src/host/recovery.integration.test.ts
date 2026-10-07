// Phase 3R acceptance (remote runtime design §2.6, promise 4): a Host restarted with no app anywhere recovers the
// workers its predecessor lost, the way the app's recovery does when it is open.
//
// **Two Hosts over one profile, one after the other.** `boot()` builds what index.ts builds for orchestration: a
// real `createHostOrch` on a temp profile, `composeHostDriving` over it, a real `createHostJournal` (Job Continuity
// on in app-settings.json) and real `createHostWorktrees` over a temp git repo. The first Host starts a Job and its
// worker; it is then dropped without a word, as a killed Host is (nothing is closed, the Dispatch stays open on
// disk). The second Host loads the same profile: its restart cleanup closes the Dispatch as lost, and its handover
// sweeps it. The fakes are only what starts a process (the spawner's worker start and the pty spawn), as in
// driving.integration.test.ts, whose rig this one follows.
//
// **Portable:** every path comes from `tempDir`/`path.join`, git runs through the fixtures, and every wait is a
// bounded `vi.waitFor` or a quiescence check.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { composeHostDriving, type HostDrivingWiring } from './drivingWiring'
import { createHostOrch, type HostOrch } from './orch'
import { createHostJournal, type HostJournal } from './hostJournal'
import { PtyRegistry, type RegistryPty } from './registry'
import { ProcRegistry } from './procRegistry'
import { createHostWorktrees } from './worktrees'
import type { HostLocal, HostSpawner } from './spawner'
import { makeRepo, gitSync, tempDir } from '../core/worktrees/testRepo'
import { HOST_YIELD_JOURNAL, HOST_YIELD_RECOVERY } from '../core/host/protocol'
import type { OrchCaller } from '../core/host/orchProtocol'
import { JournalReader } from '../core/continuity/journalReader'
import { recoveryActionsIn } from '../core/continuity/sqliteLockFixtures'
import type { OrchState } from '../core/orchestration/state'
import type { Provider } from '../core/types'

const WAIT = { timeout: 20_000, interval: 20 }
const until = <T>(fn: () => T | Promise<T>): Promise<T> => vi.waitFor(fn, WAIT)

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

interface Spawn {
  dispatchId: string
  taskId: string
  sessionId: string
  worktree: string
  cwd: string
  specFileContent?: string
  resume?: unknown
}
type FakePty = RegistryPty & { exit(code: number): void }

/** The profile both Hosts share: a repo, accounts, and app-settings.json. */
async function profile(settings: Record<string, unknown>) {
  const profileDir = await tempDir('astera-hostrecovery-profile-')
  const home = await tempDir('astera-hostrecovery-home-')
  const repo = await makeRepo('astera-hostrecovery-repo-')
  cleanups.push(async () => {
    for (const d of [profileDir, home, repo]) await fs.rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  await fs.writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'rig', scripts: { test: 'node -e "process.exit(0)"' } }))
  gitSync(repo, ['add', 'package.json'])
  gitSync(repo, ['commit', '-m', 'package.json'])
  await fs.writeFile(path.join(profileDir, 'app-settings.json'), JSON.stringify({ orchAlwaysOnMigrated: true, ...settings }))
  await fs.writeFile(path.join(profileDir, 'worktrees.json'), JSON.stringify({ root: path.join(home, 'wt'), items: [] }))
  const configDir = path.join(home, 'cfg', 'acc_1')
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(path.join(configDir, '.credentials.json'), '{}')
  const account = { id: 'acc_1', label: 'acc_1', configDir, color: '#888', createdAt: '2026-10-08T00:00:00.000Z', provider: 'claude' as Provider }
  await fs.writeFile(path.join(profileDir, 'accounts.json'), JSON.stringify({ accounts: [account] }))
  return { profileDir, home, repo, accountId: account.id }
}

/** One Host's orchestration over the profile. `startedAt` keeps each Host's journal stamps apart. */
async function boot(p: { profileDir: string; home: string }, startedAt: string, server: { app: boolean; keeps: Set<string> }) {
  const logs: string[] = []
  const log = (m: string): void => {
    logs.push(m)
  }
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
  const srv = {
    hasApp: () => server.app,
    appsKeep: (duty: string) => server.app && server.keeps.has(duty),
    broadcast: () => {}
  }
  const box: { orch: HostOrch | null } = { orch: null }
  const orchOf = (): HostOrch => box.orch!
  const worktrees = createHostWorktrees({
    profileDir: p.profileDir,
    homeDir: p.home,
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
  const journal: HostJournal = createHostJournal({
    profileDir: p.profileDir,
    writer: () => !srv.appsKeep(HOST_YIELD_JOURNAL),
    hostStartedAt: () => startedAt,
    now: () => new Date().toISOString(),
    log
  })
  await journal.start()

  const spawns: Spawn[] = []
  const local: HostLocal = {
    owns: () => true,
    startWorker: track(async (a: Parameters<HostLocal['startWorker']>[0]) => {
      const cwd =
        a.terminal !== undefined
          ? (a.terminalCwd ?? a.runCwd)
          : a.worktree === 'new'
            ? await worktrees.fork({ repoPath: a.runCwd, name: a.name ?? a.taskId })
            : a.worktree === 'current'
              ? a.runCwd
              : a.worktree
      const sessionId = a.terminal ?? `ses_${startedAt.slice(-6)}_${spawns.length + 1}`
      if (a.terminal === undefined) {
        const opened = registry.open({ id: `pty_${sessionId}`, file: 'agent', args: [], opts: { cwd, cols: 80, rows: 24, env: {} }, meta: { kind: 'session', id: sessionId, restore: {} } })
        if (!opened.ok) throw new Error(opened.error)
      }
      const specPath = path.join(p.profileDir, 'orch', 'specs', `${a.dispatchId}.md`)
      await fs.mkdir(path.dirname(specPath), { recursive: true })
      await fs.writeFile(specPath, a.specFileContent ?? `the rig's spec for ${a.taskId}`)
      spawns.push({ dispatchId: a.dispatchId, taskId: a.taskId, sessionId, worktree: a.worktree, cwd, specFileContent: a.specFileContent, resume: a.resume })
      return { sessionId, cwd, specPath }
    }),
    startCoordinator: async () => ({ sessionId: `ses_coord_${startedAt.slice(-6)}` }),
    releaseWorker: async () => {},
    readWorker: async () => '',
    probeLimit: async () => null,
    readReviewFile: async () => null,
    makeRunWorktree: (a) => worktrees.makeRunWorktree(a),
    mergeWorktrees: (runCwd, paths) => worktrees.mergeWorktrees(runCwd, paths),
    removeWorktrees: (paths) => worktrees.removeWorktrees(paths)
  }
  let retiring = false
  const spawner = {
    orchEnvNow: () => undefined,
    ...local,
    inFlight: () => 0,
    closeAndSettle: async () => {
      retiring = true
    },
    trackedSessions: () => spawns.length,
    sessionBusy: () => null,
    typeInto: () => false,
    isRetiring: () => retiring,
    prepareRollSpawn: async () => {
      throw new Error('not in this rig')
    },
    rollSpawn: () => {
      throw new Error('not in this rig')
    },
    statusLinePayload: async () => null,
    onSpawned: () => {},
    onRolloutLocated: () => {},
    onBusyChanged: () => {},
    retarget: () => {},
    createSession: async () => {
      throw new Error('not in this rig')
    }
  } satisfies HostSpawner

  const wiring: HostDrivingWiring = composeHostDriving({
    profileDir: p.profileDir,
    platform: process.platform,
    env: { PATH: process.env.PATH },
    registry,
    spawner,
    worktrees,
    orch: orchOf,
    server: () => srv,
    log,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    every: () => () => {},
    after: (_ms: number, fn: () => void) => {
      const h = setTimeout(fn, 0)
      return () => clearTimeout(h)
    },
    killRunner: (cmd) => {
      const pid = Number(cmd.args[cmd.args.indexOf('/pid') + 1])
      const pty = ptys.get(pid)
      if (pty) setTimeout(() => pty.exit(1), 5)
    },
    journal
  })
  const orch = createHostOrch({
    profileDir: p.profileDir,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => startedAt,
    runningSessions: () => registry.liveCount(),
    aliveSessionIds: () => new Set(registry.list().filter((e) => e.alive && e.meta?.kind === 'session').map((e) => e.meta!.id)),
    act: async () => undefined,
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
    specsDir: path.join(p.profileDir, 'orch', 'specs'),
    worktrees,
    journal,
    ...wiring.orchHooks
  })
  box.orch = orch
  const handle = orch.handle
  orch.handle = track((cmd: string, args: Record<string, unknown>) => handle(cmd, args))
  const cliCaller: OrchCaller = { role: 'cli', toOthers: () => {} }
  const cli = (cmd: string, args: Record<string, unknown>, sessionId = '') => orch.call({ cmd, args, sessionId, from: cliCaller })
  const ok = async (cmd: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await cli(cmd, args)
    if (r.status !== 200) throw new Error(`rig: ${cmd} answered ${r.status} ${JSON.stringify(r.body)}`)
    return r.body as Record<string, unknown>
  }
  const state = (): OrchState => orch.state()
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
  let gone = false
  /** A killed Host: nothing is closed, nothing more is done. Its timers and handles are dropped. */
  const kill = (): void => {
    if (gone) return
    gone = true
    wiring.dispose()
    retiring = true
    journal.close()
  }
  cleanups.push(async () => {
    kill()
    registry.killAll()
  })
  return {
    orch, wiring, journal, registry, cli, ok, state, settle, kill, logs,
    spawns: () => spawns,
    exitRunPty: (code: number) => {
      const entry = registry.list().filter((e) => e.meta?.kind === 'run').at(-1)
      if (!entry) throw new Error('rig: no run pty')
      ptys.get(entry.pid)!.exit(code)
    },
    runPtys: () => registry.list().filter((e) => e.meta?.kind === 'run'),
    workerReports: async (s: Spawn, outcome: 'succeeded' | 'failed') => {
      const r = await cli('send', { type: 'worker_done', taskId: s.taskId, dispatchId: s.dispatchId, outcome, subject: 'done', body: 'the rig’s worker is done' }, s.sessionId)
      if (r.status !== 200) throw new Error(`rig: worker_done answered ${r.status} ${JSON.stringify(r.body)}`)
    }
  }
}

const journalRows = (profileDir: string, runId: string) => {
  const r = new JournalReader(path.join(profileDir, 'orch', 'continuity.sqlite'))
  try {
    return r.eventsFor(runId)
  } finally {
    r.close()
  }
}

/** A Job with one Task, run by the first Host until its worker is started; that Host is then killed. */
async function lostWorker(o: { settings?: Record<string, unknown>; validate?: string[]; convergence?: boolean; coordinator?: boolean; tasks?: number } = {}) {
  const p = await profile({ jobContinuityEnabled: true, ...o.settings })
  const server = { app: false, keeps: new Set<string>() }
  const first = await boot(p, '2026-10-08T01:00:00.000Z', server)
  const job = await first.ok('jobs-create', { objective: 'the rig', cwd: p.repo, concurrency: 1, ...(o.convergence ? { convergence: true, maxFixAttempts: 1 } : {}) })
  const task = await first.ok('tasks-add', { job: job.id, title: 'task 1', spec: 'do it', account: p.accountId, ...(o.validate ? { validate: o.validate.join(',') } : {}) })
  for (let i = 2; i <= (o.tasks ?? 1); i++) await first.ok('tasks-add', { job: job.id, title: `task ${i}`, spec: 'do it too', account: p.accountId })
  await first.ok('jobs-run', { id: job.id, ...(o.coordinator ? { coordinator: p.accountId } : {}) })
  await until(() => expect(first.spawns()).toHaveLength(1))
  // The Run's own Task (jobs-run copies the Job's definition Task into the Run under a new id).
  void task
  return { p, server, first, jobId: job.id as string, taskId: first.spawns()[0].taskId }
}

describe('Host-owned recovery after a restart, with no app (remote runtime design §2.6, Phase 3R)', { timeout: 60_000 }, () => {
  it('a lost worker in a Run with no coordinator: the restarted Host resumes it once, in its worktree, journalled as the Host', async () => {
    const { p, server, first, taskId } = await lostWorker({ settings: { resumeStrategy: 'smart' } })
    const lostSpawn = first.spawns()[0]
    // The worker's unfinished work, uncommitted in its worktree.
    await fs.writeFile(path.join(lostSpawn.cwd, 'half-done.txt'), 'work in progress')
    first.kill()

    const second = await boot(p, '2026-10-08T02:00:00.000Z', server)
    await second.cli('jobs-list', {})
    await until(() => expect(second.spawns()).toHaveLength(1))
    await second.settle()
    expect(second.spawns()).toHaveLength(1)
    const again = second.spawns()[0]
    expect(again.taskId).toBe(taskId)
    expect(again.cwd).toBe(lostSpawn.cwd)
    expect(existsSync(path.join(lostSpawn.cwd, 'half-done.txt'))).toBe(true)
    const s = second.state()
    expect(s.dispatches.find((d) => d.id === again.dispatchId)?.retryOf).toBe(lostSpawn.dispatchId)
    const runId = s.tasks.find((t) => t.id === taskId)!.runId!
    const rows = journalRows(p.profileDir, runId).filter((r) => r.dispatchId === lostSpawn.dispatchId && r.type.startsWith('RECOVERY_'))
    expect(rows.map((r) => r.type)).toEqual(expect.arrayContaining(['RECOVERY_DETECTED', 'RECOVERY_STRATEGY_SELECTED', 'RECOVERY_COMPLETED']))
    for (const r of rows) expect(r.actor).toEqual({ surface: 'host' })
    expect(recoveryActionsIn(path.join(p.profileDir, 'orch', 'continuity.sqlite'), runId)).toEqual([
      expect.objectContaining({ dispatchId: lostSpawn.dispatchId, status: 'completed' })
    ])
  })

  // Final review C1: with a ready Task waiting, the scheduler must not take the lost worker's slot first.
  it('a lost worker beside a ready Task in a Run of one slot: the lost one is recovered first, and nothing is stranded', async () => {
    const { p, server, first, taskId } = await lostWorker({ settings: { resumeStrategy: 'smart' }, tasks: 2 })
    first.kill()
    const second = await boot(p, '2026-10-08T02:00:00.000Z', server)
    await second.cli('jobs-list', {})
    await until(() => expect(second.spawns()).toHaveLength(1))
    await second.settle()
    expect(second.spawns()).toHaveLength(1)
    expect(second.spawns()[0].taskId).toBe(taskId)
  })

  it('with Smart Resume off and unfinished work, the restarted Host asks a person, as the app does', async () => {
    const { p, server, first, taskId } = await lostWorker()
    await fs.writeFile(path.join(first.spawns()[0].cwd, 'half-done.txt'), 'work in progress')
    first.kill()
    const second = await boot(p, '2026-10-08T02:00:00.000Z', server)
    await second.cli('jobs-list', {})
    await until(() => expect(second.state().gates.filter((g) => g.status === 'open' && g.taskId === taskId)).toHaveLength(1))
    await second.settle()
    expect(second.spawns()).toHaveLength(0)
    // The reconciler's own review, not the journal-off Gate: its decision is journalled, as the Host.
    const runId = second.state().tasks.find((t) => t.id === taskId)!.runId!
    const review = journalRows(p.profileDir, runId).find((r) => r.type === 'RECOVERY_REQUIRES_REVIEW')
    expect(review?.actor).toEqual({ surface: 'host' })
  })

  it('a lost repair: the restarted Host starts the repair again, with its rebuilt spec', async () => {
    const { p, server, first } = await lostWorker({ validate: ['seed:npm:test'], convergence: true })
    await first.workerReports(first.spawns()[0], 'succeeded')
    await until(() => expect(first.runPtys()).toHaveLength(1))
    first.exitRunPty(1)
    await until(() => expect(first.spawns()).toHaveLength(2)) // the repair worker
    const repair = first.spawns()[1]
    first.kill()
    const second = await boot(p, '2026-10-08T02:00:00.000Z', server)
    await second.cli('jobs-list', {})
    await until(() => expect(second.spawns()).toHaveLength(1))
    await second.settle()
    const again = second.spawns()[0]
    const d = second.state().dispatches.find((x) => x.id === again.dispatchId)
    expect(d?.retryOf).toBe(repair.dispatchId)
    expect(d?.repair).toBeDefined()
    expect(again.specFileContent).toBeDefined()
  })

  it('an interrupted check: the restarted Host runs the check again, and opens no Gate', async () => {
    const { p, server, first, taskId } = await lostWorker({ validate: ['seed:npm:test'], convergence: true })
    await first.workerReports(first.spawns()[0], 'succeeded')
    await until(() => expect(first.runPtys()).toHaveLength(1))
    first.kill()
    const second = await boot(p, '2026-10-08T02:00:00.000Z', server)
    await second.cli('jobs-list', {})
    await until(() => expect(second.runPtys()).toHaveLength(1))
    expect(second.state().tasks.find((t) => t.id === taskId)?.status).toBe('validating')
    expect(second.state().gates.filter((g) => g.status === 'open')).toEqual([])
  })

  it('a lost coordinator: the restarted Host empties its slot and recovers its worker as the Run’s rules say', async () => {
    const { p, server, first, taskId } = await lostWorker({ coordinator: true })
    first.kill()
    const second = await boot(p, '2026-10-08T02:00:00.000Z', server)
    await second.cli('jobs-list', {})
    // The sweep reads git before it starts anything, so a quiet spell alone is not the end of it.
    await until(() => expect(second.spawns()).toHaveLength(1))
    await second.settle()
    const s = second.state()
    const run = s.runs.find((r) => r.id === s.tasks.find((t) => t.id === taskId)!.runId)!
    // The outcome the acceptance asks to be documented (the design's Done note states it).
    const outcome = {
      coordinatorSlot: run.coordinatorSessionId ?? null,
      taskStatus: s.tasks.find((t) => t.id === taskId)?.status,
      newWorkers: second.spawns().length,
      openGates: s.gates.filter((g) => g.status === 'open').length
    }
    // The slot is emptied by the load (today's path: the Run's own restart offers a new coordinator), and the
    // worker the coordinator's Run lost is recovered by the Host once, with no Gate.
    expect(outcome).toEqual({ coordinatorSlot: null, taskStatus: 'dispatched', newWorkers: 1, openGates: 0 })
  })

  it('an attached app that yields recovery: the Host recovers; one that keeps it: the Host starts nothing', async () => {
    const yielding = await lostWorker({ settings: { resumeStrategy: 'smart' } })
    yielding.first.kill()
    yielding.server.app = true // yields journal and recovery: keeps nothing here
    const host = await boot(yielding.p, '2026-10-08T02:00:00.000Z', yielding.server)
    await host.cli('jobs-list', {})
    await until(() => expect(host.spawns()).toHaveLength(1))

    const keeping = await lostWorker({ settings: { resumeStrategy: 'smart' } })
    keeping.first.kill()
    keeping.server.app = true
    keeping.server.keeps = new Set([HOST_YIELD_RECOVERY]) // an older app: it recovers itself
    const host2 = await boot(keeping.p, '2026-10-08T02:00:00.000Z', keeping.server)
    await host2.cli('jobs-list', {})
    await host2.settle()
    expect(host2.spawns()).toHaveLength(0)
    expect(host2.state().tasks.find((t) => t.id === keeping.taskId)?.status).toBe('dispatched')
  })

  it('journal off: the restarted Host opens today’s lost-worker Gate', async () => {
    const { p, server, first, taskId } = await lostWorker({ settings: { jobContinuityEnabled: false } })
    first.kill()
    const second = await boot(p, '2026-10-08T02:00:00.000Z', server)
    await second.cli('jobs-list', {})
    await until(() => expect(second.state().tasks.find((t) => t.id === taskId)?.status).toBe('blocked'))
    expect(second.spawns()).toHaveLength(0)
  })
})
