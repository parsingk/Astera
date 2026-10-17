// The Host's read-only watch over lifecycle Runs' pull requests (GitHub lifecycle design §6.2, G1): what it binds, how
// often it reads, and what makes it stop.
import { describe, it, expect } from 'vitest'
import { createGithubWatch, LOW_BUDGET_MS, PENDING_MS, RATE_HOLD_MS, SETTLED_MS, UNBOUND_MAX_AGE_MS, UNBOUND_MS, type GithubWatchDeps } from './githubWatch'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { Job, JobRun } from '../core/orchestration/types'
import type { PrStateRead } from '../core/github/prState'
import type { RunGitHubPatch } from '../core/github/runState'
import type { RunGitHubState } from '../core/github/lifecycle'

const T0 = Date.parse('2026-10-18T00:00:00.000Z')
const ISO0 = new Date(T0).toISOString()
const POLICY = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
const BOUND: RunGitHubState = {
  binding: { repository: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', baseBranch: 'develop', headBranch: 'u/a', createdByAstera: false, boundAt: ISO0 },
  log: [],
  seq: 0
}
const stateOf = (o: { job?: Partial<Job>; run?: Partial<JobRun> } = {}): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'o', cwd: '/repo', createdAt: ISO0, github: POLICY, ...o.job }],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: ISO0, worktree: '/wt/a', ...o.run }]
})
const prRead = (over: Partial<PrStateRead> = {}): PrStateRead => ({
  number: 12, url: 'https://github.com/o/r/pull/12', state: 'open', isDraft: true, headBranch: 'u/a',
  headSha: 'a'.repeat(40), commitSha: 'a'.repeat(40), baseBranch: 'develop',
  suites: [{ app: 'github-actions', completed: true }],
  checks: [{ externalId: 'run:1', name: 'build', status: 'completed', conclusion: 'success', required: false, jobId: 1 }],
  rateLimit: { limit: 5000, remaining: 4900, resetAt: '2026-10-18T01:00:00Z' },
  ...over
})
const running = prRead({ suites: [{ app: 'github-actions', completed: false }], checks: [{ externalId: 'run:1', name: 'build', status: 'in-progress', required: false }] })

function rig(o: { prs?: { number: number; url: string }[]; read?: PrStateRead; origin?: string | null; fail?: { at: 'find' | 'read'; kind: string } } = {}) {
  const clock = { now: T0 }
  const records: { runId: string; patch: RunGitHubPatch }[] = []
  const calls: string[] = []
  const logs: string[] = []
  const status = { record: 200 }
  const failure = (kind: string) => ({ ok: false as const, kind: kind as never, message: `failed: ${kind}` })
  const deps: GithubWatchDeps = {
    now: () => clock.now,
    random: () => 0.5, // no jitter: (0.5 * 2 - 1) = 0
    record: async (args) => (records.push(args), { status: status.record, body: {} }),
    worktreeOf: (p) => (p === '/wt/a' ? { repoPath: '/repo', branch: 'u/a', baseRef: 'develop' } : null),
    baseBranch: async (_repo, ref) => ref,
    originOf: async () => (o.origin === undefined ? 'git@github.com:o/r.git' : o.origin),
    findOpenPrs: async (_cwd, _repo, branch, base) => {
      calls.push(`find ${branch} ${base}`)
      return o.fail?.at === 'find' ? failure(o.fail.kind) : { ok: true, prs: o.prs ?? [{ number: 12, url: 'https://github.com/o/r/pull/12' }] }
    },
    readPrState: async (_cwd, _repo, n) => {
      calls.push(`read ${n}`)
      return o.fail?.at === 'read' ? failure(o.fail.kind) : { ok: true, read: o.read ?? prRead() }
    },
    ruleCheckNames: async () => (calls.push('rules'), { ok: true, names: [] }),
    log: (m) => void logs.push(m)
  }
  const watch = createGithubWatch(deps)
  const at = async (ms: number): Promise<void> => {
    clock.now = T0 + ms
    await watch.tick()
  }
  return { watch, clock, records, calls, logs, status, at }
}

describe('githubWatch', () => {
  it('binds the one open PR of the Run’s branch and records its CI in one patch', async () => {
    const r = rig()
    r.watch.onState(stateOf())
    await r.at(0)
    expect(r.calls).toEqual(['find u/a develop', 'read 12', 'rules'])
    expect(r.records).toHaveLength(1)
    expect(r.records[0].runId).toBe('run_1')
    expect(r.records[0].patch.binding).toEqual(BOUND.binding)
    expect(r.records[0].patch.read?.ci).toMatchObject({ sha: 'a'.repeat(40), basis: 'all-reported', verdict: 'passed' })
    expect(r.records[0].patch.read?.pr).toEqual({ state: 'open', isDraft: true, baseBranch: 'develop' })
    expect(r.records[0].patch.lastReadError).toBeNull()
  })

  it('does not bind when several PRs match, and says which; looks again later', async () => {
    const r = rig({ prs: [{ number: 12, url: 'u12' }, { number: 13, url: 'u13' }] })
    r.watch.onState(stateOf())
    await r.at(0)
    expect(r.records).toEqual([{ runId: 'run_1', patch: { prCandidates: [12, 13], lastReadError: null } }])
    await r.at(UNBOUND_MS - 1)
    expect(r.calls).toHaveLength(1)
    await r.at(UNBOUND_MS)
    expect(r.calls).toHaveLength(2)
  })

  it('reads a bound Run’s PR without looking it up, again after PENDING_MS while CI runs', async () => {
    const r = rig({ read: running })
    r.watch.onState(stateOf({ run: { githubState: BOUND } }))
    await r.at(0)
    expect(r.calls).toEqual(['read 12', 'rules'])
    expect(r.records[0].patch.read?.ci.verdict).toBe('pending')
    await r.at(PENDING_MS - 1)
    expect(r.calls).toHaveLength(2)
    await r.at(PENDING_MS)
    expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
  })

  it('reads a settled CI after SETTLED_MS, and the branch rules once per their lifetime', async () => {
    const r = rig()
    r.watch.onState(stateOf({ run: { githubState: BOUND } }))
    await r.at(0)
    await r.at(SETTLED_MS - 1)
    expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(1)
    await r.at(SETTLED_MS)
    expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
    expect(r.calls.filter((c) => c === 'rules')).toHaveLength(1)
  })

  it('does not read the branch rules in selected mode', async () => {
    const r = rig()
    r.watch.onState(stateOf({ job: { github: { ...POLICY, ci: { mode: 'selected', selectedChecks: ['build'] } } }, run: { githubState: BOUND } }))
    await r.at(0)
    expect(r.calls).toEqual(['read 12'])
    expect(r.records[0].patch.read?.ci.basis).toBe('selected')
  })

  it('leaves a merged or closed PR alone', async () => {
    for (const state of ['merged', 'closed'] as const) {
      const r = rig()
      r.watch.onState(stateOf({ run: { githubState: { ...BOUND, pr: { state, isDraft: false, baseBranch: 'develop' } } } }))
      await r.at(0)
      expect(r.calls).toEqual([])
    }
  })

  it('stops looking for a PR three days after the Run was made', async () => {
    const r = rig()
    r.watch.onState(stateOf({ run: { createdAt: new Date(T0 - UNBOUND_MAX_AGE_MS - 1).toISOString() } }))
    await r.at(0)
    expect(r.calls).toEqual([])
  })

  it('skips a Job without the lifecycle, a Run without a worktree, and a worktree the registry does not know', async () => {
    for (const s of [stateOf({ job: { github: undefined } }), stateOf({ run: { worktree: undefined } }), stateOf({ run: { worktree: '/wt/unknown' } })]) {
      const r = rig()
      r.watch.onState(s)
      await r.at(0)
      expect(r.calls).toEqual([])
    }
  })

  // Review Focus 3
  it('holds every read after a rate limit', async () => {
    const r = rig({ fail: { at: 'read', kind: 'rate-limit' } })
    r.watch.onState(stateOf({ run: { githubState: BOUND } }))
    await r.at(0)
    expect(r.records).toEqual([{ runId: 'run_1', patch: { lastReadError: { kind: 'rate-limit' } } }])
    await r.at(RATE_HOLD_MS - 1)
    expect(r.calls).toHaveLength(1)
    await r.at(RATE_HOLD_MS)
    expect(r.calls).toHaveLength(2)
  })

  it('stretches every spacing while the GraphQL budget is low', async () => {
    const r = rig({ read: { ...running, rateLimit: { limit: 5000, remaining: 100, resetAt: '2026-10-18T01:00:00Z' } } })
    r.watch.onState(stateOf({ run: { githubState: BOUND } }))
    await r.at(0)
    await r.at(PENDING_MS)
    expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(1)
    await r.at(LOW_BUDGET_MS)
    expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
  })

  // Review Focus 4
  it('forgets a Run whose record answers 404', async () => {
    const r = rig()
    r.status.record = 404
    r.watch.onState(stateOf({ run: { githubState: BOUND } }))
    await r.at(0)
    await r.at(SETTLED_MS * 3)
    expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(1)
  })

  it('records a missing GitHub origin and backs off, without asking gh', async () => {
    const r = rig({ origin: null })
    r.watch.onState(stateOf())
    await r.at(0)
    expect(r.records).toEqual([{ runId: 'run_1', patch: { lastReadError: { kind: 'no-github-origin' } } }])
    expect(r.calls).toEqual([])
    await r.at(19_999)
    expect(r.records).toHaveLength(1)
    await r.at(20_000)
    expect(r.records).toHaveLength(2)
  })

  it('logs a failure kind once while the Run already carries it', async () => {
    const r = rig({ fail: { at: 'read', kind: 'network' } })
    r.watch.onState(stateOf({ run: { githubState: { ...BOUND, lastReadError: { kind: 'network', since: ISO0 } } } }))
    await r.at(0)
    expect(r.logs).toEqual([])
  })

  it('reads at most two Runs at once', async () => {
    const r = rig()
    const s = stateOf({ run: { githubState: BOUND } })
    r.watch.onState({ ...s, runs: ['a', 'b', 'c'].map((id) => ({ ...s.runs[0], id: `run_${id}` })) })
    await r.at(0)
    expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
    await r.at(1)
    expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(3)
  })
})
