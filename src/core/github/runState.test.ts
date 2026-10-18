// How a read changes a Run's GitHub record (GitHub lifecycle G1): what moved is logged once, numbered, and a read that
// finds nothing new changes nothing.
import { describe, it, expect } from 'vitest'
import type { GitHubBinding, GitHubCiCheck, RunGitHubState } from './lifecycle'
import { nextGitHubState, parseRunGitHubPatch, type RunGitHubPatch } from './runState'

const T1 = '2026-10-18T00:00:00.000Z'
const T2 = '2026-10-18T00:01:00.000Z'
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const BINDING: GitHubBinding = { repository: 'o/r', number: 12, url: 'https://github.com/o/r/pull/12', baseBranch: 'develop', headBranch: 'u/a', createdByAstera: false, boundAt: T1 }
const build = (over: Partial<GitHubCiCheck> = {}): GitHubCiCheck => ({ externalId: 'run:1', name: 'build', status: 'completed', conclusion: 'success', required: false, ...over })
const read = (sha: string, verdict: 'pending' | 'passed' | 'failed', over: Partial<NonNullable<RunGitHubPatch['read']>['ci']> = {}): NonNullable<RunGitHubPatch['read']> => ({
  headSha: sha,
  pr: { state: 'open', isDraft: true, baseBranch: 'develop' },
  ci: { sha, basis: 'all-reported', verdict, checks: [build()], ...over }
})

describe('nextGitHubState', () => {
  it('binds, reads and logs the binding and the verdict in order', () => {
    const next = nextGitHubState(undefined, { binding: BINDING, read: read(A, 'passed'), lastReadError: null }, T1)!
    expect(next.binding).toEqual(BINDING)
    expect(next.headSha).toBe(A)
    expect(next.ci).toEqual({ sha: A, basis: 'all-reported', verdict: 'passed', checks: [build()], changedAt: T1 })
    expect(next.log).toEqual([
      { seq: 1, at: T1, kind: 'pr-bound', pr: 12 },
      { seq: 2, at: T1, kind: 'ci-passed', sha: A }
    ])
    expect(next.seq).toBe(2)
  })

  it('answers null for a read that finds nothing new, so nothing is written', () => {
    const first = nextGitHubState(undefined, { binding: BINDING, read: read(A, 'pending'), lastReadError: null }, T1)!
    expect(nextGitHubState(first, { read: read(A, 'pending'), lastReadError: null }, T2)).toBeNull()
  })

  it('logs a new head and the verdict of the new head, and keeps a binding once made', () => {
    const first = nextGitHubState(undefined, { binding: BINDING, read: read(A, 'passed') }, T1)!
    const next = nextGitHubState(first, { binding: { ...BINDING, number: 99 }, read: read(B, 'failed', { failing: 'build', checks: [build({ conclusion: 'failure' })] }) }, T2)!
    expect(next.binding?.number).toBe(12)
    expect(next.log.slice(2)).toEqual([
      { seq: 3, at: T2, kind: 'head-changed', sha: B },
      { seq: 4, at: T2, kind: 'ci-failed', sha: B, check: 'build' }
    ])
    expect(next.ci?.changedAt).toBe(T2)
  })

  // Final review I1: a verdict for a commit that is not the PR's head is no news about the head
  it('does not log a verdict for a commit that is not the head', () => {
    const lagging = { ...read(A, 'passed'), headSha: B }
    const next = nextGitHubState(undefined, { binding: BINDING, read: lagging }, T1)!
    expect(next.log.map((e) => e.kind)).toEqual(['pr-bound'])
    expect(next.ci?.sha).toBe(A)
    expect(next.headSha).toBe(B)
    const caughtUp = nextGitHubState(next, { read: read(B, 'passed') }, T2)!
    expect(caughtUp.log.map((e) => e.kind)).toEqual(['pr-bound', 'ci-passed'])
  })

  // Final review M6: the failing check's link is kept with the verdict, not looked up again by name
  it('keeps the failing check’s link with the verdict', () => {
    const next = nextGitHubState(undefined, { read: read(A, 'failed', { failing: 'build', failingUrl: 'https://x/run/1' }) }, T1)!
    expect(next.ci?.failingUrl).toBe('https://x/run/1')
  })

  // G2: the evidence goes with the verdict, and the log says the class
  it('keeps the failure evidence with the verdict, and logs its class with ci-failed', () => {
    const failure = { check: 'build', externalId: 'run:1', class: 'test' as const, summary: 'build (test): not ok 1', diagnostics: [], logExcerpt: 'not ok 1' }
    const next = nextGitHubState(undefined, { read: read(A, 'failed', { failing: 'build', failure }) }, T1)!
    expect(next.ci?.failure).toEqual(failure)
    expect(next.log.at(-1)).toEqual({ seq: 1, at: T1, kind: 'ci-failed', sha: A, check: 'build', class: 'test' })
  })

  it('a read whose evidence changed is a change; the same evidence again is not', () => {
    const failure = { check: 'build', externalId: 'run:1', class: 'test' as const, summary: 's', diagnostics: [] }
    const first = nextGitHubState(undefined, { read: read(A, 'failed', { failing: 'build' }) }, T1)!
    const withEvidence = nextGitHubState(first, { read: read(A, 'failed', { failing: 'build', failure }) }, T2)!
    expect(withEvidence.ci?.failure).toEqual(failure)
    expect(nextGitHubState(withEvidence, { read: read(A, 'failed', { failing: 'build', failure }) }, T2)).toBeNull()
  })

  it('does not log the same verdict twice for the same commit', () => {
    const first = nextGitHubState(undefined, { binding: BINDING, read: read(A, 'failed', { failing: 'build' }) }, T1)!
    const again = nextGitHubState(first, { read: read(A, 'failed', { failing: 'build', checks: [build({ conclusion: 'failure', completedAt: T2 })] }) }, T2)!
    expect(again.log).toHaveLength(first.log.length)
    expect(again.ci?.changedAt).toBe(T2)
  })

  it('keeps when an error kind began, and clears it on a good read', () => {
    const failed = nextGitHubState(undefined, { lastReadError: { kind: 'network' } }, T1)!
    expect(failed.lastReadError).toEqual({ kind: 'network', since: T1 })
    expect(nextGitHubState(failed, { lastReadError: { kind: 'network' } }, T2)).toBeNull()
    expect(nextGitHubState(failed, { lastReadError: null }, T2)?.lastReadError).toBeUndefined()
  })

  it('keeps PR candidates only while nothing is bound', () => {
    const many = nextGitHubState(undefined, { prCandidates: [12, 13] }, T1)!
    expect(many.prCandidates).toEqual([12, 13])
    expect(nextGitHubState(many, { binding: BINDING }, T2)?.prCandidates).toBeUndefined()
    expect(nextGitHubState(many, { prCandidates: null }, T2)?.prCandidates).toBeUndefined()
  })

  it('logs a changed source once', () => {
    const changed = nextGitHubState(undefined, { sourceChanged: true }, T1)!
    expect(changed.log).toEqual([{ seq: 1, at: T1, kind: 'source-changed' }])
    expect(nextGitHubState(changed, { sourceChanged: true }, T2)).toBeNull()
  })

  it('keeps at most 50 checks and the last 100 log entries, with their numbers', () => {
    const many = Array.from({ length: 60 }, (_, i) => build({ externalId: `run:${i}`, name: `c${i}` }))
    const big = nextGitHubState(undefined, { read: read(A, 'pending', { checks: many }) }, T1)!
    expect(big.ci?.checks).toHaveLength(50)
    let s: RunGitHubState = { log: [], seq: 0 }
    for (let i = 0; i < 120; i++) s = nextGitHubState(s, { read: read(i % 2 ? A : B, 'pending') }, T1) ?? s
    expect(s.log).toHaveLength(100)
    expect(s.log[0].seq).toBe(s.seq - 99)
  })
})

describe('parseRunGitHubPatch', () => {
  it('accepts what the watch sends', () => {
    const patch = { binding: BINDING, read: read(A, 'passed'), lastReadError: null, prCandidates: null }
    expect(parseRunGitHubPatch(patch)).toEqual(patch)
  })
  it.each([
    [null, 'patch must be an object'],
    [{ binding: { number: '12' } }, 'binding is malformed'],
    [{ read: { headSha: 'x', pr: {}, ci: {} } }, 'read is malformed'],
    [{ read: { ...read(A, 'failed'), ci: { ...read(A, 'failed').ci, failingUrl: 7 } } }, 'read is malformed'],
    [{ read: { ...read(A, 'failed'), ci: { ...read(A, 'failed').ci, failure: { check: 1 } } } }, 'read is malformed'],
    [{ prCandidates: ['12'] }, 'prCandidates is malformed'],
    [{ lastReadError: { kind: 3 } }, 'lastReadError is malformed'],
    [{ sourceChanged: 'yes' }, 'sourceChanged is malformed']
  ])('refuses %j', (patch, why) => expect(parseRunGitHubPatch(patch)).toBe(why))
})
