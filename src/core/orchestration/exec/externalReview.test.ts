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
import { removeFixture, waitPidsGone } from '../../testFixtures'
import { resolveAgentCommand } from '../../acp/spawn'
import { VERDICT_RETRY_PROMPT } from './externalVerdict'
import type { ExternalReviewer, ReviewerSettings } from '../../settings/externalReviewers'
import type { Account } from '../../types'
import type { ProcLike } from '../../sessions/proc'
import { readRangeDiff, trackedTreeState } from '../../git/changes'
import { gitSync } from '../../worktrees/testRepo'
import { externalReviewIo } from './externalReviewIo'
import { sweepStaleSpecFiles } from './specFiles'

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
afterEach(async () => {
  for (const r of rigs.splice(0)) r.start.disposeExternal()
  // Only processes this test file spawned: killed if still alive, then waited for, before their folder goes
  for (const pid of pids) if (pid > 0 && alive(pid)) process.kill(pid)
  await waitPidsGone(pids)
  pids.clear()
  for (const d of dirs.splice(0)) await removeFixture(d)
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
  /** Changes the state as the settle arrives, before it is answered */
  beforeSettle?: (s: OrchState) => OrchState
  settingsThrow?: string
  /** Holds one await of the start until `release()`: the settings read, the path guard, or the review Dispatch's commit
   *  (the state is already changed when the commit is held, as a real store's is). `commitFails` rejects that commit. */
  hold?: 'settings' | 'path' | 'commit'
  commitFails?: boolean
  rangeDiff?: ReviewContext['rangeDiff']
  /** Replaces the rig's environment: what the driver gives an agent in that folder */
  env?: ExternalReviewDeps['env']
  /** More arguments for the fake agent */
  agentArgs?: string[]
  /** Replaces `trees`: the folder's tracked state as the driver reads it */
  treeState?: ExternalReviewDeps['treeState']
  /** The drivers' own file writes (externalReviewIo) instead of the rig's capture */
  realIo?: boolean
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
  const pruned: string[] = []
  const kills: number[] = []
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
  let release: () => void = () => {}
  const held = new Promise<void>((r) => (release = r))
  const holdAt = (at: NonNullable<RigOpts['hold']>): Promise<void> => (o.hold === at ? held : Promise.resolve())

  const external: ExternalReviewDeps = {
    settings: async () => {
      await holdAt('settings')
      if (o.settingsThrow) throw new Error(o.settingsThrow)
      return settings
    },
    handle: async (cmd, args) => {
      handled.push({ cmd, args })
      if (o.beforeSettle) state = o.beforeSettle(state)
      if (o.settleAnswer) return o.settleAnswer
      return handleCommand(deps, { sessionId: APP_CALLER }, cmd, args)
    },
    spawn: (file, args, opts) => {
      const proc: ProcLike = nodeProcFactory(file, args, opts)
      spawned.push({ file, args, env: opts.env })
      // A process that never started has pid 0, and signalling 0 would signal this test's whole process group
      if (proc.pid > 0) pids.add(proc.pid)
      // Every kill is counted: each one of a process tree starts a taskkill (final fix wave D2)
      const kill = proc.kill
      proc.kill = () => {
        kills.push(proc.pid)
        kill()
      }
      return proc
    },
    env: o.env ?? (() => ({ PATH: process.env.PATH, ASTERA_HOST_PIPE: 'p', KEEP_ME: '1' })),
    platform: process.platform,
    clientVersion: '0.0.0-test',
    writeFile: async (p, text) => void fs.writeFileSync(p, text),
    appendLog: (p, line) => void acpLines.push({ path: p, line }),
    pruneReviewLogs: (d) => void pruned.push(d),
    ...(o.realIo ? externalReviewIo((m) => logs.push(m)) : {}),
    treeState: o.treeState ?? (async () => trees[Math.min(treeCalls++, trees.length - 1)]),
    timeoutMs: o.timeoutMs ?? 20_000,
    pollMs: o.pollMs ?? 50,
    resolve: async (r, platform) => {
      if (r.command !== REVIEWER.command) return resolveAgentCommand(r, platform, { ensure: async () => {} })
      return {
        ok: true,
        file: process.execPath,
        args: [AGENT, o.mode ?? 'approve', '--message', o.message ?? APPROVED, ...(o.retryMessage ? ['--retry-message', o.retryMessage] : []), '--record', record, ...(o.agentArgs ?? [])]
      }
    }
  }

  const ctx: ReviewContext = {
    getState: () => state,
    setState: async (next) => {
      const opening = !state.dispatches.some((x) => x.review) && next.dispatches.some((x) => x.review)
      if (opening && o.commitFails) throw new Error('disk full')
      history.push(next)
      state = next
      if (opening) await holdAt('commit')
    },
    now: () => NOW,
    log: (m) => logs.push(m),
    accounts: () => [claude('c1'), codex('x1')],
    loginStatus: async () => true,
    assertAllowedPath: async (p) => {
      await holdAt('path')
      return p
    },
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
    kills,
    repairs,
    acpLines,
    pruned,
    /** Where this review's transcript is kept (final fix wave C1) */
    /** The review Dispatch may be gone (a failure removes it): its id is read from the states committed on the way */
    logFile: (): string => path.join(dir, 'review-logs', `${taskId}-${history.flatMap((s) => s.dispatches).find((x) => x.review)!.id}.log`),
    reviewer,
    history,
    release: () => release(),
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
    // the transcript is kept in the review-logs folder beside the specs folder (final fix wave C1), each line with a time,
    // and the prompt is not in it wholesale
    expect(h.acpLines.length).toBeGreaterThan(0)
    for (const l of h.acpLines) {
      expect(l.path).toBe(path.join(path.dirname(h.specsDir), 'review-logs', `${h.taskId}-${d.id}.log`))
      expect(l.line).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z /)
    }
    // the old transcripts are pruned when a review starts
    expect(h.pruned).toEqual([path.join(path.dirname(h.specsDir), 'review-logs')])
  })

  // Final fix wave C1: the Host's tick removes every file of an ended Dispatch beside its spec
  it('keeps the transcript out of the specs folder, so the spec sweep leaves it', async () => {
    const h = rig({ realIo: true, mode: 'no-verdict-twice', message: 'I am not sure yet.' })
    await h.run()
    const log = h.logFile()
    expect(path.dirname(log)).not.toBe(h.specsDir)
    expect(fs.readFileSync(log, 'utf8')).toContain('agent message:')
    const removed = await sweepStaleSpecFiles({ dir: h.specsDir, state: h.state(), live: new Set() })
    expect(removed.length).toBeGreaterThan(0)
    expect(fs.existsSync(log)).toBe(true)
    // every failure's Gate says where the transcript is, after the reason
    expect(h.gateText()).toContain(`ended without a readable verdict: `)
    expect(h.gateText()).toContain(` Transcript: ${log}`)
  })

  // Final fix wave C2: what the agent says reaches a Gate in one line of at most 300 characters
  it.each([
    ['a sign-in message', { mode: 'auth-required', agentArgs: ['--error-message'] }, 'needs a sign-in: '],
    ['a protocol message', { mode: 'new-session-error', agentArgs: ['--error-message'] }, 'could not be used: '],
    ['a violation title', { mode: 'edits-without-asking', agentArgs: ['--title'] }, 'changed a file without asking ('],
    ['a stop reason', { mode: 'stop-reason', agentArgs: ['--stop-reason'] }, 'ended its turn with ']
  ])('cuts %s to one line of 300 characters before it enters the Gate', async (_label, o, prefix) => {
    const long = `first line\nsecond line ${'x'.repeat(400)}`
    const h = rig({ mode: o.mode, agentArgs: [...o.agentArgs, long] })
    await h.run()
    const text = h.gateText()
    expect(text).toContain(prefix)
    const quoted = text.slice(text.indexOf(prefix) + prefix.length)
    expect(quoted.startsWith('first line second line xxx')).toBe(true)
    expect(text).not.toContain('x'.repeat(301))
    expect(text).toContain('x'.repeat(250))
    expect(text).not.toContain('first line\nsecond')
  })

  it('a rejected verdict in a convergence Run writes review.json, then opens a repair Dispatch', async () => {
    const h = rig({ convergence: true, message: REJECTED })
    await h.run()
    const d = h.review()!
    const file = `${d.specPath}.review.json`
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      issues: [{ severity: 'high', title: 'empty input', description: 'crashes on an empty list', file: 'src/x.ts', line: 3 }]
    })
    // with a convergence policy the findings travel in review.json and the body stays the summary (final fix wave B4)
    expect(h.handled[0].args).toMatchObject({ outcome: 'failed', subject: 'Misses the empty case.', body: 'Misses the empty case.' })
    expect(h.state().gates).toEqual([])
    const repair = h.state().dispatches.find((x) => x.repair !== undefined && !x.endedAt)
    expect(repair).toBeDefined()
    expect(h.repairs).toEqual([repair!.id])
    await gone(h.pid())
  })

  // Final fix wave B5: an approval with a blocking finding can only go to repair if the command read the review.json the
  // runner wrote before it sent
  it('an approved verdict with a critical finding in a convergence Run goes to repair, carrying that finding', async () => {
    const h = rig({
      convergence: true,
      message: verdictMessage({ outcome: 'approved', summary: 'Fine apart from one thing.', issues: [{ severity: 'critical', title: 'drops the last row', file: 'src/y.ts' }] })
    })
    await h.run()
    expect(h.handled[0].args).toMatchObject({ outcome: 'succeeded' })
    expect(h.task().status).not.toBe('completed')
    const repair = h.state().dispatches.find((x) => x.repair === 'review-failure' && !x.endedAt)
    expect(repair).toBeDefined()
    expect(h.repairs).toEqual([repair!.id])
    expect(h.task().reviewIssues?.map((i) => i.title)).toContain('drops the last row')
    await gone(h.pid())
  })

  it('a rejected verdict with no convergence fails the Task as a terminal reviewer’s would, and writes no review.json', async () => {
    const h = rig({ message: REJECTED })
    await h.run()
    expect(h.task().status).toBe('failed')
    expect(h.state().gates).toEqual([])
    expect(fs.existsSync(`${h.review()!.specPath}.review.json`)).toBe(false)
    expect(h.handled[0].args).toMatchObject({ outcome: 'failed' })
    // Final fix wave B4: with no review.json the findings travel in the body, or they are lost
    expect(h.handled[0].args.body).toBe('Misses the empty case.\n\n- [high] empty input (src/x.ts:3): crashes on an empty list')
  })

  it('renders at most 20 findings in the body, each with only the parts it has, then says how many more', async () => {
    const issues = [
      { severity: 'medium', title: 'no file' },
      { severity: 'low', title: 'file only', file: 'a.ts' },
      { severity: 'info', title: 'two\nlines', description: 'first\nsecond' },
      ...Array.from({ length: 20 }, (_, i) => ({ severity: 'high', title: `t${i}`, file: 'b.ts', line: i + 1, description: 'd' }))
    ]
    const h = rig({ message: verdictMessage({ outcome: 'rejected', summary: 'Several.', issues }) })
    await h.run()
    const lines = String(h.handled[0].args.body).split('\n')
    expect(lines.slice(0, 5)).toEqual(['Several.', '', '- [medium] no file', '- [low] file only (a.ts)', '- [info] two lines: first second'])
    expect(lines.filter((l) => l.startsWith('- ['))).toHaveLength(20)
    expect(lines.at(-1)).toBe('and 3 more')
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
      // Final fix wave C3: one period, and no promise of "then review again"
      "the external reviewer Fake Agent needs a sign-in: Gemini API key is missing or not configured. Sign in with that agent's own CLI in a terminal first."
    )
    expect(h.gateText()).not.toMatch(/review again/)
    await gone(h.pid())
  })

  // Final fix wave A3: the agent starts from what the driver's checks start from in that folder (the Credentials list)
  it('the agent gets the environment env(cwd) answers for the folder it reviews', async () => {
    const asked: string[] = []
    const h = rig({
      agentArgs: ['--echo-env', 'REVIEW_MARK'],
      env: async (cwd) => {
        asked.push(cwd)
        return { PATH: process.env.PATH, REVIEW_MARK: `for ${path.basename(cwd)}`, ASTERA_HOST_PIPE: 'p' }
      }
    })
    await h.run()
    expect(h.task().status).toBe('completed')
    expect(asked).toEqual([h.implCwd])
    expect(h.prompts()).toContain('env REVIEW_MARK=for tree')
    expect(h.spawned[0].env).toMatchObject({ REVIEW_MARK: 'for tree', NO_BROWSER: 'true' })
    expect(h.spawned[0].env).not.toHaveProperty('ASTERA_HOST_PIPE')
  })

  // Final fix wave B2: the implementer's head is recorded after it ends, later than the review builds its prompt
  describe('the diff in the prompt', () => {
    /** A repository in the implementer's folder, its first commit recorded as the implementer's base (and no head) */
    const withRepo = (h: ReturnType<typeof rig>): string => {
      const g = (args: string[]): string => gitSync(h.implCwd, args)
      g(['init', '-q'])
      g(['config', 'user.email', 't@t'])
      g(['config', 'user.name', 't'])
      g(['config', 'core.autocrlf', 'false'])
      fs.writeFileSync(path.join(h.implCwd, 'a.txt'), 'one\n')
      g(['add', '-A'])
      g(['commit', '-q', '-m', 'base'])
      const base = g(['rev-parse', 'HEAD'])
      h.setState({ ...h.state(), dispatches: h.state().dispatches.map((d) => (d.taskId === h.taskId && !d.review ? { ...d, git: { base } } : d)) })
      return base
    }

    it('embeds the change from the first attempt’s base to HEAD when the head is not recorded yet', async () => {
      const h = rig({ rangeDiff: (cwd, base, head, o) => readRangeDiff(cwd, base, head, o) })
      withRepo(h)
      fs.writeFileSync(path.join(h.implCwd, 'a.txt'), 'the changed line\n')
      gitSync(h.implCwd, ['commit', '-q', '-am', 'work'])
      await h.run()
      expect(h.task().status).toBe('completed')
      expect(h.prompts()[0]).toContain('+the changed line')
      expect(h.prompts()[0]).not.toContain('No diff is attached')
    }, 30_000)

    it('says no diff is attached when nothing changed since the base', async () => {
      const h = rig({ rangeDiff: (cwd, base, head, o) => readRangeDiff(cwd, base, head, o) })
      withRepo(h)
      await h.run()
      expect(h.prompts()[0]).toContain('No diff is attached. Read the files listed above.')
    }, 30_000)

    it('logs a diff that could not be read, and says no diff is attached', async () => {
      const h = rig({ rangeDiff: async () => { throw new Error('git broke') } })
      h.setState({ ...h.state(), dispatches: h.state().dispatches.map((d) => (d.taskId === h.taskId && !d.review ? { ...d, git: { base: 'abc123' } } : d)) })
      await h.run()
      expect(h.prompts()[0]).toContain('No diff is attached. Read the files listed above.')
      expect(h.logs.join('\n')).toMatch(/diff abc123\.\.HEAD could not be read: .*git broke/)
    })
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

  // Final fix wave A1: a second edit of a file the work already modified leaves `git status` as it was
  it('a second edit of a file the work already modified, made while the reviewer ran, makes the changed-folder Gate', async () => {
    let reads = 0
    const h = rig({
      treeState: async (cwd) => {
        const s = await trackedTreeState(cwd)
        // the reviewer's edit, between the read before it ran and the read after
        if (reads++ === 0) fs.writeFileSync(path.join(cwd, 'a.txt'), 'three\n')
        return s
      }
    })
    gitSync(h.implCwd, ['init', '-q'])
    gitSync(h.implCwd, ['config', 'user.email', 't@t'])
    gitSync(h.implCwd, ['config', 'user.name', 't'])
    gitSync(h.implCwd, ['config', 'core.autocrlf', 'false'])
    fs.writeFileSync(path.join(h.implCwd, 'a.txt'), 'one\n')
    gitSync(h.implCwd, ['add', '-A'])
    gitSync(h.implCwd, ['commit', '-q', '-m', 'base'])
    // the implementer's work: already modified when the review starts
    fs.writeFileSync(path.join(h.implCwd, 'a.txt'), 'two\n')
    await h.run()
    expect(reads).toBe(2)
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain(`files in ${h.implCwd} changed while the external reviewer Fake Agent ran. Its verdict is not used.`)
    expect(h.handled).toEqual([])
  }, 30_000)

  it('a folder that could be read before the review and cannot be read after it counts as changed', async () => {
    const h = rig({ trees: ['before', null] })
    await h.run()
    expect(h.task().status).toBe('blocked')
    expect(h.gateText()).toContain(`files in ${h.implCwd} changed while the external reviewer Fake Agent ran. Its verdict is not used.`)
    expect(h.handled).toEqual([])
  })

  it('a folder that could not be read before the review skips the check and says so in the log', async () => {
    const h = rig({ trees: [null, 'after'] })
    await h.run()
    expect(h.task().status).toBe('completed')
    expect(h.acpLines.map((l) => l.line).join('\n')).toMatch(/folder check skipped: the folder's tracked state could not be read before the review/)
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

  // Final fix wave A4: a person who moved the Task out of `reviewing` is not overruled by the review they left behind
  // Follow-up R1: the review closes its own Dispatch as unproven, or the moved Task could never be started again
  it('a Task moved out of reviewing during a review ends it: the process is killed, its Dispatch closed as unproven, no Gate, the Task untouched', async () => {
    const h = rig({ mode: 'hang-prompt' })
    await h.start({ taskId: h.taskId })
    await until(() => h.prompts().length === 1, 'the agent to be mid-turn')
    const pid = h.pid()
    // what task-update does: the Task moves, the review Dispatch stays open
    h.setState({ ...h.state(), tasks: h.state().tasks.map((t) => (t.id === h.taskId ? { ...t, status: 'pending' as const } : t)) })
    await Promise.race([h.start.externalIdle(), sleep(20_000).then(() => Promise.reject(new Error('not idle')))])
    await gone(pid)
    const d = h.review()!
    expect(d.endedAt).toBeDefined()
    expect(d.workerState).toBe('outcome_unknown')
    expect(d.outcome).toBeUndefined()
    expect(h.task().status).toBe('pending')
    expect(h.state().gates).toEqual([])
    expect(h.handled).toEqual([])
    // the rescued Task can be started again
    const again = openDispatch(h.state(), { taskId: h.taskId, provider: 'claude', accountId: 'c1', sessionId: 'sess2', cwd: h.implCwd, specPath: path.join(h.specsDir, 'again.md') }, NOW)
    expect(again.ok ? '' : again.error).not.toMatch(/already open/)
  })

  // Follow-up R3: a failure that lands before the poll notices the move does not gate the moved Task
  it('an agent that exits mid-turn after the Task moved, before the poll saw it, closes the Dispatch as unproven and opens no Gate', async () => {
    let reads = 0
    const h = rig({
      mode: 'exit-mid-turn',
      pollMs: 60_000,
      treeState: async () => {
        // the person moves the Task while the review starts; the poll will not look for a minute
        if (reads++ === 0) h.setState({ ...h.state(), tasks: h.state().tasks.map((t) => (t.id === h.taskId ? { ...t, status: 'pending' as const } : t)) })
        return 'same'
      }
    })
    await h.run()
    await gone(h.pid())
    expect(h.state().gates).toEqual([])
    expect(h.task().status).toBe('pending')
    const d = h.review()!
    expect(d).toMatchObject({ workerState: 'outcome_unknown' })
    expect(d.endedAt).toBeDefined()
    expect(d.outcome).toBeUndefined()
  })

  it('a settle refused after the Task left reviewing is dropped and logged, not gated', async () => {
    const h = rig({
      settleAnswer: { status: 409, body: { error: 'task is not reviewing: pending' } },
      beforeSettle: (s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === h.taskId ? { ...t, status: 'pending' as const } : t)) })
    })
    await h.run()
    expect(h.task().status).toBe('pending')
    expect(h.state().gates).toEqual([])
    // Follow-up R1: its Dispatch is closed as unproven, so the moved Task can be started again
    expect(h.review()).toMatchObject({ workerState: 'outcome_unknown' })
    expect(h.review()!.endedAt).toBeDefined()
    expect(h.review()!.outcome).toBeUndefined()
    expect(h.logs.join('\n')).toContain('was refused after its Task left reviewing or its Dispatch closed; dropped')
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

  // Final fix wave D2: however many ends call stop, the process is killed once
  it.each([
    ['a verdict', {}],
    ['a file changed without asking', { mode: 'edits-without-asking' }],
    ['a timeout', { mode: 'hang-prompt', timeoutMs: 600 }]
  ])('kills the agent once after %s', async (_label, o) => {
    const h = rig(o)
    await h.run()
    await gone(h.pid())
    expect(h.kills).toEqual([h.pid()])
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

  // Fix round 1, finding 1: a driver that has been disposed starts nothing, wherever its start was suspended
  describe('after disposeExternal', () => {
    const quiet = (h: ReturnType<typeof rig>): void => {
      expect(h.spawned).toEqual([])
      expect(h.prompts()).toEqual([])
      expect(h.handled).toEqual([])
      expect(h.state().gates).toEqual([])
      expect(h.start.externalInFlight().size).toBe(0)
    }

    it('a settings read that resolves only after the dispose opens no Dispatch, no Gate, and does not fall through to the automatic path', async () => {
      const h = rig({ hold: 'settings' })
      const starting = h.start({ taskId: h.taskId })
      h.start.disposeExternal()
      h.release()
      await starting
      quiet(h)
      expect(h.review()).toBeUndefined()
      expect(h.task().status).toBe('reviewing')
      expect(h.startWorker).not.toHaveBeenCalled()
    })

    it('a settings read that fails after the dispose opens no Gate either', async () => {
      const h = rig({ hold: 'settings', settingsThrow: 'EBUSY' })
      const starting = h.start({ taskId: h.taskId })
      h.start.disposeExternal()
      h.release()
      await starting
      quiet(h)
      expect(h.task().status).toBe('reviewing')
    })

    it('a start suspended at the path guard spawns nothing and opens no Dispatch', async () => {
      const h = rig({ hold: 'path' })
      const starting = h.start({ taskId: h.taskId })
      await sleep(30)
      h.start.disposeExternal()
      h.release()
      await starting
      quiet(h)
      expect(h.review()).toBeUndefined()
    })

    it('a start suspended at the commit of its Dispatch spawns nothing, and the Dispatch is left open for the next driver', async () => {
      const h = rig({ hold: 'commit' })
      const starting = h.start({ taskId: h.taskId })
      await sleep(30)
      // the state already has the Dispatch, and it is already counted as in flight
      expect(h.review()).toBeDefined()
      expect([...h.start.externalInFlight()]).toEqual([h.review()!.id])
      h.start.disposeExternal()
      h.release()
      await starting
      await h.start.externalIdle()
      await sleep(100)
      quiet(h)
      expect(h.review()!.endedAt).toBeUndefined()
    })

    it('a later start on the same starter does nothing on the external path, and the automatic path still runs', async () => {
      const h = rig()
      h.start.disposeExternal()
      await h.start({ taskId: h.taskId })
      quiet(h)
      expect(h.review()).toBeUndefined()
      const auto = rig({ reviewBy: null })
      auto.start.disposeExternal()
      await auto.start({ taskId: auto.taskId })
      expect(auto.startWorker).toHaveBeenCalledTimes(1)
    })

    it('a commit that fails takes the review out of the in-flight set and gates as a failed start does', async () => {
      const h = rig({ commitFails: true })
      await h.start({ taskId: h.taskId })
      expect(h.start.externalInFlight().size).toBe(0)
      await h.start.externalIdle()
      expect(h.spawned).toEqual([])
      expect(h.task().status).toBe('blocked')
      expect(h.gateText()).toContain('disk full')
    })
  })

  it('the new Dispatch is in externalInFlight as soon as startReview resolves', async () => {
    const h = rig({ mode: 'hang-prompt' })
    await h.start({ taskId: h.taskId })
    expect([...h.start.externalInFlight()]).toEqual([h.review()!.id])
  })

  // Fix round 1, finding 2: spec 3.4 step 9, the agent's messages are in the transcript
  it('keeps each turn’s message in the transcript, cut at a cap with a marker', async () => {
    const h = rig()
    await h.run()
    expect(h.acpLines.map((l) => l.line).join('\n')).toContain('Second line.')
    const long = rig({ mode: 'no-verdict-twice', message: 'x'.repeat(25_000) })
    await long.run()
    const logged = long.acpLines.map((l) => l.line)
    expect(logged.some((l) => l.includes('x'.repeat(20_000)) && !l.includes('x'.repeat(20_001)))).toBe(true)
    expect(logged.join('\n')).toMatch(/cut at 20000 characters/)
  })
})
