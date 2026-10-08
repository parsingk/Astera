// `runs-git-record`, the Host's own write of the git range a Run or a Dispatch worked over (remote runtime design Phase
// 10). Only the Host calls it: a worker, the app, the CLI or a controller could otherwise point a Run's changed files
// at any commits.
import { describe, it, expect } from 'vitest'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'
import { HOST_CALLER } from '../host/driver'

const NOW = '2026-10-08T00:00:00.000Z'

const makeDeps = (): OrchServerDeps => {
  const box = { state: emptyState() as OrchState }
  return {
    getState: () => box.state,
    setState: async (next: OrchState) => void (box.state = next),
    startWorker: async () => ({ sessionId: 's', cwd: 'D:/p', specPath: 'D:/p/a.md' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc', label: 'a', provider: 'codex' as const }],
    readWorker: async () => '',
    now: () => NOW
  } as unknown as OrchServerDeps
}

const host = (deps: OrchServerDeps, args: Record<string, unknown>) => handleCommand(deps, { sessionId: HOST_CALLER }, 'runs-git-record', args)

const seeded = async (): Promise<{ deps: OrchServerDeps; runId: string }> => {
  const deps = makeDeps()
  await handleCommand(deps, { sessionId: '' }, 'run-create', { objective: 'o', cwd: 'D:/p' })
  return { deps, runId: deps.getState().runs[0].id }
}

describe('runs-git-record', () => {
  it('the Host records a Run’s range', async () => {
    const { deps, runId } = await seeded()
    expect((await host(deps, { runId, base: 'b1b1b1b', head: 'c1c1c1c' })).status).toBe(200)
    expect(deps.getState().runs[0].git).toEqual({ base: 'b1b1b1b', head: 'c1c1c1c' })
  })
  it('anyone but the Host is refused', async () => {
    const { deps, runId } = await seeded()
    for (const sessionId of ['', 'sess-worker', 'astera:app'])
      expect((await handleCommand(deps, { sessionId }, 'runs-git-record', { runId, base: 'b1b1b1b' })).status).toBe(403)
    expect(deps.getState().runs[0].git).toBeUndefined()
  })
  it('needs exactly one id and something to record; an unknown id is 404', async () => {
    const { deps, runId } = await seeded()
    expect((await host(deps, { base: 'bbbbbbb' })).status).toBe(400)
    expect((await host(deps, { runId, dispatchId: 'd', base: 'bbbbbbb' })).status).toBe(400)
    expect((await host(deps, { runId })).status).toBe(400)
    expect((await host(deps, { runId: 'run_x', base: 'bbbbbbb' })).status).toBe(404)
    expect((await host(deps, { dispatchId: 'dsp_x', head: 'ccccccc' })).status).toBe(404)
  })
  // Phase 10 review: what is recorded is handed to git as a revision, so it is a commit id and nothing else.
  it('a value that is not a commit id is refused', async () => {
    const { deps, runId } = await seeded()
    for (const bad of ['--output=x', 'HEAD', 'main', 'abc', 'b1b1b1b;rm'])
      expect((await host(deps, { runId, base: bad })).status).toBe(400)
    expect(deps.getState().runs[0].git).toBeUndefined()
  })
})
