// The Host's read-only watch over lifecycle Runs' pull requests (GitHub lifecycle design §6.2, G1): what it binds, how
// often it reads, and what makes it stop.
import { describe, it, expect } from 'vitest'
import { createGithubWatch, ERROR_BACKOFF_MS, ISSUE_MS, LOW_BUDGET_MS, NEW_HEAD_MS, NO_CI_GRACE_MS, PENDING_MS, RATE_HOLD_MS, RERUN_SHOW_MS, REVIEWING_MS, SETTLED_MS, UNBOUND_MAX_AGE_MS, UNBOUND_MS, type GithubWatchDeps } from './githubWatch'
import { issueBodyHash } from '../core/github/issue'
import { emptyState, type OrchState } from '../core/orchestration/state'
import type { CheckResult, Job, JobRun } from '../core/orchestration/types'
import type { PrStateRead } from '../core/github/prState'
import type { RunGitHubPatch } from '../core/github/runState'
import { EVIDENCE_TRIES, type GitHubCiCheck, type GitHubCiFailure, type GitHubRerun, type RunGitHubState } from '../core/github/lifecycle'
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
    /** Fails the log read only, in gh's words. */
    logFail?: { kind: string; message: string }
    /** Whether the PR's head is in the history of the pushed head (G3b2); absent: the watch has no git. */
    ancestry?: 'ancestor' | 'not' | 'unknown'
    lang?: 'en' | 'ko'
    /** What lifecycle-gate answers, in turn; the last repeats (G3b2). */
    gateStatus?: number[]
    /** How many settles throw first (G3b2). */
    settleFails?: number
    /** What rerunCi answers, in turn; the last repeats (G4). Absent: it reruns. */
    rerun?: ({ ok: true } | { ok: false; kind: string; message: string; running?: true })[]
  } = {}
) {
  const clock = { now: T0 }
  const records: { runId: string; patch: RunGitHubPatch }[] = []
  const calls: string[] = []
  const logs: string[] = []
  const settled: { taskId: string; result: CheckResult; since?: string }[] = []
  const gates: { taskId: string; since: string; kind: string; question: string; options: string[] }[] = []
  const status = { record: 200 }
  const fails = { settle: o.settleFails ?? 0 }
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
      if (o.logFail) return { ok: false as const, kind: o.logFail.kind as never, message: o.logFail.message }
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
    settle: async (a) => {
      if (fails.settle > 0) {
        fails.settle--
        throw new Error('the store could not be written')
      }
      settled.push(a)
    },
    openGitHubGate: async (a) => (gates.push(a), { status: o.gateStatus?.[Math.min(gates.length - 1, o.gateStatus.length - 1)] ?? 200, body: {} }),
    rerunCi: async (_cwd, repo, id) => {
      calls.push(`rerun ${id} ${repo.owner}/${repo.name}`)
      const n = calls.filter((c) => c.startsWith('rerun ')).length
      return (o.rerun?.[Math.min(n - 1, o.rerun.length - 1)] ?? { ok: true }) as never
    },
    ...(o.ancestry ? { ancestry: async () => o.ancestry! } : {}),
    lang: () => o.lang ?? 'en',
    log: (m) => void logs.push(m)
  }
  const watch = createGithubWatch(deps)
  const at = async (ms: number): Promise<void> => {
    clock.now = T0 + ms
    await watch.tick()
  }
  return { watch, clock, records, calls, logs, status, at, settled, gates }
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
    const failedJob = { externalId: 'run:1', name: 'build', status: 'completed' as const, conclusion: 'failure' as const, required: false, jobId: 1, ciRunId: 9, detailsUrl: 'https://x/run/1' }
    const failingRead = prRead({ checks: [failedJob] })
    const stillRunning = prRead({
      suites: [{ app: 'github-actions', completed: false }],
      checks: [failedJob, { externalId: 'run:2', name: 'slow', status: 'in-progress', required: false, jobId: 2, ciRunId: 9 }]
    })
    /** The Run's record after the last read, as the Host would hold it. */
    const after = (r: ReturnType<typeof rig>): RunGitHubState => ({ ...BOUND, ci: { ...r.records.at(-1)!.patch.read!.ci, changedAt: ISO0 } })
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
      expect(r.records[0].patch.read?.ci).toMatchObject({ verdict: 'failed', failure: { check: 'build', class: 'build' } })
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

    // G2 final review I1: gh gives no job log until the whole Actions run ends (measured on the sandbox)
    it('reads no log while the failed job’s run still has a job going, then reads it soon after the run ends', async () => {
      const o: Parameters<typeof rig>[0] = { read: stillRunning, log: LOG }
      const r = rig(o)
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.calls).toContain('annotations 1')
      expect(r.calls).not.toContain('log 1')
      expect(r.records[0].patch.read?.ci.failure).toMatchObject({ class: 'build', incomplete: { reason: 'run-in-progress', tries: 0 } })
      // still going: read again soon, and what the record holds is kept without a log or annotations read
      r.watch.onState(stateOf({ run: { githubState: after(r) } }))
      await r.at(PENDING_MS)
      expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
      expect(r.calls.filter((c) => c.startsWith('log') || c.startsWith('annotations'))).toEqual(['annotations 1'])
      // the run ended: the log is read and the evidence is complete
      o.read = failingRead
      r.watch.onState(stateOf({ run: { githubState: after(r) } }))
      await r.at(2 * PENDING_MS)
      expect(r.calls).toContain('log 1')
      const done = r.records.at(-1)!.patch.read!.ci.failure!
      expect(done).toMatchObject({ class: 'test', summary: 'build (test): not ok 1 - adds' })
      expect(done.incomplete).toBeUndefined()
    })

    it('takes gh’s "still in progress" for a run still going, not for a failed read', async () => {
      const r = rig({ read: failingRead, logFail: { kind: 'other', message: 'gh failed: run 9 is still in progress; logs will be available when it is complete' } })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.records[0].patch.read?.ci.failure?.incomplete).toEqual({ reason: 'run-in-progress', tries: 0 })
    })

    it('reads again after reads that failed for a reason that passes, at most EVIDENCE_TRIES times; a missing log is final', async () => {
      const r = rig({ read: failingRead, evidenceFail: 'network' })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.records[0].patch.read?.ci.failure?.incomplete).toEqual({ reason: 'read-failed', tries: 1 })
      expect(r.logs.filter((l) => l.includes('could not be read'))).toHaveLength(2)
      const tried = (tries: number): RunGitHubState => {
        const s = after(r)
        return { ...s, ci: { ...s.ci!, failure: { ...s.ci!.failure!, incomplete: { reason: 'read-failed', tries } } } }
      }
      const again = rig({ read: failingRead, evidenceFail: 'network' })
      again.watch.onState(stateOf({ run: { githubState: tried(1) } }))
      await again.at(0)
      expect(again.records[0].patch.read?.ci.failure?.incomplete).toEqual({ reason: 'read-failed', tries: 2 })
      const recovered = rig({ read: failingRead, log: LOG })
      recovered.watch.onState(stateOf({ run: { githubState: tried(2) } }))
      await recovered.at(0)
      expect(recovered.records[0].patch.read?.ci.failure).toMatchObject({ class: 'test' })
      expect(recovered.records[0].patch.read?.ci.failure?.incomplete).toBeUndefined()
      const spent = rig({ read: failingRead, log: LOG })
      spent.watch.onState(stateOf({ run: { githubState: tried(EVIDENCE_TRIES) } }))
      await spent.at(0)
      expect(spent.calls).not.toContain('log 1')
      const missing = rig({ read: failingRead, evidenceFail: 'not-found' })
      missing.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await missing.at(0)
      expect(missing.records[0].patch.read?.ci.failure?.incomplete).toBeUndefined()
    })

    // G2 final review M1
    it('reads no job log for a check run another app made, only its annotations', async () => {
      const app = prRead({ checks: [{ externalId: 'run:5', name: 'SonarCloud', status: 'completed', conclusion: 'failure', required: false, jobId: 5 }] })
      const r = rig({ read: app })
      r.watch.onState(stateOf({ run: { githubState: BOUND } }))
      await r.at(0)
      expect(r.calls).toContain('annotations 5')
      expect(r.calls).not.toContain('log 5')
      expect(r.records[0].patch.read?.ci.failure?.incomplete).toBeUndefined()
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

  // GitHub lifecycle G5b (design §5.4, §6.2): merge-ready is withdrawn when the pull request moves
  describe('merge-ready (G5b)', () => {
    const A = 'a'.repeat(40)
    const B = 'b'.repeat(40)
    const READY: RunGitHubState = {
      ...BOUND,
      headSha: A,
      lastPushedSha: A,
      pr: { state: 'open', isDraft: true, baseBranch: 'develop' },
      mergeReady: { pullRequestNumber: 12, headSha: A, localChecksPassed: true, requiredCiPassed: true, reviewPassed: true, unresolvedQuestions: 0, ciChecks: ['build'], evaluatedAt: ISO0 }
    }
    const withdrawal = (r: ReturnType<typeof rig>): string[] => r.records.flatMap((x) => (x.patch.invalidated ? [x.patch.invalidated.reason] : []))
    const readOf = async (read: PrStateRead, gs: RunGitHubState = READY): Promise<string[]> => {
      const r = rig({ read })
      r.watch.onState(stateOf({ run: { githubState: gs } }))
      await r.at(0)
      return withdrawal(r)
    }
    const fail = { externalId: 'run:1', name: 'build', status: 'completed' as const, conclusion: 'failure' as const, required: false, jobId: 1 }
    const e2e = { externalId: 'run:2', name: 'e2e', status: 'completed' as const, conclusion: 'success' as const, required: false, jobId: 2 }

    it('a read with the same head and checks withdraws nothing', async () => {
      expect(await readOf(prRead())).toEqual([])
    })

    it.each([
      ['head-changed', prRead({ headSha: B, commitSha: B })],
      ['base-changed', prRead({ baseBranch: 'main' })],
      ['closed', prRead({ state: 'closed' })],
      ['merged', prRead({ state: 'merged' })],
      ['ci-failed', prRead({ checks: [fail] })],
      ['checks-changed', prRead({ checks: [...prRead().checks, e2e] })]
    ] as const)('withdraws it once the pull request moves: %s', async (reason, read) => {
      expect(await readOf(read)).toEqual([reason])
    })

    it('a review asking for changes on GitHub is shown, never a withdrawal; one withdrawn already is not withdrawn again', async () => {
      expect(await readOf(prRead({ reviewDecision: 'CHANGES_REQUESTED' }))).toEqual([])
      expect(await readOf(prRead({ headSha: B, commitSha: B }), { ...READY, invalidated: { reason: 'head-changed', at: ISO0 } })).toEqual([])
    })

    it('reads a Run whose lifecycle Task is in review every 30 seconds', async () => {
      const r = rig()
      const s = stateOf()
      r.watch.onState({
        ...s,
        tasks: [{ id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub 전달', spec: 's', deps: [], status: 'reviewing', consecutiveFailures: 0, createdAt: ISO0, updatedAt: ISO0 }]
      })
      await r.at(0)
      await r.at(REVIEWING_MS)
      expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
    })

    it('reads a Run at once when it becomes merge-ready', async () => {
      const r = rig()
      r.watch.onState(stateOf({ run: { githubState: { ...READY, mergeReady: undefined } } }))
      await r.at(0)
      r.watch.onState(stateOf({ run: { githubState: { ...READY, mergeReady: { ...READY.mergeReady!, evaluatedAt: '2026-10-18T00:00:05.000Z' } } } }))
      await r.at(10_000)
      expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
    })
  })

  // GitHub lifecycle G3b1 (design §4.4, §4.6): CI on the pushed head settles the handed-over round, once
  describe('the lifecycle round (G3b1)', () => {
    const A = 'a'.repeat(40)
    const withRound = (ciWait: Record<string, unknown> = { since: ISO0, done: [], pr: 12, sha: A }, run: Partial<JobRun> = { githubState: BOUND }): OrchState => ({
      ...stateOf({ job: { convergence: {} }, run }),
      tasks: [
        { id: 'tsk_a', runId: 'run_1', title: 'a', spec: 's', deps: [], status: 'completed', consecutiveFailures: 0, createdAt: ISO0, updatedAt: ISO0 },
        {
          id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub 전달', spec: 's', deps: ['tsk_a'], status: 'validating', validateConfigIds: ['github:ci'],
          reviewRequested: true, consecutiveFailures: 0, createdAt: ISO0, updatedAt: ISO0, ciWait: ciWait as never
        }
      ]
    })
    const LOG = ['##[group]Run npm test', 'not ok 1 - adds', '##[error]Process completed with exit code 1.'].map((l) => `t\tUNKNOWN STEP\t2026-10-17T20:32:40.1Z ${l}`).join('\n')
    const TIMED_OUT = prRead({ checks: [{ externalId: 'run:1', name: 'deploy', status: 'completed', conclusion: 'timed-out', required: false, jobId: 1, ciRunId: 9 }] })
    const CANCELLED = prRead({ checks: [{ externalId: 'run:1', name: 'deploy', status: 'completed', conclusion: 'cancelled', required: false, jobId: 1, ciRunId: 9 }] })
    const failed = (name = 'test') =>
      prRead({ checks: [{ externalId: 'run:1', name, status: 'completed', conclusion: 'failure', required: false, jobId: 1, ciRunId: 9, detailsUrl: 'https://x/run/1' }] })

    it('a pass on the pushed head settles the round passed, linked to the pull request', async () => {
      const r = rig()
      r.watch.onState(withRound())
      await r.at(0)
      expect(r.settled).toEqual([{ taskId: 'tsk_l', since: ISO0, result: expect.objectContaining({ configId: 'github:ci', status: 'passed', externalUrl: 'https://github.com/o/r/pull/12' }) }])
    })

    it('a test failure settles the round failed with its evidence', async () => {
      const r = rig({ read: failed(), log: LOG })
      r.watch.onState(withRound())
      await r.at(0)
      expect(r.settled[0].result).toMatchObject({ status: 'failed', summary: 'test (test): not ok 1 - adds', externalUrl: 'https://x/run/1' })
    })

    // Review Focus 2
    it('a verdict on a commit that is not the pushed head settles nothing', async () => {
      const r = rig()
      r.watch.onState(withRound({ since: ISO0, done: [], pr: 12, sha: 'b'.repeat(40) }))
      await r.at(0)
      expect(r.settled).toEqual([])
    })

    // Review Focus 5
    it('a failure whose evidence is incomplete waits; the same verdict read again settles once', async () => {
      const o: Parameters<typeof rig>[0] = { read: prRead({ suites: [{ app: 'github-actions', completed: false }], checks: [
        { externalId: 'run:1', name: 'test', status: 'completed', conclusion: 'failure', required: false, jobId: 1, ciRunId: 9 },
        { externalId: 'run:2', name: 'slow', status: 'in-progress', required: false, jobId: 2, ciRunId: 9 }
      ] }), log: LOG }
      const r = rig(o)
      r.watch.onState(withRound())
      await r.at(0)
      expect(r.settled).toEqual([])
      const passed = rig()
      passed.watch.onState(withRound())
      await passed.at(0)
      await passed.at(PENDING_MS)
      await passed.at(SETTLED_MS * 2)
      expect(passed.settled).toHaveLength(1)
    })

    // G3b2: the question keeps the round's wait, and failing the Task is one of its answers. A cause a rerun cannot cure
    // (cancelled, permission) asks at once (G4).
    it('a cause outside the code a rerun cannot cure asks whether to wait again or fail, and settles nothing', async () => {
      const r = rig({ read: CANCELLED, log: LOG })
      r.watch.onState(withRound())
      await r.at(0)
      expect(r.settled).toEqual([])
      expect(r.calls.filter((c) => c.startsWith('rerun'))).toEqual([])
      expect(r.gates).toEqual([
        { taskId: 'tsk_l', since: ISO0, kind: 'github-ci-outside', question: expect.stringContaining('GitHub CI failed for a reason outside the code (cancelled)'), options: ['wait', 'mark-failed'] }
      ])
      const ko = rig({ read: CANCELLED, log: LOG, lang: 'ko' })
      ko.watch.onState(withRound())
      await ko.at(0)
      expect(ko.gates[0].question).toContain('GitHub CI 가 코드 밖의 이유로 실패했습니다(cancelled)')
    })

    // GitHub lifecycle G4 (L9, design §4.6): a failure a rerun can cure is rerun by the Host within the Job's budget
    describe('the infrastructure rerun (G4)', () => {
      const INFRA = (attempt = 1, over: Partial<GitHubCiCheck> = {}): PrStateRead =>
        prRead({
          checks: [
            { externalId: `run:${attempt}0`, name: 'npm-network', status: 'completed', conclusion: 'startup-failure', required: false, jobId: attempt * 10, ciRunId: 9, ciRunAttempt: attempt, ...over }
          ]
        })
      const rerun = (attempt: number, by: 'astera' | 'person' = 'astera'): GitHubRerun => ({ ciRunId: 9, attempt, sha: A, check: 'npm-network', externalId: `run:${attempt}0`, by, at: ISO0 })
      const reran = (...rs: GitHubRerun[]): Partial<JobRun> => ({ githubState: { ...BOUND, reruns: rs } })
      const reruns = (r: ReturnType<typeof rig>): string[] => r.calls.filter((c) => c.startsWith('rerun '))
      const OPTIONS = ['rerun', 'wait', 'mark-failed']

      it('an infrastructure failure on the pushed head is rerun in the Run’s repository and recorded; nothing settles or asks', async () => {
        const r = rig({ read: INFRA() })
        r.watch.onState(withRound())
        await r.at(0)
        expect(reruns(r)).toEqual(['rerun 9 o/r'])
        expect(r.records.flatMap((x) => (x.patch.rerun ? [x.patch.rerun] : []))).toEqual([{ ciRunId: 9, attempt: 1, sha: A, check: 'npm-network', externalId: 'run:10', by: 'astera' }])
        expect(r.settled).toEqual([])
        expect(r.gates).toEqual([])
      })

      // G4 final review M6
      it('an outside cause in a toolchain setup step (environment) is rerun too', async () => {
        const ENV_LOG = ['##[group]Run actions/setup-node@v4', 'Error: read ECONNRESET', '##[error]Process completed with exit code 1.']
          .map((l) => `t\tUNKNOWN STEP\t2026-10-17T20:32:40.1Z ${l}`)
          .join('\n')
        const r = rig({ read: INFRA(1, { conclusion: 'failure' }), log: ENV_LOG })
        r.watch.onState(withRound())
        await r.at(0)
        expect(reruns(r)).toEqual(['rerun 9 o/r'])
      })

      // G4 final review I1: the hold ends: a run that never shows again does not keep the round from its verdict
      it('a recorded rerun holds the verdict for a while only; then a green read settles', async () => {
        const r = rig({ read: prRead() })
        r.watch.onState(withRound(undefined, reran(rerun(1))))
        await r.at(0)
        await r.at(RERUN_SHOW_MS - PENDING_MS)
        expect(r.settled).toEqual([])
        await r.at(RERUN_SHOW_MS + PENDING_MS)
        expect(r.settled).toEqual([{ taskId: 'tsk_l', since: ISO0, result: expect.objectContaining({ status: 'passed' }) }])
      })

      it('a rerun of an earlier round does not hold a new round of the same head', async () => {
        const LATER = '2026-10-18T00:05:00.000Z'
        const r = rig({ read: prRead() })
        r.watch.onState(withRound({ since: LATER, done: [], pr: 12, sha: A, waitingSince: LATER }, reran(rerun(1))))
        await r.at(5 * 60_000)
        expect(r.settled).toEqual([{ taskId: 'tsk_l', since: LATER, result: expect.objectContaining({ status: 'passed' }) }])
      })

      // G4 final review M3: an attempt is the workflow run's, so the old failing check run can read a later one
      it('the failing check run still showing holds the verdict, whatever attempt its run reads', async () => {
        const r = rig({ read: INFRA(2, { externalId: 'run:10' }) })
        r.watch.onState(withRound(undefined, reran(rerun(1))))
        await r.at(0)
        expect(reruns(r)).toEqual([])
        expect(r.gates).toEqual([])
        expect(r.settled).toEqual([])
      })

      it('a timeout is rerun too', async () => {
        const r = rig({ read: TIMED_OUT, log: LOG })
        r.watch.onState(withRound())
        await r.at(0)
        expect(reruns(r)).toEqual(['rerun 9 o/r'])
        expect(r.records.find((x) => x.patch.rerun)?.patch.rerun).toMatchObject({ attempt: 1, check: 'deploy' })
      })

      // Review Focus 2 (measured): right after a rerun the old attempt can still show, then none of its run
      it('a read still showing the attempt that was rerun, or none of its run, decides nothing and reads again soon', async () => {
        const o: Parameters<typeof rig>[0] = { read: INFRA(1) }
        const r = rig(o)
        r.watch.onState(withRound(undefined, reran(rerun(1))))
        await r.at(0)
        o.read = prRead()
        await r.at(PENDING_MS)
        expect(reruns(r)).toEqual([])
        expect(r.settled).toEqual([])
        expect(r.gates).toEqual([])
        expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
        await r.at(NO_CI_GRACE_MS + 2 * PENDING_MS)
        expect(r.gates).toEqual([])
      })

      it('the new attempt failing for the same kind of reason is rerun again; past the budget it asks with rerun', async () => {
        const r = rig({ read: INFRA(2) })
        r.watch.onState(withRound(undefined, reran(rerun(1))))
        await r.at(0)
        expect(r.records.find((x) => x.patch.rerun)?.patch.rerun).toMatchObject({ attempt: 2, by: 'astera' })
        const spent = rig({ read: INFRA(3) })
        spent.watch.onState(withRound(undefined, reran(rerun(1), rerun(2))))
        await spent.at(0)
        expect(reruns(spent)).toEqual([])
        expect(spent.settled).toEqual([])
        expect(spent.gates).toEqual([
          { taskId: 'tsk_l', since: ISO0, kind: 'github-ci-outside', question: expect.stringContaining('Astera reran it 2 times, the limit this Job allows'), options: OPTIONS }
        ])
      })

      it('counts only its own reruns against the budget', async () => {
        const r = rig({ read: INFRA(3) })
        r.watch.onState(withRound(undefined, reran(rerun(1, 'person'), rerun(2, 'person'))))
        await r.at(0)
        expect(reruns(r)).toEqual(['rerun 9 o/r'])
      })

      // G5c (design §3.5): a reconverged lifecycle Task has a budget of its own — the Run's reruns before it stay on record
      // and do not count
      it('counts only the reruns of the lifecycle Task that waits, not those before a reconverge', async () => {
        const EARLIER = new Date(T0 - 60 * 60_000).toISOString()
        const before = (attempt: number): GitHubRerun => ({ ...rerun(attempt), at: EARLIER })
        const r = rig({ read: INFRA(3) })
        r.watch.onState(withRound(undefined, reran(before(1), before(2))))
        await r.at(0)
        expect(reruns(r)).toEqual(['rerun 9 o/r'])
        expect(r.gates).toEqual([])
      })

      it('with automatic reruns off it asks at once, offering the rerun', async () => {
        const s = withRound()
        const r = rig({ read: INFRA() })
        r.watch.onState({ ...s, jobs: [{ ...s.jobs[0], github: { ...POLICY, autoRerunInfrastructureFailures: false } }] })
        await r.at(0)
        expect(reruns(r)).toEqual([])
        expect(r.gates).toEqual([{ taskId: 'tsk_l', since: ISO0, kind: 'github-ci-outside', question: expect.stringContaining('Automatic reruns are off for this Job'), options: OPTIONS }])
      })

      // L16: gh saying the run is already running means someone reran it first
      it('a run already running again is waited on: nothing recorded, nothing asked', async () => {
        const r = rig({ read: INFRA(), rerun: [{ ok: false, kind: 'other', message: 'run 9 cannot be rerun; This workflow is already running', running: true }] })
        r.watch.onState(withRound())
        await r.at(0)
        expect(reruns(r)).toHaveLength(1)
        expect(r.records.some((x) => x.patch.rerun)).toBe(false)
        expect(r.gates).toEqual([])
        // G4 final review M1: the new attempt is going: read again soon
        await r.at(PENDING_MS)
        expect(r.calls.filter((c) => c === 'read 12')).toHaveLength(2)
      })

      it('a rerun GitHub refuses asks with the reason; one the network lost is tried again on the next read', async () => {
        const r = rig({ read: INFRA(), rerun: [{ ok: false, kind: 'other', message: 'run 9 cannot be rerun; This workflow run cannot be retried' }] })
        r.watch.onState(withRound())
        await r.at(0)
        expect(r.gates).toEqual([{ taskId: 'tsk_l', since: ISO0, kind: 'github-ci-outside', question: expect.stringContaining('This workflow run cannot be retried'), options: OPTIONS }])
        const lost = rig({ read: INFRA(), rerun: [{ ok: false, kind: 'network', message: 'GitHub could not be reached' }, { ok: true }] })
        lost.watch.onState(withRound())
        await lost.at(0)
        expect(lost.gates).toEqual([])
        await lost.at(PENDING_MS)
        expect(reruns(lost)).toHaveLength(2)
        expect(lost.records.some((x) => x.patch.rerun)).toBe(true)
      })

      it('a failure with no Actions run behind it asks at once, without the rerun', async () => {
        const r = rig({ read: INFRA(1, { ciRunId: undefined, ciRunAttempt: undefined }) })
        r.watch.onState(withRound())
        await r.at(0)
        expect(reruns(r)).toEqual([])
        expect(r.gates[0]).toMatchObject({ kind: 'github-ci-outside', options: ['wait', 'mark-failed'] })
      })

      it('a code failure of the new attempt settles as before', async () => {
        const r = rig({ read: failed(), log: LOG })
        r.watch.onState(withRound(undefined, reran({ ...rerun(1), ciRunId: 9, attempt: 0 })))
        await r.at(0)
        expect(r.settled[0]?.result).toMatchObject({ status: 'failed', summary: 'test (test): not ok 1 - adds' })
      })
    })

    // G3b1 final review M1: a round pushed again is read at once, not when the last verdict put the next read
    it('reads a new round at once', async () => {
      const o: Parameters<typeof rig>[0] = { read: failed(), log: LOG }
      const r = rig(o)
      r.watch.onState(withRound())
      await r.at(0)
      expect(r.settled).toHaveLength(1)
      const B = 'b'.repeat(40)
      o.read = prRead({ headSha: B, commitSha: B })
      r.watch.onState(withRound({ since: '2026-10-18T00:01:00.000Z', done: [], pr: 12, sha: B }))
      await r.at(5_000)
      expect(r.settled).toHaveLength(2)
      expect(r.settled[1]).toMatchObject({ since: '2026-10-18T00:01:00.000Z', result: { status: 'passed' } })
    })

    // G3b1 final review M9
    it('settles a failure once its evidence is complete', async () => {
      const o: Parameters<typeof rig>[0] = {
        read: prRead({ suites: [{ app: 'github-actions', completed: false }], checks: [
          { externalId: 'run:1', name: 'test', status: 'completed', conclusion: 'failure', required: false, jobId: 1, ciRunId: 9 },
          { externalId: 'run:2', name: 'slow', status: 'in-progress', required: false, jobId: 2, ciRunId: 9 }
        ] }),
        log: LOG
      }
      const r = rig(o)
      r.watch.onState(withRound())
      await r.at(0)
      expect(r.settled).toEqual([])
      o.read = failed()
      await r.at(PENDING_MS)
      expect(r.settled).toHaveLength(1)
      expect(r.settled[0].result).toMatchObject({ status: 'failed', summary: 'test (test): not ok 1 - adds' })
    })

    it('settles with what it has once the evidence reads are spent', async () => {
      const spent: GitHubCiFailure = {
        check: 'test', externalId: 'run:1', class: 'build', summary: 'test (build): failure', diagnostics: [],
        incomplete: { reason: 'read-failed', tries: EVIDENCE_TRIES }
      }
      const r = rig({ read: failed(), evidenceFail: 'network' })
      r.watch.onState(withRound(undefined, { githubState: { ...BOUND, ci: { sha: A, basis: 'all-reported', verdict: 'failed', failing: 'test', checks: [], changedAt: ISO0, failure: spent } } }))
      await r.at(0)
      expect(r.settled[0]?.result).toMatchObject({ status: 'failed', summary: 'test (build): failure' })
    })

    // GitHub lifecycle G3b2 (design §4.2-4.4, §4.6, §6.2): the Gate that fits, once per wait
    describe('the GitHub Gates (G3b2)', () => {
      const waiting = (over: Record<string, unknown> = {}, run?: Partial<JobRun>): OrchState =>
        withRound({ since: ISO0, done: [], pr: 12, sha: A, waitingSince: ISO0, ...over }, run)
      const B = 'b'.repeat(40)
      const NONE = prRead({ suites: [], checks: [] })

      it('no CI on the pushed head for 3 minutes asks whether to wait, go on without CI or fail; not before', async () => {
        const r = rig({ read: NONE })
        r.watch.onState(waiting())
        await r.at(0)
        await r.at(NO_CI_GRACE_MS - 1_000)
        expect(r.gates).toEqual([])
        await r.at(NO_CI_GRACE_MS + PENDING_MS)
        expect(r.gates).toEqual([
          { taskId: 'tsk_l', since: ISO0, kind: 'github-no-ci', question: expect.stringContaining('No GitHub CI appeared on aaaaaaa in 3 minutes (PR #12)'), options: ['wait', 'no-ci', 'mark-failed'] }
        ])
        expect(r.settled).toEqual([])
      })

      // G4 (measured): a workflow starting or rerunning shows a suite and no check run for seconds; that is CI coming
      it('asks nothing about no CI while an Actions suite runs with no check yet, and reads again soon', async () => {
        const r = rig({ read: prRead({ suites: [{ app: 'github-actions', completed: false }], checks: [] }) })
        r.watch.onState(waiting())
        await r.at(0)
        await r.at(NO_CI_GRACE_MS + PENDING_MS)
        expect(r.gates).toEqual([])
        expect(r.settled).toEqual([])
        const reads = r.calls.filter((c) => c === 'read 12').length
        await r.at(NO_CI_GRACE_MS + 2 * PENDING_MS)
        expect(r.calls.filter((c) => c === 'read 12').length).toBe(reads + 1)
      })

      it('no CI is no CI in required mode with rule names too, where the verdict reads pending', async () => {
        const r = rig({ read: NONE, rules: { ok: true, names: ['ci'] } })
        r.watch.onState(waiting())
        await r.at(0)
        await r.at(NO_CI_GRACE_MS + PENDING_MS)
        expect(r.gates.map((g) => g.kind)).toEqual(['github-no-ci'])
      })

      it('a wait past the Job’s ciWaitMinutes asks whether to wait again or fail, even while reads fail, once', async () => {
        const r = rig({ fail: { at: 'read', kind: 'network' } })
        r.watch.onState(waiting())
        await r.at(0)
        expect(r.gates).toEqual([])
        await r.at(90 * 60_000)
        expect(r.gates).toEqual([
          { taskId: 'tsk_l', since: ISO0, kind: 'github-ci-cap', question: expect.stringContaining('gave no verdict in 90 minutes (PR #12)'), options: ['wait', 'mark-failed'] }
        ])
        await r.at(90 * 60_000 + 5_000)
        expect(r.gates).toHaveLength(1)
      })

      it('a read GitHub refuses for this account asks at once; a network failure does not', async () => {
        const r = rig({ fail: { at: 'read', kind: 'auth' } })
        r.watch.onState(waiting())
        await r.at(0)
        expect(r.gates).toEqual([
          { taskId: 'tsk_l', since: ISO0, kind: 'github-ci-outside', question: expect.stringContaining('GitHub does not take this account’s reads'.replace('’', "'")), options: ['wait', 'mark-failed'] }
        ])
        await r.at(ERROR_BACKOFF_MS[0])
        expect(r.gates).toHaveLength(1)
        const n = rig({ fail: { at: 'read', kind: 'network' } })
        n.watch.onState(waiting())
        await n.at(0)
        expect(n.gates).toEqual([])
      })

      it('a bound pull request closed while the round waits asks to reopen it and wait, or fail; a merged one to fail', async () => {
        const closedRun = { githubState: { ...BOUND, pr: { state: 'closed' as const, isDraft: true, baseBranch: 'develop' } } }
        const r = rig({ read: prRead({ state: 'closed' }) })
        r.watch.onState(waiting({}, closedRun))
        await r.at(0)
        expect(r.gates).toEqual([
          { taskId: 'tsk_l', since: ISO0, kind: 'github-pr-closed', question: expect.stringContaining('pull request #12 was closed'), options: ['wait', 'mark-failed'] }
        ])
        expect(r.settled).toEqual([])
        const m = rig({ read: prRead({ state: 'merged' }) })
        m.watch.onState(waiting({}, { githubState: { ...BOUND, pr: { state: 'merged' as const, isDraft: false, baseBranch: 'develop' } } }))
        await m.at(0)
        expect(m.gates).toEqual([
          { taskId: 'tsk_l', since: ISO0, kind: 'github-pr-closed', question: expect.stringContaining('pull request #12 was merged before'), options: ['mark-failed'] }
        ])
      })

      it('a pull request head Astera did not push is recorded and asks whether to bring it in; one behind the push waits', async () => {
        const r = rig({ read: prRead({ headSha: B, commitSha: B }), ancestry: 'not' })
        r.watch.onState(waiting())
        await r.at(0)
        expect(r.records.some((x) => x.patch.externalHead?.sha === B)).toBe(true)
        expect(r.gates).toEqual([
          { taskId: 'tsk_l', since: ISO0, kind: 'github-external-head', question: expect.stringContaining('u/a on GitHub has a commit Astera did not push (bbbbbbb)'), options: ['continue', 'mark-failed'] }
        ])
        for (const ancestry of ['ancestor', 'unknown'] as const) {
          const lag = rig({ read: prRead({ headSha: B, commitSha: B }), ancestry })
          lag.watch.onState(waiting())
          await lag.at(0)
          expect(lag.gates, ancestry).toEqual([])
          expect(lag.settled, ancestry).toEqual([])
        }
      })

      it('going on without CI settles the round passed, says why, and records the choice, once', async () => {
        const r = rig({ read: NONE })
        r.watch.onState(waiting({ noCi: true }))
        await r.at(0)
        await r.at(5_000)
        expect(r.settled).toEqual([
          { taskId: 'tsk_l', since: ISO0, result: expect.objectContaining({ configId: 'github:ci', status: 'passed', summary: 'No CI ran on aaaaaaa; a person chose to go on without CI.' }) }
        ])
        expect(r.records.filter((x) => x.patch.noCi?.sha === A)).toHaveLength(1)
      })

      // A question the Host could not write is asked again on the next read; one refused because the round moved is not
      it('asks again on the next read when the question could not be written, not when the round moved', async () => {
        const r = rig({ read: CANCELLED, log: LOG, gateStatus: [500, 200] })
        r.watch.onState(waiting())
        await r.at(0)
        await r.at(SETTLED_MS * 2)
        await r.at(SETTLED_MS * 4)
        expect(r.gates).toHaveLength(2)
        const moved = rig({ read: CANCELLED, log: LOG, gateStatus: [400] })
        moved.watch.onState(waiting())
        await moved.at(0)
        await moved.at(SETTLED_MS * 2)
        expect(moved.gates).toHaveLength(1)
      })

      it('going on without CI that could not be recorded is tried again on the next read', async () => {
        const r = rig({ read: NONE, settleFails: 1 })
        r.watch.onState(waiting({ noCi: true }))
        await r.at(0)
        expect(r.settled).toEqual([])
        await r.at(SETTLED_MS * 2)
        expect(r.settled).toHaveLength(1)
      })

      // G3b2 final review I1 (S10): going on without CI is for a head with no check at all
      it('a choice to go on without CI does not pass a head whose CI ran since', async () => {
        const f = rig({ read: failed(), log: LOG })
        f.watch.onState(waiting({ noCi: true }))
        await f.at(0)
        expect(f.settled).toEqual([{ taskId: 'tsk_l', since: ISO0, ciClass: 'test', result: expect.objectContaining({ status: 'failed' }) }])
        expect(f.records.some((x) => x.patch.noCi)).toBe(false)
        const o = rig({ read: CANCELLED, log: LOG })
        o.watch.onState(waiting({ noCi: true }))
        await o.at(0)
        expect(o.settled).toEqual([])
        expect(o.gates.map((g) => g.kind)).toEqual(['github-ci-outside'])
      })

      // G3b2 final review M2: a verdict read at the cap is the verdict
      it('a verdict read past the cap settles the round instead of asking', async () => {
        const r = rig()
        r.watch.onState(waiting())
        await r.at(90 * 60_000)
        expect(r.settled).toHaveLength(1)
        expect(r.gates).toEqual([])
      })

      // G3b2 final review M3: while a person chooses among pull requests, the watch binds none
      it('binds no pull request for a Run whose lifecycle Task holds a wait with nothing pushed, even while it waits on a person', async () => {
        const r = rig({ prs: [{ number: 3, url: 'u3' }] })
        const s = waiting({ sha: undefined }, {})
        r.watch.onState({ ...s, tasks: s.tasks.map((t) => (t.id === 'tsk_l' ? { ...t, status: 'blocked' as const } : t)) })
        await r.at(0)
        expect(r.calls.some((c) => c.startsWith('find'))).toBe(false)
      })

      // G3c1 (design §4.6): an unknown failure gets one repair; a second in the same lifecycle Task asks a person
      it('settles a first failure Astera cannot classify, with its class, and asks on the second', async () => {
        const ODD = ['##[group]Run ./deploy.sh', 'exit 1', '##[error]Process completed with exit code 1.'].map((l) => `t\tUNKNOWN STEP\t2026-10-17T20:32:40.1Z ${l}`).join('\n')
        const first = rig({ read: failed('deploy-preview'), log: ODD })
        first.watch.onState(waiting())
        await first.at(0)
        expect(first.settled).toEqual([expect.objectContaining({ taskId: 'tsk_l', ciClass: 'unknown', result: expect.objectContaining({ status: 'failed' }) })])
        expect(first.gates).toEqual([])
        const again = rig({ read: failed('deploy-preview'), log: ODD })
        const s = waiting()
        again.watch.onState({ ...s, tasks: s.tasks.map((t) => (t.id === 'tsk_l' ? { ...t, ciUnknowns: 1 } : t)) })
        await again.at(0)
        expect(again.settled).toEqual([])
        expect(again.gates).toEqual([
          { taskId: 'tsk_l', since: ISO0, kind: 'github-ci-outside', question: expect.stringContaining('GitHub CI failed again for a reason Astera could not classify'), options: ['wait', 'retry', 'mark-failed'] }
        ])
      })

      it('after waiting again the same head is decided again, once', async () => {
        const r = rig({ read: CANCELLED, log: LOG })
        r.watch.onState(waiting())
        await r.at(0)
        expect(r.gates).toHaveLength(1)
        r.watch.onState(waiting({ waitingSince: '2026-10-18T00:10:00.000Z' }))
        await r.at(10 * 60_000)
        await r.at(10 * 60_000 + 5_000)
        expect(r.gates).toHaveLength(2)
      })
    })

    it('leaves the binding of a Run whose round waits to be pushed to the Host’s carrier', async () => {
      const r = rig()
      r.watch.onState(withRound({ since: ISO0, done: [] }, {}))
      await r.at(0)
      expect(r.calls.some((c) => c.startsWith('find'))).toBe(false)
    })
  })
})
