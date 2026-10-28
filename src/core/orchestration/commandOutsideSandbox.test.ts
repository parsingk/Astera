// A sandboxed caller cannot hand work to something outside its sandbox (final fix pass, part 2, A, the person's strict
// decision). Typing into or messaging a session that is not sandboxed (`sessions send`, a worker started into another
// session with `worker-start --terminal`, a `reply` to a worker's question) is refused, and so is running a Job, or work
// of one, that is not sandboxed (`run start`, `jobs run`, `run spawn`, `run resume`, `runs resume`, `runs reconverge`,
// `tasks dispatch`, `worker-start`, a `task-update` that re-arms a Task, a question's answer; part 3 adds `worker-start`
// with or without `--terminal`), and a message posted into such a Job's run by a session that is neither a worker of that
// run nor its coordinator (`send`, part 3). A sandboxed target is allowed, and so are a worker's reports and questions to
// its own run (`send`, `ask`) and the answers that only stop work. A caller that is not sandboxed is answered exactly as
// before.
import { describe, it, expect, vi } from 'vitest'
import { handleCommand, type HostSession, type OrchServerDeps } from './command'
import { closeDispatch, createGate, createJob, createQuestion, createTask, emptyState, openDispatch, startJobRun, type OrchState } from './state'
import { APP_CALLER } from '../host/driver'

const NOW = '2026-10-28T00:00:00.000Z'
/** The callers: a session in its CLI's sandbox, and one outside it */
const BOXED = 'sess_box'
const OPEN = 'sess_open'
/** The sessions work is handed to: a worker in the sandbox, and one outside it, each with a session of the same run whose
 *  attempt has ended (what `worker-start --terminal` types the next Task into) */
const W_BOX = 'w_box'
const W_OPEN = 'w_open'
const idleOf = (worker: string): string => `${worker}_idle`
const SANDBOXED = new Set([BOXED, W_BOX, idleOf(W_BOX)])

type Res<T> = { ok: true; state: OrchState; value: T } | { ok: false; error: string }
function ok<T>(r: Res<T>): { state: OrchState; value: T } {
  if (!r.ok) throw new Error(r.error)
  return r
}

/** A Job with its first run: Task a worked on by `worker`, whose question is open; Task b ready; Task c blocked on a
 *  question (a Gate); Task e's attempt ended in the session `idleOf(worker)`. `jobBoxed` marks the Job as a sandboxed
 *  session's, `taskBoxed` its run's Tasks. */
function world(o: { jobBoxed?: boolean; taskBoxed?: boolean; worker?: string } = {}) {
  let s = emptyState()
  const job = ok(createJob(s, { objective: 'o', cwd: 'D:/p', ...(o.jobBoxed ? { sandboxed: true } : {}) }, NOW))
  s = job.state
  const run = ok(startJobRun(s, job.value.id, NOW))
  s = run.state
  const task = (title: string) => {
    const t = ok(createTask(s, { runId: run.value.id, title, spec: 's', deps: [], accountIds: ['acc_c'], ...(o.taskBoxed ? { sandboxed: true } : {}) }, NOW))
    s = t.state
    return t.value
  }
  const a = task('a')
  const b = task('b')
  const c = task('c')
  const e = task('e')
  const worker = o.worker ?? W_OPEN
  s = ok(openDispatch(s, { taskId: e.id, provider: 'claude', accountId: 'acc_c', sessionId: idleOf(worker), cwd: 'D:/p', specPath: 'S' }, NOW)).state
  s = ok(closeDispatch(s, { sessionId: idleOf(worker), exitCode: 0 }, NOW)).state
  const d = ok(openDispatch(s, { taskId: a.id, provider: 'claude', accountId: 'acc_c', sessionId: worker, cwd: 'D:/p', specPath: 'S' }, NOW))
  s = d.state
  const q = ok(createQuestion(s, { taskId: a.id, dispatchId: d.value.id, question: 'which one?' }, NOW))
  s = q.state
  const g = ok(createGate(s, { taskId: c.id, question: 'go on?' }, NOW))
  s = g.state
  return { s, jobId: job.value.id, runId: run.value.id, a, b, c, worker, dispatchId: d.value.id, questionId: q.value.id, gateId: g.value.id }
}
type World = ReturnType<typeof world>

const row = (id: string): HostSession => ({ id, kind: 'terminal', title: 't', accountId: 'acc_c', cwd: 'D:/p', alive: true, state: 'unknown' })

/** A Host's deps over `s`, with every effect a spy. Without `sandboxed: false` it answers which sessions run in the
 *  sandbox, as the Host does from its sessions' notes. */
function makeDeps(s: OrchState, o: { sandboxed?: false } = {}) {
  const box = { state: s }
  const effects = {
    startWorker: vi.fn(async () => ({ sessionId: 'w_new', cwd: 'D:/p', specPath: 'S' })),
    dispatchTask: vi.fn(async () => ({ status: 200, body: { placed: true } })),
    sendSession: vi.fn(async () => {}),
    chatSend: vi.fn(async () => ({ sent: true as const })),
    startCoordinator: vi.fn(async () => ({ sessionId: 'coord' }))
  }
  const deps = {
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc_c', label: 'C', provider: 'claude' as const }],
    readWorker: async () => '',
    now: () => NOW,
    listSessions: async () => [row(W_BOX), row(W_OPEN)],
    ...effects,
    ...(o.sandboxed === false ? {} : { sessionSandboxed: (id: string) => SANDBOXED.has(id) })
  } as unknown as OrchServerDeps
  return { deps, effects, box }
}

const call = (deps: OrchServerDeps, sessionId: string, cmd: string, args: Record<string, unknown>) =>
  handleCommand(deps, { sessionId, role: sessionId === APP_CALLER ? 'app' : 'cli' }, cmd, args)

const errorOf = (r: { body: unknown }): string | undefined => (r.body as { error?: string } | null)?.error

/** Each route that hands work on, the arguments for it in a world, and what its refusal names. */
type Kind = 'job' | 'task' | 'session' | 'task-and-session'
const ROUTES: Array<{ name: string; cmd: string; args: (w: World) => Record<string, unknown>; target: (w: World) => string; kind: Kind }> = [
  { name: 'run start of a Job', cmd: 'run-start', args: (w) => ({ run: w.jobId }), target: (w) => `job ${w.jobId}`, kind: 'job' },
  { name: 'run start of a run', cmd: 'run-start', args: (w) => ({ run: w.runId }), target: (w) => `job ${w.jobId}`, kind: 'job' },
  { name: 'jobs run', cmd: 'jobs-run', args: (w) => ({ id: w.jobId }), target: (w) => `job ${w.jobId}`, kind: 'job' },
  { name: 'run spawn', cmd: 'run-spawn', args: (w) => ({ run: w.jobId }), target: (w) => `job ${w.jobId}`, kind: 'job' },
  { name: 'run resume', cmd: 'run-resume', args: (w) => ({ run: w.jobId }), target: (w) => `job ${w.jobId}`, kind: 'job' },
  { name: 'runs resume', cmd: 'runs-resume', args: (w) => ({ id: w.runId }), target: (w) => `job ${w.jobId}`, kind: 'job' },
  { name: 'runs reconverge', cmd: 'runs-reconverge', args: (w) => ({ id: w.runId }), target: (w) => `job ${w.jobId}`, kind: 'job' },
  { name: 'tasks dispatch', cmd: 'tasks-dispatch', args: (w) => ({ id: w.b.id }), target: (w) => `task ${w.b.id}`, kind: 'task' },
  { name: 'task-update to ready', cmd: 'task-update', args: (w) => ({ id: w.b.id, status: 'ready' }), target: (w) => `task ${w.b.id}`, kind: 'task' },
  { name: 'task-update to completed', cmd: 'task-update', args: (w) => ({ id: w.a.id, status: 'completed' }), target: (w) => `task ${w.a.id}`, kind: 'task' },
  { name: 'gate-resolve', cmd: 'gate-resolve', args: (w) => ({ id: w.gateId, resolution: 'yes' }), target: (w) => `task ${w.c.id}`, kind: 'task' },
  { name: 'questions answer', cmd: 'questions-answer', args: (w) => ({ id: w.gateId, answer: 'yes' }), target: (w) => `task ${w.c.id}`, kind: 'task' },
  { name: 'sessions send', cmd: 'sessions-send', args: (w) => ({ id: w.worker, text: 'do this' }), target: (w) => `session ${w.worker}`, kind: 'session' },
  // Part 3: a worker of a Task that is not sandboxed is refused whether it starts afresh or into another session
  {
    name: 'worker-start',
    cmd: 'worker-start',
    args: (w) => ({ taskId: w.b.id, agent: 'claude', account: 'acc_c', worktree: 'current' }),
    target: (w) => `task ${w.b.id}`,
    kind: 'task'
  },
  {
    name: 'worker-start --terminal',
    cmd: 'worker-start',
    args: (w) => ({ taskId: w.b.id, agent: 'claude', account: 'acc_c', worktree: 'current', terminal: idleOf(w.worker) }),
    target: (w) => `task ${w.b.id}`,
    kind: 'task-and-session'
  },
  // Part 3: a message into the run of a Job that is not sandboxed, from a session that is neither its worker nor its
  // coordinator
  { name: 'send', cmd: 'send', args: (w) => ({ type: 'status', taskId: w.b.id, subject: 'note', body: 'do this' }), target: (w) => `job ${w.jobId}`, kind: 'job' },
  // Part 3: a question follows the send rule, a new one and a wait on one already asked alike
  { name: 'ask --resume', cmd: 'ask', args: (w) => ({ resume: w.questionId, timeoutMs: 0 }), target: (w) => `job ${w.jobId}`, kind: 'job' },
  { name: 'reply', cmd: 'reply', args: (w) => ({ id: w.questionId, body: 'this one' }), target: (w) => `session ${w.worker}`, kind: 'session' }
]

/** The world in which a route's target runs in the sandbox: a sandboxed session's Job, a sandboxed Task in a Job that is
 *  not, a worker session in the sandbox, or both of the last two. */
const boxedWorlds = (kind: Kind): World[] =>
  kind === 'job'
    ? [world({ jobBoxed: true })]
    : kind === 'task'
      ? [world({ jobBoxed: true }), world({ taskBoxed: true })]
      : kind === 'session'
        ? [world({ worker: W_BOX })]
        : [world({ jobBoxed: true, worker: W_BOX }), world({ taskBoxed: true, worker: W_BOX })]

describe('a sandboxed caller hands nothing outside its sandbox', () => {
  it.each(ROUTES)('$name is refused for unsandboxed work, before anything moves', async (route) => {
    const w = world()
    const { deps, effects, box } = makeDeps(w.s)
    const r = await call(deps, BOXED, route.cmd, route.args(w))
    expect(r.status).toBe(403)
    expect(errorOf(r)).toBe(`SANDBOX_UNAVAILABLE: outside-sandbox ${route.target(w)}`)
    // Nothing was committed, started, placed or typed
    expect(box.state).toBe(w.s)
    for (const [name, spy] of Object.entries(effects)) expect(spy, name).not.toHaveBeenCalled()
  })

  it.each(ROUTES)('$name is allowed for sandboxed work, answered as an unsandboxed caller is', async (route) => {
    for (const w of boxedWorlds(route.kind)) {
      const boxed = await call(makeDeps(w.s).deps, BOXED, route.cmd, route.args(w))
      const open = await call(makeDeps(w.s).deps, OPEN, route.cmd, route.args(w))
      expect(errorOf(boxed) ?? '').not.toMatch(/outside-sandbox/)
      expect(boxed.status).toBe(open.status)
      expect(errorOf(boxed)).toBe(errorOf(open))
    }
  })

  it.each(ROUTES)('$name from an unsandboxed caller is unchanged', async (route) => {
    const w = world()
    for (const sessionId of [OPEN, '', APP_CALLER]) {
      const asked = await call(makeDeps(w.s).deps, sessionId, route.cmd, route.args(w))
      const before = await call(makeDeps(w.s, { sandboxed: false }).deps, sessionId, route.cmd, route.args(w))
      expect(asked.status, sessionId).toBe(before.status)
      expect(errorOf(asked), sessionId).toBe(errorOf(before))
    }
  })

  it('a session send to a chat session outside the sandbox is refused too, and nothing is typed', async () => {
    const w = world()
    const { deps, effects } = makeDeps(w.s)
    ;(deps as { listSessions: () => Promise<HostSession[]> }).listSessions = async () => [{ ...row(W_OPEN), kind: 'chat' }]
    const r = await call(deps, BOXED, 'sessions-send', { id: W_OPEN, text: 'do this' })
    expect(errorOf(r)).toBe(`SANDBOX_UNAVAILABLE: outside-sandbox session ${W_OPEN}`)
    expect(effects.chatSend).not.toHaveBeenCalled()
  })

  // A session that is gone or never was is answered as before (404, 409): there is nothing to hand anything to
  it('a session send names a missing or ended session as before', async () => {
    const w = world()
    const { deps } = makeDeps(w.s)
    expect((await call(deps, BOXED, 'sessions-send', { id: 'nobody', text: 'x' })).status).toBe(404)
    ;(deps as { listSessions: () => Promise<HostSession[]> }).listSessions = async () => [{ ...row(W_OPEN), alive: false }]
    expect((await call(deps, BOXED, 'sessions-send', { id: W_OPEN, text: 'x' })).status).toBe(409)
  })
})

describe('what stays open to a sandboxed caller', () => {
  // The answers that only stop work hand nothing on
  it('the answers that only stop unsandboxed work', async () => {
    for (const [cmd, args] of [
      ['task-update', (w: World) => ({ id: w.b.id, status: 'failed' })],
      ['task-update', (w: World) => ({ id: w.c.id, status: 'blocked' })],
      ['task-update', (w: World) => ({ id: w.b.id, convergence: 'off' })],
      ['gate-resolve', (w: World) => ({ id: w.gateId, resolution: 'mark-failed' })]
    ] as const) {
      const w = world()
      const boxed = await call(makeDeps(w.s).deps, BOXED, cmd, args(w))
      const open = await call(makeDeps(w.s).deps, OPEN, cmd, args(w))
      expect(errorOf(boxed) ?? '', `${cmd} ${JSON.stringify(args(w))}`).not.toMatch(/outside-sandbox/)
      expect(boxed.status).toBe(open.status)
    }
  })

  // `astera report` and `ask` are the structured channel a worker uses toward its coordinator: a sandboxed worker of a
  // person's Job that is not sandboxed reports to its own run and asks as any worker does (part 3 keeps this open)
  it('a sandboxed worker reports and asks toward a coordinator outside the sandbox', async () => {
    const w = world({ worker: BOXED })
    const { deps } = makeDeps(w.s)
    const status = await call(deps, BOXED, 'send', { type: 'status', taskId: w.a.id, subject: 'half way', body: 'b' })
    expect(status.status).toBe(200)
    // Without --task-id the message goes to the latest run, its own here
    const heartbeat = await call(deps, BOXED, 'send', { type: 'heartbeat', subject: 'alive', body: '' })
    expect(heartbeat.status).toBe(200)
    // Its question is open already (the world's): it waits on it again
    const asked = await call(deps, BOXED, 'ask', { resume: w.questionId, timeoutMs: 0 })
    expect(asked.status).toBe(200)
    const done = await call(deps, BOXED, 'send', { type: 'worker_done', taskId: w.a.id, dispatchId: w.dispatchId, outcome: 'succeeded', subject: 'done', body: 'b' })
    expect(done.status).toBe(200)
    expect(errorOf(done)).toBeUndefined()
  })

  // Part 3: the coordinator Astera started for the run posts into it too
  it("a sandboxed run's coordinator, posting into its own run", async () => {
    const w = world()
    const s = { ...w.s, runs: w.s.runs.map((r) => (r.id === w.runId ? { ...r, coordinatorSessionId: BOXED } : r)) }
    const r = await call(makeDeps(s).deps, BOXED, 'send', { type: 'status', taskId: w.b.id, subject: 'note', body: 'b' })
    expect(r.status).toBe(200)
  })

  // Part 1 (§3): a worker a sandboxed caller starts on sandboxed work starts in the sandbox
  it('a worker it starts on a sandboxed Task, which starts in the sandbox', async () => {
    const w = world({ taskBoxed: true })
    const { deps, effects } = makeDeps(w.s)
    const r = await call(deps, BOXED, 'worker-start', { taskId: w.b.id, agent: 'claude', account: 'acc_c', worktree: 'current' })
    expect(r.status).toBe(200)
    expect((effects.startWorker.mock.calls[0] as unknown as [Record<string, unknown>])[0].sandbox).toBe(true)
  })
})

describe('what part 3 closes besides', () => {
  // A new question, as `send` is: open to a worker of the run (a sandboxed worker of a person's Job asks on its own run),
  // refused from a sandboxed session that is neither its worker nor its coordinator
  it('a new question from a sandboxed caller follows the send rule', async () => {
    for (const worker of [BOXED, W_OPEN]) {
      const w = world({ worker })
      const { deps, box } = makeDeps(w.s)
      // The world's question answered first (by an unsandboxed caller), so the Dispatch may ask again
      expect((await call(deps, OPEN, 'reply', { id: w.questionId, body: 'that one' })).status).toBe(200)
      const answered = box.state
      const r = await call(deps, BOXED, 'ask', { taskId: w.a.id, dispatchId: w.dispatchId, question: 'and then?', timeoutMs: 0 })
      if (worker === BOXED) {
        expect(r.status).toBe(200)
        expect(box.state.messages.filter((m) => m.type === 'question')).toHaveLength(2)
      } else {
        expect(errorOf(r)).toBe(`SANDBOX_UNAVAILABLE: outside-sandbox job ${w.jobId}`)
        expect(box.state).toBe(answered)
      }
    }
    // Into a sandboxed Job's run, and from the coordinator Astera started for the run, it is open
    const boxedJob = world({ jobBoxed: true })
    const open = makeDeps(boxedJob.s)
    await call(open.deps, OPEN, 'reply', { id: boxedJob.questionId, body: 'that one' })
    expect((await call(open.deps, BOXED, 'ask', { taskId: boxedJob.a.id, dispatchId: boxedJob.dispatchId, question: 'q', timeoutMs: 0 })).status).toBe(200)
    const led = world()
    const coordinated = makeDeps({ ...led.s, runs: led.s.runs.map((r) => (r.id === led.runId ? { ...r, coordinatorSessionId: BOXED } : r)) })
    await call(coordinated.deps, OPEN, 'reply', { id: led.questionId, body: 'that one' })
    expect((await call(coordinated.deps, BOXED, 'ask', { taskId: led.a.id, dispatchId: led.dispatchId, question: 'q', timeoutMs: 0 })).status).toBe(200)
  })

  // A sandboxed Task typed into a session outside the sandbox is refused for the session
  it('worker-start --terminal of a sandboxed Task into a session outside the sandbox', async () => {
    const w = world({ taskBoxed: true })
    const { deps, effects, box } = makeDeps(w.s)
    const r = await call(deps, BOXED, 'worker-start', { taskId: w.b.id, agent: 'claude', account: 'acc_c', worktree: 'current', terminal: idleOf(w.worker) })
    expect(errorOf(r)).toBe(`SANDBOX_UNAVAILABLE: outside-sandbox session ${idleOf(w.worker)}`)
    expect(box.state).toBe(w.s)
    expect(effects.startWorker).not.toHaveBeenCalled()
  })

  // Driving a run from outside (`check --run`) makes no session its coordinator, and a worker of another run is no
  // worker of this one
  it('a send from a session that only drives the run from outside, or works in another run', async () => {
    const w = world()
    const driven = { ...w.s, runs: w.s.runs.map((r) => (r.id === w.runId ? { ...r, externalCoordinatorSessionId: BOXED } : r)) }
    const fromOutside = await call(makeDeps(driven).deps, BOXED, 'send', { type: 'escalation', taskId: w.b.id, subject: 'x', body: 'y' })
    expect(errorOf(fromOutside)).toBe(`SANDBOX_UNAVAILABLE: outside-sandbox job ${w.jobId}`)
    // BOXED works in a sandboxed Job's run, and posts into the person's run
    const mine = world({ jobBoxed: true, worker: BOXED })
    const theirs = world()
    const both: OrchState = {
      ...mine.s,
      jobs: [...mine.s.jobs, ...theirs.s.jobs],
      runs: [...mine.s.runs, ...theirs.s.runs],
      tasks: [...mine.s.tasks, ...theirs.s.tasks],
      dispatches: [...mine.s.dispatches, ...theirs.s.dispatches],
      messages: [...mine.s.messages, ...theirs.s.messages],
      gates: [...mine.s.gates, ...theirs.s.gates]
    }
    const elsewhere = await call(makeDeps(both).deps, BOXED, 'send', { type: 'status', taskId: theirs.b.id, subject: 'x', body: 'y' })
    expect(errorOf(elsewhere)).toBe(`SANDBOX_UNAVAILABLE: outside-sandbox job ${theirs.jobId}`)
    const own = await call(makeDeps(both).deps, BOXED, 'send', { type: 'status', taskId: mine.a.id, subject: 'x', body: 'y' })
    expect(own.status).toBe(200)
  })
})
