// The external review runner (external reviewers design 3.4 to 3.6), through createReviewStarter. The rig is the one of
// review.test.ts extended with `external`: the agent is a real child process (the scripted fake ACP agent) and the verdict
// goes through the real command handler as the app's own caller, so the loop after a verdict is the real one.
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReviewStarter, type ExternalReviewDeps, type ReviewContext } from './review'
import { specFileName } from './coordinator'
import { handleCommand, type OrchServerDeps } from '../command'
import { APP_CALLER } from '../../host/driver'
import { applyWorkerDone, createJob, createTask, emptyState, openDispatch, startJobRun, type OrchState } from '../state'
import { nodeProcFactory } from '../../sessions/nodeProcFactory'
import { resolveAgentCommand } from '../../acp/spawn'
import { VERDICT_RETRY_PROMPT } from './externalVerdict'
import type { ExternalReviewer, ReviewerSettings } from '../../settings/externalReviewers'
import type { Account } from '../../types'
import type { ProcLike } from '../../sessions/proc'

const NOW = '2026-09-24T00:00:00.000Z'
const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../acp/__fixtures__/fakeAgent.mjs')
const REVIEWER: ExternalReviewer = { id: 'ext_0a1b2c3d', name: 'Fake Agent', command: 'fake-agent', args: [] }

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
const gone = (pid: number): Promise<void> => until(() => !alive(pid), `process ${pid} to be gone`)

const dirs: string[] = []
const pids = new Set<number>()
const rigs: { start: { disposeExternal(): void } }[] = []
afterEach(() => {
  for (const r of rigs.splice(0)) r.start.disposeExternal()
  // Only processes this test file spawned
  for (const pid of pids) if (alive(pid)) process.kill(pid)
  pids.clear()
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

const claude = (id: string): Account => ({ id, label: id, configDir: `/cfg/${id}`, color: '#000', createdAt: NOW, provider: 'claude' })
const codex = (id: string): Account => ({ ...claude(id), provider: 'codex' })

/** The final message of a verdict, as an agent writes it: prose, then the fenced block. */
const verdictMessage = (v: Record<string, unknown>): string => `I read the change.\n\n\`\`\`json\n${JSON.stringify(v)}\n\`\`\``
const APPROVED = verdictMessage({ outcome: 'approved', summary: 'Looks right.\nSecond line.', issues: [] })
const REJECTED = verdictMessage({
  outcome: 'rejected',
  summary: 'Misses the empty case.',
  issues: [{ severity: 'high', title: 'empty input', description: 'crashes on an empty list', file: 'src/x.ts', line: 3 }]
})

interface RigOpts {
  mode?: string
  message?: string
  retryMessage?: string
  convergence?: boolean
  implSandboxKind?: 'sandbox' | 'deny-only'
  reviewBy?: string | null
  reviewer?: Partial<ExternalReviewer>
  /** What the folder's tracked state answers, in order; the last one repeats. */
  trees?: (string | null)[]
  /** Another Dispatch that worked in the folder */
  other?: { endedAt?: string }
  timeoutMs?: number
  pollMs?: number
  /** Replaces the real command handler's answer to the settle */
  settleAnswer?: { status: number; body: unknown }
  settingsThrow?: string
  rangeDiff?: ReviewContext['rangeDiff']
}

function rig(o: RigOpts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astera-extreview-'))
  dirs.push(dir)
  const implCwd = path.join(dir, 'tree')
  const specsDir = path.join(dir, 'specs')
  fs.mkdirSync(implCwd)
  fs.mkdirSync(specsDir)
  const record = path.join(dir, 'prompts.jsonl')

  const planned = unwrap<{ id: string }>(createJob(emptyState(), { objective: 'o', cwd: implCwd, ...(o.convergence ? { convergence: {} } : {}) }, NOW) as never)
  const started0 = unwrap<{ id: string }>(startJobRun(planned.state, planned.value.id, NOW) as never)
  const t = unwrap<{ id: string }>(createTask(started0.state, { runId: started0.value.id, title: 'T', spec: 'do it', deps: [], reviewRequested: true }, NOW) as never)
  const d = unwrap<{ id: string }>(
    openDispatch(t.state, { taskId: t.value.id, provider: 'claude', accountId: 'c1', sessionId: 'sess1', cwd: implCwd, specPath: path.join(dir, 'spec.md') }, NOW) as never
  )
  let state = unwrap(applyWorkerDone(d.state, { taskId: t.value.id, dispatchId: d.value.id, outcome: 'succeeded', subject: 's', body: 'b' }, NOW) as never).state
  const taskId = t.value.id
  if (state.tasks.find((x) => x.id === taskId)?.status !== 'reviewing') throw new Error('rig: not reviewing')
  if (o.implSandboxKind) {
    const sandboxKind = o.implSandboxKind
    state = { ...state, dispatches: state.dispatches.map((x) => (x.id === d.value.id ? { ...x, sandboxKind } : x)) }
  }
  if (o.other)
    state = {
      ...state,
      dispatches: [
        ...state.dispatches,
        {
          id: 'dsp_other', taskId: 'tsk_other', provider: 'codex', accountId: 'x1', sessionId: 'sess_other', cwd: implCwd,
          specPath: path.join(dir, 'other.md'), startedAt: NOW, workerState: 'ready', retained: false,
          ...(o.other.endedAt ? { endedAt: o.other.endedAt, outcome: 'succeeded' as const } : {})
        }
      ]
    }

  const history: OrchState[] = []
  const logs: string[] = []
  const acpLines: { path: string; line: string }[] = []
  const repairs: string[] = []
  const handled: { cmd: string; args: Record<string, unknown> }[] = []
  const spawned: { file: string; args: string[]; env: Record<string, string | undefined> }[] = []
  const startWorker = vi.fn(async (a: Parameters<ReviewContext['startWorker']>[0]) => ({ sessionId: 's-review', cwd: a.runCwd, specPath: path.join(specsDir, 'x.md') }))

  const deps = {
    getState: () => state,
    setState: async (next: OrchState) => void (state = next),
    now: () => NOW,
    readReviewFile: async (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
    repairTargetFor: () => ({ kind: 'same-session' as const, sessionId: 'sess1', cwd: implCwd, provider: 'claude' as const, accountId: 'c1' }),
    startRepair: (a: { dispatchId: string }) => void repairs.push(a.dispatchId),
    startReview: () => {},
    startValidation: () => {},
    lang: () => 'en' as const
  } as unknown as OrchServerDeps

  const trees = o.trees ?? ['same']
  let treeCalls = 0
  const reviewer: ExternalReviewer = { ...REVIEWER, ...o.reviewer }
  const reviewBy = o.reviewBy === undefined ? reviewer.id : o.reviewBy
  const settings: ReviewerSettings = { reviewers: [reviewer], reviewBy }

  const external: ExternalReviewDeps = {
    settings: async () => {
      if (o.settingsThrow) throw new Error(o.settingsThrow)
      return settings
    },
    handle: async (cmd, args) => {
      handled.push({ cmd, args })
      if (o.settleAnswer) return o.settleAnswer
      return handleCommand(deps, { sessionId: APP_CALLER }, cmd, args)
    },
    spawn: (file, args, opts) => {
      const proc: ProcLike = nodeProcFactory(file, args, opts)
      spawned.push({ file, args, env: opts.env })
      // A process that never started has pid 0, and signalling 0 would signal this test's whole process group
      if (proc.pid > 0) pids.add(proc.pid)
      return proc
    },
    baseEnv: () => ({ PATH: process.env.PATH, ASTERA_HOST_PIPE: 'p', KEEP_ME: '1' }),
    platform: process.platform,
    clientVersion: '0.0.0-test',
    writeFile: async (p, text) => void fs.writeFileSync(p, text),
    appendLog: (p, line) => void acpLines.push({ path: p, line }),
    treeState: async () => trees[Math.min(treeCalls++, trees.length - 1)],
    timeoutMs: o.timeoutMs ?? 20_000,
    pollMs: o.pollMs ?? 50,
    resolve: async (r, platform) => {
      if (r.command !== REVIEWER.command) return resolveAgentCommand(r, platform, { ensure: async () => {} })
      return {
        ok: true,
        file: process.execPath,
        args: [AGENT, o.mode ?? 'approve', '--message', o.message ?? APPROVED, ...(o.retryMessage ? ['--retry-message', o.retryMessage] : []), '--record', record]
      }
    }
  }

  const ctx: ReviewContext = {
    getState: () => state,
    setState: async (next) => {
      history.push(next)
      state = next
    },
    now: () => NOW,
    log: (m) => logs.push(m),
    accounts: () => [claude('c1'), codex('x1')],
    loginStatus: async () => true,
    assertAllowedPath: async (p) => p,
    startWorker,
    specsDir,
    ...(o.rangeDiff ? { rangeDiff: o.rangeDiff } : {}),
    external
  }
  const start = createReviewStarter(ctx)
  const h = {
    start,
    taskId,
    implCwd,
    specsDir,
    logs,
    startWorker,
    handled,
    spawned,
    repairs,
    acpLines,
    reviewer,
    history,
    setState: (s: OrchState) => void (state = s),
    state: () => state,
    task: () => state.tasks.find((x) => x.id === taskId)!,
    review: () => state.dispatches.find((x) => x.review),
    prompts: (): string[] => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as string) : []),
    pid: () => [...pids].at(-1) ?? 0,
    /** Starts the review and waits until nothing is in flight. */
    run: async () => {
      await start({ taskId })
      await idle()
    },
    gateText: () => state.gates.map((g) => g.question).join('\n')
  }
  const idle = (): Promise<void> =>
    Promise.race([start.externalIdle(), sleep(20_000).then(() => Promise.reject(new Error('the review did not become idle in 20 s')))])
  rigs.push(h)
  return h
}

describe('createReviewStarter with an external reviewer', () => {
  it('an approved verdict completes the Task, and the Dispatch carries the reviewer', async () => {
    const h = rig()
    await h.run()
    expect(h.startWorker).not.toHaveBeenCalled()
    expect(h.task().status).toBe('completed')
    const d = h.review()!
    expect(d).toMatchObject({ review: true, outcome: 'succeeded', externalReviewer: { id: REVIEWER.id, name: REVIEWER.name }, provider: 'claude', accountId: '' })
    expect(d.sessionId).toMatch(/^acp:[0-9a-f]{8}$/)
    expect(h.state().gates).toEqual([])
    const specPath = path.join(h.specsDir, specFileName(h.taskId, d.id))
    expect(d.specPath).toBe(specPath)
    const prompt = fs.readFileSync(specPath, 'utf8')
    expect(prompt).toContain('json')
    expect(h.handled).toHaveLength(1)
    expect(h.handled[0].cmd).toBe('send')
    expect(h.handled[0].args).toEqual({ type: 'worker_done', taskId: h.taskId, dispatchId: d.id, outcome: 'succeeded', subject: 'Looks right.', body: 'Looks right.\nSecond line.' })
    await gone(h.pid())
    // the agent's environment is the driver's without what Astera plants, plus NO_BROWSER
    expect(h.spawned[0].env).toMatchObject({ KEEP_ME: '1', NO_BROWSER: 'true' })
    expect(h.spawned[0].env).not.toHaveProperty('ASTERA_HOST_PIPE')
    // the transcript is kept beside the spec file, each line with a time, and the prompt is not in it wholesale
    expect(h.acpLines.length).toBeGreaterThan(0)
    for (const l of h.acpLines) {
      expect(l.path).toBe(`${specPath}.acp.log`)
      expect(l.line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z /)
    }
  })

  it('a rejected verdict in a convergence Run writes review.json, then opens a repair Dispatch', async () => {
    const h = rig({ convergence: true, message: REJECTED })
    await h.run()
    const d = h.review()!
    const file = `${d.specPath}.review.json`
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      issues: [{ severity: 'high', title: 'empty input', description: 'crashes on an empty list', file: 'src/x.ts', line: 3 }]
    })
    expect(h.handled[0].args).toMatchObject({ outcome: 'failed', subject: 'Misses the empty case.', body: 'Misses the empty case.' })
    expect(h.state().gates).toEqual([])
    const repair = h.state().dispatches.find((x) => x.repair !== undefined && !x.endedAt)
    expect(repair).toBeDefined()
    expect(h.repairs).toEqual([repair!.id])
    await gone(h.pid())
  })

  it('a rejected verdict with no convergence fails the Task as a terminal reviewer’s would, and writes no review.json', async () => {
    const h = rig({ message: REJECTED })
    await h.run()
    expect(h.task().status).toBe('failed')
    expect(h.state().gates).toEqual([])
    expect(fs.existsSync(`${h.review()!.specPath}.review.json`)).toBe(false)
    expect(h.handled[0].args).toMatchObject({ outcome: 'failed' })
  })

  it('an answer with no verdict gets one retry prompt in the same session, then settles', async () => {
    const h = rig({ mode: 'no-verdict-then-verdict', message: 'I am not sure yet.', retryMessage: APPROVED })
    await h.run()
    expect(h.task().status).toBe('completed')
    const prompts = h.prompts()
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toBe(VERDICT_RETRY_PROMPT)
    expect(h.spawned).toHaveLength(1)
  })

  it('two answers with no verdict make a Gate, and the process is gone', async () => {
    const h = rig({ mode: 'no-verdict-twice', message: 'I am not sure yet.' })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain('the external reviewer Fake Agent ended without a readable verdict: ')
    expect(h.prompts()).toHaveLength(2)
    expect(h.handled).toEqual([])
    expect(h.state().dispatches.filter((d) => d.review)).toEqual([])
    await gone(h.pid())
  })

  it('a sign-in the agent asks for makes a Gate that carries its message', async () => {
    const h = rig({ mode: 'auth-required' })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain(
      'the external reviewer Fake Agent needs a sign-in: Gemini API key is missing or not configured.. Run fake-agent in a terminal once and sign in, then review again.'
    )
    await gone(h.pid())
  })

  it('a command that is not there makes a Gate', async () => {
    const h = rig({ reviewer: { command: 'astera-no-such-agent-cmd', args: ['--acp'] } })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain('the external reviewer Fake Agent could not be started: astera-no-such-agent-cmd was not found. Install it or correct the command in Settings.')
    expect(h.state().dispatches.filter((d) => d.review)).toEqual([])
  })

  it('an agent that does not finish in time makes a Gate, and the process is gone', async () => {
    const h = rig({ mode: 'hang-prompt', timeoutMs: 600 })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain('the external reviewer Fake Agent did not finish in ')
    expect(h.gateText()).toContain(' minutes.')
    await gone(h.pid())
  })

  it('an agent that exits mid-turn makes a Gate with its exit code and stderr tail', async () => {
    const h = rig({ mode: 'exit-mid-turn' })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain('the external reviewer Fake Agent stopped before giving a verdict (exit 3): ')
    expect(h.gateText()).toContain('agent crashed: out of memory')
    await gone(h.pid())
  })

  it('an agent that changes a file without asking makes a Gate, and the process is gone', async () => {
    const h = rig({ mode: 'edits-without-asking' })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain('the external reviewer Fake Agent changed a file without asking (Edit b.txt). Its verdict is not used. Check the folder, and set the agent so that it asks before editing.')
    expect(h.handled).toEqual([])
    await gone(h.pid())
  })

  it('a folder that changed while the reviewer ran, with nobody else there, makes a Gate and settles nothing', async () => {
    const h = rig({ trees: ['before', 'after'] })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain(`files in ${h.implCwd} changed while the external reviewer Fake Agent ran. Its verdict is not used.`)
    expect(h.handled).toEqual([])
    await gone(h.pid())
  })

  it('a folder that changed while another Dispatch worked in it does not stop the verdict, and says so in the log', async () => {
    const h = rig({ trees: ['before', 'after'], other: {} })
    await h.run()
    expect(h.task().status).toBe('completed')
    expect(h.acpLines.map((l) => l.line).join('\n')).toMatch(/folder check skipped/)
    // a Dispatch that ended after the review began counts as well
    const h2 = rig({ trees: ['before', 'after'], other: { endedAt: '2026-09-24T00:00:01.000Z' } })
    await h2.run()
    expect(h2.task().status).toBe('completed')
  })

  it('a folder that is not a repository skips the check', async () => {
    const h = rig({ trees: [null] })
    await h.run()
    expect(h.task().status).toBe('completed')
  })

  it('work that ran in a sandbox makes a Gate before anything is spawned', async () => {
    const h = rig({ implSandboxKind: 'sandbox' })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain(
      "this task's work ran in a sandbox, and the external reviewer Fake Agent cannot be sandboxed. Set the reviewer to Automatic in Settings, or complete the task by hand."
    )
    expect(h.spawned).toEqual([])
    expect(h.review()).toBeUndefined()
  })

  it('a reviewer setting that cannot be read makes a Gate', async () => {
    const h = rig({ settingsThrow: 'EBUSY: resource busy' })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain('could not read the reviewer setting: EBUSY: resource busy')
    expect(h.spawned).toEqual([])
  })

  it('a refused settle makes a Gate, and an alreadyReported one does not', async () => {
    const refused = rig({ settleAnswer: { status: 409, body: { error: 'task is not reviewing: completed' } } })
    await refused.run()
    expect(refused.task().status).toBe('blocked')
    expect(refused.gateText()).toContain('the verdict of the external reviewer Fake Agent was refused: ')
    const again = rig({ settleAnswer: { status: 200, body: 'alreadyReported' } })
    await again.run()
    expect(again.state().gates).toEqual([])
  })

  it('with no reviewer chosen the automatic path runs and no child is spawned', async () => {
    const h = rig({ reviewBy: null })
    await h.start({ taskId: h.taskId })
    expect(h.startWorker).toHaveBeenCalledTimes(1)
    expect(h.spawned).toEqual([])
    expect(h.start.externalInFlight().size).toBe(0)
  })

  // Review Focus 3: a Dispatch closed under a running review
  it('a Dispatch closed under a running review kills the process and records nothing', async () => {
    const h = rig({ mode: 'hang-prompt' })
    await h.start({ taskId: h.taskId })
    await until(() => h.prompts().length === 1, 'the agent to be mid-turn')
    const pid = h.pid()
    expect(alive(pid)).toBe(true)
    expect([...h.start.externalInFlight()]).toEqual([h.review()!.id])
    // what worker-stop does
    h.setState({ ...h.state(), dispatches: h.state().dispatches.map((d) => (d.review ? { ...d, endedAt: NOW, outcome: 'failed' as const, workerState: 'stopped' as const, closedBy: 'stop' as const } : d)) })
    const before = h.state()
    await Promise.race([h.start.externalIdle(), sleep(20_000).then(() => Promise.reject(new Error('not idle')))])
    await gone(pid)
    expect(h.state()).toBe(before)
    expect(h.state().gates).toEqual([])
    expect(h.handled).toEqual([])
  })

  // Review Focus 1: dispose
  it('disposeExternal during a turn kills the process and leaves the state untouched', async () => {
    const h = rig({ mode: 'hang-prompt' })
    await h.start({ taskId: h.taskId })
    await until(() => h.prompts().length === 1, 'the agent to be mid-turn')
    const pid = h.pid()
    const before = h.state()
    const writes = h.history.length
    h.start.disposeExternal()
    await Promise.race([h.start.externalIdle(), sleep(20_000).then(() => Promise.reject(new Error('not idle')))])
    await gone(pid)
    await sleep(150)
    expect(h.state()).toBe(before)
    expect(h.history.length).toBe(writes)
    expect(h.review()!.endedAt).toBeUndefined()
    expect(h.handled).toEqual([])
    expect(h.start.externalInFlight().size).toBe(0)
  })

  // Review Focus 1: the kill that follows a verdict is ours
  it('the kill after a verdict is not read as an exit mid-turn', async () => {
    const h = rig()
    await h.run()
    await gone(h.pid())
    await sleep(300)
    expect(h.state().gates).toEqual([])
    expect(h.task().status).toBe('completed')
    expect(h.state().dispatches.filter((d) => d.review)).toHaveLength(1)
  })

  it('a failure of an older review leaves a newer review Dispatch of the Task alone', async () => {
    const h = rig({ mode: 'hang-prompt', timeoutMs: 700, pollMs: 60_000 })
    await h.start({ taskId: h.taskId })
    await until(() => h.prompts().length === 1, 'the agent to be mid-turn')
    const stale = h.review()!
    // Another driver replaced it before the poll noticed: the named Dispatch is gone and a newer one is open
    h.setState({ ...h.state(), dispatches: h.state().dispatches.map((d) => (d.id === stale.id ? { ...d, id: 'dsp_newer', sessionId: 'acp:ffffffff' } : d)) })
    await Promise.race([h.start.externalIdle(), sleep(20_000).then(() => Promise.reject(new Error('not idle')))])
    expect(h.state().dispatches.some((d) => d.id === 'dsp_newer')).toBe(true)
    expect(h.state().gates).toEqual([])
    expect(h.task().status).toBe('reviewing')
    expect(h.logs.join('\n')).toContain('failed after its Dispatch was closed')
  })

  // The budget and the poll are timers of the review's own: every end clears both
  it('no timer or interval survives the end of a review, however it ended', async () => {
    const made: { delay: number; handle: { _destroyed?: boolean } }[] = []
    const st = globalThis.setTimeout
    const si = globalThis.setInterval
    const spyT = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = st(fn, ms, ...rest)
      made.push({ delay: ms ?? 0, handle: handle as never })
      return handle
    }) as never)
    const spyI = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = si(fn, ms, ...rest)
      made.push({ delay: ms ?? 0, handle: handle as never })
      return handle
    }) as never)
    try {
      const opts = { timeoutMs: 12_345, pollMs: 777 }
      await rig({ ...opts }).run()
      await rig({ ...opts, mode: 'exit-mid-turn' }).run()
      const disposed = rig({ ...opts, mode: 'hang-prompt' })
      await disposed.start({ taskId: disposed.taskId })
      await until(() => disposed.prompts().length === 1, 'the agent to be mid-turn')
      disposed.start.disposeExternal()
      await disposed.start.externalIdle()
    } finally {
      spyT.mockRestore()
      spyI.mockRestore()
    }
    const ours = made.filter((m) => m.delay === 12_345 || m.delay === 777)
    expect(ours).toHaveLength(6)
    for (const m of ours) expect(m.handle._destroyed, `a timer of ${m.delay} ms is still pending`).toBe(true)
  })
})
