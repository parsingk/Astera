// The public face of a lifecycle Run's GitHub side (design §5.3, §8), derived from the Host's record on every read.
import { describe, it, expect } from 'vitest'
import type { GitHubLifecyclePolicy, RunGitHubState } from './lifecycle'
import { githubLifecycleOf } from './view'

const POLICY: GitHubLifecyclePolicy = { ci: { mode: 'required' }, autoRerunInfrastructureFailures: true, maxInfrastructureReruns: 2, ciWaitMinutes: 90 }
const A = 'a'.repeat(40)
const bound = (over: Partial<RunGitHubState> = {}): RunGitHubState => ({
  binding: { repository: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', baseBranch: 'develop', headBranch: 'u/a', createdByAstera: false, boundAt: 'T' },
  log: [],
  seq: 0,
  ...over
})
const ci = (verdict: 'pending' | 'passed' | 'failed' | 'none', failing?: string): RunGitHubState['ci'] => ({
  sha: A, basis: 'all-reported', verdict, changedAt: 'T', ...(failing ? { failing, failingUrl: 'https://x/1' } : {}),
  checks: [{ externalId: 'run:1', name: 'build', status: 'completed', conclusion: verdict === 'failed' ? 'failure' : 'success', required: false, detailsUrl: 'https://x/1', jobId: 1 }]
})

describe('githubLifecycleOf', () => {
  it('is absent for a Job without the lifecycle', () => {
    expect(githubLifecycleOf(undefined, bound())).toBeUndefined()
  })

  it.each([
    [undefined, 'unbound'],
    [{ log: [], seq: 0, prCandidates: [12, 13] }, 'unbound'],
    [bound(), 'pr-bound'],
    [bound({ ci: ci('none') }), 'pr-bound'],
    [bound({ ci: ci('pending') }), 'ci-pending'],
    [bound({ ci: ci('passed') }), 'ci-passed'],
    [bound({ ci: ci('failed', 'build') }), 'ci-failed'],
    [bound({ ci: ci('passed'), pr: { state: 'merged', isDraft: false, baseBranch: 'develop' } }), 'pr-merged'],
    [bound({ pr: { state: 'closed', isDraft: false, baseBranch: 'develop' } }), 'pr-closed'],
    [bound({ ci: ci('passed'), lastReadError: { kind: 'network', since: 'T' } }), 'external-state-unavailable']
  ] as const)('reads %j as %s', (gs, state) => {
    expect(githubLifecycleOf(POLICY, gs as RunGitHubState | undefined)?.state).toBe(state)
  })

  it('shows the PR, the head, the checks without their internals, and the failing check with its link', () => {
    const view = githubLifecycleOf(POLICY, bound({ headSha: A, pr: { state: 'open', isDraft: true, baseBranch: 'develop', mergeStateStatus: 'BLOCKED' }, ci: ci('failed', 'build') }))
    expect(view).toEqual({
      state: 'ci-failed',
      pr: { number: 12, url: 'https://github.com/o/r/pull/12', isDraft: true, state: 'open', mergeStateStatus: 'BLOCKED' },
      headSha: A,
      ci: { sha: A, basis: 'all-reported', verdict: 'failed', checks: [{ name: 'build', status: 'completed', conclusion: 'failure', required: false }] },
      failing: { check: 'build', detailsUrl: 'https://x/1' }
    })
  })

  // Final review I1: a verdict for a commit that is not the PR's head says nothing about the head yet
  it('reads a verdict for a commit that is not the head as ci-pending', () => {
    expect(githubLifecycleOf(POLICY, bound({ headSha: 'b'.repeat(40), ci: ci('passed') }))?.state).toBe('ci-pending')
    expect(githubLifecycleOf(POLICY, bound({ headSha: 'b'.repeat(40), ci: ci('failed', 'build') }))?.state).toBe('ci-pending')
    expect(githubLifecycleOf(POLICY, bound({ headSha: A, ci: ci('passed') }))?.state).toBe('ci-passed')
  })

  // G2: why it failed, as Astera classified it; the excerpt and diagnostics stay off the view (the lifecycle Task's check
  // result carries them from G3)
  it('says the failing check’s class and summary from its evidence', () => {
    const failure = { check: 'build', externalId: 'run:1', class: 'test' as const, summary: 'build (test): not ok 1', diagnostics: [{ path: 'a.ts', line: 3, message: 'm' }], logExcerpt: 'x' }
    expect(githubLifecycleOf(POLICY, bound({ ci: { ...ci('failed', 'build')!, failure } }))?.failing).toEqual({
      check: 'build', class: 'test', summary: 'build (test): not ok 1', detailsUrl: 'https://x/1'
    })
  })

  // Final review M6: the link comes from the verdict, never from a check found again by name
  it('takes the failing link from the verdict only', () => {
    const noUrl = { ...ci('failed', 'build')!, failingUrl: undefined }
    expect(githubLifecycleOf(POLICY, bound({ ci: noUrl }))?.failing).toEqual({ check: 'build' })
  })

  it('names PR candidates and a changed source', () => {
    expect(githubLifecycleOf(POLICY, { log: [], seq: 1, prCandidates: [12, 13], sourceChanged: { at: 'T' } })).toEqual({
      state: 'unbound', candidates: [12, 13], sourceChanged: true
    })
  })
})
