// The Phase 5 gate (spec §7, design "Gate"): a Task an external agent works, end to end through the real pieces. The Task
// is added through `tasks add --external-agent` (the CLI's and MCP's command), the real dispatch loop places it through
// `external-work-start`, the real driver runs the scripted fake ACP agent in the Run worktree, and its report, its
// permission question and the person's answer go through the real command layer. What the app shows is read from the
// real snapshot. Claude and codex workers are the rest of the suite, unchanged.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDispatchLoop, type DispatchLoop, type DispatchLoopContext } from './dispatchLoop'
import { createExternalWorks, type ExternalWorks } from './externalWork'
import { handleCommand, type OrchServerDeps } from '../command'
import { APP_CALLER, HOST_CALLER } from '../../host/driver'
import { createJob, emptyState, startJobRun, type OrchState } from '../state'
import { snapshotFor } from '../view'
import { nodeProcFactory } from '../../sessions/nodeProcFactory'
import { removeFixture, waitPidsGone } from '../../testFixtures'
import type { AgentPermissionMode } from '../../types'

const AGENT_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../acp/__fixtures__/fakeAgent.mjs')
const AGENT = { id: 'ext_0a1b2c3d', name: 'Fake OpenCode', command: 'fake-opencode', args: [] }

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (f: () => boolean, what: string, ms = 20_000): Promise<void> => {
  const t = Date.now()
  while (!f()) {
    if (Date.now() - t > ms) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const dirs: string[] = []
const pids = new Set<number>()
const drivers: ExternalWorks[] = []
afterEach(async () => {
  for (const w of drivers.splice(0)) w.dispose()
  for (const pid of pids) if (pid > 0 && alive(pid)) process.kill(pid)
  await waitPidsGone(pids)
  pids.clear()
  for (const d of dirs.splice(0)) await removeFixture(d)
})

function gate(o: { mode?: string; permission?: AgentPermissionMode } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astera-extgate-'))
  dirs.push(dir)
  const project = path.join(dir, 'project')
  const worktree = path.join(dir, 'run-worktree')
  const specsDir = path.join(dir, 'specs')
  for (const d of [project, worktree, specsDir]) fs.mkdirSync(d)
  const now = (): string => new Date().toISOString()

  const job = createJob(emptyState(), { objective: 'write the file', cwd: project }, now())
  if (!job.ok) throw new Error(job.error)
  const withAuto: OrchState = { ...job.state, jobs: job.state.jobs.map((j) => ({ ...j, autoDispatch: true })) }
  const run = startJobRun(withAuto, job.value.id, now())
  if (!run.ok) throw new Error(run.error)
  let state = run.state
  const runId = run.value.id

  // eslint-disable-next-line prefer-const
  let loop: DispatchLoop
  // eslint-disable-next-line prefer-const
  let works: ExternalWorks
  const deps = {
    getState: () => state,
    // As the app's and the Host's commit hook: replace, then run the loop again
    setState: async (next: OrchState) => {
      state = next
      void loop.run().catch(() => {})
    },
    now,
    lang: () => 'en' as const,
    listAccounts: async () => [],
    log: () => {},
    runningSessions: () => 0,
    appVersion: () => '1.0.0',
    startReview: () => {},
    startValidation: () => {},
    startExternalWork: (a: { dispatchId: string }) => works.start(a)
  } as unknown as OrchServerDeps
  const forked: string[] = []
  const ctx: DispatchLoopContext = {
    handle: (cmd, args) => handleCommand(deps, { sessionId: HOST_CALLER }, cmd, args),
    getState: () => state,
    accounts: () => [],
    loginStatus: async () => false,
    lang: () => 'en',
    forkRunWorktree: async (a) => {
      forked.push(a.repoPath)
      return worktree
    },
    integrate: async () => ({ kind: 'clean' }) as never,
    reap: async () => true,
    isRegisteredWorktree: () => false,
    sessionAlive: () => false,
    sessionBusy: () => false,
    typeInto: () => {},
    mayStart: () => true,
    log: () => {},
    nowMs: () => Date.now()
  }
  loop = createDispatchLoop(ctx)
  works = createExternalWorks({
    getState: () => state,
    setState: (n) => deps.setState(n),
    now,
    log: () => {},
    specsDir,
    external: {
      settings: async () => ({ reviewers: [AGENT], reviewBy: null }),
      handle: (cmd, args) => handleCommand(deps, { sessionId: HOST_CALLER }, cmd, args),
      spawn: (file, args, opts) => {
        const proc = nodeProcFactory(file, args, opts)
        if (proc.pid > 0) pids.add(proc.pid)
        return proc
      },
      env: () => ({ PATH: process.env.PATH }),
      platform: process.platform,
      clientVersion: '0.0.0-gate',
      writeFile: async (p, text) => void fs.writeFileSync(p, text),
      appendLog: (p, line) => {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.appendFileSync(p, `${line}\n`)
      },
      pruneReviewLogs: () => {},
      treeState: async () => 'same',
      pollMs: 50,
      askMs: 200,
      permissionMode: async () => o.permission ?? 'yolo',
      resolve: async () => ({ ok: true as const, file: process.execPath, args: [AGENT_JS, o.mode ?? 'works'] })
    }
  })
  drivers.push(works)

  const addTask = async (): Promise<string> => {
    const r = await handleCommand(deps, { sessionId: '' }, 'tasks-add', { run: runId, spec: 'write work.txt', title: 'Write the file', externalAgent: AGENT.id })
    if (r.status !== 200) throw new Error(`tasks add answered ${r.status}: ${JSON.stringify(r.body)}`)
    return (r.body as { id: string }).id
  }
  const snapshotTask = (taskId: string) =>
    snapshotFor(state, project, () => false, [], () => null, () => true).runs.flatMap((r) => r.tasks).find((t) => t.id === taskId)
  return {
    project, worktree, runId, deps, forked, works, addTask, snapshotTask,
    state: () => state,
    task: (id: string) => state.tasks.find((t) => t.id === id)!,
    dispatchOf: (id: string) => state.dispatches.find((d) => d.taskId === id)
  }
}

describe('Phase 5 gate: an external agent works a Task', () => {
  it('end to end in yolo: placed by the loop in the Run worktree, its turn reported, the Task completed, its transcript kept', async () => {
    const g = gate({ permission: 'yolo' })
    const taskId = await g.addTask()
    await until(() => g.task(taskId).status === 'completed', 'the Task to complete')
    await g.works.idle()
    expect(g.forked).toEqual([g.project])
    expect(fs.readFileSync(path.join(g.worktree, 'work.txt'), 'utf8')).toBe('worked')
    expect(fs.existsSync(path.join(g.project, 'work.txt'))).toBe(false)
    const d = g.dispatchOf(taskId)!
    expect(d).toMatchObject({ cwd: g.worktree, accountId: '', outcome: 'succeeded', externalAgent: { id: AGENT.id, name: 'Fake OpenCode' } })
    const transcript = fs.readFileSync(path.join(path.dirname(d.specPath), '..', 'review-logs', `${taskId}-${d.id}.log`), 'utf8')
    expect(transcript).toContain('permission edit Edit work.txt: allow-once')
    expect(transcript).toContain('Wrote work.txt')
    expect(g.state().messages.find((m) => m.type === 'worker_done' && m.dispatchId === d.id)?.subject).toBe('Wrote work.txt')
  })

  it('in manual, the person is asked in the app, an agent session cannot answer for them, and their answer reaches the agent', async () => {
    const g = gate({ permission: 'manual' })
    const taskId = await g.addTask()
    await until(() => g.snapshotTask(taskId)?.permissionAsk !== undefined, 'the permission request in the app')
    const ask = g.snapshotTask(taskId)!.permissionAsk!
    expect(ask.options).toEqual(['Yes', 'No'])
    expect(g.snapshotTask(taskId)!.externalAgent).toEqual({ id: AGENT.id, name: 'Fake OpenCode' })
    // Nobody answers it for the person: the loop's pass leaves it, and an agent session is refused
    await sleep(400)
    expect(g.snapshotTask(taskId)!.permissionAsk?.id).toBe(ask.id)
    expect((await handleCommand(g.deps, { sessionId: 'some-coordinator' }, 'reply', { id: ask.id, body: 'Yes' })).status).toBe(403)
    expect((await handleCommand(g.deps, { sessionId: APP_CALLER }, 'reply', { id: ask.id, body: 'Yes' })).status).toBe(200)
    await until(() => g.task(taskId).status === 'completed', 'the Task to complete')
    expect(fs.existsSync(path.join(g.worktree, 'work.txt'))).toBe(true)
  })

  it('a crash ends the run as a Gate a person answers, and the loop places the Task again', async () => {
    const g = gate({ mode: 'exit-mid-turn' })
    const taskId = await g.addTask()
    await until(() => g.task(taskId).status === 'blocked', 'the Gate')
    await g.works.idle()
    const open = g.state().gates.find((x) => x.taskId === taskId && x.status === 'open')!
    expect(open.question).toContain('stopped before it finished')
    const first = g.dispatchOf(taskId)!.id
    expect((await handleCommand(g.deps, { sessionId: APP_CALLER }, 'gate-resolve', { id: open.id, resolution: 'retry' })).status).toBe(200)
    await until(() => g.state().dispatches.filter((d) => d.taskId === taskId).length === 2, 'the second attempt')
    expect(g.state().dispatches.find((d) => d.taskId === taskId && d.id !== first)?.externalAgent?.id).toBe(AGENT.id)
  })

  it('a stopped Run ends the agent with no Gate', async () => {
    const g = gate({ mode: 'hang-prompt' })
    const taskId = await g.addTask()
    await until(() => g.dispatchOf(taskId) !== undefined && g.works.inFlight().size === 1, 'the agent to run')
    await until(() => pids.size === 1, 'the agent process')
    const pid = [...pids][0]
    expect((await handleCommand(g.deps, { sessionId: APP_CALLER }, 'runs-stop', { id: g.runId })).status).toBe(200)
    await g.works.idle()
    await until(() => !alive(pid), 'the agent to be gone')
    expect(g.state().gates).toEqual([])
    expect(g.dispatchOf(taskId)!.endedAt).toBeDefined()
  })
})
