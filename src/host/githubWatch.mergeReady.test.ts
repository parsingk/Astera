// Merge-ready decided by the review's verdict and kept or withdrawn by the watch, end to end over the pure record
// (GitHub lifecycle G5b final review: the evidence and the watch judge on the same checks, by the same definition).
import { describe, it, expect } from 'vitest'
import { createGithubWatch, REVIEWING_MS, type GithubWatchDeps } from './githubWatch'
import { emptyState, type OrchState } from '../core/orchestration/state'
import { mergeReadyOf } from '../core/orchestration/lifecycleTask'
import { nextGitHubState, type RunGitHubPatch } from '../core/github/runState'
import { ciTargets, evaluateCi } from '../core/github/ciVerdict'
import type { PrStateRead } from '../core/github/prState'
import type { GitHubCiCheck, RunGitHubState } from '../core/github/lifecycle'
import type { Dispatch, Task } from '../core/orchestration/types'

const T0 = Date.parse('2026-10-18T00:00:00.000Z')
const ISO0 = new Date(T0).toISOString()
const A = 'a'.repeat(40)
const BINDING = { repository: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', baseBranch: 'develop', headBranch: 'u/a', createdByAstera: true, boundAt: ISO0 }
const POLICY = { ci: { mode: 'required' as const }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }

const ok = (name: string, over: Partial<GitHubCiCheck> = {}): GitHubCiCheck => ({ externalId: `run:${name}`, name, status: 'completed', conclusion: 'success', required: false, jobId: 1, ...over })
const prRead = (checks: GitHubCiCheck[], over: Partial<PrStateRead> = {}): PrStateRead => ({
  number: 12, url: BINDING.url, state: 'open', isDraft: true, headBranch: 'u/a', headSha: A, commitSha: A, baseBranch: 'develop',
  suites: [{ app: 'github-actions', completed: true }], checks, ...over
})
const lifecycleTask = (status: Task['status'], checks: Task['checks'] = []): Task =>
  ({ id: 'tsk_l', runId: 'run_1', kind: 'lifecycle', title: 'GitHub', spec: 's', deps: [], status, consecutiveFailures: 0, createdAt: ISO0, updatedAt: ISO0, checks }) as Task
const reviewDispatch = { id: 'dsp_r', taskId: 'tsk_l', review: true, reviewHead: A } as unknown as Dispatch
const stateWith = (gs: RunGitHubState | undefined, tasks: Task[] = []): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: 'o', cwd: '/repo', createdAt: ISO0, github: POLICY, convergence: {} } as never],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 1, createdAt: ISO0, worktree: '/wt/a', githubState: gs } as never],
  tasks
})

/** The record as the watch keeps it after reading `read` (its verdict and the checks it judged on), Astera's push A. */
const recorded = (read: PrStateRead, rules: string[] = []): RunGitHubState => {
  const ev = evaluateCi(read, POLICY.ci, rules)
  let gs = nextGitHubState(undefined, { binding: BINDING }, ISO0)!
  gs = nextGitHubState(gs, { pushed: { sha: A } }, ISO0)!
  return nextGitHubState(
    gs,
    { read: { headSha: read.headSha, pr: { state: 'open', isDraft: true, baseBranch: 'develop' }, ci: { sha: read.commitSha, basis: ev.basis, verdict: ev.verdict, checks: read.checks, targetNames: ciTargets(read, POLICY.ci, rules).names } } },
    ISO0
  )!
}

function rig(read: PrStateRead, rules: string[] = []) {
  const clock = { now: T0 }
  const records: { runId: string; patch: RunGitHubPatch }[] = []
  const calls: string[] = []
  const deps: GithubWatchDeps = {
    now: () => clock.now,
    random: () => 0.5,
    record: async (args) => (records.push(args), { status: 200, body: {} }),
    worktreeOf: (p) => (p === '/wt/a' ? { repoPath: '/repo', branch: 'u/a', baseRef: 'develop' } : null),
    baseBranch: async (_r, ref) => ref,
    originOf: async () => 'git@github.com:o/r.git',
    findOpenPrs: async () => ({ ok: true, prs: [{ number: 12, url: BINDING.url }] as never }),
    readPrState: async () => (calls.push('read'), { ok: true, read }),
    ruleCheckNames: async () => ({ ok: true, names: rules }),
    readJobLog: async () => ({ ok: true, log: '' }),
    readAnnotations: async () => ({ ok: true, annotations: [] }),
    readIssue: async () => ({ ok: false, kind: 'other', message: 'x' }) as never,
    log: () => undefined
  }
  const watch = createGithubWatch(deps)
  const at = async (ms: number): Promise<void> => {
    clock.now = T0 + ms
    await watch.tick()
  }
  return { watch, records, calls, at }
}

/** The verdict's evidence on `verdictRead`, then what the watch withdraws on reading `laterRead`. */
const afterVerdict = async (verdictRead: PrStateRead, laterRead: PrStateRead, rules: string[] = []) => {
  const gs = recorded(verdictRead, rules)
  const v = mergeReadyOf(stateWith(gs), lifecycleTask('completed'), reviewDispatch)
  if (!('evidence' in v)) throw new Error(`no evidence: ${JSON.stringify(v)}`)
  const ready = nextGitHubState(gs, { mergeReady: v.evidence }, ISO0)!
  const r = rig(laterRead, rules)
  r.watch.onState(stateWith(ready, [lifecycleTask('completed')]))
  await r.at(0)
  return { evidence: v.evidence, reasons: r.records.flatMap((x) => (x.patch.invalidated ? [x.patch.invalidated.reason] : [])) }
}

describe('merge-ready kept and withdrawn on the same checks (G5b final review)', () => {
  // I1: the evidence was the first 50 of the record, the watch's the whole read
  it('keeps merge-ready on a pull request with more than 50 checks read again unchanged', async () => {
    const read = prRead(Array.from({ length: 60 }, (_, i) => ok(`test (${String(i).padStart(2, '0')})`)))
    const { evidence, reasons } = await afterVerdict(read, read)
    expect(evidence.ciChecks).toHaveLength(60)
    expect(reasons).toEqual([])
  })

  // M2
  it('a read that cannot say which checks are required withdraws nothing, even beside a failing optional check', async () => {
    const verdictRead = prRead([ok('build', { required: true }), ok('lint')])
    expect((await afterVerdict(verdictRead, prRead([ok('build'), ok('lint')], { requiredUnknown: true }))).reasons).toEqual([])
    const failingLint = prRead([ok('build', { required: true }), ok('lint', { conclusion: 'failure' })])
    expect((await afterVerdict(failingLint, prRead([ok('build'), ok('lint', { conclusion: 'failure' })], { requiredUnknown: true }))).reasons).toEqual([])
  })

  // M3
  it('a passed workflow rerunning is not a changed check set while it runs', async () => {
    const verdictRead = prRead([ok('build'), ok('deploy', { conclusion: 'skipped' })])
    const rerunning = prRead(
      [ok('build', { externalId: 'run:b2', status: 'in-progress', conclusion: undefined }), ok('deploy', { externalId: 'run:d2', status: 'queued', conclusion: undefined })],
      { suites: [{ app: 'github-actions', completed: false }] }
    )
    expect((await afterVerdict(verdictRead, rerunning)).reasons).toEqual([])
  })

  // M1
  it('reads a Run within 30 seconds of its lifecycle Task going to review, whatever read was due', async () => {
    const read = prRead([ok('build')])
    const gs = recorded(read)
    const r = rig(read)
    r.watch.onState(stateWith(gs, [lifecycleTask('validating')]))
    await r.at(0)
    r.watch.onState(stateWith(gs, [lifecycleTask('reviewing')]))
    await r.at(5_000)
    expect(r.calls).toHaveLength(2)
    await r.at(5_000 + REVIEWING_MS)
    expect(r.calls).toHaveLength(3)
  })

  // M4
  it('a person’s no-CI does not stand for a head on which CI failed or still runs', () => {
    const failed = { ...recorded(prRead([ok('build', { conclusion: 'failure' })])), ciOverride: { sha: A, at: ISO0 } }
    expect(mergeReadyOf(stateWith(failed), lifecycleTask('completed'), reviewDispatch)).toEqual({ reason: 'ci-not-passed' })
    const none = { ...recorded(prRead([])), ciOverride: { sha: A, at: ISO0 } }
    expect(mergeReadyOf(stateWith(none), lifecycleTask('completed'), reviewDispatch)).toMatchObject({ evidence: { ciOverride: 'no-ci' } })
  })

  // M5
  it('a local check a person skipped withholds merge-ready as skipped, not failed', () => {
    const task = lifecycleTask('completed', [
      { configId: 'npm-test', name: 'npm test', status: 'not-run', skipped: true },
      { configId: 'github:ci', name: 'GitHub CI', status: 'passed' }
    ] as Task['checks'])
    expect(mergeReadyOf(stateWith(recorded(prRead([ok('build')]))), task, reviewDispatch)).toEqual({ reason: 'local-check-skipped' })
  })

  // G6 (spec §30): a pull request retargeted to another base is not merge-ready against the base Astera bound; the next
  // read would only withdraw it again (`base-changed`), and runs reconverge binds the new base
  it('withholds merge-ready while the pull request’s base is not the binding’s', () => {
    const gs = recorded(prRead([ok('build')]))
    const retargeted = { ...gs, pr: { ...gs.pr!, baseBranch: 'main' } }
    expect(mergeReadyOf(stateWith(retargeted), lifecycleTask('completed'), reviewDispatch)).toEqual({ reason: 'base-changed' })
  })

  // M6
  it('withholds merge-ready while GitHub cannot be read', () => {
    const gs = { ...recorded(prRead([ok('build')])), lastReadError: { kind: 'network', since: ISO0 } }
    expect(mergeReadyOf(stateWith(gs), lifecycleTask('completed'), reviewDispatch)).toEqual({ reason: 'external-state-unavailable' })
  })
})
