// The list filters of the public read surface (CLI spec §14, §16, §19): `jobs list --status` and
// `--project`, `questions list --run`, `sessions list --status` and `--provider`.
//
// **They are applied here, in the command layer, and never in the parser.** The parser only turns
// tokens into values; what a value means is this layer's, and a value it does not know is a 400
// (exit 2) that names the values it does, never an empty list that reads as "nothing matches".
import { describe, it, expect } from 'vitest'
import { handleCommand, type HostSession, type OrchServerDeps } from './command'
import { ensureProject } from './projects'
import { emptyState, type OrchState } from './state'
import { absPath } from '../testPaths'

const NOW = '2026-08-04T00:00:00.000Z'

const makeDeps = (initial: OrchState = emptyState(), extra: Partial<OrchServerDeps> = {}): OrchServerDeps => {
  const box = { state: initial }
  return {
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.state = next
    },
    startWorker: async () => ({ sessionId: 'sess1', cwd: 'D:/p', specPath: 'D:/p/orch/specs/a.md' }),
    releaseWorker: async () => {},
    listAccounts: (provider?: 'claude' | 'codex') =>
      [
        { id: 'acc_c', label: 'Claude', provider: 'claude' as const },
        { id: 'acc_x', label: 'Codex', provider: 'codex' as const }
      ].filter((a) => provider === undefined || a.provider === provider),
    readWorker: async () => 'output',
    now: () => NOW,
    ...extra
  } as OrchServerDeps
}

const call = (
  deps: OrchServerDeps,
  cmd: string,
  args: Record<string, unknown> = {}
): Promise<{ status: number; body: unknown }> => handleCommand(deps, { sessionId: '' }, cmd, args)

const ids = (body: unknown): string[] => (body as { id: string }[]).map((x) => x.id)

describe('jobs list --status — the state word the --human table shows', () => {
  /** Four Jobs, one per state: completed, failed, waiting and pending. */
  const fourJobs = async (): Promise<{ deps: OrchServerDeps; byState: Record<string, string> }> => {
    const deps = makeDeps()
    const byState: Record<string, string> = {}
    const task = async (runId: string): Promise<string> => {
      const t = await call(deps, 'task-create', { run: runId, title: 't', spec: 's', account: 'acc_x' })
      return (t.body as { id: string }).id
    }
    for (const name of ['completed', 'failed', 'waiting']) {
      await call(deps, 'run-create', { objective: name, cwd: 'D:/p' })
      const run = deps.getState().runs.at(-1)!
      byState[name] = run.jobId
      const id = await task(run.id)
      if (name === 'completed') await call(deps, 'task-update', { id, status: 'completed' })
      if (name === 'waiting') await call(deps, 'gate-create', { task: id, question: 'q' })
      if (name === 'failed') {
        const cur = deps.getState()
        await deps.setState({
          ...cur,
          tasks: cur.tasks.map((t) => (t.id === id ? { ...t, status: 'failed' as const, consecutiveFailures: 3 } : t))
        })
      }
    }
    const created = await call(deps, 'jobs-create', { objective: 'pending', cwd: 'D:/p' })
    byState.pending = (created.body as { id: string }).id
    return { deps, byState }
  }

  it('keeps only the Jobs in that state', async () => {
    const { deps, byState } = await fourJobs()
    for (const state of ['completed', 'failed', 'waiting', 'pending']) {
      const r = await call(deps, 'jobs-list', { status: state })
      expect(r.status, state).toBe(200)
      expect(ids(r.body), state).toEqual([byState[state]])
    }
    const running = await call(deps, 'jobs-list', { status: 'running' })
    expect(ids(running.body)).toEqual([])
  })

  it('a paused schedule is paused, not scheduled', async () => {
    const deps = makeDeps()
    await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p', schedule: { kind: 'daily', time: '09:00' } })
    const jobId = deps.getState().jobs[0].id
    expect(ids((await call(deps, 'jobs-list', { status: 'scheduled' })).body)).toEqual([jobId])
    await call(deps, 'run-pause', { run: jobId })
    expect(ids((await call(deps, 'jobs-list', { status: 'paused' })).body)).toEqual([jobId])
    expect(ids((await call(deps, 'jobs-list', { status: 'scheduled' })).body)).toEqual([])
  })

  it('an unknown value is a 400 that lists the values it knows', async () => {
    const r = await call(makeDeps(), 'jobs-list', { status: 'complete' })
    expect(r.status).toBe(400)
    const error = (r.body as { error: string }).error
    expect(error).toContain('complete')
    for (const known of ['pending', 'paused', 'scheduled', 'waiting', 'running', 'completed', 'failed'])
      expect(error).toContain(known)
  })

  it('a --status with no value is a 400, not every Job', async () => {
    expect((await call(makeDeps(), 'jobs-list', { status: true })).status).toBe(400)
    expect((await call(makeDeps(), 'jobs-list', { status: '' })).status).toBe(400)
  })
})

describe('jobs list --project — the project `projects find` would name', () => {
  const win = process.platform === 'win32'
  const root = absPath('work', 'proj')
  const other = absPath('work', 'other')

  const seeded = async (): Promise<{ deps: OrchServerDeps; mine: string[]; theirs: string }> => {
    const a = ensureProject(emptyState(), { path: root, now: NOW })
    const b = ensureProject(a.state, { path: other, now: NOW })
    const deps = makeDeps(b.state)
    await call(deps, 'jobs-create', { objective: 'mine', cwd: root })
    await call(deps, 'jobs-create', { objective: 'theirs', cwd: other })
    const state = deps.getState()
    // A Job made before projects were registered has no projectId, and belongs by its folder, the way
    // the Jobs sidebar reads it (view.ts jobsForProject). Spelled differently, as it arrives on win32.
    const legacy = {
      ...state.jobs[0],
      id: 'job_legacy',
      projectId: undefined,
      cwd: win ? root.toUpperCase() : `${root}/`
    }
    await deps.setState({ ...state, jobs: [...state.jobs, legacy] })
    return { deps, mine: [state.jobs[0].id, 'job_legacy'], theirs: state.jobs[1].id }
  }

  it("keeps only that project's Jobs, by id and, for old Jobs, by folder", async () => {
    const { deps, mine } = await seeded()
    const r = await call(deps, 'jobs-list', { project: win ? root.toLowerCase() : root })
    expect(r.status).toBe(200)
    expect(ids(r.body).sort()).toEqual([...mine].sort())
  })

  it('a folder no project is registered for is a 404, as projects find says', async () => {
    const { deps } = await seeded()
    const r = await call(deps, 'jobs-list', { project: absPath('nowhere') })
    expect(r.status).toBe(404)
    expect((r.body as { error: string }).error).toContain('no project registered for')
  })

  it('a --project with no value is a 400', async () => {
    const { deps } = await seeded()
    expect((await call(deps, 'jobs-list', { project: true })).status).toBe(400)
  })

  it('combines with --status', async () => {
    const { deps, theirs } = await seeded()
    const r = await call(deps, 'jobs-list', { project: other, status: 'pending' })
    expect(ids(r.body)).toEqual([theirs])
  })
})

describe('questions list --run', () => {
  const twoRuns = async (): Promise<{ deps: OrchServerDeps; runs: string[]; gates: string[] }> => {
    const deps = makeDeps()
    const runs: string[] = []
    const gates: string[] = []
    for (const o of ['a', 'b']) {
      await call(deps, 'run-create', { objective: o, cwd: 'D:/p' })
      const runId = deps.getState().runs.at(-1)!.id
      const t = await call(deps, 'task-create', { run: runId, title: 't', spec: 's', account: 'acc_x' })
      const g = await call(deps, 'gate-create', { task: (t.body as { id: string }).id, question: 'q' })
      runs.push(runId)
      gates.push((g.body as { id: string }).id)
    }
    return { deps, runs, gates }
  }

  it("keeps only that run's questions", async () => {
    const { deps, runs, gates } = await twoRuns()
    const r = await call(deps, 'questions-list', { run: runs[1] })
    expect(r.status).toBe(200)
    expect(ids(r.body)).toEqual([gates[1]])
  })

  it('an unknown run is a 404, not an empty list', async () => {
    const { deps } = await twoRuns()
    expect((await call(deps, 'questions-list', { run: 'run_nope' })).status).toBe(404)
  })

  it('a --run with no value is a 400', async () => {
    const { deps } = await twoRuns()
    expect((await call(deps, 'questions-list', { run: true })).status).toBe(400)
  })
})

describe('sessions list --status and --provider', () => {
  const rows: HostSession[] = [
    { id: 's1', kind: 'terminal', title: 'a', accountId: 'acc_c', cwd: null, alive: true, state: 'working' },
    { id: 's2', kind: 'terminal', title: 'b', accountId: 'acc_x', cwd: null, alive: true, state: 'unknown' },
    { id: 's3', kind: 'chat', title: 'c', accountId: 'acc_c', cwd: null, alive: false, state: 'unknown' },
    { id: 's4', kind: 'terminal', title: 'd', accountId: 'acc_gone', cwd: null, alive: true, state: 'waiting' },
    { id: 's5', kind: 'terminal', title: 'e', accountId: null, cwd: null, alive: true, state: 'unknown' }
  ]
  const hostDeps = (): OrchServerDeps =>
    makeDeps(emptyState(), {
      listSessions: async () => rows,
      readSession: async () => ({ cols: 80, rows: 24, screen: [], scrollback: [] }),
      sendSession: async () => {},
      readChat: async () => [],
      chatSend: async () => ({ sent: true })
    })

  it('--status alive and ended read `alive`', async () => {
    expect(ids((await call(hostDeps(), 'sessions-list', { status: 'alive' })).body)).toEqual(['s1', 's2', 's4', 's5'])
    expect(ids((await call(hostDeps(), 'sessions-list', { status: 'ended' })).body)).toEqual(['s3'])
  })

  it('--status working, waiting and unknown read `state`', async () => {
    expect(ids((await call(hostDeps(), 'sessions-list', { status: 'working' })).body)).toEqual(['s1'])
    expect(ids((await call(hostDeps(), 'sessions-list', { status: 'waiting' })).body)).toEqual(['s4'])
    expect(ids((await call(hostDeps(), 'sessions-list', { status: 'unknown' })).body)).toEqual(['s2', 's3', 's5'])
  })

  it("--provider is the provider of the session's account", async () => {
    expect(ids((await call(hostDeps(), 'sessions-list', { provider: 'claude' })).body)).toEqual(['s1', 's3'])
    expect(ids((await call(hostDeps(), 'sessions-list', { provider: 'codex' })).body)).toEqual(['s2'])
  })

  it('the two combine', async () => {
    const r = await call(hostDeps(), 'sessions-list', { provider: 'claude', status: 'alive' })
    expect(ids(r.body)).toEqual(['s1'])
  })

  it('an unknown value is a 400 that lists the values it knows', async () => {
    const status = await call(hostDeps(), 'sessions-list', { status: 'running' })
    expect(status.status).toBe(400)
    for (const known of ['alive', 'ended', 'working', 'waiting', 'unknown'])
      expect((status.body as { error: string }).error).toContain(known)
    const provider = await call(hostDeps(), 'sessions-list', { provider: 'gemini' })
    expect(provider.status).toBe(400)
    expect((provider.body as { error: string }).error).toContain('claude')
    expect((await call(hostDeps(), 'sessions-list', { provider: true })).status).toBe(400)
  })
})
