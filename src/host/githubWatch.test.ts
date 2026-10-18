// The Host's read-only watch over lifecycle Runs' pull requests (GitHub lifecycle design §6.2, G1): what it binds, how
// often it reads, and what makes it stop.
import { describe, it, expect } from 'vitest'
import { createGithubWatch, ISSUE_MS, LOW_BUDGET_MS, NEW_HEAD_MS, PENDING_MS, RATE_HOLD_MS, SETTLED_MS, UNBOUND_MAX_AGE_MS, UNBOUND_MS, type GithubWatchDeps } from './githubWatch'
import { issueBodyHash } from '../core/github/issue'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { Job, JobRun } from '../core/orchestration/types'
import type { PrStateRead } from '../core/github/prState'
import type { RunGitHubPatch } from '../core/github/runState'
import type { GitHubCiFailure, RunGitHubState } from '../core/github/lifecycle'
import type { RawAnnotation } from '../core/github/evidence'

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

function rig(
  o: {
    prs?: { number: number; url: string }[]
    read?: PrStateRead
    origin?: string | null
    fail?: { at: 'find' | 'read'; kind: string }
    issue?: { body: string; updatedAt: string }
    rules?: { ok: true; names: string[] } | { ok: false; kind: string }
    log?: string
    annotations?: RawAnnotation[]
    evidenceFail?: string
  } = {}
) {
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
    ruleCheckNames: async () => {
      calls.push('rules')
      const r = o.rules ?? { ok: true as const, names: [] }
      return r.ok ? r : failure(r.kind)
    },
    readJobLog: async (_cwd, _repo, id) => {
      calls.push(`log ${id}`)
      return o.evidenceFail ? failure(o.evidenceFail) : { ok: true, log: o.log ?? '' }
    },
    readAnnotations: async (_cwd, _repo, id) => {
      calls.push(`annotations ${id}`)
      return o.evidenceFail ? failure(o.evidenceFail) : { ok: true, annotations: o.annotations ?? [] }
    },
    readIssue: async (_cwd, n) => {
      calls.push(`issue ${n}`)
      return {
        ok: true,
        issue: { number: n, title: 't', body: o.issue?.body ?? 'old', state: 'open', labels: [], author: 'pk', authorAssociation: 'OWNER', url: 'u', isPullRequest: false, updatedAt: o.issue?.updatedAt ?? 'T1' }
      }
    },
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

  describe('final review fixes', () => {
    // I1: a read that caught GitHub between a push and the PR's own move is read again soon, however settled
    it('reads again after PENDING_MS when the checks are of a commit that is not the head', async () => {
      const r = rig({ read: prRead({ headSha: 'c'.repeat(40) }) })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.records[0].patch.read?.ci.verdict).toBe('passed')
      await r.at(PENDING_MS)
      expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
    })

    // Measured on the sandbox (2026-10-18): right after a push the new head has no check at all for a few seconds
    it('reads a new head with no checks again soon, and a head long without checks only now and then', async () => {
      const bare = prRead({ suites: [], checks: [] })
      const r = rig({ read: bare })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.records[0].patch.read?.ci.verdict).toBe('none')
      await r.at(PENDING_MS)
      expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
      await r.at(NEW_HEAD_MS + PENDING_MS)
      const after = r.calls.filter((c) => c === 'read 12').length
      await r.at(NEW_HEAD_MS + 2 * PENDING_MS)
      expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(after)
    })

    // I2: branch rules that could not be read are not "no rules"
    it('does not pass, nor cache, branch rules that could not be read', async () => {
      const r = rig({ rules: { ok: false, kind: 'network' } })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.records[0].patch.read?.ci.verdict).toBe('pending')
      await r.at(PENDING_MS)
      expect(r.calls.filter((c) => c === 'rules')).toHaveLength(2)
    })

    it('caches a repository without rules (404) as no rules', async () => {
      const r = rig({ rules: { ok: false, kind: 'not-found' } })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.records[0].patch.read?.ci.verdict).toBe('passed')
      await r.at(SETTLED_MS)
      expect(r.calls.filter((c) => c === 'rules')).toHaveLength(1)
    })

    // M4: a rate limit on any read holds every read
    it('holds every read after a rate limit on the branch rules', async () => {
      const r = rig({ rules: { ok: false, kind: 'rate-limit' } })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      const before = r.calls.length
      await r.at(RATE_HOLD_MS - 1)
      expect(r.calls).toHaveLength(before)
    })

    // M5: a Run that left the watch and came back is read at once: nothing of its old schedule is kept
    it('forgets the schedule of a Run that left the watch', async () => {
      const r = rig()
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      r.watch.onState(stateOf({ run: { githubState: { ...BOUND, pr: { state: 'closed', isDraft: false, baseBranch: 'develop' } } } }))
      await r.at(1)
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(2)
      expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
    })

    // M6: the failing check's link goes with the verdict
    it('records the failing check’s link with the verdict', async () => {
      const failing = prRead({ checks: [{ externalId: 'run:1', name: 'build', status: 'completed', conclusion: 'failure', required: false, detailsUrl: 'https://x/run/1' }] })
      const r = rig({ read: failing })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.records[0].patch.read?.ci).toMatchObject({ verdict: 'failed', failing: 'build', failingUrl: 'https://x/run/1' })
    })

    // M8: an issue change seen in a pass whose PR read then fails is still recorded
    it('records a changed issue even when the pull request read fails', async () => {
      const source = { id: 'github', itemId: '5', label: 'GitHub issue #5 in o/r', capturedBodyHash: issueBodyHash('old'), capturedUpdatedAt: 'T1' }
      const r = rig({ issue: { body: 'new', updatedAt: 'T2' }, fail: { at: 'read', kind: 'network' } })
      r.watch.onState(stateOf({ job: { source }, run: { githubState: BOUND } }))
      await r.at(0)
      await r.at(ISSUE_MS)
      expect(r.records.at(-1)?.patch).toMatchObject({ lastReadError: { kind: 'network' }, sourceChanged: true })
    })
  })

  describe('failure evidence (G2)', () => {
    const A = 'a'.repeat(40)
    const failingRead = prRead({
      checks: [{ externalId: 'run:1', name: 'build', status: 'completed', conclusion: 'failure', required: false, jobId: 1, detailsUrl: 'https://x/run/1' }]
    })
    const LOG = ['##[group]Run npm test', 'not ok 1 - adds', '##[error]Process completed with exit code 1.'].map((l) => `t\tUNKNOWN STEP\t2026-10-17T20:32:40.1Z ${l}`).join('\n')
    const known: GitHubCiFailure = { check: 'build', externalId: 'run:1', class: 'test', summary: 'build (test): known', diagnostics: [] }
    const withEvidence = (sha: string): RunGitHubState => ({
      ...BOUND,
      ci: { sha, basis: 'all-reported', verdict: 'failed', failing: 'build', checks: [], changedAt: ISO0, failure: known }
    })

    it('fetches a failed head check’s log and annotations once and records its classified evidence', async () => {
      const r = rig({ read: failingRead, log: LOG })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.records[0].patch.read?.ci.failure).toMatchObject({ check: 'build', class: 'test', summary: 'build (test): not ok 1 - adds', url: 'https://x/run/1' })
      expect(r.calls.filter((c) => c === 'log 1' || c === 'annotations 1')).toEqual(['log 1', 'annotations 1'])
    })

    // Review Focus 4
    it('reuses the evidence the record holds for the same commit and check', async () => {
      const r = rig({ read: failingRead, log: LOG })
      r.watch.onState(stateOf({ run: { githubState: withEvidence(A) } }))
      await r.at(0)
      expect(r.calls).not.toContain('log 1')
      expect(r.records[0].patch.read?.ci.failure).toEqual(known)
    })

    it('fetches again for a new commit', async () => {
      const r = rig({ read: failingRead, log: LOG })
      r.watch.onState(stateOf({ run: { githubState: withEvidence('b'.repeat(40)) } }))
      await r.at(0)
      expect(r.calls).toContain('log 1')
    })

    // Review Focus 3
    it('records the verdict with what it could read when the evidence reads fail, and a rate limit there holds every read', async () => {
      const r = rig({ read: failingRead, evidenceFail: 'not-found' })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.records[0].patch.read?.ci).toMatchObject({ verdict: 'failed', failure: { check: 'build', class: 'unknown' } })
      const limited = rig({ read: failingRead, evidenceFail: 'rate-limit' })
      limited.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await limited.at(0)
      const before = limited.calls.length
      await limited.at(RATE_HOLD_MS - 1)
      expect(limited.calls).toHaveLength(before)
    })

    // Review Focus 5
    it('asks no log or annotations for a failing commit status', async () => {
      const status = prRead({ checks: [{ externalId: 'status:ci/ext', name: 'ci/ext', status: 'completed', conclusion: 'failure', required: false }] })
      const r = rig({ read: status })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.calls.some((c) => c.startsWith('log') || c.startsWith('annotations'))).toBe(false)
      expect(r.records[0].patch.read?.ci.failure).toMatchObject({ check: 'ci/ext', class: 'unknown' })
    })

    it('fetches no evidence for a commit that is not the head', async () => {
      const r = rig({ read: { ...failingRead, headSha: 'c'.repeat(40) }, log: LOG })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.calls).not.toContain('log 1')
      expect(r.records[0].patch.read?.ci.failure).toBeUndefined()
    })
  })

  describe('the source issue (§6)', () => {
    const source = { id: 'github', itemId: '5', label: 'GitHub issue #5 in o/r', capturedBodyHash: issueBodyHash('old'), capturedUpdatedAt: 'T1' }

    it('records once that the issue body changed, first looking after ISSUE_MS', async () => {
      const r = rig({ issue: { body: 'new', updatedAt: 'T2' } })
      r.watch.onState(stateOf({ job: { source }, run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.calls).not.toContain('issue 5')
      await r.at(ISSUE_MS)
      expect(r.calls).toContain('issue 5')
      expect(r.records.at(-1)?.patch.sourceChanged).toBe(true)
    })

    it('an edit that leaves the body as it was is not a change', async () => {
      const r = rig({ issue: { body: 'old', updatedAt: 'T2' } })
      r.watch.onState(stateOf({ job: { source }, run: { githubState: BOUND } }))
      await r.at(0)
      await r.at(ISSUE_MS)
      expect(r.records.some((x) => x.patch.sourceChanged)).toBe(false)
    })

    it('does not look again once the Run carries the change, nor for a source that is not GitHub', async () => {
      const a = rig({ issue: { body: 'new', updatedAt: 'T2' } })
      a.watch.onState(stateOf({ job: { source }, run: { githubState: { ...BOUND, sourceChanged: { at: ISO0 } } } }))
      await a.at(0)
      await a.at(ISSUE_MS)
      expect(a.calls).not.toContain('issue 5')
      const b = rig()
      b.watch.onState(stateOf({ job: { source: { ...source, id: 'astera-linear-source' } }, run: { githubState: BOUND } }))
      await b.at(0)
      await b.at(ISSUE_MS)
      expect(b.calls).not.toContain('issue 5')
    })
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
