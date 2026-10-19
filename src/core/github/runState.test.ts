// How a read changes a Run's GitHub record (GitHub lifecycle G1): what moved is logged once, numbered, and a read that
// finds nothing new changes nothing.
import { describe, it, expect } from 'vitest'
import { GITHUB_LOG_MAX, type GitHubBinding, type GitHubCiCheck, type GitHubLogKind, type RunGitHubState } from './lifecycle'
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

  // G7b (design §5.5): the timeline's push and CI start. CI is said to start when a read first sees the head's checks
  // running; one already finished at the first read is said by its verdict alone
  it('logs a push, and CI starting on the head once', () => {
    const bound = nextGitHubState(undefined, { binding: BINDING }, T1)!
    const pushed = nextGitHubState(bound, { pushed: { sha: A } }, T1)!
    expect(pushed.log.at(-1)).toEqual({ seq: 2, at: T1, kind: 'pushed', sha: A })
    const running = nextGitHubState(pushed, { read: read(A, 'pending', { checks: [build({ status: 'in-progress', conclusion: undefined })] }) }, T2)!
    expect(running.log.at(-1)).toEqual({ seq: 3, at: T2, kind: 'ci-started', sha: A })
    const still = nextGitHubState(running, { read: read(A, 'pending', { checks: [build({ status: 'in-progress', conclusion: undefined }), build({ externalId: 'run:2', name: 'lint', status: 'queued', conclusion: undefined })] }) }, T2)!
    expect(still.log.filter((e) => e.kind === 'ci-started')).toHaveLength(1)
    const none = nextGitHubState(pushed, { read: read(A, 'pending', { checks: [] }) }, T2)!
    expect(none.log.map((e) => e.kind)).toEqual(['pr-bound', 'pushed'])
    const done = nextGitHubState(pushed, { read: read(A, 'passed') }, T2)!
    expect(done.log.map((e) => e.kind)).toEqual(['pr-bound', 'pushed', 'ci-passed'])
  })

  // G7b final review M8: a rerun of the same commit starts CI again
  it('logs CI starting again on the same commit after a verdict', () => {
    const running = (sha: string) => read(sha, 'pending', { checks: [build({ status: 'in-progress', conclusion: undefined })] })
    const first = nextGitHubState(undefined, { binding: BINDING, read: running(A) }, T1)!
    const failed = nextGitHubState(first, { read: read(A, 'failed', { failing: 'build', checks: [build({ conclusion: 'failure' })] }) }, T1)!
    const rerun = nextGitHubState(failed, { read: running(A) }, T2)!
    expect(rerun.log.map((e) => e.kind)).toEqual(['pr-bound', 'ci-started', 'ci-failed', 'ci-started'])
  })

  // G7b final review I3: the log keeps the newest GITHUB_LOG_MAX; the timeline lines it dropped are counted, so a Run's
  // event count (runs follow's) still grows with each new line once the log is full
  it('counts the timeline lines it drops past the cap, and not the entries that are no line', () => {
    const full = { ...nextGitHubState(undefined, { binding: BINDING }, T1)!, log: Array.from({ length: GITHUB_LOG_MAX }, (_, i) => ({ seq: i + 1, at: T1, kind: (i === 0 ? 'head-changed' : 'pushed') as GitHubLogKind, sha: A })), seq: GITHUB_LOG_MAX }
    const one = nextGitHubState(full, { rerun: { ciRunId: 1, attempt: 1, sha: A, by: 'person' } }, T2)!
    expect(one.log).toHaveLength(GITHUB_LOG_MAX)
    expect(one.droppedLines ?? 0).toBe(0)
    const two = nextGitHubState(one, { rerun: { ciRunId: 2, attempt: 1, sha: A, by: 'person' } }, T2)!
    expect(two.droppedLines).toBe(1)
  })

  it('logs why merge-ready was withdrawn', () => {
    const ready = nextGitHubState(undefined, { binding: BINDING, read: read(A, 'passed'), mergeReady: { pullRequestNumber: 12, headSha: A, localChecksPassed: true, requiredCiPassed: true, reviewPassed: true, unresolvedQuestions: 0 } as never }, T1)!
    const gone = nextGitHubState(ready, { invalidated: { reason: 'head-changed' } as never }, T2)!
    expect(gone.log.at(-1)).toEqual({ seq: gone.seq, at: T2, kind: 'invalidated', reason: 'head-changed' })
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

  // G2 final review I1: with its run still going, the class is read from the check's name alone
  it('logs no class with a verdict whose evidence is still incomplete', () => {
    const failure = { check: 'build', externalId: 'run:1', class: 'build' as const, summary: 's', diagnostics: [], incomplete: { reason: 'run-in-progress' as const, tries: 0 } }
    const next = nextGitHubState(undefined, { read: read(A, 'failed', { failing: 'build', failure }) }, T1)!
    expect(next.log.at(-1)).toEqual({ seq: 1, at: T1, kind: 'ci-failed', sha: A, check: 'build' })
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

  // G3b1: the pull request Astera made says so in the log; the head it pushed is kept
  it('logs a pull request Astera created as pr-created, and keeps the head it pushed', () => {
    const made = nextGitHubState(undefined, { binding: { ...BINDING, createdByAstera: true }, pushed: { sha: A } }, T1)!
    // G7b: the push is a timeline line, once per head pushed, before the pull request it opened (final review M4)
    expect(made.log).toEqual([
      { seq: 1, at: T1, kind: 'pushed', sha: A },
      { seq: 2, at: T1, kind: 'pr-created', pr: 12 }
    ])
    expect(made.lastPushedSha).toBe(A)
    expect(nextGitHubState(made, { pushed: { sha: A } }, T2)).toBeNull()
    expect(nextGitHubState(made, { pushed: { sha: B } }, T2)!.lastPushedSha).toBe(B)
  })

  // G3b2 (design §4.2, §4.4): a head on GitHub Astera did not push is kept until Astera pushes again
  it('keeps a head Astera did not push until its next push', () => {
    const seen = nextGitHubState(undefined, { externalHead: { sha: B } }, T1)!
    expect(seen.externalHeadChange).toEqual({ sha: B, at: T1 })
    expect(nextGitHubState(seen, { externalHead: { sha: B } }, T2)).toBeNull()
    expect(nextGitHubState(undefined, { externalHead: {} }, T1)!.externalHeadChange).toEqual({ at: T1 })
    expect(nextGitHubState(seen, { pushed: { sha: A } }, T2)!.externalHeadChange).toBeUndefined()
  })

  // G3b2 (design §4.4 grace, S10): a person's choice to go on without CI is kept with the head it was for
  it('keeps a person’s choice to go on without CI', () => {
    const chose = nextGitHubState(undefined, { noCi: { sha: A } }, T1)!
    expect(chose.ciOverride).toEqual({ sha: A, at: T1 })
    expect(nextGitHubState(chose, { noCi: { sha: A } }, T2)).toBeNull()
  })

  // GitHub lifecycle G4 (design §4.6, §5.2): each CI rerun is kept, by whom, for the head it was asked on
  it('keeps each CI rerun with its time, the last 20, and logs it with the head and the check', () => {
    const rerun = { ciRunId: 39099662373, attempt: 1, sha: A, check: 'npm-network', by: 'astera' as const }
    const once = nextGitHubState({ ...nextGitHubState(undefined, { binding: BINDING }, T1)! }, { rerun }, T2)!
    expect(once.reruns).toEqual([{ ...rerun, at: T2 }])
    expect(once.log.at(-1)).toEqual({ seq: 2, at: T2, kind: 'ci-rerun', sha: A, check: 'npm-network' })
    const again = nextGitHubState(once, { rerun: { ...rerun, attempt: 2, by: 'person' } }, T2)!
    expect(again.reruns?.map((r) => [r.attempt, r.by])).toEqual([[1, 'astera'], [2, 'person']])
    let s: RunGitHubState = once
    for (let i = 0; i < 25; i++) s = nextGitHubState(s, { rerun: { ...rerun, attempt: i + 2 } }, T2)!
    expect(s.reruns).toHaveLength(20)
    expect(s.reruns?.[0].attempt).toBe(7)
  })

  // GitHub lifecycle G5b (design §5.2, §5.4): merge-ready with its evidence, and why it was withdrawn
  describe('merge-ready', () => {
    const evidence = { pullRequestNumber: 12, headSha: A, localChecksPassed: true, requiredCiPassed: true, reviewPassed: true, unresolvedQuestions: 0, ciChecks: ['build'] }
    const bound = (): RunGitHubState => nextGitHubState(undefined, { binding: BINDING }, T1)!

    it('records merge-ready with its evidence and logs it with the head and the pull request', () => {
      const ready = nextGitHubState(bound(), { mergeReady: evidence }, T2)!
      expect(ready.mergeReady).toEqual({ ...evidence, evaluatedAt: T2 })
      expect(ready.log.at(-1)).toEqual({ seq: 2, at: T2, kind: 'merge-ready', sha: A, pr: 12 })
    })

    it('withdraws it once: a second withdrawal while one stands changes nothing', () => {
      const ready = nextGitHubState(bound(), { mergeReady: evidence }, T2)!
      const withdrawn = nextGitHubState(ready, { invalidated: { reason: 'head-changed' } }, T2)!
      expect(withdrawn.invalidated).toEqual({ reason: 'head-changed', at: T2 })
      expect(withdrawn.log.at(-1)).toEqual({ seq: 3, at: T2, kind: 'invalidated', reason: 'head-changed' })
      expect(nextGitHubState(withdrawn, { invalidated: { reason: 'closed' } }, T2)).toBeNull()
    })

    // G5c final review M2: a watch read taken before `runs reconverge` withdraws evidence the reconverge already cleared;
    // nothing stands to withdraw, so no withdrawal comes back while the new lifecycle Task works
    it('a withdrawal with no merge-ready standing changes nothing', () => {
      expect(nextGitHubState(bound(), { invalidated: { reason: 'head-changed' } }, T2)).toBeNull()
      const ready = nextGitHubState(bound(), { mergeReady: evidence }, T2)!
      const cleared = nextGitHubState(ready, { mergeReady: null }, T2)!
      expect(nextGitHubState(cleared, { invalidated: { reason: 'head-changed' } }, T2)).toBeNull()
    })

    it('a fresh verdict replaces both: merge-ready again clears the withdrawal, and a failed one replaces the reason', () => {
      const ready = nextGitHubState(bound(), { mergeReady: evidence }, T2)!
      const withdrawn = nextGitHubState(ready, { invalidated: { reason: 'head-changed' } }, T2)!
      const again = nextGitHubState(withdrawn, { mergeReady: { ...evidence, headSha: B } }, T2)!
      expect(again.invalidated).toBeUndefined()
      expect(again.mergeReady?.headSha).toBe(B)
      const refused = nextGitHubState(withdrawn, { mergeReady: null, invalidated: { reason: 'ci-not-passed' } }, T2)!
      expect(refused.mergeReady).toBeUndefined()
      expect(refused.invalidated).toEqual({ reason: 'ci-not-passed', at: T2 })
    })
  })

  // G6 (spec §30): runs reconverge binds the base the pull request was retargeted to; nothing else of the binding moves
  it('re-binds the base, and only the base, and notes when', () => {
    const bound = nextGitHubState(undefined, { binding: BINDING }, T1)!
    const rebound = nextGitHubState(bound, { rebase: { baseBranch: 'release' } }, T2)!
    expect(rebound.binding).toEqual({ ...BINDING, baseBranch: 'release' })
    expect(rebound.baseReboundAt).toBe(T2)
    expect(nextGitHubState(rebound, { rebase: { baseBranch: 'release' } }, T2)).toBeNull()
    expect(nextGitHubState(undefined, { rebase: { baseBranch: 'release' } }, T2)).toBeNull()
  })

  // G6 final review M8: the re-bind is the state function's own, never a wire patch
  it('does not take a re-bind off the wire', () => {
    const parsed = parseRunGitHubPatch({ pushed: { sha: 'a'.repeat(40) }, rebase: { baseBranch: 'release' } })
    expect(parsed).toEqual({ pushed: { sha: 'a'.repeat(40) } })
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
  it('accepts the head Astera pushed, and refuses a malformed one', () => {
    expect(parseRunGitHubPatch({ pushed: { sha: A } })).toEqual({ pushed: { sha: A } })
    expect(parseRunGitHubPatch({ pushed: { sha: 7 } })).toBe('pushed is malformed')
    expect(parseRunGitHubPatch({ externalHead: { sha: A } })).toEqual({ externalHead: { sha: A } })
    expect(parseRunGitHubPatch({ externalHead: {} })).toEqual({ externalHead: {} })
    expect(parseRunGitHubPatch({ externalHead: { sha: 7 } })).toBe('externalHead is malformed')
    expect(parseRunGitHubPatch({ noCi: { sha: A } })).toEqual({ noCi: { sha: A } })
    expect(parseRunGitHubPatch({ noCi: true })).toBe('noCi is malformed')
  })

  it('accepts a CI rerun, and refuses a malformed one', () => {
    const rerun = { ciRunId: 9, attempt: 1, sha: A, by: 'astera' }
    expect(parseRunGitHubPatch({ rerun })).toEqual({ rerun })
    expect(parseRunGitHubPatch({ rerun: { ...rerun, check: 'build', by: 'person' } })).toEqual({ rerun: { ...rerun, check: 'build', by: 'person' } })
    expect(parseRunGitHubPatch({ rerun: { ...rerun, by: 'someone' } })).toBe('rerun is malformed')
    expect(parseRunGitHubPatch({ rerun: { ...rerun, ciRunId: '9' } })).toBe('rerun is malformed')
    expect(parseRunGitHubPatch({ rerun: { ...rerun, check: 3 } })).toBe('rerun is malformed')
    expect(parseRunGitHubPatch({ rerun: { ...rerun, externalId: 'run:70' } })).toEqual({ rerun: { ...rerun, externalId: 'run:70' } })
    expect(parseRunGitHubPatch({ rerun: { ...rerun, externalId: 70 } })).toBe('rerun is malformed')
  })

  it('accepts merge-ready and its withdrawal, and refuses malformed ones', () => {
    const evidence = { pullRequestNumber: 12, headSha: A, localChecksPassed: true, requiredCiPassed: false, ciOverride: 'no-ci', reviewPassed: true, unresolvedQuestions: 0, ciChecks: [] }
    expect(parseRunGitHubPatch({ mergeReady: evidence })).toEqual({ mergeReady: evidence })
    expect(parseRunGitHubPatch({ mergeReady: null, invalidated: { reason: 'pr-not-open' } })).toEqual({ mergeReady: null, invalidated: { reason: 'pr-not-open' } })
    expect(parseRunGitHubPatch({ mergeReady: { ...evidence, headSha: 7 } })).toBe('mergeReady is malformed')
    expect(parseRunGitHubPatch({ mergeReady: { ...evidence, ciOverride: 'yes' } })).toBe('mergeReady is malformed')
    expect(parseRunGitHubPatch({ mergeReady: { ...evidence, ciChecks: [1] } })).toBe('mergeReady is malformed')
    expect(parseRunGitHubPatch({ invalidated: { reason: 3 } })).toBe('invalidated is malformed')
  })

  // G2 final review I1
  it('accepts evidence that is still incomplete', () => {
    const failure = { check: 'build', externalId: 'run:1', class: 'build' as const, summary: 's', diagnostics: [], incomplete: { reason: 'run-in-progress' as const, tries: 0 } }
    const patch = { read: read(A, 'failed', { failing: 'build', failure }) }
    expect(parseRunGitHubPatch(patch)).toEqual(patch)
  })
  it.each([
    [{ reason: 'later', tries: 0 }],
    [{ reason: 'read-failed', tries: '1' }],
    ['yes']
  ])('refuses evidence whose incomplete mark is %j', (incomplete) => {
    const failure = { check: 'build', externalId: 'run:1', class: 'build', summary: 's', diagnostics: [], incomplete }
    expect(parseRunGitHubPatch({ read: { ...read(A, 'failed'), ci: { ...read(A, 'failed').ci, failure } } })).toBe('read is malformed')
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
