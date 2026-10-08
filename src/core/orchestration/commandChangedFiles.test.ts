// `runs-changed-files` and `runs-diff` (remote runtime design Phase 10, §4.8): a Run's or a Task's changed files from
// the owning machine's git beside the worker's own list, and one file's diff by the id the list gave it, never a path.
import { describe, it, expect } from 'vitest'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'
import { HOST_CALLER } from '../host/driver'
import type { ChangedFile } from '../git/changes'

const NOW = '2026-10-08T00:00:00.000Z'
const file = (id: string, path: string): ChangedFile => ({ id, path, status: 'modified', additions: 1, deletions: 0 })
const FILE = file('f1', 'src/한글 a.ts')

function makeDeps(o: { answers?: Record<string, ChangedFile[] | null>; state?: OrchState } = {}) {
  const box = { state: o.state ?? (emptyState() as OrchState) }
  const asked: string[] = []
  const diffs: string[] = []
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
      diff: async (repo: string, base: string, head: string | null, f: ChangedFile) => {
        diffs.push(`${repo} ${base}..${head ?? 'worktree'} ${f.path}`)
        return { diff: `diff of ${f.path}`, truncated: false }
      }
    }
  } as unknown as OrchServerDeps
  return { deps, asked, diffs }
}

const call = (deps: OrchServerDeps, cmd: string, args: Record<string, unknown>) => handleCommand(deps, { sessionId: '' }, cmd, args)

async function seeded(o: Parameters<typeof makeDeps>[0] = {}) {
  const m = makeDeps(o)
  await call(m.deps, 'run-create', { objective: 'o', cwd: 'D:/p' })
  const runId = m.deps.getState().runs[0].id
  await handleCommand(m.deps, { sessionId: HOST_CALLER }, 'runs-git-record', { runId, base: 'bbbbbbb', head: 'ccccccc' })
  return { ...m, runId }
}

/** A parallel Run: its root is a worktree, and a Task worked in a worktree of its own. */
function parallel(answers: Record<string, ChangedFile[] | null>) {
  const state = {
    ...emptyState(),
    jobs: [{ id: 'job1', cwd: 'P' }],
    runs: [{ id: 'run1', jobId: 'job1', worktree: 'W', git: { base: 'aaaaaaa', head: 'bbbbbbb' } }],
    tasks: [{ id: 't1', runId: 'run1', filesModified: ['x.ts'] }],
    dispatches: [{ id: 'd1', taskId: 't1', cwd: 'T1', startedAt: '1', endedAt: '2', git: { base: 'ccccccc', head: 'ddddddd' } }]
  } as unknown as OrchState
  return makeDeps({ state, answers })
}

describe('runs-changed-files', () => {
  it('answers the first range git can read, beside the worker’s list', async () => {
    const { deps, runId, asked } = await seeded({ answers: { 'D:/p bbbbbbb..ccccccc': [FILE] } })
    const r = await call(deps, 'runs-changed-files', { runId })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ runId, reported: [], git: { files: [FILE], live: false, total: 1 } })
    expect(asked).toEqual(['D:/p bbbbbbb..ccccccc'])
  })
  it('a parallel Run’s list holds what its Tasks did in their own worktrees, one row per path', async () => {
    const { deps } = parallel({
      'P aaaaaaa..bbbbbbb': [file('r1', 'root.ts'), file('r2', 'both.ts')],
      'T1 ccccccc..ddddddd': [file('t1', 'task.ts'), file('t2', 'both.ts')]
    })
    const body = (await call(deps, 'runs-changed-files', { runId: 'run1' })).body as { git: { files: ChangedFile[]; total: number } }
    expect(body.git.files.map((f) => [f.path, f.taskId])).toEqual([
      ['root.ts', undefined],
      ['both.ts', undefined],
      ['task.ts', 't1']
    ])
    expect(new Set(body.git.files.map((f) => f.id)).size).toBe(3)
    expect(body.git.total).toBe(3)
  })
  it('a Task part that git cannot read leaves the rest of the list', async () => {
    const { deps } = parallel({ 'P aaaaaaa..bbbbbbb': [file('r1', 'root.ts')] })
    expect((await call(deps, 'runs-changed-files', { runId: 'run1' })).body).toMatchObject({ git: { files: [{ path: 'root.ts' }] } })
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
    const { deps, runId } = await seeded({ answers: { 'D:/p bbbbbbb..ccccccc': [FILE] } })
    const jobId = deps.getState().runs[0].jobId
    expect((await call(deps, 'runs-changed-files', { runId: jobId })).body).toMatchObject({ runId, git: { files: [FILE] } })
    expect((await call(deps, 'runs-diff', { runId: jobId, fileId: 'f1' })).status).toBe(200)
  })
  it('an unknown Run is 404, a missing id 400', async () => {
    const { deps } = await seeded()
    expect((await call(deps, 'runs-changed-files', { runId: 'run_x' })).status).toBe(404)
    expect((await call(deps, 'runs-changed-files', {})).status).toBe(400)
  })
  it('a list cut by git says how many files there were', async () => {
    const cut = Object.defineProperty([FILE], 'total', { value: 5000, enumerable: false }) as ChangedFile[]
    const { deps, runId } = await seeded({ answers: { 'D:/p bbbbbbb..ccccccc': cut } })
    expect((await call(deps, 'runs-changed-files', { runId })).body).toMatchObject({ git: { files: [FILE], total: 5000 } })
  })
})

describe('runs-diff', () => {
  it('takes a file by its id and answers its diff', async () => {
    const { deps, runId } = await seeded({ answers: { 'D:/p bbbbbbb..ccccccc': [FILE] } })
    const r = await call(deps, 'runs-diff', { runId, fileId: 'f1' })
    expect(r).toEqual({ status: 200, body: { file: FILE, diff: 'diff of src/한글 a.ts', truncated: false } })
  })
  it('a Task part’s file is read in that Task’s range', async () => {
    const { deps, diffs } = parallel({ 'P aaaaaaa..bbbbbbb': [file('r1', 'root.ts')], 'T1 ccccccc..ddddddd': [file('t1', 'task.ts')] })
    const list = (await call(deps, 'runs-changed-files', { runId: 'run1' })).body as { git: { files: ChangedFile[] } }
    const id = list.git.files.find((f) => f.path === 'task.ts')!.id
    expect((await call(deps, 'runs-diff', { runId: 'run1', fileId: id })).status).toBe(200)
    expect(diffs).toEqual(['T1 ccccccc..ddddddd task.ts'])
  })
  it('an id the list does not have is 404, and a path is never taken for one', async () => {
    const { deps, runId } = await seeded({ answers: { 'D:/p bbbbbbb..ccccccc': [FILE] } })
    expect((await call(deps, 'runs-diff', { runId, fileId: 'src/한글 a.ts' })).status).toBe(404)
    expect((await call(deps, 'runs-diff', { runId })).status).toBe(400)
  })
})
