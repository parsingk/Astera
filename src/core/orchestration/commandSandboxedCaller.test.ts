// What a sandboxed session starts is sandboxed (final fix pass, C3, the person's decision): `sessions create` and a Job
// made by a session whose note says it runs in the sandbox start in the sandbox whatever profile they name, and so does
// every worker of such a Job, of a Task such a session added, and of a `worker-start` it asks for. A caller that is not
// sandboxed is answered exactly as before. This file holds the command layer's half: what it marks and hands on.
import { describe, it, expect, vi } from 'vitest'
import { handleCommand, type HostSession, type OrchServerDeps } from './command'
import { createJob, createTask, emptyState, startJobRun, workSandboxed, type OrchState } from './state'
import { APP_CALLER } from '../host/driver'

const NOW = '2026-10-28T00:00:00.000Z'
const BOXED = 'sess_box'
const OPEN = 'sess_open'

const row = (over: Partial<HostSession> = {}): HostSession => ({
  id: 'sess_new', kind: 'terminal', title: 't', accountId: 'acc_c', cwd: 'D:/p', alive: true, state: 'unknown', ...over
})

const makeDeps = (extra: Partial<OrchServerDeps> = {}): OrchServerDeps & { asked: string[] } => {
  const box = { state: emptyState() }
  const asked: string[] = []
  return {
    asked,
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 's', cwd: 'D:/p', specPath: 'S' }),
    releaseWorker: async () => {},
    listAccounts: () => [
      { id: 'acc_c', label: 'C', provider: 'claude' as const },
      { id: 'acc_x', label: 'X', provider: 'codex' as const }
    ],
    readWorker: async () => '',
    now: () => NOW,
    // The Host answers from the session's note (`sandboxed`), by the session the call's token names
    sessionSandboxed: (sessionId: string) => (asked.push(sessionId), sessionId === BOXED),
    ...extra
  } as OrchServerDeps & { asked: string[] }
}

const callAs = (deps: OrchServerDeps, sessionId: string, cmd: string, args: Record<string, unknown>) => handleCommand(deps, { sessionId }, cmd, args)

describe('sessions create from a sandboxed session', () => {
  it('starts the session sandboxed, whatever the profile; an unsandboxed caller is unchanged', async () => {
    const createSession = vi.fn(async () => row())
    const deps = makeDeps({ createSession })
    expect((await callAs(deps, BOXED, 'sessions-create', { account: 'acc_c', cwd: 'D:/p' })).status).toBe(200)
    expect(createSession).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'acc_c', sandbox: true }))
    for (const sessionId of [OPEN, '']) {
      expect((await callAs(deps, sessionId, 'sessions-create', { account: 'acc_c', cwd: 'D:/p' })).status).toBe(200)
      expect((createSession.mock.calls.at(-1) as unknown as [Record<string, unknown>])[0]).not.toHaveProperty('sandbox')
    }
    // The app's own calls and a shell's are no session: nothing is asked for them
    await handleCommand(deps, { sessionId: APP_CALLER, role: 'app' }, 'sessions-create', { account: 'acc_c', cwd: 'D:/p' })
    expect(deps.asked).toEqual([BOXED, OPEN])
  })
})

describe('a Job and a Task made by a sandboxed session', () => {
  it('marks the Job, and every Task it holds runs sandboxed', async () => {
    const deps = makeDeps()
    const boxed = await callAs(deps, BOXED, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const open = await callAs(deps, OPEN, 'run-create', { objective: 'o2', cwd: 'D:/p' })
    // run-create answers the Job's first run, or the Job itself while it waits for its start
    const jobOf = (r: { body: unknown }) => {
      const id = (r.body as { id: string }).id
      const s = deps.getState()
      return s.jobs.find((j) => j.id === id || j.id === s.runs.find((x) => x.id === id)?.jobId)!
    }
    expect(jobOf(boxed).sandboxed).toBe(true)
    expect(jobOf(open)).not.toHaveProperty('sandboxed')
    // Every Task of the sandboxed Job runs sandboxed, whoever adds it
    const run = deps.getState().runs.find((x) => x.jobId === jobOf(boxed).id)!
    const t = (await callAs(deps, OPEN, 'task-create', { run: run.id, spec: 'x', account: 'acc_c' })).body as { id: string }
    const task = deps.getState().tasks.find((x) => x.id === t.id)!
    expect(task).not.toHaveProperty('sandboxed')
    expect(workSandboxed(deps.getState(), task)).toBe(true)
  })

  it('marks a Task it adds, to a Job it did not make too', async () => {
    const deps = makeDeps()
    const job = (await callAs(deps, OPEN, 'run-create', { objective: 'o', cwd: 'D:/p' })).body as { id: string }
    const added = await callAs(deps, BOXED, 'task-create', { run: job.id, spec: 'do it', account: 'acc_c' })
    const plain = await callAs(deps, OPEN, 'task-create', { run: job.id, spec: 'do that', account: 'acc_c' })
    const taskOf = (r: { body: unknown }) => deps.getState().tasks.find((t) => t.id === (r.body as { id: string }).id)!
    expect(taskOf(added).sandboxed).toBe(true)
    expect(taskOf(plain)).not.toHaveProperty('sandboxed')
  })

  it('starts the coordinator of a sandboxed Job sandboxed', async () => {
    const started: Array<Record<string, unknown>> = []
    const deps = makeDeps({
      makeRunWorktree: async (a: { name: string }) => `D:/wt/${a.name}`,
      startCoordinator: async (a) => (started.push(a as unknown as Record<string, unknown>), { sessionId: 'coord' })
    })
    for (const sessionId of [BOXED, OPEN]) {
      const job = (await callAs(deps, sessionId, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true, coordinatorAccount: 'acc_c' })).body as { id: string }
      expect((await callAs(deps, APP_CALLER, 'run-start', { run: job.id })).status).toBe(200)
    }
    expect(started).toHaveLength(2)
    expect(started[0].sandbox).toBe(true)
    expect(started[1]).not.toHaveProperty('sandbox')
  })

  it('asks for a sandboxed worker when a sandboxed session starts one', async () => {
    const startWorker = vi.fn(async () => ({ sessionId: 'w1', cwd: 'D:/p', specPath: 'S' }))
    const deps = makeDeps({ startWorker })
    const job = (await callAs(deps, OPEN, 'run-create', { objective: 'o', cwd: 'D:/p', auto: true })).body as { id: string }
    await callAs(deps, APP_CALLER, 'run-start', { run: job.id })
    const run = deps.getState().runs.find((r) => r.jobId === job.id)!
    for (const [sessionId, spec] of [[BOXED, 'a'], [OPEN, 'b']]) {
      const t = (await callAs(deps, OPEN, 'task-create', { run: run.id, spec, account: 'acc_c' })).body as { id: string }
      expect((await callAs(deps, sessionId, 'worker-start', { taskId: t.id, agent: 'claude', account: 'acc_c', worktree: 'current' })).status, sessionId).toBe(200)
    }
    expect((startWorker.mock.calls[0] as unknown as [Record<string, unknown>])[0].sandbox).toBe(true)
    expect((startWorker.mock.calls[1] as unknown as [Record<string, unknown>])[0]).not.toHaveProperty('sandbox')
  })
})

describe('workSandboxed', () => {
  it('reads the Task’s mark or its Job’s, through a run the Job started', () => {
    let s = emptyState()
    const boxed = createJob(s, { objective: 'o', cwd: 'D:/p', sandboxed: true }, NOW)
    if (!boxed.ok) throw new Error(boxed.error)
    s = boxed.state
    const def = createTask(s, { jobId: boxed.value.id, title: 't', spec: 's', deps: [] }, NOW)
    if (!def.ok) throw new Error(def.error)
    s = def.state
    const started = startJobRun(s, boxed.value.id, NOW)
    if (!started.ok) throw new Error(started.error)
    s = started.state
    const copy = s.tasks.find((t) => t.runId === started.value.id)!
    expect(workSandboxed(s, def.value)).toBe(true)
    expect(workSandboxed(s, copy)).toBe(true)
    const open = createJob(s, { objective: 'o2', cwd: 'D:/p' }, NOW)
    if (!open.ok) throw new Error(open.error)
    s = open.state
    const plain = createTask(s, { jobId: open.value.id, title: 't', spec: 's', deps: [] }, NOW)
    const marked = createTask(plain.ok ? plain.state : s, { jobId: open.value.id, title: 't2', spec: 's', deps: [], sandboxed: true }, NOW)
    if (!plain.ok || !marked.ok) throw new Error('task')
    expect(workSandboxed(marked.state, plain.value)).toBe(false)
    expect(workSandboxed(marked.state, marked.value)).toBe(true)
    // A Task copied into a run keeps its own mark
    const run = startJobRun(marked.state, open.value.id, NOW)
    if (!run.ok) throw new Error(run.error)
    const copies = run.state.tasks.filter((t) => t.runId === run.value.id)
    expect(copies.map((t) => workSandboxed(run.state, t)).sort()).toEqual([false, true])
  })
})
