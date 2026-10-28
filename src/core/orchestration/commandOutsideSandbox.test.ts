// A sandboxed caller cannot hand work to something outside its sandbox (final fix pass, part 2, A, the person's strict
// decision). Typing into or messaging a session that is not sandboxed (`sessions send`, a worker started into another
// session with `worker-start --terminal`, a `reply` to a worker's question) is refused, and so is running a Job, or work
// of one, that is not sandboxed (`run start`, `jobs run`, `run spawn`, `run resume`, `runs resume`, `runs reconverge`,
// `tasks dispatch`, a `task-update` that re-arms a Task, a question's answer). A sandboxed target is allowed, and so are
// the structured channel a worker reports and asks through (`send`, `ask`) and the answers that only stop work. A caller
// that is not sandboxed is answered exactly as before.
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
const ROUTES: Array<{ name: string; cmd: string; args: (w: World) => Record<string, unknown>; target: (w: World) => string; kind: 'job' | 'task' | 'session' }> = [
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
  {
    name: 'worker-start --terminal',
    cmd: 'worker-start',
    args: (w) => ({ taskId: w.b.id, agent: 'claude', account: 'acc_c', worktree: 'current', terminal: idleOf(w.worker) }),
    target: (w) => `session ${idleOf(w.worker)}`,
    kind: 'session'
  },
  { name: 'reply', cmd: 'reply', args: (w) => ({ id: w.questionId, body: 'this one' }), target: (w) => `session ${w.worker}`, kind: 'session' }
]

/** The world in which a route's target runs in the sandbox: a sandboxed session's Job, a sandboxed Task in a Job that is
 *  not, a worker session in the sandbox. */
const boxedWorlds = (kind: 'job' | 'task' | 'session'): World[] =>
  kind === 'job' ? [world({ jobBoxed: true })] : kind === 'task' ? [world({ jobBoxed: true }), world({ taskBoxed: true })] : [world({ worker: W_BOX })]

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
  // Job that is not sandboxed reports and asks as any worker does
  it('a sandboxed worker reports and asks toward a coordinator outside the sandbox', async () => {
    const w = world({ worker: BOXED })
    const { deps } = makeDeps(w.s)
    const status = await call(deps, BOXED, 'send', { type: 'status', taskId: w.a.id, subject: 'half way', body: 'b' })
    expect(status.status).toBe(200)
    // Its question is open already (the world's): it waits on it again
    const asked = await call(deps, BOXED, 'ask', { resume: w.questionId, timeoutMs: 0 })
    expect(asked.status).toBe(200)
    const done = await call(deps, BOXED, 'send', { type: 'worker_done', taskId: w.a.id, dispatchId: w.dispatchId, outcome: 'succeeded', subject: 'done', body: 'b' })
    expect(done.status).toBe(200)
    expect(errorOf(done)).toBeUndefined()
  })

  // Part 1 (§3): a worker a sandboxed caller starts itself starts in the sandbox, so it hands nothing outside
  it('a worker it starts itself, which starts in the sandbox', async () => {
    const w = world()
    const { deps, effects } = makeDeps(w.s)
    const r = await call(deps, BOXED, 'worker-start', { taskId: w.b.id, agent: 'claude', account: 'acc_c', worktree: 'current' })
    expect(r.status).toBe(200)
    expect((effects.startWorker.mock.calls[0] as unknown as [Record<string, unknown>])[0].sandbox).toBe(true)
  })
})
