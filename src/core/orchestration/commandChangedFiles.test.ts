// `runs-changed-files` and `runs-diff` (remote runtime design Phase 10, §4.8): a Run's or a Task's changed files from
// the owning machine's git beside the worker's own list, and one file's diff by the id the list gave it, never a path.
import { describe, it, expect } from 'vitest'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'
import { HOST_CALLER } from '../host/driver'
import type { ChangedFile } from '../git/changes'

const NOW = '2026-10-08T00:00:00.000Z'
const FILE: ChangedFile = { id: 'f1', path: 'src/한글 a.ts', status: 'modified', additions: 1, deletions: 0 }

function makeDeps(o: { answers?: Record<string, ChangedFile[] | null> } = {}) {
  const box = { state: emptyState() as OrchState }
  const asked: string[] = []
  const deps = {
    getState: () => box.state,
    setState: async (next: OrchState) => void (box.state = next),
    startWorker: async () => ({ sessionId: 's', cwd: 'D:/p', specPath: 'D:/p/a.md' }),
    releaseWorker: async () => {},
    listAccounts: () => [{ id: 'acc', label: 'a', provider: 'codex' as const }],
    readWorker: async () => '',
    now: () => NOW,
    changes: {
      read: async (repo: string, base: string, head: string | null) => {
        const key = `${repo} ${base}..${head ?? 'worktree'}`
        asked.push(key)
        return key in (o.answers ?? {}) ? o.answers![key] : null
      },
      diff: async (_repo: string, _base: string, _head: string | null, f: ChangedFile) => ({ diff: `diff of ${f.path}`, truncated: false })
    }
  } as unknown as OrchServerDeps
  return { deps, asked }
}

const call = (deps: OrchServerDeps, cmd: string, args: Record<string, unknown>) => handleCommand(deps, { sessionId: '' }, cmd, args)

async function seeded(o: Parameters<typeof makeDeps>[0] = {}) {
  const m = makeDeps(o)
  await call(m.deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
  const runId = m.deps.getState().runs[0].id
  await handleCommand(m.deps, { sessionId: HOST_CALLER }, 'runs-git-record', { runId, base: 'b', head: 'h' })
  return { ...m, runId }
}

describe('runs-changed-files', () => {
  it('answers the first range git can read, beside the worker’s list', async () => {
    const { deps, runId, asked } = await seeded({ answers: { 'D:/p b..h': [FILE] } })
    const r = await call(deps, 'runs-changed-files', { runId })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ runId, reported: [], git: { files: [FILE], base: 'b', head: 'h' } })
    expect(asked).toEqual(['D:/p b..h'])
  })
  it('says why when there is no git list', async () => {
    const { deps, runId } = await seeded()
    expect((await call(deps, 'runs-changed-files', { runId })).body).toMatchObject({ git: null, unavailable: 'git-failed' })
    const fresh = makeDeps()
    await call(fresh.deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
    const other = fresh.deps.getState().runs[0].id
    expect((await call(fresh.deps, 'runs-changed-files', { id: other })).body).toMatchObject({ git: null, unavailable: 'not-recorded' })
  })
  // The Run detail names a Run by its Job (hand check of Phase 10): the Job's latest Run, as runs-completion reads it.
  it('a Job id reads its latest Run', async () => {
    const { deps, runId } = await seeded({ answers: { 'D:/p b..h': [FILE] } })
    const jobId = deps.getState().runs[0].jobId
    expect((await call(deps, 'runs-changed-files', { runId: jobId })).body).toMatchObject({ runId, git: { files: [FILE] } })
    expect((await call(deps, 'runs-diff', { runId: jobId, fileId: 'f1' })).status).toBe(200)
  })
  it('an unknown Run is 404, a missing id 400', async () => {
    const { deps } = await seeded()
    expect((await call(deps, 'runs-changed-files', { runId: 'run_x' })).status).toBe(404)
    expect((await call(deps, 'runs-changed-files', {})).status).toBe(400)
  })
})

describe('runs-diff', () => {
  it('takes a file by its id and answers its diff', async () => {
    const { deps, runId } = await seeded({ answers: { 'D:/p b..h': [FILE] } })
    const r = await call(deps, 'runs-diff', { runId, fileId: 'f1' })
    expect(r).toEqual({ status: 200, body: { file: FILE, diff: 'diff of src/한글 a.ts', truncated: false } })
  })
  it('an id the list does not have is 404, and a path is never taken for one', async () => {
    const { deps, runId } = await seeded({ answers: { 'D:/p b..h': [FILE] } })
    expect((await call(deps, 'runs-diff', { runId, fileId: 'src/한글 a.ts' })).status).toBe(404)
    expect((await call(deps, 'runs-diff', { runId })).status).toBe(400)
  })
})
