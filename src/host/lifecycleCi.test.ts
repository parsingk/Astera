// The Host carries a handed-off lifecycle round to GitHub (GitHub lifecycle G3b1, design §4.1-4.3): preconditions, the
// push, the open or new draft pull request, and the wait recorded; on fakes for git, gh and the Host's commands.
import { describe, it, expect } from 'vitest'
import { createLifecycleCi, type LifecycleCiDeps } from './lifecycleCi'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { CheckResult, JobSourceRef } from '../core/orchestration/types'
import type { GitHubBinding } from '../core/github/lifecycle'

const NOW = Date.parse('2026-10-18T00:00:00.000Z')
const ISO = new Date(NOW).toISOString()
const SHA = 'c'.repeat(40)
const POLICY = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
const ISSUE: JobSourceRef = { id: 'github', itemId: '7', label: 'GitHub issue #7', url: 'https://github.com/parsingk/astera-lifecycle-sandbox/issues/7' }

const stateWith = (o: { binding?: GitHubBinding; source?: JobSourceRef; ciWait?: { since: string; done: CheckResult[]; pr?: number; sha?: string } } = {}): OrchState => ({
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
  commits?: { subject: string; body: string }[]
  push?: Awaited<ReturnType<LifecycleCiDeps['push']>>
  open?: number[][]
  create?: Awaited<ReturnType<LifecycleCiDeps['createDraftPr']>>
} = {}) {
  const calls: string[] = []
  const settled: { taskId: string; result: CheckResult }[] = []
  const gates: { taskId: string; question: string }[] = []
  const records: unknown[] = []
  const waits: unknown[] = []
  const created: { base: string; head: string; title: string; body: string }[] = []
  const lookups = [...(o.open ?? [[]])]
  const deps: LifecycleCiDeps = {
    worktreeOf: (p) => (p === '/wt-run' ? { repoPath: '/repo', branch: 'u/a', baseRef: 'origin/main' } : null),
    originOf: async () => 'git@github.com:parsingk/astera-lifecycle-sandbox.git',
    isClean: async () => (calls.push('isClean'), { clean: o.clean ?? true, changedCount: o.changed ?? 0 }),
    readCommits: async () => (calls.push('readCommits'), o.commits ?? [{ subject: 'Fix add', body: 'add adds now' }]),
    baseBranch: async () => 'main',
    push: async () => (calls.push('push'), o.push ?? { ok: true }),
    headOf: async () => (calls.push('headOf'), SHA),
    findOpenPrs: async () => {
      calls.push('findOpenPrs')
      const next = lookups.length > 1 ? lookups.shift()! : lookups[0]
      return { ok: true, prs: next.map((n) => ({ number: n, url: `https://github.com/parsingk/astera-lifecycle-sandbox/pull/${n}` })) }
    },
    createDraftPr: async (_cwd, _repo, pr) => (calls.push('createDraftPr'), created.push(pr), o.create ?? { ok: true, number: 3, url: 'https://github.com/parsingk/astera-lifecycle-sandbox/pull/3' }),
    record: async (args) => (calls.push('record'), records.push(args), { status: 200, body: {} }),
    recordWait: async (args) => (calls.push('recordWait'), waits.push(args), { status: 200, body: {} }),
    settle: async (a) => void (calls.push('settle'), settled.push(a)),
    openGate: async (a) => (calls.push('openGate'), gates.push(a), { status: 200, body: {} }),
    log: () => {},
    now: () => NOW
  }
  const ci = createLifecycleCi(deps)
  return { ci, calls, settled, gates, records, waits, created }
}

describe('createLifecycleCi', () => {
  it('pushes, opens a draft pull request that refers to its issue, records the binding and the push, then the wait', async () => {
    const r = rig()
    r.ci.onState(stateWith({ source: ISSUE }))
    await r.ci.drain()
    expect(r.calls).toEqual(['isClean', 'readCommits', 'push', 'headOf', 'findOpenPrs', 'createDraftPr', 'record', 'recordWait'])
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
    expect(r.waits).toEqual([{ taskId: 'tsk_l', pr: 3, sha: SHA }])
  })

  it('binds the one open pull request of the branch instead of making another', async () => {
    const r = rig({ open: [[5]] })
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.calls).not.toContain('createDraftPr')
    expect(r.records[0]).toMatchObject({ patch: { binding: { number: 5, createdByAstera: false } } })
    expect(r.waits).toEqual([{ taskId: 'tsk_l', pr: 5, sha: SHA }])
  })

  // Review Focus 1: a restart after the binding was recorded
  it('a Run already bound pushes again and waits on its pull request, making none', async () => {
    const binding: GitHubBinding = { repository: 'parsingk/astera-lifecycle-sandbox', number: 3, url: 'u', baseBranch: 'main', headBranch: 'u/a', createdByAstera: true, boundAt: ISO }
    const r = rig()
    r.ci.onState(stateWith({ binding }))
    await r.ci.drain()
    expect(r.calls).toEqual(['isClean', 'readCommits', 'push', 'headOf', 'record', 'recordWait'])
    expect(r.records).toEqual([{ runId: 'run_1', patch: { pushed: { sha: SHA } } }])
  })

  // Review Focus 3
  it('a create that failed is followed by a lookup that binds what it made', async () => {
    const r = rig({ open: [[], [3]], create: { ok: false, kind: 'network', message: 'Could not reach GitHub' } })
    r.ci.onState(stateWith())
    await r.ci.drain()
    expect(r.records[0]).toMatchObject({ patch: { binding: { number: 3, createdByAstera: false } } })
    expect(r.gates).toEqual([])
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
      { taskId: 'tsk_l', result: expect.objectContaining({ configId: 'github:ci', status: 'failed', summary: expect.stringContaining('2 uncommitted changes') }) }
    ])
    expect(dirty.calls).not.toContain('push')
    const empty = rig({ commits: [] })
    empty.ci.onState(stateWith())
    await empty.ci.drain()
    expect(empty.settled[0].result).toMatchObject({ status: 'failed', summary: expect.stringContaining('adds no commits past origin/main') })
    expect(empty.calls).not.toContain('push')
  })

  it('several open pull requests, or a push that failed, ask a person and go no further', async () => {
    const several = rig({ open: [[3, 4]] })
    several.ci.onState(stateWith())
    await several.ci.drain()
    expect(several.gates[0].question).toContain('#3, #4')
    expect(several.calls).not.toContain('createDraftPr')
    const refused = rig({ push: { ok: false, kind: 'auth', detail: 'Permission denied (publickey).' } })
    refused.ci.onState(stateWith())
    await refused.ci.drain()
    expect(refused.gates[0].question).toContain('Permission denied (publickey).')
    expect(refused.calls).not.toContain('findOpenPrs')
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
