import { describe, it, expect } from 'vitest'
import { createPullRequest, type PrCreateRequest } from './prCreate'

const req = (over: Partial<PrCreateRequest> = {}): PrCreateRequest => ({
  worktreePath: 'C:/wt/opal',
  repoPath: 'D:/repo',
  branch: 'parsingk/opal',
  base: 'develop',
  title: 't',
  body: 'b',
  draft: false,
  needsPush: false,
  ...over
})

const okGh = { ok: true, stdout: 'https://github.com/o/r/pull/7', stderr: '' }
const okGit = { ok: true, stdout: '', stderr: '' }

describe('createPullRequest', () => {
  it('creates without pushing when the branch is already on the remote', async () => {
    const gitCalls: string[][] = []
    const r = await createPullRequest(req(), {
      runGit: async (a) => {
        gitCalls.push(a)
        return okGit
      },
      runGh: async () => okGh,
      normalizeBase: async (_r, b) => b
    })
    expect(r).toEqual({ ok: true, url: 'https://github.com/o/r/pull/7' })
    expect(gitCalls).toEqual([])
  })

  it('pushes with -u and only then creates', async () => {
    const order: string[] = []
    const r = await createPullRequest(req({ needsPush: true }), {
      runGit: async (a) => {
        order.push('git ' + a.join(' '))
        return okGit
      },
      runGh: async (a) => {
        order.push('gh ' + a.join(' '))
        return okGh
      },
      normalizeBase: async (_r, b) => b
    })
    expect(r.ok).toBe(true)
    expect(order[0]).toBe('git push -u origin parsingk/opal')
    expect(order[1]).toContain('gh pr create')
  })

  // A force fallback here would rewrite someone's remote branch to make a button work.
  it('never falls back to force when the push is rejected', async () => {
    const calls: string[][] = []
    const r = await createPullRequest(req({ needsPush: true }), {
      runGit: async (a) => {
        calls.push(a)
        return { ok: false, stdout: '', stderr: 'rejected: non-fast-forward' }
      },
      runGh: async () => okGh,
      normalizeBase: async (_r, b) => b
    })
    expect(r).toEqual({
      ok: false,
      stage: 'push',
      kind: 'rejected',
      detail: 'rejected: non-fast-forward',
      pushed: false
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].join(' ')).not.toContain('force')
  })

  // Leaving this out invites someone to undo a push that was fine.
  it('reports that the push already succeeded when only the create failed', async () => {
    const r = await createPullRequest(req({ needsPush: true }), {
      runGit: async () => okGit,
      runGh: async () => ({ ok: false, stdout: '', stderr: 'HTTP 403: API rate limit exceeded' }),
      normalizeBase: async (_r, b) => b
    })
    expect(r).toMatchObject({ ok: false, stage: 'create', kind: 'rate-limit', pushed: true })
  })

  it('recognises an already-existing PR as its own kind', async () => {
    const r = await createPullRequest(req(), {
      runGit: async () => okGit,
      runGh: async () => ({
        ok: false,
        stdout: '',
        stderr: 'a pull request for branch "parsingk/opal" into branch "develop" already exists:\nhttps://github.com/o/r/pull/3'
      }),
      normalizeBase: async (_r, b) => b
    })
    expect(r).toMatchObject({ ok: false, stage: 'create', kind: 'exists' })
  })

  // The union mirrors GhFailureKind; a bucket the classifier knows must not be flattened into
  // 'other', or a later reader cannot tell an unclassified failure from a discarded answer.
  it('passes a classifier bucket through rather than folding it into other', async () => {
    const r = await createPullRequest(req(), {
      runGit: async () => okGit,
      runGh: async () => ({ ok: false, stdout: '', stderr: 'no git remotes found' }),
      normalizeBase: async (_r, b) => b
    })
    expect(r).toMatchObject({ ok: false, stage: 'create', kind: 'no-remote' })
  })

  it('passes the normalised base, and --draft only when asked', async () => {
    let args: string[] = []
    await createPullRequest(req({ base: 'origin/develop', draft: true }), {
      runGit: async () => okGit,
      runGh: async (a) => {
        args = a
        return okGh
      },
      normalizeBase: async () => 'develop'
    })
    expect(args).toContain('--base')
    expect(args[args.indexOf('--base') + 1]).toBe('develop')
    expect(args).toContain('--draft')
  })

  it('omits --draft when not asked', async () => {
    let args: string[] = []
    await createPullRequest(req(), {
      runGit: async () => okGit,
      runGh: async (a) => {
        args = a
        return okGh
      },
      normalizeBase: async (_r, b) => b
    })
    expect(args).not.toContain('--draft')
  })

  it('runs gh in the worktree, not the main repo', async () => {
    let cwd = ''
    await createPullRequest(req(), {
      runGit: async () => okGit,
      runGh: async (_a, c) => {
        cwd = c
        return okGh
      },
      normalizeBase: async (_r, b) => b
    })
    expect(cwd).toBe('C:/wt/opal')
  })
})
