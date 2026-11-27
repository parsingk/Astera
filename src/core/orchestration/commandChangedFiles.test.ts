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
    expect(r.body).toEqual({ runId, reported: [], git: { files: [FILE], live: false, total: 1 }, ranges: [{ base: 'bbbbbbb', head: 'ccccccc' }] })
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
    expect(r).toEqual({ status: 200, body: { file: FILE, diff: 'diff of src/한글 a.ts', truncated: false, range: { base: 'bbbbbbb', head: 'ccccccc' } } })
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

// Phase 3 Part 4: one attempt's own range, the ranges read, and who changed each file
describe('agent-aware review', () => {
  const T = (m: number): string => `2026-11-27T10:${String(m).padStart(2, '0')}:00.000Z`
  const reviewState = (): OrchState =>
    ({
      ...emptyState(),
      jobs: [{ id: 'job1', cwd: 'P' }],
      runs: [{ id: 'run1', jobId: 'job1', git: { base: 'aaaaaaa', head: 'ccccccc' } }],
      tasks: [
        { id: 't1', runId: 'run1', filesModified: ['src/a.ts'] },
        { id: 't2', runId: 'run1' }
      ],
      dispatches: [
        { id: 'd1', taskId: 't1', provider: 'claude', accountId: 'acc', sessionId: 's1', cwd: 'P', startedAt: T(0), endedAt: T(10), git: { base: 'aaaaaaa', head: 'bbbbbbb' } },
        { id: 'd2', taskId: 't1', provider: 'codex', accountId: 'acc2', sessionId: 's2', cwd: 'P', startedAt: T(20), endedAt: T(30), repair: 'review-failure', git: { base: 'bbbbbbb', head: 'ccccccc' } },
        { id: 'r1', taskId: 't1', provider: 'claude', accountId: 'acc', sessionId: 'sr', cwd: 'P', startedAt: T(12), endedAt: T(15), review: true, git: { base: 'bbbbbbb', head: 'bbbbbbb' } }
      ]
    }) as unknown as OrchState
  const A = file('fa', 'src/a.ts')
  const B = file('fb', 'src/b.ts')
  const answers = {
    'P aaaaaaa..ccccccc': [A, B],
    'P aaaaaaa..bbbbbbb': [A],
    'P bbbbbbb..ccccccc': [A, B]
  }
  const withReview = (o: { ancestry?: boolean; audit?: ReadonlySet<string> | null } = {}) => {
    const m = makeDeps({ state: reviewState(), answers })
    const audits: unknown[] = []
    const deps = m.deps as unknown as Record<string, unknown> & { changes: Record<string, unknown> }
    if (o.ancestry !== false) deps.changes.isAncestor = async () => true
    deps.auditWrites = async (a: unknown) => {
      audits.push(a)
      return o.audit ?? null
    }
    return { ...m, audits }
  }

  it('reads one attempt’s own range when it is named, and echoes it', async () => {
    const { deps, asked } = withReview()
    const r = await call(deps, 'runs-changed-files', { runId: 'run1', dispatchId: 'd2' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ runId: 'run1', taskId: 't1', dispatchId: 'd2' })
    expect((r.body as { git: { files: ChangedFile[] } }).git.files.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(asked).toEqual(['P bbbbbbb..ccccccc'])
  })

  it('refuses an attempt of another Run, a review attempt, or one that is not the named Task’s', async () => {
    const { deps } = withReview()
    expect((await call(deps, 'runs-changed-files', { runId: 'run1', dispatchId: 'nope' })).status).toBe(404)
    expect((await call(deps, 'runs-changed-files', { runId: 'run1', dispatchId: 'r1' })).status).toBe(404)
    expect((await call(deps, 'runs-changed-files', { runId: 'run1', taskId: 't2', dispatchId: 'd1' })).status).toBe(400)
  })

  it('names the range each part was read over', async () => {
    const { deps } = withReview()
    const body = (await call(deps, 'runs-changed-files', { runId: 'run1' })).body as { ranges: unknown }
    expect(body.ranges).toEqual([{ base: 'aaaaaaa', head: 'ccccccc' }])
  })

  it('attributes each file when asked, and reads nothing more when not', async () => {
    const plain = withReview()
    const body = (await call(plain.deps, 'runs-changed-files', { runId: 'run1', taskId: 't1' })).body as Record<string, unknown>
    expect(body.attribution).toBeUndefined()
    expect(plain.asked).toEqual(['P aaaaaaa..ccccccc'])
    const asked = withReview({ audit: new Set(['src/a.ts']) })
    const got = (await call(asked.deps, 'runs-changed-files', { runId: 'run1', taskId: 't1', attribution: true })).body as {
      attribution: Record<string, { kind: string; level?: string; evidence: Array<{ dispatchId: string }> }>
    }
    // A Task's list names its files with the Task, as it always did
    expect(got.attribution['fa~t1']).toMatchObject({ kind: 'agent', level: 'observe-audit' })
    expect(got.attribution['fa~t1'].evidence.map((e) => e.dispatchId)).toEqual(['d1', 'd2'])
    expect(got.attribution['fb~t1']).toMatchObject({ kind: 'agent', level: 'recorded-range' })
    expect(got.attribution['fb~t1'].evidence.map((e) => e.dispatchId)).toEqual(['d2'])
    expect(asked.audits).toEqual([
      { taskId: 't1', since: T(0), until: T(10) },
      { taskId: 't1', since: T(20), until: T(30) }
    ])
  })

  // Final review I1: once a merge reaps an attempt's worktree, its range is read in the project folder, as the list is
  it('attributes an attempt whose worktree is gone over its range in the project folder', async () => {
    const m = makeDeps({
      state: {
        ...emptyState(),
        jobs: [{ id: 'job1', cwd: 'P' }],
        runs: [{ id: 'run1', jobId: 'job1', worktree: 'W', git: { base: 'aaaaaaa', head: 'bbbbbbb' } }],
        tasks: [{ id: 't1', runId: 'run1' }],
        dispatches: [{ id: 'd1', taskId: 't1', provider: 'claude', accountId: 'acc', sessionId: 's1', cwd: 'W', startedAt: T(0), endedAt: T(10), git: { base: 'aaaaaaa', head: 'bbbbbbb' } }]
      } as unknown as OrchState,
      answers: { 'P aaaaaaa..bbbbbbb': [A] }
    })
    const repos: string[] = []
    const deps = m.deps as unknown as { changes: Record<string, unknown> }
    deps.changes.isAncestor = async (repo: string) => {
      repos.push(repo)
      return true
    }
    const got = (await call(m.deps, 'runs-changed-files', { runId: 'run1', taskId: 't1', attribution: true })).body as { attribution: Record<string, { kind: string }> }
    expect(got.attribution['fa~t1'].kind).toBe('agent')
    expect(repos).toEqual(['P'])
  })

  // Review focus 3 with reads: the repair's base was recorded after its first commit, so that commit's file is in no
  // attempt's range and is credited to no one
  it('credits a commit made before a late base to no attempt', async () => {
    const late = withReview()
    const s = late.deps.getState()
    late.deps.setState({ ...s, dispatches: s.dispatches.map((x) => (x.id === 'd2' ? { ...x, git: { base: 'bbbbbb2', head: 'ccccccc' } } : x)) } as OrchState)
    const answers2 = late.asked
    void answers2
    const m = makeDeps({ state: late.deps.getState(), answers: { 'P aaaaaaa..ccccccc': [A, B], 'P aaaaaaa..bbbbbbb': [A], 'P bbbbbb2..ccccccc': [A] } })
    const deps2 = m.deps as unknown as { changes: Record<string, unknown> }
    deps2.changes.isAncestor = async () => true
    const got = (await call(m.deps, 'runs-changed-files', { runId: 'run1', taskId: 't1', attribution: true })).body as { attribution: Record<string, { kind: string; why?: string }> }
    expect(got.attribution['fb~t1']).toMatchObject({ kind: 'unknown', why: 'no-range' })
    expect(got.attribution['fa~t1'].kind).toBe('agent')
  })

  it('answers no attribution where git ancestry cannot be asked', async () => {
    const { deps } = withReview({ ancestry: false })
    const body = (await call(deps, 'runs-changed-files', { runId: 'run1', taskId: 't1', attribution: true })).body as Record<string, unknown>
    expect(body.attribution).toBeUndefined()
  })

  it('answers runs-diff’s range always and the file’s placed findings when asked', async () => {
    const { deps } = withReview()
    const plain = (await call(deps, 'runs-diff', { runId: 'run1', taskId: 't1', fileId: 'fa~t1' })).body as Record<string, unknown>
    expect(plain.range).toEqual({ base: 'aaaaaaa', head: 'ccccccc' })
    expect(plain.findings).toBeUndefined()
    const s = deps.getState()
    deps.setState({ ...s, tasks: s.tasks.map((t) => (t.id === 't1' ? { ...t, reviewIssues: [{ id: 'i1', severity: 'high', blocking: true, title: 'wrong', description: '', file: 'src/a.ts', line: 1 }] } : t)) } as OrchState)
    const asked = (await call(deps, 'runs-diff', { runId: 'run1', taskId: 't1', fileId: 'fa~t1', findings: true })).body as { findings: Array<{ title: string; placement: unknown }> }
    expect(asked.findings).toEqual([expect.objectContaining({ title: 'wrong', placement: 'file' })])
  })

  it('reads a file’s diff in the attempt’s own range when runs-diff names the attempt', async () => {
    const { deps, diffs } = withReview()
    const r = await call(deps, 'runs-diff', { runId: 'run1', dispatchId: 'd2', fileId: 'fb~t1' })
    expect(r.status).toBe(200)
    expect(diffs).toEqual(['P bbbbbbb..ccccccc src/b.ts'])
  })
})
