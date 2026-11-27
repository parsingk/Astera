// The external agent worker (Phase 5 A1): the agent is a real child process (the scripted fake ACP agent), the Dispatch is
// opened by the real `external-work-start` and the report, the questions and the answers go through the real command
// handler, so what follows a turn's end is the real loop.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { allowOptionOf, buildExternalWorkSpec, createExternalWorks, optionForAnswer, type ExternalWorkDeps, type ExternalWorks } from './externalWork'
import { handleCommand, type OrchServerDeps } from '../command'
import { APP_CALLER, HOST_CALLER } from '../../host/driver'
import { createJob, createTask, emptyState, startJobRun, type OrchState } from '../state'
import { nodeProcFactory } from '../../sessions/nodeProcFactory'
import { removeFixture, waitPidsGone } from '../../testFixtures'
import type { ExternalReviewer } from '../../settings/externalReviewers'
import type { ProcLike } from '../../sessions/proc'
import type { AgentPermissionMode } from '../../types'

const NOW = '2026-11-27T00:00:00.000Z'
const AGENT_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../acp/__fixtures__/fakeAgent.mjs')
const AGENT: ExternalReviewer = { id: 'ext_0a1b2c3d', name: 'Fake Agent', command: 'fake-agent', args: [] }

const unwrap = <T>(r: { ok: boolean } & Record<string, unknown>): { state: OrchState; value: T } => {
  if (!r.ok) throw new Error(`expected ok, got ${String(r.error)}`)
  return { state: r.state as OrchState, value: r.value as T }
}
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

interface RigOpts {
  mode?: string
  permission?: AgentPermissionMode
  agents?: ExternalReviewer[]
  timeoutMs?: number
  agentArgs?: string[]
}

function rig(o: RigOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astera-extwork-'))
  dirs.push(dir)
  const tree = path.join(dir, 'tree')
  const specsDir = path.join(dir, 'specs')
  fs.mkdirSync(tree)
  fs.mkdirSync(specsDir)
  const planned = unwrap<{ id: string }>(createJob(emptyState(), { objective: 'o', cwd: tree }, NOW) as never)
  const started = unwrap<{ id: string }>(startJobRun(planned.state, planned.value.id, NOW) as never)
  const t = unwrap<{ id: string }>(
    createTask(started.state, { runId: started.value.id, title: 'Write the file', spec: 'write work.txt', deps: [], externalAgentId: AGENT.id }, NOW) as never
  )
  let state = t.state
  const taskId = t.value.id
  const logs: string[] = []
  const transcript: string[] = []
  const spawned: { args: string[]; cwd?: string }[] = []

  // eslint-disable-next-line prefer-const
  let works: ExternalWorks
  const deps = {
    getState: () => state,
    setState: async (next: OrchState) => void (state = next),
    now: () => NOW,
    lang: () => 'en' as const,
    startReview: () => {},
    startValidation: () => {},
    startExternalWork: (a: { dispatchId: string }) => works.start(a)
  } as unknown as OrchServerDeps

  const external: ExternalWorkDeps = {
    settings: async () => ({ reviewers: o.agents ?? [AGENT], reviewBy: null }),
    handle: (cmd, args) => handleCommand(deps, { sessionId: HOST_CALLER }, cmd, args),
    spawn: (file, args, opts) => {
      const proc: ProcLike = nodeProcFactory(file, args, opts)
      spawned.push({ args, cwd: opts.cwd })
      if (proc.pid > 0) pids.add(proc.pid)
      return proc
    },
    env: () => ({ PATH: process.env.PATH }),
    platform: process.platform,
    clientVersion: '0.0.0-test',
    writeFile: async (p, text) => void fs.writeFileSync(p, text),
    appendLog: (_p, line) => void transcript.push(line),
    pruneReviewLogs: () => {},
    treeState: async () => 'same',
    timeoutMs: o.timeoutMs ?? 20_000,
    pollMs: 50,
    askMs: 150,
    permissionMode: async () => o.permission ?? 'yolo',
    resolve: async () => ({ ok: true as const, file: process.execPath, args: [AGENT_JS, o.mode ?? 'works', ...(o.agentArgs ?? [])] })
  }
  works = createExternalWorks({ getState: () => state, setState: async (n) => void (state = n), now: () => NOW, log: (m) => logs.push(m), specsDir, external })
  drivers.push(works)

  const start = async (): Promise<string> => {
    const r = await handleCommand(deps, { sessionId: HOST_CALLER }, 'external-work-start', { task: taskId })
    if (r.status !== 200) throw new Error(`external-work-start answered ${r.status}: ${JSON.stringify(r.body)}`)
    return (r.body as { dispatchId: string }).dispatchId
  }
  return {
    dir, tree, specsDir, taskId, logs, transcript, spawned, works, deps, start,
    state: () => state,
    set: (next: OrchState) => void (state = next),
    task: () => state.tasks.find((x) => x.id === taskId)!,
    dispatch: (id: string) => state.dispatches.find((x) => x.id === id)!
  }
}

describe('external agent work', () => {
  it('works a Task end to end in yolo: the agent is allowed, writes in the Run folder, and its turn is the report', async () => {
    const r = rig({ permission: 'yolo' })
    const id = await r.start()
    await until(() => r.task().status === 'completed', 'the Task to complete')
    await r.works.idle()
    expect(fs.readFileSync(path.join(r.tree, 'work.txt'), 'utf8')).toBe('worked')
    expect(r.spawned[0].cwd).toBe(r.tree)
    const d = r.dispatch(id)
    expect(d).toMatchObject({ outcome: 'succeeded', externalAgent: { id: AGENT.id, name: 'Fake Agent' } })
    expect(fs.readFileSync(d.specPath, 'utf8')).toContain('write work.txt')
    const done = r.state().messages.find((m) => m.type === 'worker_done' && m.dispatchId === id)!
    expect(done.subject).toBe('Wrote work.txt')
    expect(done.body).toContain('Nothing is left.')
    expect(r.transcript.some((l) => l.includes('permission edit Edit work.txt: allow-once'))).toBe(true)
    expect(r.state().messages.some((m) => m.type === 'question')).toBe(false)
  })

  it('asks the person in manual, keeps waiting past one ask, and answers the agent with what they picked', async () => {
    const r = rig({ permission: 'manual' })
    const id = await r.start()
    await until(() => r.state().messages.some((m) => m.type === 'question' && m.dispatchId === id), 'the permission question')
    const q = r.state().messages.find((m) => m.type === 'question' && m.dispatchId === id)!
    expect(q.options).toEqual(['Yes', 'No'])
    expect(q.body).toContain('Edit work.txt')
    // Longer than one ask: the driver asks again with --resume instead of giving up
    await sleep(400)
    expect(r.task().status).toBe('dispatched')
    const answered = await handleCommand(r.deps, { sessionId: APP_CALLER }, 'reply', { id: q.id, body: 'Yes' })
    expect(answered.status).toBe(200)
    await until(() => r.task().status === 'completed', 'the Task to complete')
    expect(fs.existsSync(path.join(r.tree, 'work.txt'))).toBe(true)
    expect(r.state().messages.filter((m) => m.type === 'question')).toHaveLength(1)
  })

  it('asks two requests made at once one after the other, with the clock stopped while either waits', async () => {
    const r = rig({ mode: 'asks-twice', permission: 'manual', timeoutMs: 1500 })
    const id = await r.start()
    const questions = () => r.state().messages.filter((m) => m.type === 'question' && m.dispatchId === id)
    await until(() => questions().length === 1, 'the first question')
    await sleep(1000)
    expect(questions()).toHaveLength(1)
    await handleCommand(r.deps, { sessionId: APP_CALLER }, 'reply', { id: questions()[0].id, body: 'Yes' })
    await until(() => questions().length === 2, 'the second question')
    await sleep(1000)
    expect(r.task().status).toBe('dispatched')
    await handleCommand(r.deps, { sessionId: APP_CALLER }, 'reply', { id: questions()[1].id, body: 'No' })
    await until(() => r.task().status === 'completed', 'the Task to complete')
    expect(r.state().messages.find((m) => m.type === 'worker_done' && m.dispatchId === id)?.subject).toBe('outcomes:allow-once,reject')
  })

  it('a refusal in manual reaches the agent, and its FAILED report fails the Task', async () => {
    const r = rig({ permission: 'manual' })
    const id = await r.start()
    await until(() => r.state().messages.some((m) => m.type === 'question' && m.dispatchId === id), 'the permission question')
    const q = r.state().messages.find((m) => m.type === 'question' && m.dispatchId === id)!
    await handleCommand(r.deps, { sessionId: APP_CALLER }, 'reply', { id: q.id, body: 'No' })
    await until(() => r.task().status === 'failed', 'the Task to fail')
    expect(fs.existsSync(path.join(r.tree, 'work.txt'))).toBe(false)
    expect(r.dispatch(id).outcome).toBe('failed')
  })

  it('reads the report from the agent’s last message, not from what it said before its tool calls', async () => {
    const r = rig({ mode: 'narrates-then-fails' })
    const id = await r.start()
    await until(() => r.task().status === 'failed', 'the Task to fail')
    const done = r.state().messages.find((m) => m.type === 'worker_done' && m.dispatchId === id)!
    expect(done.subject).toBe('FAILED: a.txt is missing')
    expect(done.body).not.toContain('I will look')
    expect(r.transcript.some((l) => l.includes('I will look at the files first.'))).toBe(true)
  })

  it('a first line that only starts like a failure is no failure: the mark is FAILED: as the brief writes it', async () => {
    const r = rig({ mode: 'approve', agentArgs: ['--message', 'Failed: 0, passed: 12'] })
    await r.start()
    await until(() => r.task().status === 'completed', 'the Task to complete')
  })

  it('a crash ends the Dispatch unproven and puts the Task to a person, who answers to have it worked again', async () => {
    const r = rig({ mode: 'exit-mid-turn' })
    const id = await r.start()
    await until(() => r.task().status === 'blocked', 'the Gate')
    await r.works.idle()
    const d = r.dispatch(id)
    expect(d.endedAt).toBeDefined()
    expect(d.outcome).toBeUndefined()
    expect(d.workerState).toBe('outcome_unknown')
    const gate = r.state().gates.find((g) => g.taskId === r.taskId && g.status === 'open')!
    expect(gate.question).toContain('the external agent Fake Agent stopped before it finished (exit 3)')
    expect(gate.question).toContain('out of memory')
    const resolved = await handleCommand(r.deps, { sessionId: APP_CALLER }, 'gate-resolve', { id: gate.id, resolution: 'retry' })
    expect(resolved.status).toBe(200)
    expect(r.task().status).toBe('ready')
  })

  it('an agent no longer registered is a Gate, and nothing is spawned', async () => {
    const r = rig({ agents: [] })
    await r.start()
    await until(() => r.task().status === 'blocked', 'the Gate')
    expect(r.spawned).toHaveLength(0)
    expect(r.state().gates[0].question).toContain('is not registered in Settings, Agents any more')
  })

  it('a turn that ends with anything but end_turn is a Gate', async () => {
    const r = rig({ mode: 'stop-reason', agentArgs: ['--stop-reason', 'refusal'] })
    await r.start()
    await until(() => r.task().status === 'blocked', 'the Gate')
    expect(r.state().gates[0].question).toContain('ended its turn with refusal')
  })

  it('runs out of its budget into a Gate', async () => {
    const r = rig({ mode: 'hang-prompt', timeoutMs: 300 })
    await r.start()
    await until(() => r.task().status === 'blocked', 'the Gate')
    expect(r.state().gates[0].question).toContain('did not finish in 1 minutes')
  })

  it('a Dispatch closed under it (a Run stopped) ends the work silently and kills the agent', async () => {
    const r = rig({ mode: 'hang-prompt' })
    const id = await r.start()
    await until(() => r.transcript.some((l) => l.includes('agent:')), 'the session to open')
    const pid = [...pids].at(-1)!
    r.set({ ...r.state(), dispatches: r.state().dispatches.map((x) => (x.id === id ? { ...x, endedAt: NOW, workerState: 'stopped' as const } : x)) })
    await r.works.idle()
    await until(() => !alive(pid), 'the agent to be gone')
    expect(r.state().gates).toHaveLength(0)
    expect(r.task().status).toBe('dispatched')
  })

  it('a waiting permission question ends with the Dispatch, and nobody is asked twice', async () => {
    const r = rig({ permission: 'manual' })
    const id = await r.start()
    await until(() => r.state().messages.some((m) => m.type === 'question' && m.dispatchId === id), 'the permission question')
    r.set({ ...r.state(), dispatches: r.state().dispatches.map((x) => (x.id === id ? { ...x, endedAt: NOW, workerState: 'stopped' as const } : x)) })
    await r.works.idle()
    expect(r.state().gates).toHaveLength(0)
    expect(r.state().messages.filter((m) => m.type === 'question')).toHaveLength(1)
    expect(fs.existsSync(path.join(r.tree, 'work.txt'))).toBe(false)
  })

  it('counts its runs in flight for the orphan close, and a dispose ends them without a record', async () => {
    const r = rig({ mode: 'hang-prompt' })
    const id = await r.start()
    expect([...r.works.inFlight()]).toEqual([id])
    r.works.dispose()
    await r.works.idle()
    expect(r.works.inFlight().size).toBe(0)
    expect(r.state().gates).toHaveLength(0)
    expect(r.dispatch(id).endedAt).toBeUndefined()
  })
})

describe('external work helpers', () => {
  const req = { kind: 'edit', title: 'Edit a', options: [
    { optionId: 'aa', kind: 'allow_always', name: 'Always' },
    { optionId: 'a1', kind: 'allow_once', name: 'Yes, once' },
    { optionId: 'r1', kind: 'reject_once', name: 'No' }
  ] }

  it('yolo picks the narrowest allow, and a reject when no allow is offered', () => {
    expect(allowOptionOf(req)).toBe('a1')
    expect(allowOptionOf({ options: [{ optionId: 'r1', kind: 'reject_once' }] })).toBe('r1')
    expect(allowOptionOf({ options: [] })).toBeNull()
  })

  it('maps a person’s answer back to the option, by its label without commas or by id, and anything else rejects', () => {
    expect(optionForAnswer(req, 'Yes  once')).toBe('a1')
    expect(optionForAnswer(req, 'aa')).toBe('aa')
    expect(optionForAnswer(req, 'whatever')).toBe('r1')
  })

  it('the brief asks for a commit only in a worktree, and says the turn is the report', () => {
    const inTree = buildExternalWorkSpec({ title: 'T', spec: 'S', committing: true })
    expect(inTree).toContain('## Commit obligation')
    expect(inTree).toContain('begin that message with FAILED:')
    expect(buildExternalWorkSpec({ title: 'T', spec: 'S', committing: false })).not.toContain('Commit obligation')
  })
})
