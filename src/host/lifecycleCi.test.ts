// The Host carries a handed-off lifecycle round to GitHub (GitHub lifecycle G3b1, design §4.1-4.3): preconditions, the
// push, the open or new draft pull request, and the wait recorded; on fakes for git, gh and the Host's commands.
import { describe, it, expect } from 'vitest'
import { RETRY_MS, createLifecycleCi, type LifecycleCiDeps } from './lifecycleCi'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { CheckResult, JobSourceRef } from '../core/orchestration/types'
import type { GitHubBinding } from '../core/github/lifecycle'

const NOW = Date.parse('2026-10-18T00:00:00.000Z')
const ISO = new Date(NOW).toISOString()
const SHA = 'c'.repeat(40)
const POLICY = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
const ISSUE: JobSourceRef = { id: 'github', itemId: '7', label: 'GitHub issue #7', url: 'https://github.com/parsingk/astera-lifecycle-sandbox/issues/7' }

const stateWith = (o: { binding?: GitHubBinding; source?: JobSourceRef; ciWait?: { since: string; done: CheckResult[]; pr?: number; sha?: string; bindPr?: number } } = {}): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'o', cwd: '/repo', createdAt: ISO, github: POLICY, convergence: {}, ...(o.source ? { source: o.source } : {}) }],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: ISO, worktree: '/wt-run', ...(o.binding ? { githubState: { binding: o.binding, log: [], seq: 0 } } : {}) }],
  tasks: [
    { id: 'tsk_a', runId: 'run_1', title: 'a', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: ISO, updatedAt: ISO },
    {
      id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub 전달', spec: 's', deps: ['tsk_a'], status: 'validating', validateConfigIds: ['github:ci'],
      reviewRequested: true, consecutiveFailures: 0, createdAt: ISO, updatedAt: ISO, ciWait: o.ciWait ?? { since: ISO, done: [] }
    }
  ]
})

function rig(o: {
  clean?: boolean
  changed?: number
  commits?: { subject: string; body: string }[] | null
  push?: Awaited<ReturnType<LifecycleCiDeps['push']>>
  open?: number[][]
  create?: Awaited<ReturnType<LifecycleCiDeps['createDraftPr']>>
  /** HEAD (ref undefined) or a ref, for the n-th headOf call (0-based). */
  heads?: (ref: string | undefined, n: number) => string | null
  recordStatus?: number
  waitStatus?: number
  gateStatus?: number
  worktree?: boolean
  origin?: string | null
  lang?: 'en' | 'ko'
} = {}) {
  const calls: string[] = []
  const settled: { taskId: string; result: CheckResult }[] = []
  const gates: { taskId: string; question: string }[] = []
  const githubGates: { taskId: string; since: string; kind: string; question: string; options: string[] }[] = []
  const records: unknown[] = []
  const waits: unknown[] = []
  const created: { base: string; head: string; title: string; body: string }[] = []
  const lookups = [...(o.open ?? [[]])]
  const clock = { now: NOW }
  let headCalls = 0
  const deps: LifecycleCiDeps = {
    worktreeOf: (p) => (o.worktree !== false && p === '/wt-run' ? { repoPath: '/repo', branch: 'u/a', baseRef: 'origin/main' } : null),
    originOf: async () => (o.origin === undefined ? 'git@github.com:parsingk/astera-lifecycle-sandbox.git' : o.origin),
    isClean: async () => (calls.push('isClean'), { clean: o.clean ?? true, changedCount: o.changed ?? 0 }),
    readCommits: async () => (calls.push('readCommits'), o.commits === undefined ? [{ subject: 'Fix add', body: 'add adds now' }] : o.commits),
    baseBranch: async () => 'main',
    push: async () => (calls.push('push'), o.push ?? { ok: true }),
    headOf: async (_cwd, ref) => (calls.push(ref ? `headOf ${ref}` : 'headOf'), o.heads ? o.heads(ref, headCalls++) : SHA),
    findOpenPrs: async () => {
      calls.push('findOpenPrs')
      const next = lookups.length > 1 ? lookups.shift()! : lookups[0]
      return { ok: true, prs: next.map((n) => ({ number: n, url: `https://github.com/parsingk/astera-lifecycle-sandbox/pull/${n}` })) }
    },
    createDraftPr: async (_cwd, _repo, pr) => (calls.push('createDraftPr'), created.push(pr), o.create ?? { ok: true, number: 3, url: 'https://github.com/parsingk/astera-lifecycle-sandbox/pull/3' }),
    record: async (args) => (calls.push('record'), records.push(args), { status: o.recordStatus ?? 200, body: {} }),
    recordWait: async (args) => (calls.push('recordWait'), waits.push(args), { status: o.waitStatus ?? 200, body: {} }),
    settle: async (a) => void (calls.push('settle'), settled.push(a)),
    openGate: async (a) => (calls.push('openGate'), gates.push(a), { status: o.gateStatus ?? 200, body: {} }),
    openGitHubGate: async (a) => (calls.push('openGitHubGate'), githubGates.push(a), { status: o.gateStatus ?? 200, body: {} }),
    lang: () => o.lang ?? 'ko',
    log: () => {},
    now: () => clock.now
  }
  const ci = createLifecycleCi(deps)
  return { ci, calls, settled, gates, githubGates, records, waits, created, clock }
}

describe('createLifecycleCi', () => {
  it('pushes, opens a draft pull request that refers to its issue, records the binding and the push, then the wait', async () => {
    const r = rig()
    r.ci.onState(stateWith({ source: ISSUE }))
    await r.ci.drain()
    expect(r.calls).toEqual(['isClean', 'readCommits', 'headOf', 'headOf refs/heads/u/a', 'push', 'headOf', 'findOpenPrs', 'createDraftPr', 'record', 'recordWait'])
    expect(r.created).toEqual([{ base: 'main', head: 'u/a', title: 'Fix add', body: 'add adds now\n\nRefs #7' }])
    expect(r.records).toEqual([
      {
        runId: 'run_1',
        patch: {
          binding: {
            repository: 'parsingk/astera-lifecycle-sandbox', number: 3, url: 'https://github.com/parsingk/astera-lifecycle-sandbox/pull/3',
            baseBranch: 'main', headBranch: 'u/a', createdByAstera: true, boundAt: ISO
          },
          pushed: { sha: SHA }
        }
      }
    ])
    expect(r.waits).toEqual([{ taskId: 'tsk_l', since: ISO, pr: 3, sha: SHA }])
  })

  it('binds the one open pull request of the branch instead of making another', async () => {
    const r = rig({ open: [[5]] })
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.calls).not.toContain('createDraftPr')
    expect(r.records[0]).toMatchObject({ patch: { binding: { number: 5, createdByAstera: false } } })
    expect(r.waits).toEqual([{ taskId: 'tsk_l', since: ISO, pr: 5, sha: SHA }])
  })

  // Review Focus 1: a restart after the binding was recorded
  it('a Run already bound pushes again and waits on its pull request, making none', async () => {
    const binding: GitHubBinding = { repository: 'parsingk/astera-lifecycle-sandbox', number: 3, url: 'u', baseBranch: 'main', headBranch: 'u/a', createdByAstera: true, boundAt: ISO }
    const r = rig()
    r.ci.onState(stateWith({ binding }))
    await r.ci.drain()
    expect(r.calls).toEqual(['isClean', 'readCommits', 'headOf', 'headOf refs/heads/u/a', 'push', 'headOf', 'record', 'recordWait'])
    expect(r.records).toEqual([{ runId: 'run_1', patch: { pushed: { sha: SHA } } }])
  })

  // Review Focus 3
  it('a create that failed is followed by a lookup that binds what it made', async () => {
    const r = rig({ open: [[], [3]], create: { ok: false, kind: 'network', message: 'Could not reach GitHub' } })
    r.ci.onState(stateWith())
    await r.ci.drain()
    // G3b1 final review M4: the lookup before found none, so the PR found now is the one Astera just made
    expect(r.records[0]).toMatchObject({ patch: { binding: { number: 3, createdByAstera: true } } })
    expect(r.gates).toEqual([])
  })

  it('a pull request gh says already exists for the branch is bound as the one Astera made', async () => {
    const r = rig({ create: { ok: true, number: 3, url: 'https://github.com/parsingk/astera-lifecycle-sandbox/pull/3', existed: true } })
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.records[0]).toMatchObject({ patch: { binding: { number: 3, createdByAstera: true } } })
  })

  it('a create that failed with nothing found after asks a person and makes no second one', async () => {
    const r = rig({ open: [[], []], create: { ok: false, kind: 'network', message: 'Could not reach GitHub' } })
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.calls.filter((c) => c === 'createDraftPr')).toHaveLength(1)
    expect(r.gates[0].question).toContain('Could not reach GitHub')
    expect(r.waits).toEqual([])
  })

  // G3b1 final review I1: CI is waited on for the commit the push sent, and only that one
  it('waits on the head it pushed: a HEAD off the branch tip, or one that moved during the push, asks a person', async () => {
    const off = rig({ heads: (ref) => (ref ? 'b'.repeat(40) : SHA) })
    off.ci.onState(stateWith())
    await off.ci.drain()
    expect(off.calls).not.toContain('push')
    expect(off.gates).toHaveLength(1)
    const moved = rig({ heads: (_ref, n) => (n < 2 ? SHA : 'd'.repeat(40)) })
    moved.ci.onState(stateWith())
    await moved.ci.drain()
    expect(moved.calls).toContain('push')
    expect(moved.gates).toHaveLength(1)
    expect(moved.waits).toEqual([])
  })

  // G3b1 final review M9
  it('a missing branch, origin or HEAD asks a person and pushes nothing', async () => {
    for (const r of [rig({ worktree: false }), rig({ origin: null }), rig({ heads: () => null })]) {
      r.ci.onState(stateWith())
      await r.ci.drain()
      expect(r.gates).toHaveLength(1)
      expect(r.calls).not.toContain('push')
    }
  })

  // G3b1 final review M3: a git that could not read the commits is not a branch with none
  it('commits that could not be read ask a person instead of failing the check', async () => {
    const r = rig({ commits: null })
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.settled).toEqual([])
    expect(r.gates).toEqual([{ taskId: 'tsk_l', question: expect.stringContaining('커밋을 읽지 못했습니다') }])
  })

  // G3b1 final review M6
  it('a push it could not record asks a person and records no wait; so does a wait it could not record', async () => {
    const noRecord = rig({ recordStatus: 500 })
    noRecord.ci.onState(stateWith())
    await noRecord.ci.drain()
    expect(noRecord.waits).toEqual([])
    expect(noRecord.gates).toHaveLength(1)
    const noWait = rig({ waitStatus: 500 })
    noWait.ci.onState(stateWith())
    await noWait.ci.drain()
    expect(noWait.gates).toHaveLength(1)
  })

  // G3b1 final review M7: a round it could not move is not taken again on every state
  it('a round left where it was is taken again only after a while', async () => {
    const r = rig({ open: [[3, 4]], gateStatus: 409 })
    r.ci.onState(stateWith())
    await r.ci.drain()
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.calls.filter((c) => c === 'push')).toHaveLength(1)
    r.clock.now = NOW + RETRY_MS
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.calls.filter((c) => c === 'push')).toHaveLength(2)
  })

  // Review Focus 4
  it('an issue of another repository gets no Refs line', async () => {
    const r = rig()
    r.ci.onState(stateWith({ source: { ...ISSUE, url: 'https://github.com/someone/else/issues/7' } }))
    await r.ci.drain()
    expect(r.created[0].body).toBe('add adds now')
  })

  it('a branch with uncommitted changes, or no commit past its base, is a failed CI check, and nothing is pushed', async () => {
    const dirty = rig({ clean: false, changed: 2 })
    dirty.ci.onState(stateWith())
    await dirty.ci.drain()
    expect(dirty.settled).toEqual([
      { taskId: 'tsk_l', since: ISO, result: expect.objectContaining({ configId: 'github:ci', status: 'failed', summary: expect.stringContaining('2 uncommitted changes') }) }
    ])
    expect(dirty.calls).not.toContain('push')
    const empty = rig({ commits: [] })
    empty.ci.onState(stateWith())
    await empty.ci.drain()
    expect(empty.settled[0].result).toMatchObject({ status: 'failed', summary: expect.stringContaining('adds no commits past origin/main') })
    expect(empty.calls).not.toContain('push')
  })

  // G3b2 (design §4.3): the answer binds the pull request a person chose
  it('several open pull requests ask which to bind, and go no further; a push that failed asks a person', async () => {
    const several = rig({ open: [[3, 4]] })
    several.ci.onState(stateWith())
    await several.ci.drain()
    expect(several.githubGates).toEqual([
      { taskId: 'tsk_l', since: ISO, kind: 'github-pr-ambiguous', question: expect.stringContaining('#3, #4'), options: ['pr-3', 'pr-4', 'mark-failed'] }
    ])
    expect(several.calls).not.toContain('createDraftPr')
    expect(several.waits).toEqual([])
    const refused = rig({ push: { ok: false, kind: 'auth', detail: 'Permission denied (publickey).' } })
    refused.ci.onState(stateWith())
    await refused.ci.drain()
    expect(refused.gates[0].question).toContain('Permission denied (publickey).')
    expect(refused.calls).not.toContain('findOpenPrs')
  })

  // G3b2 (design §4.2): a push GitHub refused because the branch moved is a head Astera did not push
  it('a refused push records a head Astera did not push and asks whether to bring it in', async () => {
    const r = rig({ push: { ok: false, kind: 'rejected', detail: '! [rejected]        u/a -> u/a (fetch first)' } })
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.records).toEqual([{ runId: 'run_1', patch: { externalHead: {} } }])
    expect(r.githubGates).toEqual([
      { taskId: 'tsk_l', since: ISO, kind: 'github-external-head', question: expect.stringContaining('(fetch first)'), options: ['continue', 'mark-failed'] }
    ])
    expect(r.gates).toEqual([])
    expect(r.calls).not.toContain('findOpenPrs')
  })

  it('binds the pull request a person chose among several, then waits on it', async () => {
    const r = rig({ open: [[3, 4]] })
    r.ci.onState(stateWith({ ciWait: { since: ISO, done: [], bindPr: 4 } }))
    await r.ci.drain()
    expect(r.githubGates).toEqual([])
    expect(r.records[0]).toMatchObject({ patch: { binding: { number: 4, createdByAstera: false }, pushed: { sha: SHA } } })
    expect(r.waits).toEqual([{ taskId: 'tsk_l', since: ISO, pr: 4, sha: SHA }])
    const gone = rig({ open: [[3, 5]] })
    gone.ci.onState(stateWith({ ciWait: { since: ISO, done: [], bindPr: 4 } }))
    await gone.ci.drain()
    expect(gone.githubGates[0]).toMatchObject({ kind: 'github-pr-ambiguous', options: ['pr-3', 'pr-5', 'mark-failed'] })
    expect(gone.waits).toEqual([])
  })

  it('asks in the person’s language', async () => {
    const r = rig({ commits: null, lang: 'en' })
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.gates).toEqual([{ taskId: 'tsk_l', question: expect.stringContaining('The commits past origin/main on this Run’s branch could not be read'.replace('’', "'")) }])
  })

  it('a step that throws asks a person, so the round is not taken again on every state', async () => {
    const r = rig()
    const failing = createLifecycleCi({
      ...({} as LifecycleCiDeps),
      worktreeOf: () => ({ repoPath: '/repo', branch: 'u/a', baseRef: 'origin/main' }),
      originOf: async () => 'git@github.com:parsingk/astera-lifecycle-sandbox.git',
      isClean: async () => {
        throw new Error('GIT_REMOVE_FAILED: index.lock exists')
      },
      openGate: async (a) => (r.gates.push(a), { status: 200, body: {} }),
      log: () => {}
    })
    failing.onState(stateWith())
    await failing.drain()
    expect(r.gates).toEqual([{ taskId: 'tsk_l', question: expect.stringContaining('index.lock exists') }])
  })

  it('takes a round once, however many states arrive meanwhile, and never one already waiting', async () => {
    const r = rig()
    r.ci.onState(stateWith())
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.calls.filter((c) => c === 'push')).toHaveLength(1)
    const waiting = rig()
    waiting.ci.onState(stateWith({ ciWait: { since: ISO, done: [], pr: 3, sha: SHA } }))
    await waiting.ci.drain()
    expect(waiting.calls).toEqual([])
  })
})
