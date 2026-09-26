// The public CLI against a real Host, end to end (CLI spec §48 "Integration", §49 "Cross-platform").
//
// **The CLI side is the real entry.** `main()` in run.ts is what index.ts (out/main/cli.js) calls and
// nothing else; here it runs in this process with its argv, its environment, its stdout and its
// `process.exit` taken over for the call, so every line below goes through the parser, the mode, the
// Host discovery (`ASTERA_PROFILE_DIR` → the address), the handshake, `orch-call`, the public field
// filter, the envelope and the exit code exactly as a shell would see them.
//
// **The Host side is the one index.ts builds**, minus what starts a process: a real `startHostServer`
// on the profile's own address, a real `createHostOrch` on a temp profile, the real driving
// (`composeHostDriving`: the dispatch loop, the lost-worker Gate) and the real exits
// (`createHostExits`), over a real `PtyRegistry` whose pty spawn is fake. A "worker" is a fake pty the
// fake spawner opens in that registry, exactly as the rig in src/host/driving.integration.test.ts does.
// No app (unless a test attaches a raw one), no agent, no network.
//
// **Portable and loaded-runner safe:** every path is `os.tmpdir()`/`path.join`, every profile is its
// own (so every address is its own), every wait is a bounded `vi.waitFor`, and the budgets are wide.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { promises as fs, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { main } from './run'
import { hostAddress } from '../host/address'
import { encodeLine, createLineReader } from '../host/framing'
import { startHostServer, ADDRESS_TAKEN, type HostServer } from '../host/server'
import { createHostOrch, type HostOrch } from '../host/orch'
import { createHostJournal } from '../host/hostJournal'
import { JournalReader } from '../core/continuity/journalReader'
import type { JournalEventRow } from '../core/continuity/journal'
import { composeHostDriving } from '../host/drivingWiring'
import { createHostExits } from '../host/exits'
import { createHostWorktrees } from '../host/worktrees'
import { createHostProjectRoots } from '../host/projectRoots'
import { hostFeatures } from '../host/features'
import { PtyRegistry, type RegistryPty } from '../host/registry'
import { ProcRegistry } from '../host/procRegistry'
import type { HostLocal, HostSpawner } from '../host/spawner'
import { makeRepo, tempDir } from '../core/worktrees/testRepo'
import { readDispatchGate } from '../core/host/driver'
import {
  HOST_PROTOCOL,
  HOST_YIELD_CHAT_TAKEOVER,
  HOST_YIELD_DISPATCH,
  HOST_YIELD_JOURNAL,
  HOST_YIELD_ROLLING,
  HOST_YIELD_SLACK,
  HOST_YIELD_WORKTREES,
  type ClientMessage,
  type HostMessage
} from '../core/host/protocol'
import { createJob, createTask, emptyState, openDispatch, startJobRun, type OrchState, type Res } from '../core/orchestration/state'
import { ensureProject } from '../core/orchestration/projects'
import { CLI_PROTOCOL, codeForStatus, exitCodeFor } from '../core/orchestration/cliOutput'

/** Every wait is bounded: long enough for real git on a loaded Windows runner, short enough to fail. */
const WAIT = { timeout: 25_000, interval: 25 }
const until = <T>(fn: () => T | Promise<T>): Promise<T> => vi.waitFor(fn, WAIT)
/** A profile name with a space and Hangul in it, for every test: the address, the state file and the
 *  CLI's discovery all go through it (§49 "spaces/non-ASCII user directory"). */
const PROFILE_PREFIX = 'astera cli 통합 프로필-'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})
const rmrf = (d: string): Promise<void> => fs.rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })

// ---------------------------------------------------------------------------------------------------
// The CLI, run through its real entry.

class Exited extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`)
  }
}

interface CliRun {
  code: number
  stdout: string
  stderr: string
  /** The last line of stdout, parsed: the envelope in the default JSON mode. */
  envelope: {
    ok: boolean
    data?: Record<string, unknown>
    error?: { code: string; message: string; details?: Record<string, unknown>; nextSteps?: string[] }
  }
}

/** The variables that pick a Host and a caller. Each call sets exactly the ones it is given. */
const CLI_ENV = ['ASTERA_PROFILE_DIR', 'ASTERA_HOST', 'ASTERA_PROFILE', 'ASTERA_SESSION'] as const

/** One `astera …` invocation, the way index.ts runs it. Calls are serial (the process globals are
 *  borrowed for the call), which is also how a script runs them. */
async function astera(argv: string[], env: Partial<Record<(typeof CLI_ENV)[number], string>>): Promise<CliRun> {
  const saved = { argv: process.argv, env: Object.fromEntries(CLI_ENV.map((k) => [k, process.env[k]])) }
  let stdout = ''
  let stderr = ''
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  }) as typeof process.stderr.write)
  const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Exited(code ?? 0)
  }) as typeof process.exit)
  process.argv = [process.execPath, path.join('out', 'main', 'cli.js'), ...argv]
  for (const k of CLI_ENV) {
    const v = env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  let code: number
  try {
    await main()
    throw new Error(`astera ${argv.join(' ')} returned without an exit code`)
  } catch (e) {
    if (!(e instanceof Exited)) throw e
    code = e.code
  } finally {
    out.mockRestore()
    err.mockRestore()
    exit.mockRestore()
    process.argv = saved.argv
    for (const k of CLI_ENV) {
      const v = saved.env[k]
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
  const last = stdout.trim().split('\n').at(-1) ?? ''
  let envelope: CliRun['envelope']
  try {
    envelope = JSON.parse(last) as CliRun['envelope']
  } catch {
    throw new Error(`astera ${argv.join(' ')} printed no envelope (exit ${code}): ${stdout}\n${stderr}`)
  }
  return { code, stdout, stderr, envelope }
}

/** A call that must succeed: exit 0 and `ok: true`, its `data` handed back. */
const okData = (r: CliRun, what: string): Record<string, unknown> => {
  expect(r.code, `${what} → ${r.stdout} ${r.stderr}`).toBe(0)
  expect(r.envelope.ok).toBe(true)
  return r.envelope.data ?? {}
}

// ---------------------------------------------------------------------------------------------------
// A raw client, for the app role: says hello, answers the Host's `orch-act`s, and calls `orch-call`.

interface RawClient {
  call(cmd: string, args: Record<string, unknown>): Promise<{ status: number; body: unknown }>
  got: HostMessage[]
  close(): Promise<void>
}

async function rawClient(address: string, hello: ClientMessage, answer?: (act: string, args: unknown) => unknown): Promise<RawClient> {
  const sock = net.connect(address)
  sock.setEncoding('utf8')
  const got: HostMessage[] = []
  const waiting = new Map<string, (m: { status: number; body: unknown }) => void>()
  let greeted: () => void = () => {}
  const hi = new Promise<void>((r) => (greeted = r))
  sock.on(
    'data',
    createLineReader({
      onMessage: (v) => {
        const m = v as HostMessage
        got.push(m)
        if (m.t === 'hello') greeted()
        if (m.t === 'orch-result') waiting.get(m.call)?.({ status: m.status, body: m.body })
        if (m.t === 'orch-act') {
          try {
            const value = answer?.(m.act, m.args)
            sock.write(encodeLine({ t: 'orch-acted', call: m.call, ok: true, value } satisfies ClientMessage))
          } catch (e) {
            sock.write(encodeLine({ t: 'orch-acted', call: m.call, ok: false, error: String(e) } satisfies ClientMessage))
          }
        }
      },
      onBadLine: () => {},
      onHandlerError: () => {}
    })
  )
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })
  sock.write(encodeLine(hello))
  await hi
  let n = 0
  return {
    got,
    call: (cmd, args) =>
      new Promise((resolve) => {
        const call = `c${++n}`
        waiting.set(call, resolve)
        sock.write(encodeLine({ t: 'orch-call', call, cmd, args } satisfies ClientMessage))
      }),
    close: () =>
      new Promise<void>((resolve) => {
        if (sock.destroyed) return resolve()
        sock.once('close', () => resolve())
        sock.end()
      })
  }
}

/** What the fake app answers when the Host asks it for something only the app has (`orch-act`): the
 *  accounts and the project root, as Astera answers them. Anything else is refused, so a test that
 *  starts depending on another act fails with that act's name instead of an answer made up here. */
const appAnswers =
  (accountId: string) =>
  (act: string, args: unknown): unknown => {
    if (act === 'listAccounts') return [{ id: accountId, label: 'a', provider: 'claude' }]
    if (act === 'resolveProjectRoot') return (args as string[])[0]
    throw new Error(`the test app does not answer ${act}`)
  }

/** A current Astera: it says it is the app and yields every duty this Host announces, so the Host keeps
 *  driving while it is attached. */
const appHello: ClientMessage = {
  t: 'hello',
  protocol: HOST_PROTOCOL,
  app: '9.9.9',
  role: 'app',
  yields: [HOST_YIELD_WORKTREES, HOST_YIELD_DISPATCH, HOST_YIELD_ROLLING, HOST_YIELD_CHAT_TAKEOVER, HOST_YIELD_JOURNAL, HOST_YIELD_SLACK]
}

// ---------------------------------------------------------------------------------------------------
// The Host.

type FakePty = RegistryPty & { exit(code: number): void }

interface Spawn {
  dispatchId: string
  taskId: string
  sessionId: string
  cwd: string
}

interface Rig {
  profileDir: string
  address: string
  /** The CLI environment that finds this Host: its profile, as the app hands it to a session. */
  env: { ASTERA_PROFILE_DIR: string }
  accountId: string
  repo: string
  orch: HostOrch
  server: HostServer
  spawns(): Spawn[]
  state(): OrchState
  /** Ends a worker's session the way a crashed agent ends: its pty exits with no report. */
  exitWorker(s: Spawn, code: number): void
  logs: string[]
  /** The rows of the Host's Job Journal for this run, read through a read-only `JournalReader` opened
   *  and closed per call on `<profile>/orch/continuity.sqlite`, as the app reads them. */
  journalRows(runId: string): JournalEventRow[]
  /** Test seams inside the Host's own commands. */
  hooks: { release?: () => Promise<void> }
}

async function hostRig(o: { repo?: boolean; seed?: OrchState; profileDir?: string; continuity?: boolean } = {}): Promise<Rig> {
  const profileDir = o.profileDir ?? (await tempDir(PROFILE_PREFIX))
  const home = await tempDir('astera-cli-int-home-')
  const repo = o.repo === false ? '' : await makeRepo('astera-cli-int-repo-')
  cleanups.push(async () => {
    for (const d of [profileDir, home, repo]) if (d) await rmrf(d)
  })

  // The profile an app that ran once leaves behind: the settings migration done (the Host may drive,
  // F62), a worktrees root of the test's own, one logged-in account (C8's one login rule, read for real).
  // `continuity` turns Job Continuity on, so the Host keeps the Job Journal (Host journal J1).
  await fs.writeFile(
    path.join(profileDir, 'app-settings.json'),
    JSON.stringify(o.continuity ? { orchAlwaysOnMigrated: true, jobContinuityEnabled: true } : { orchAlwaysOnMigrated: true })
  )
  await fs.writeFile(path.join(profileDir, 'worktrees.json'), JSON.stringify({ root: path.join(home, 'wt'), items: [] }))
  const accountId = 'acc_claude_0'
  const configDir = path.join(home, 'cfg', accountId)
  await fs.mkdir(configDir, { recursive: true })
  await fs.writeFile(path.join(configDir, '.credentials.json'), '{}')
  await fs.writeFile(
    path.join(profileDir, 'accounts.json'),
    JSON.stringify({ accounts: [{ id: accountId, label: 'a', configDir, color: '#888', createdAt: '2026-09-26T00:00:00.000Z', provider: 'claude' }] })
  )
  if (o.seed) await fs.writeFile(path.join(profileDir, 'orchestration.json'), JSON.stringify(o.seed))

  const logs: string[] = []
  const log = (m: string): void => {
    logs.push(m)
  }

  // The pty spawn: nothing runs. Each pty's pid is unique, so a registry entry maps back to it.
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

  const box: { orch: HostOrch | null; server: HostServer | null } = { orch: null, server: null }
  const orchOf = (): HostOrch => box.orch!
  const serverOf = (): HostServer => box.server!

  const worktrees = createHostWorktrees({
    profileDir,
    homeDir: home,
    ptys: registry,
    procs,
    getState: () => orchOf().state(),
    broadcast: (m) => serverOf().broadcast(m),
    log,
    app: { hasApp: () => serverOf().hasApp(), act: (name, args) => serverOf().act(name, args), lastAppPid: () => serverOf().lastAppPid() },
    closeTimeoutMs: 500,
    pollMs: 10
  })
  await worktrees.load()

  // The spawner: records each start and opens its session pty in the real registry — the fake worker.
  const spawns: Spawn[] = []
  let retiring = false
  const hooks: Rig['hooks'] = {}
  const local: HostLocal = {
    owns: () => true,
    startWorker: async (a) => {
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
      const specPath = path.join(profileDir, 'orch', 'specs', `${a.dispatchId}.md`)
      await fs.mkdir(path.dirname(specPath), { recursive: true })
      await fs.writeFile(specPath, `the rig's spec for ${a.taskId}`)
      spawns.push({ dispatchId: a.dispatchId, taskId: a.taskId, sessionId, cwd })
      return { sessionId, cwd, specPath }
    },
    startCoordinator: async () => ({ sessionId: 'ses_coord' }),
    // A worker is ended here in `runs stop`. The hook lets a test put something between that command's
    // read of the state and its commit, which is the window a lost update would come through.
    releaseWorker: async () => {
      await hooks.release?.()
    },
    readWorker: async () => '',
    probeLimit: async () => null,
    readReviewFile: async () => null,
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
    retarget: () => {},
    createSession: async () => {
      throw new Error('not in this rig')
    }
  } satisfies HostSpawner

  const wiring = composeHostDriving({
    profileDir,
    platform: process.platform,
    env: { PATH: process.env.PATH },
    registry,
    spawner,
    worktrees,
    orch: orchOf,
    server: serverOf,
    log,
    now: () => new Date().toISOString(),
    nowMs: () => Date.now(),
    // No tick: every pass here comes from a load, a commit or an app coming or going.
    every: () => () => {},
    // The app-left grace passes at once: the tests are about what follows it.
    after: (_ms: number, fn: () => void) => {
      const h = setTimeout(fn, 0)
      return () => clearTimeout(h)
    },
    readGate: (p: string) => readDispatchGate(p)
  })

  // The Job Journal, built the way index.ts builds it (J2: it writes while every attached app yields it).
  // `journalDown` is the rig's own, set by the teardown only.
  let journalDown = false
  const journal = o.continuity
    ? createHostJournal({
        profileDir,
        writer: () => !journalDown && !serverOf().appsKeep(HOST_YIELD_JOURNAL),
        hostStartedAt: () => serverOf().startedAt,
        now: () => new Date().toISOString(),
        log
      })
    : null
  await journal?.start()

  /** Exits the Host has handed to the command layer, counted so the teardown can wait them out. */
  let exitsHandled = 0
  const orch = createHostOrch({
    profileDir,
    version: '9.9.9',
    now: () => new Date().toISOString(),
    hostStartedAt: () => serverOf().startedAt,
    runningSessions: () => registry.liveCount() + procs.liveCount(),
    aliveSessionIds: () => new Set(registry.list().filter((e) => e.alive && e.meta?.kind === 'session').map((e) => e.meta!.id)),
    act: (name, args) => serverOf().act(name, args),
    hasApp: () => serverOf().hasApp(),
    onState: (state, version) => serverOf().broadcast({ t: 'orch-state', state, version }),
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
    resolveProjectRoot: createHostProjectRoots({ profileDir, repoPaths: () => worktrees.repoPaths() }).resolve,
    journal,
    ...wiring.orchHooks
  })
  box.orch = orch
  const exits = createHostExits({
    registry,
    sessionExited: async (e) => {
      try {
        await orch.sessionExited(e)
      } finally {
        exitsHandled += 1
      }
    },
    orphanedSessions: (isAlive) => orch.orphanedSessions(isAlive),
    log,
    deferMs: 10
  })

  const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
  const server = await startHostServer({
    address: addr.address,
    dirToPrepare: addr.dirToPrepare,
    version: '9.9.9',
    idleMs: 120_000,
    onIdle: () => {},
    onMessage: () => false,
    onClientGone: (from) => exits.appGone(from.socket),
    liveCounts: () => ({ sessions: registry.liveCount() + procs.liveCount(), runs: orch.runningRuns() }),
    orch,
    features: hostFeatures({ spawns: true, slack: false }),
    ...wiring.serverHooks,
    onAppGreeted: (send) => wiring.appGreeted(send),
    log: { write: log, close: () => {} }
  })
  box.server = server

  // Teardown in `leave()`'s order: the driver stops, the spawner retires, the server closes, the ptys
  // end, and the exits those ends start run out before the folders are removed.
  cleanups.push(async () => {
    wiring.dispose()
    await spawner.closeAndSettle()
    await server.close().catch(() => {})
    const live = registry.list().filter((e) => e.alive && e.meta?.kind === 'session').length
    const target = exitsHandled + live
    registry.killAll()
    await until(() => expect(exitsHandled).toBeGreaterThanOrEqual(target)).catch(() => {})
    // The journal's handle goes last, once the exits the kill started have committed. The writer rule
    // turns false first: a commit after `close()` would open the file again (a driving pass already in
    // flight when the teardown began can still place a worker), and Windows cannot remove a folder
    // whose SQLite file is open.
    journalDown = true
    journal?.close()
    if (addr.dirToPrepare) await rmrf(addr.dirToPrepare)
  })

  return {
    profileDir,
    address: addr.address,
    env: { ASTERA_PROFILE_DIR: profileDir },
    accountId,
    repo,
    orch,
    server,
    spawns: () => spawns,
    state: () => orch.state(),
    exitWorker: (s, code) => {
      const entry = registry.list().find((e) => e.meta?.kind === 'session' && e.meta.id === s.sessionId)
      if (!entry) throw new Error(`rig: no pty for ${s.sessionId}`)
      ptys.get(entry.pid)!.exit(code)
    },
    logs,
    journalRows: (runId) => {
      const reader = new JournalReader(path.join(profileDir, 'orch', 'continuity.sqlite'))
      try {
        return reader.eventsFor(runId)
      } finally {
        reader.close()
      }
    },
    hooks
  }
}

/** A Job with one Task, started through the CLI, and the worker the Host placed for it. */
async function runningJob(h: Rig): Promise<{ jobId: string; runId: string; taskId: string; worker: Spawn }> {
  const job = okData(
    await astera(['jobs', 'create', '--objective', 'the integration job', '--cwd', h.repo, '--concurrency', '1'], h.env),
    'jobs create'
  )
  const jobId = job.id as string
  okData(await astera(['tasks', 'add', '--job', jobId, '--title', 'one', '--spec', 'do the one thing', '--account', h.accountId], h.env), 'tasks add')
  const run = okData(await astera(['jobs', 'run', '--id', jobId], h.env), 'jobs run')
  const runId = run.id as string
  // The Host places the worker by itself: no app is attached to do it.
  await until(() => expect(h.spawns()).toHaveLength(1))
  const worker = h.spawns()[0]
  return { jobId, runId, taskId: worker.taskId, worker }
}

/** What a Host restart finds after a worker died with the Host: a Job, its Run, one Task and an open
 *  Dispatch on a session no registry holds ('ses_gone'), built with the pure layer. The Host's load
 *  cleanup closes that Dispatch as lost. */
function lostWorkerSeed(): { state: OrchState; runId: string; taskId: string } {
  const now = new Date().toISOString()
  const cwd = path.join(os.tmpdir(), 'astera-cli-int-lost')
  const need = <T>(r: Res<T>, what: string): { state: OrchState; value: T } => {
    if (!r.ok) throw new Error(`lostWorkerSeed: ${what}: ${r.error}`)
    return r
  }
  const job = need(createJob(emptyState(), { objective: 'the lost worker job', cwd, concurrency: 1 }, now), 'createJob')
  const run = need(startJobRun(job.state, job.value.id, now), 'startJobRun')
  const task = need(createTask(run.state, { runId: run.value.id, title: 'one', spec: 'do the one thing', deps: [], accountIds: ['acc_claude_0'] }, now), 'createTask')
  const opened = need(
    openDispatch(
      task.state,
      { taskId: task.value.id, provider: 'claude', accountId: 'acc_claude_0', sessionId: 'ses_gone', cwd, specPath: path.join(os.tmpdir(), 'astera-cli-int-lost.md') },
      now
    ),
    'openDispatch'
  )
  return { state: opened.state, runId: run.value.id, taskId: task.value.id }
}

// ---------------------------------------------------------------------------------------------------

describe('the public CLI against a real Host (§48, §49)', { timeout: 60_000 }, () => {
  // §48 "Integration — UI closed, Host alive": the Job runs, the Desktop window goes, and the CLI
  // still answers from the Host that is running it.
  it('with the app gone, jobs list, jobs get and runs get answer the running Job from the Host', async () => {
    const h = await hostRig()
    // The app is open when the Job is started, then it quits.
    const app = await rawClient(h.address, appHello, appAnswers(h.accountId))
    const { jobId, runId, taskId } = await runningJob(h)
    await app.close()
    await until(() => expect(h.server.hasApp()).toBe(false))

    // Nothing answers from the file here: a Host is running, so the CLI must have asked it.
    const status = okData(await astera(['status'], h.env), 'status')
    expect(status).toMatchObject({ running: true, driver: 'host', appAttached: false })

    const listed = okData(await astera(['jobs', 'list', '--status', 'running'], h.env), 'jobs list')
    const jobs = listed.jobs as Array<Record<string, unknown>>
    expect(jobs.map((j) => j.id)).toEqual([jobId])
    expect(jobs[0]).toMatchObject({ objective: 'the integration job', outcome: 'running', progress: { done: 0, total: 1 } })

    const got = okData(await astera(['jobs', 'get', '--id', jobId], h.env), 'jobs get')
    expect(got).toMatchObject({ id: jobId, outcome: 'running', run: { id: runId, jobId } })
    // `paused` is left out of a run that is not paused.
    expect((got.run as { paused?: boolean }).paused).toBeFalsy()
    // A Job with no status word of its own: `pendingStart` is gone once it runs.
    expect(got.pendingStart).toBeFalsy()

    const run = okData(await astera(['runs', 'get', '--id', runId], h.env), 'runs get')
    expect(run).toMatchObject({ id: runId, jobId, outcome: 'running', progress: { done: 0, total: 1 } })
    expect(run.paused).toBeFalsy()

    const tasks = okData(await astera(['tasks', 'list', '--run', runId], h.env), 'tasks list').tasks as Array<Record<string, unknown>>
    expect(tasks).toEqual([expect.objectContaining({ id: taskId, status: 'dispatched' })])
    // `host stop` refuses over it, with the counts in `error.details` (docs/cli.md "The Host").
    const stop = await astera(['host', 'stop'], h.env)
    expect(stop.code).toBe(6)
    expect(stop.envelope.error).toMatchObject({ code: 'CONFLICT', details: { sessions: 1, runs: 1 } })
  })

  // §48 "Integration — question" and Scenario C. **A worker cannot open a Gate itself** — `gate-create`
  // is a coordinator's command (COORDINATOR_ONLY) and a Gate cannot be made over an open Dispatch — so
  // the question a person gets from a worker in a run with no coordinator, with Astera closed, is the
  // one the Host opens when that worker ends without reporting (docs/cli.md, "A worker lost while
  // Astera is closed opens a question"). Answering it is what lets the worker go again: the Task
  // unblocks and the Host places it, with the answer recorded on the Gate. The Journal's answer row is
  // asserted in the Host journal tests below.
  it('a worker question: questions list --run shows it, questions answer records it, and the Host places the worker again', async () => {
    const h = await hostRig()
    const { runId, taskId, worker } = await runningJob(h)
    h.exitWorker(worker, 1)
    await until(() => expect(h.state().gates.filter((g) => g.status === 'open')).toHaveLength(1))

    // `runs wait` stops on it with 8, which is how a script learns there is a question.
    const waited = await astera(['runs', 'wait', '--id', runId, '--timeout-ms', '5000'], h.env)
    expect(waited.code).toBe(8)
    const questionId = waited.envelope.error?.details?.questionId as string
    expect(questionId).toMatch(/^gat_/)

    const listed = okData(await astera(['questions', 'list', '--run', runId, '--status', 'open'], h.env), 'questions list')
    expect(listed.questions).toEqual([expect.objectContaining({ id: questionId, runId, taskId, status: 'open' })])
    expect(h.state().tasks.find((t) => t.id === taskId)?.status).toBe('blocked')

    const answered = okData(
      await astera(['questions', 'answer', '--id', questionId, '--answer', 'Use the existing DB.'], h.env),
      'questions answer'
    )
    expect(answered).toMatchObject({ id: questionId, status: 'resolved', resolution: 'Use the existing DB.' })

    // The state changed, and the worker was told the only way a Host tells one: it is placed again.
    const gate = h.state().gates.find((g) => g.id === questionId)!
    expect(gate).toMatchObject({ status: 'resolved', resolution: 'Use the existing DB.' })
    expect(typeof gate.resolvedAt).toBe('string')
    await until(() => expect(h.spawns()).toHaveLength(2))
    expect(h.spawns()[1].taskId).toBe(taskId)
    await until(() => expect(h.state().tasks.find((t) => t.id === taskId)?.status).toBe('dispatched'))
    const open = okData(await astera(['questions', 'list', '--run', runId, '--status', 'open'], h.env), 'questions list')
    expect(open.questions).toEqual([])
    const shown = okData(await astera(['questions', 'get', '--id', questionId], h.env), 'questions get')
    expect(shown).toMatchObject({ status: 'resolved', resolution: 'Use the existing DB.' })
    // A second answer is not a second decision: the Gate keeps the first.
    okData(await astera(['questions', 'answer', '--id', questionId, '--answer', 'Something else'], h.env), 'questions answer again')
    expect(h.state().gates.find((g) => g.id === questionId)?.resolution).toBe('Use the existing DB.')
  })

  // §48 "Host RPC — concurrent mutation conflict". The app writes whole states quoting the version it
  // built them on (ruling F56); the CLI's `runs stop` is a command the Host commits itself. Whatever
  // order they land in, one is refused with CONFLICT or both land — never a lost update.
  it('runs stop from the CLI and a state-put from the app at the same moment: no lost update', async () => {
    const h = await hostRig()
    const app = await rawClient(h.address, appHello, appAnswers(h.accountId))
    cleanups.push(() => app.close())
    const { jobId, runId } = await runningJob(h)

    /** The app's mirror, and an edit of it: the Job's objective, a field `runs stop` never touches. */
    const mirror = async (): Promise<{ state: OrchState; version: number }> =>
      (await app.call('state-get', {})).body as { state: OrchState; version: number }
    const renamed = (s: OrchState, objective: string): OrchState => ({
      ...s,
      jobs: s.jobs.map((j) => (j.id === jobId ? { ...j, objective } : j))
    })
    const objective = (): string | undefined => h.state().jobs.find((j) => j.id === jobId)?.objective
    const paused = (): boolean => h.state().runs.find((r) => r.id === runId)?.paused === true

    // 1. The app's write lands **inside** `runs stop`: after the command has read the state and while it
    //    ends the worker, before it commits. Nothing has been committed yet, so the write is current
    //    and accepted — and the stop must then commit on top of it, not over it.
    const seen = await mirror()
    let inside: { status: number; body: unknown } | null = null
    h.hooks.release = async () => {
      inside = await app.call('state-put', { state: renamed(seen.state, 'renamed inside the stop'), version: seen.version })
    }
    const stop = await astera(['runs', 'stop', '--id', runId], h.env)
    h.hooks.release = undefined
    expect(okData(stop, 'runs stop')).toMatchObject({ runId, stopped: 1, paused: true })
    expect(inside).toMatchObject({ status: 200 })
    expect(objective()).toBe('renamed inside the stop')
    expect(paused()).toBe(true)
    expect(h.state().dispatches.filter((d) => d.closedBy === 'stop')).toHaveLength(1)

    // 2. The same write again, now that `runs stop` has committed: it was built on a state the Host
    //    has replaced, and landing it would erase the stop. Refused with CONFLICT, and the refusal
    //    carries the current state so the app can put its mirror right.
    const late = await app.call('state-put', { state: renamed(seen.state, 'too late'), version: seen.version })
    expect(late.status).toBe(409)
    expect(codeForStatus(late.status)).toBe('CONFLICT')
    expect(exitCodeFor('CONFLICT')).toBe(6)
    expect((late.body as { state: OrchState }).state.runs.find((r) => r.id === runId)?.paused).toBe(true)
    expect(objective()).toBe('renamed inside the stop')
    expect(paused()).toBe(true)

    // 3. The two sent together, with no seam to order them: one of the two outcomes above, never a
    //    third where either change is gone.
    okData(await astera(['runs', 'resume', '--id', runId], h.env), 'runs resume')
    expect(paused()).toBe(false)
    const both = await mirror()
    const [put, again] = await Promise.all([
      app.call('state-put', { state: renamed(both.state, 'raced'), version: both.version }),
      astera(['runs', 'stop', '--id', runId], h.env)
    ])
    expect(okData(again, 'runs stop')).toMatchObject({ runId, paused: true })
    expect(paused()).toBe(true)
    if (put.status === 200) expect(objective()).toBe('raced')
    else {
      expect(put.status).toBe(409)
      expect(objective()).toBe('renamed inside the stop')
    }

    // And the CLI reads what both wrote.
    expect(okData(await astera(['jobs', 'get', '--id', jobId], h.env), 'jobs get')).toMatchObject({
      objective: objective(),
      run: { id: runId, paused: true }
    })
  })

  // §48 "Integration — version mismatch". The address carries the protocol, so a Host of another
  // protocol on this profile is at another address; the CLI finds it before it answers from the file.
  it('a Host of another protocol on the same profile is exit 9 with the documented message, and the file is not read', async () => {
    const profileDir = await tempDir(PROFILE_PREFIX)
    cleanups.push(() => rmrf(profileDir))
    const seed = emptyState()
    await fs.writeFile(path.join(profileDir, 'orchestration.json'), JSON.stringify(seed))
    const other = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL + 1 })
    if (other.dirToPrepare) await fs.mkdir(other.dirToPrepare, { recursive: true, mode: 0o700 })
    const listener = net.createServer((s) => s.on('error', () => {}))
    await new Promise<void>((resolve) => listener.listen(other.address, resolve))
    cleanups.push(async () => {
      await new Promise<void>((resolve) => listener.close(() => resolve()))
      if (other.dirToPrepare) await rmrf(other.dirToPrepare)
    })
    const env = { ASTERA_PROFILE_DIR: profileDir }

    for (const argv of [['jobs', 'list'], ['status'], ['host', 'status']]) {
      const r = await astera(argv, env)
      expect(r.code, argv.join(' ')).toBe(9)
      expect(r.envelope.error).toEqual({
        code: 'VERSION_MISMATCH',
        message:
          `a Host speaking protocol ${HOST_PROTOCOL + 1} serves this profile at ${other.address}, and this astera speaks protocol ${HOST_PROTOCOL}: ` +
          'they come from different builds of Astera. That Host is running, so its state was not read from the file. ' +
          'Quit Astera, stop that Host with the build that started it, then start the build you mean to use.',
        details: { hostProtocol: HOST_PROTOCOL + 1, hostAddress: other.address, cliProtocol: HOST_PROTOCOL },
        // docs/cli.md, Exit 9: only `astera version`. `host start` would be refused with 9 while that
        // Host runs, so it is never suggested.
        nextSteps: ['astera version']
      })
    }
    // `host start` does not start a second Host on the profile.
    const start = await astera(['host', 'start'], env)
    expect(start.code).toBe(9)
    expect(start.envelope.error?.nextSteps).toEqual(['astera version'])
    // `version` never fails: it is how a person checks the two halves.
    expect(okData(await astera(['version'], env), 'version')).toMatchObject({ protocol: CLI_PROTOCOL, app: null })
  })

  // The other half of a mismatch: a Host at this CLI's own address that answers the handshake with
  // `protocol-mismatch`. It answered, so it is running and the file is not read.
  it('a Host at this address that refuses the handshake is exit 9 as well', async () => {
    const profileDir = await tempDir(PROFILE_PREFIX)
    cleanups.push(() => rmrf(profileDir))
    await fs.writeFile(path.join(profileDir, 'orchestration.json'), JSON.stringify(emptyState()))
    const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
    if (addr.dirToPrepare) await fs.mkdir(addr.dirToPrepare, { recursive: true, mode: 0o700 })
    const listener = net.createServer((s) => {
      s.on('error', () => {})
      s.once('data', () => s.end(encodeLine({ t: 'protocol-mismatch', protocol: HOST_PROTOCOL + 1 })))
    })
    await new Promise<void>((resolve) => listener.listen(addr.address, resolve))
    cleanups.push(async () => {
      await new Promise<void>((resolve) => listener.close(() => resolve()))
      if (addr.dirToPrepare) await rmrf(addr.dirToPrepare)
    })
    const r = await astera(['jobs', 'list'], { ASTERA_PROFILE_DIR: profileDir })
    expect(r.code).toBe(9)
    expect(r.envelope.error).toMatchObject({
      code: 'VERSION_MISMATCH',
      message: `the Host at ${addr.address} speaks a different protocol version — it is running, so its state was not read from the file`
    })
  })

  // §49 "spaces/non-ASCII user directory", "path quoting": a profile and a Job folder with a space and
  // Hangul in their names, through the address, `projects find`, `jobs create --cwd` and `--project`.
  it('a profile and a Job folder with spaces and Hangul work end to end', async () => {
    const project = await tempDir('astera 한글 프로젝트-')
    cleanups.push(() => rmrf(project))
    const sub = path.join(project, '하위 폴더', 'src')
    await fs.mkdir(sub, { recursive: true })
    // The app registered the project when a person opened it, then quit (projects are only ever
    // registered by the app: command.ts `projects-list`).
    const seed = ensureProject(emptyState(), { path: project, now: '2026-09-26T00:00:00.000Z' })
    const h = await hostRig({ repo: false, seed: seed.state })
    expect(h.profileDir).toContain('통합 프로필')
    // The address is the profile's own, derived from the Hangul path and still a valid one.
    expect(h.address).toBe(hostAddress({ profileDir: h.profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL }).address)

    const found = okData(await astera(['projects', 'find', '--path', sub], h.env), 'projects find')
    expect(found).toEqual({ id: seed.project.id, path: project, name: seed.project.name, addedAt: seed.project.addedAt })
    expect(seed.project.name).toContain('한글 프로젝트')

    // A Job at the project's folder is that project's.
    const job = okData(await astera(['jobs', 'create', '--objective', '한글 목표 with spaces', '--cwd', project], h.env), 'jobs create')
    expect(job).toMatchObject({ objective: '한글 목표 with spaces', cwd: project, projectId: seed.project.id, pendingStart: true })
    // A Job at a subfolder keeps the folder as given with Astera closed (docs/cli.md, `run-configs`).
    const inSub = okData(await astera(['jobs', 'create', '--objective', '하위', '--cwd', sub], h.env), 'jobs create')
    expect(inSub).toMatchObject({ cwd: sub })
    // The state file on disk holds the same strings: written and read back as UTF-8, not mangled.
    await until(async () => {
      const onDisk = JSON.parse(await fs.readFile(path.join(h.profileDir, 'orchestration.json'), 'utf8')) as OrchState
      expect(onDisk.jobs.map((j) => j.cwd).sort()).toEqual([project, sub].sort())
    })

    // The global --project, given the Hangul subfolder, finds the project and lists both its Jobs: the
    // one at the root by its projectId, the one in the subfolder by the folder it is inside.
    const inProject = okData(await astera(['--project', sub, 'jobs', 'list'], h.env), 'jobs list --project')
    expect((inProject.jobs as Array<{ id: string }>).map((j) => j.id).sort()).toEqual([job.id, inSub.id].sort())
    const got = okData(await astera(['jobs', 'get', '--id', inSub.id as string], h.env), 'jobs get')
    expect(got).toMatchObject({ objective: '하위', cwd: sub })

    // A forward-slash spelling of the same profile reaches the same Host (docs/cli.md, "Which Host").
    if (process.platform === 'win32') {
      const slashed = okData(await astera(['jobs', 'list'], { ASTERA_PROFILE_DIR: `${h.profileDir.replace(/\\/g, '/')}/` }), 'jobs list')
      expect((slashed.jobs as Array<{ id: string }>).map((j) => j.id).sort()).toEqual([job.id, inSub.id].sort())
    }
    // A folder no project holds is a 4.
    const outside = await astera(['projects', 'find', '--path', os.tmpdir()], h.env)
    expect(outside.code).toBe(4)
  })

  // §49 "Unix socket cleanup". What is left at an address is cleared only when nothing answers there.
  describe('what is left at an address', () => {
    /** A profile with one Job in its file and no Host: what an ungraceful exit leaves. */
    const orphanProfile = async (): Promise<{ profileDir: string; jobId: string; address: string; dirToPrepare: string | null }> => {
      const profileDir = await tempDir(PROFILE_PREFIX)
      cleanups.push(() => rmrf(profileDir))
      const s = emptyState()
      const jobId = 'job_left'
      const state: OrchState = {
        ...s,
        jobs: [{ id: jobId, objective: 'left behind', cwd: profileDir, createdAt: '2026-09-26T00:00:00.000Z', concurrency: 1, pendingStart: true } as OrchState['jobs'][number]]
      }
      await fs.writeFile(path.join(profileDir, 'orchestration.json'), JSON.stringify(state))
      const addr = hostAddress({ profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
      cleanups.push(async () => {
        if (addr.dirToPrepare) await rmrf(addr.dirToPrepare)
      })
      return { profileDir, jobId, address: addr.address, dirToPrepare: addr.dirToPrepare }
    }

    // posix only: a socket file outlives a process killed outright. On win32 a pipe name goes with the
    // process that made it, so there is no file to leave (server.test.ts says the same).
    it.runIf(process.platform !== 'win32')('a socket file a killed Host left is ignored by the CLI and replaced by the next Host', async () => {
      const o = await orphanProfile()
      await fs.mkdir(o.dirToPrepare!, { recursive: true, mode: 0o700 })
      // A real Host-like process that listens and is then killed with SIGKILL, so nothing unlinks.
      const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(o.address)}, () => console.log('up'))`], { stdio: ['ignore', 'pipe', 'inherit'] })
      await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()))
      const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await gone
      expect(existsSync(o.address)).toBe(true)

      // Nobody answers there, so the file answers what it can, and the socket file is left alone.
      const listed = okData(await astera(['jobs', 'list'], { ASTERA_PROFILE_DIR: o.profileDir }), 'jobs list')
      expect((listed.jobs as Array<{ id: string }>).map((j) => j.id)).toEqual([o.jobId])
      const down = await astera(['host', 'status'], { ASTERA_PROFILE_DIR: o.profileDir })
      expect(down.code).toBe(3)
      expect(existsSync(o.address)).toBe(true)

      // The next Host finds nothing answering and takes the address.
      const h = await hostRig({ repo: false, profileDir: o.profileDir })
      expect(h.logs).toContain('a socket file was left behind by an earlier Host — replaced')
      const up = okData(await astera(['host', 'status'], h.env), 'host status')
      expect(up).toMatchObject({ running: true, version: '9.9.9' })
    })

    it('a live Host is never cleared: a second Host steps aside and the first keeps answering', async () => {
      const o = await orphanProfile()
      const h = await hostRig({ repo: false, profileDir: o.profileDir })
      const addr = hostAddress({ profileDir: o.profileDir, platform: process.platform, tmpDir: os.tmpdir(), protocol: HOST_PROTOCOL })
      await expect(
        startHostServer({
          address: addr.address,
          dirToPrepare: addr.dirToPrepare,
          version: '0.0.1',
          idleMs: 60_000,
          onIdle: () => {},
          log: { write: () => {}, close: () => {} }
        })
      ).rejects.toThrow(ADDRESS_TAKEN)
      const up = okData(await astera(['host', 'status'], h.env), 'host status')
      expect(up).toMatchObject({ running: true, version: '9.9.9' })
      if (process.platform !== 'win32') expect(existsSync(addr.address)).toBe(true)
    })

    // An address that accepts and never says hello is somebody who is running and not answering: it is
    // neither cleared by a new Host nor read around by the CLI, which says 7.
    it('an address that accepts and never answers is not cleared, and the CLI does not read the file around it', async () => {
      const o = await orphanProfile()
      if (o.dirToPrepare) await fs.mkdir(o.dirToPrepare, { recursive: true, mode: 0o700 })
      const held = new Set<net.Socket>()
      const wedged = net.createServer((s) => {
        held.add(s)
        s.on('error', () => {})
        s.on('close', () => held.delete(s))
      })
      await new Promise<void>((resolve) => wedged.listen(o.address, resolve))
      // `close` waits for every connection, and this server never ends one itself.
      cleanups.push(async () => {
        for (const s of held) s.destroy()
        await new Promise<void>((resolve) => wedged.close(() => resolve()))
      })

      const r = await astera(['jobs', 'list'], { ASTERA_PROFILE_DIR: o.profileDir })
      expect(r.code).toBe(7)
      expect(r.envelope.error).toMatchObject({ code: 'TIMEOUT' })
      expect(r.stdout).not.toContain(o.jobId)
      await expect(
        startHostServer({
          address: o.address,
          dirToPrepare: o.dirToPrepare,
          version: '0.0.1',
          idleMs: 60_000,
          onIdle: () => {},
          log: { write: () => {}, close: () => {} }
        })
      ).rejects.toThrow(ADDRESS_TAKEN)
      if (process.platform !== 'win32') expect(existsSync(o.address)).toBe(true)
    })

    it('an address nobody holds: the file answers the reads, and a command that acts is exit 3', async () => {
      const o = await orphanProfile()
      const listed = okData(await astera(['jobs', 'list'], { ASTERA_PROFILE_DIR: o.profileDir }), 'jobs list')
      expect((listed.jobs as Array<{ id: string }>).map((j) => j.id)).toEqual([o.jobId])
      const acts = await astera(['jobs', 'run', '--id', o.jobId], { ASTERA_PROFILE_DIR: o.profileDir })
      expect(acts.code).toBe(3)
      expect(acts.envelope.error?.code).toBe('HOST_NOT_RUNNING')
    })
  })
})

describe('the Job Journal with Astera closed (Host journal)', { timeout: 60_000 }, () => {
  it('a question answered from the CLI lands one GATE_RESOLVED row, and says the CLI did it', async () => {
    const h = await hostRig({ continuity: true })
    const { runId, taskId, worker } = await runningJob(h)
    h.exitWorker(worker, 1)
    await until(() => expect(h.state().gates.filter((g) => g.status === 'open')).toHaveLength(1))
    const questionId = h.state().gates.find((g) => g.status === 'open')!.id
    okData(await astera(['questions', 'answer', '--id', questionId, '--answer', 'Use the existing DB.'], h.env), 'questions answer')
    okData(await astera(['questions', 'answer', '--id', questionId, '--answer', 'Something else'], h.env), 'questions answer again')
    const rows = h.journalRows(runId)
    expect(rows.filter((e) => e.type === 'GATE_RESOLVED')).toEqual([
      expect.objectContaining({ taskId, actor: { surface: 'cli' }, payload: expect.objectContaining({ gateId: questionId, resolution: 'Use the existing DB.' }) })
    ])
    // Who did the rest: the CLI started the run, the Host placed the worker and opened the question.
    expect(rows.find((e) => e.type === 'JOB_RUN_STARTED')?.actor).toEqual({ surface: 'cli' })
    expect(rows.find((e) => e.type === 'ATTEMPT_START_REQUESTED')?.actor).toEqual({ surface: 'host' })
    expect(rows.find((e) => e.type === 'TASK_WAITING_INPUT')?.actor).toEqual({ surface: 'host' })
    expect(rows.some((e) => e.type === 'PROMPT_WRITE_REQUESTED')).toBe(false) // the rig's spawner is fake; the real one is Task 5's test
  })

  it('a worker the restart lost is a journal row written by the Host, and runs follow prints it', async () => {
    const seeded = lostWorkerSeed() // a Job, a Run, a Task and an open Dispatch on 'ses_gone', built with the pure layer
    const h = await hostRig({ continuity: true, seed: seeded.state })
    const r = await astera(['runs', 'follow', '--id', seeded.runId, '--timeout-ms', '1500', '--no-keepalive'], h.env)
    const events = r.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { data?: { event?: { kind: string; taskId?: string } } })
      .flatMap((e) => (e.data?.event ? [e.data.event] : []))
    expect(events).toContainEqual(expect.objectContaining({ kind: 'runtime-lost', taskId: seeded.taskId }))
    expect(h.journalRows(seeded.runId).find((e) => e.type === 'ATTEMPT_LOST')?.actor).toEqual({ surface: 'host' })
  })

  it('an older app attached holds the Host off; once it leaves the Host journals again (J2, P9)', async () => {
    const h = await hostRig({ continuity: true })
    const { runId } = await runningJob(h)
    const older = await rawClient(
      h.address,
      { t: 'hello', protocol: HOST_PROTOCOL, app: '1.3.40', role: 'app', yields: [HOST_YIELD_WORKTREES, HOST_YIELD_DISPATCH] },
      appAnswers(h.accountId)
    )
    okData(await astera(['runs', 'stop', '--id', runId], h.env), 'runs stop')
    expect(h.journalRows(runId).some((e) => e.type === 'JOB_RUN_PAUSED')).toBe(false)
    await older.close()
    await until(() => expect(h.server.hasApp()).toBe(false))
    okData(await astera(['runs', 'resume', '--id', runId], h.env), 'runs resume')
    await until(() => expect(h.journalRows(runId).map((e) => e.type)).toContain('JOB_RUN_RESUMED'))
  })
})
