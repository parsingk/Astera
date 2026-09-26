// `runs-follow`, the Host's half of `astera runs follow` (CLI spec §22). One call is one long poll: it
// answers as soon as the run has more timeline events than the caller has seen, or has reached one of
// `runs wait`'s endings, or its window passes. It never writes, so a client that goes away (Ctrl+C)
// leaves nothing behind but a poll that ends on its own.
import { describe, it, expect } from 'vitest'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'

const NOW = '2026-08-04T00:00:00.000Z'

const makeDeps = (): OrchServerDeps & { writes: number } => {
  const box = { state: emptyState() as OrchState, writes: 0 }
  const deps = {
    get writes() {
      return box.writes
    },
    getState: () => box.state,
    setState: async (next: OrchState) => {
      box.writes++
      box.state = next
    },
    startWorker: async () => ({ sessionId: 's', cwd: 'D:/p', specPath: 'D:/p/a.md' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc', label: 'a', provider: 'codex' as const }],
    readWorker: async () => '',
    now: () => NOW
  }
  return deps as unknown as OrchServerDeps & { writes: number }
}

const call = (deps: OrchServerDeps, cmd: string, args: Record<string, unknown> = {}) =>
  handleCommand(deps, { sessionId: '' }, cmd, args)

interface Page {
  runId: string
  jobId: string
  count: number
  events: { kind: string; sourceId: string }[]
  ending: { state: string } | null
  progress: { done: number; total: number }
}

const seeded = async (): Promise<{ deps: OrchServerDeps & { writes: number }; runId: string; taskId: string }> => {
  const deps = makeDeps()
  await call(deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
  const runId = deps.getState().runs[0].id
  const t = await call(deps, 'task-create', { run: runId, title: 't', spec: 's', account: 'acc' })
  return { deps, runId, taskId: (t.body as { id: string }).id }
}

describe('runs-follow', () => {
  it('answers at once with every event when the caller has seen fewer', async () => {
    const { deps, runId } = await seeded()
    const r = await call(deps, 'runs-follow', { id: runId, seen: 0, waitMs: 5_000 })
    expect(r.status).toBe(200)
    const page = r.body as Page
    expect(page.runId).toBe(runId)
    expect(page.count).toBe(2)
    expect(page.events.map((e) => e.kind)).toEqual(['run-created', 'task-created'])
    expect(page.ending).toBeNull()
    expect(page.progress).toEqual({ done: 0, total: 1 })
  })

  it('with nothing new it waits out its window and answers no events', async () => {
    const { deps, runId } = await seeded()
    const started = Date.now()
    const r = await call(deps, 'runs-follow', { id: runId, seen: 2, waitMs: 120 })
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
    expect((r.body as Page).events).toEqual([])
    expect((r.body as Page).ending).toBeNull()
  })

  it('wakes when a new event lands during the window', async () => {
    const { deps, runId, taskId } = await seeded()
    const pending = call(deps, 'runs-follow', { id: runId, seen: 2, waitMs: 5_000 })
    setTimeout(() => void call(deps, 'gate-create', { task: taskId, question: 'which?' }), 30)
    const page = (await pending).body as Page
    expect(page.events.map((e) => e.kind)).toContain('gate-opened')
  })

  it("ends on `runs wait`'s endings, with the same body", async () => {
    const { deps, runId, taskId } = await seeded()
    await call(deps, 'task-update', { id: taskId, status: 'completed' })
    const page = (await call(deps, 'runs-follow', { id: runId, seen: 99, waitMs: 5_000 })).body as Page
    const waited = (await call(deps, 'runs-wait', { id: runId, timeoutMs: 100 })).body
    expect(page.ending).toEqual(waited)
    expect(page.ending?.state).toBe('completed')
  })

  it('a waiting run ends the follow too, as it ends a wait', async () => {
    const { deps, runId, taskId } = await seeded()
    await call(deps, 'gate-create', { task: taskId, question: 'q' })
    const page = (await call(deps, 'runs-follow', { id: runId, seen: 0, waitMs: 5_000 })).body as Page
    expect(page.ending?.state).toBe('waiting')
    expect(page.events.map((e) => e.kind)).toContain('gate-opened')
  })

  it('never writes the state', async () => {
    const { deps, runId } = await seeded()
    const before = deps.writes
    await call(deps, 'runs-follow', { id: runId, seen: 0, waitMs: 50 })
    await call(deps, 'runs-follow', { id: runId, seen: 2, waitMs: 50 })
    expect(deps.writes).toBe(before)
  })

  it('a missing id is 400, and an unknown run is 404', async () => {
    const { deps } = await seeded()
    expect((await call(deps, 'runs-follow', {})).status).toBe(400)
    expect((await call(deps, 'runs-follow', { id: 'run_nope' })).status).toBe(404)
  })

  it('a run deleted while it is followed is a 404', async () => {
    const { deps, runId } = await seeded()
    const pending = call(deps, 'runs-follow', { id: runId, seen: 2, waitMs: 5_000 })
    setTimeout(() => {
      const cur = deps.getState()
      void deps.setState({ ...cur, runs: [], tasks: [] })
    }, 30)
    expect((await pending).status).toBe(404)
  })
})
