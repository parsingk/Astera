// One pull request's state at one moment (GitHub lifecycle design §6.1): the real answer for a merged PR, and made-up
// answers for what a merged PR cannot show (running checks, commit statuses, partial errors, a moving head).
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { GhResult } from './gh'
import { PR_STATE_QUERY, parsePrState, readPrState } from './prState'

const merged = readFileSync(path.join(__dirname, 'fixtures', 'pr-state-merged.json'), 'utf8')
const HEAD = 'b'.repeat(40)

/** An answer for an open PR whose head commit carries the given contexts and suites. */
const answer = (o: { contexts?: unknown[]; suites?: unknown[]; headRefOid?: string; oid?: string; errors?: unknown[] } = {}): string =>
  JSON.stringify({
    data: {
      rateLimit: { limit: 5000, remaining: 4000, resetAt: '2026-10-18T01:00:00Z' },
      repository: {
        pullRequest: {
          number: 12, state: 'OPEN', isDraft: false, url: 'https://github.com/o/r/pull/12', headRefName: 'u/a',
          headRefOid: o.headRefOid ?? HEAD, baseRefName: 'develop', mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED',
          commits: { nodes: [{ commit: { oid: o.oid ?? HEAD, checkSuites: { nodes: o.suites ?? [] }, statusCheckRollup: { contexts: { nodes: o.contexts ?? [] } } } }] }
        }
      }
    },
    ...(o.errors ? { errors: o.errors } : {})
  })

describe('parsePrState', () => {
  it('reads the real answer for a merged PR', () => {
    const read = parsePrState(merged)
    expect(read).toMatchObject({
      number: 1,
      url: 'https://github.com/parsingk/Astera/pull/1',
      state: 'merged',
      isDraft: true,
      headBranch: 'feature/linux-build',
      headSha: '8bd42aad136cbb50c31d623f7013331f5fa4c876',
      commitSha: '8bd42aad136cbb50c31d623f7013331f5fa4c876',
      baseBranch: 'develop',
      mergeStateStatus: 'UNKNOWN',
      rateLimit: { limit: 5000, remaining: 4991, resetAt: '2026-10-17T16:01:18Z' }
    })
    expect(read).not.toHaveProperty('reviewDecision')
    expect(read!.suites).toEqual([
      { app: 'github-actions', completed: true },
      { app: 'github-actions', completed: true },
      { app: 'github-actions', completed: true }
    ])
    expect(read!.checks.map((c) => c.name)).toEqual(['build', 'build (macos-latest)', 'build (ubuntu-latest)', 'build (windows-latest)'])
    expect(read!.checks[3]).toEqual({
      externalId: 'run:95020118524',
      name: 'build (windows-latest)',
      workflow: 'CI',
      status: 'completed',
      conclusion: 'success',
      required: false,
      detailsUrl: 'https://github.com/parsingk/Astera/actions/runs/31888056267/job/95020118524',
      ciRunId: 31888056267,
      jobId: 95020118524,
      startedAt: '2026-08-15T13:45:14Z',
      completedAt: '2026-08-15T13:49:08Z'
    })
  })

  it('maps running and finished check runs, commit statuses, and drops what it does not know', () => {
    const read = parsePrState(
      answer({
        suites: [
          { status: 'IN_PROGRESS', app: { slug: 'github-actions' }, checkRuns: { totalCount: 2 } },
          { status: 'QUEUED', app: { slug: 'stuck-app' }, checkRuns: { totalCount: 0 } }
        ],
        contexts: [
          { __typename: 'CheckRun', databaseId: 1, name: 'test', status: 'IN_PROGRESS', conclusion: null, isRequired: true },
          { __typename: 'CheckRun', databaseId: 2, name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', isRequired: false, completedAt: '2026-10-18T00:01:00Z' },
          { __typename: 'CheckRun', databaseId: 3, name: 'odd', status: 'COMPLETED', conclusion: 'SOMETHING_NEW', isRequired: false },
          { __typename: 'StatusContext', context: 'ci/ext', state: 'PENDING', targetUrl: 'https://ci.example/1', isRequired: true },
          { __typename: 'StatusContext', context: 'ci/err', state: 'ERROR', targetUrl: '', createdAt: '2026-10-18T00:02:00Z', isRequired: false },
          { __typename: 'Mystery', name: 'x' }
        ]
      })
    )!
    expect(read.state).toBe('open')
    expect(read.reviewDecision).toBe('REVIEW_REQUIRED')
    expect(read.suites).toEqual([{ app: 'github-actions', completed: false }])
    expect(read.checks.map((c) => [c.name, c.status, c.conclusion, c.required])).toEqual([
      ['ci/err', 'completed', 'failure', false],
      ['ci/ext', 'queued', undefined, true],
      ['lint', 'completed', 'failure', false],
      ['odd', 'completed', 'unknown', false],
      ['test', 'in-progress', undefined, true]
    ])
    expect(read.checks[1]).toMatchObject({ externalId: 'status:ci/ext', detailsUrl: 'https://ci.example/1' })
    expect(read.checks[0]).not.toHaveProperty('detailsUrl')
  })

  // An invalid workflow file leaves a failed Actions suite and no check run (measured on the sandbox, 2026-10-18)
  it('reads an Actions workflow that failed before any job as a failed check of its own, and still drops other empty suites', () => {
    const run = (id: number, name: string) => ({ databaseId: id, url: `https://github.com/o/r/actions/runs/${id}`, workflow: { name } })
    const read = parsePrState(
      answer({
        suites: [
          { status: 'COMPLETED', conclusion: 'FAILURE', app: { slug: 'github-actions' }, checkRuns: { totalCount: 0 }, workflowRun: run(39099661750, '.github/workflows/invalid.yml') },
          { status: 'COMPLETED', conclusion: 'STARTUP_FAILURE', app: { slug: 'github-actions' }, checkRuns: { totalCount: 0 }, workflowRun: run(39099661751, 'deploy') },
          { status: 'COMPLETED', conclusion: 'SUCCESS', app: { slug: 'github-actions' }, checkRuns: { totalCount: 0 }, workflowRun: run(39099661752, 'quiet') },
          { status: 'COMPLETED', conclusion: 'FAILURE', app: { slug: 'other-app' }, checkRuns: { totalCount: 0 } },
          { status: 'QUEUED', conclusion: null, app: { slug: 'stuck-app' }, checkRuns: { totalCount: 0 } }
        ]
      })
    )!
    expect(read.checks).toEqual([
      {
        externalId: 'suite:39099661750', name: '.github/workflows/invalid.yml', workflow: '.github/workflows/invalid.yml', status: 'completed',
        conclusion: 'failure', required: false, detailsUrl: 'https://github.com/o/r/actions/runs/39099661750', ciRunId: 39099661750
      },
      {
        externalId: 'suite:39099661751', name: 'deploy', workflow: 'deploy', status: 'completed', conclusion: 'startup-failure', required: false,
        detailsUrl: 'https://github.com/o/r/actions/runs/39099661751', ciRunId: 39099661751
      }
    ])
    expect(read.suites).toEqual([])
  })

  it('asks for each suite’s conclusion and workflow run, and each workflow run’s attempt', () => {
    expect(PR_STATE_QUERY).toMatch(/checkSuites\(first:50\)\{ totalCount nodes\{ status conclusion app\{ slug \} checkRuns\(first:1\)\{ totalCount \} workflowRun\{ databaseId runAttempt url workflow\{ name \} \} \} \}/)
    expect(PR_STATE_QUERY).toContain('checkSuite{ workflowRun{ databaseId runAttempt workflow{ name } } }')
  })

  // GitHub lifecycle G4 (measured on the sandbox 2026-10-19): a rerun leaves its workflow's suite QUEUED with no check
  // run for seconds, and the rollup without that workflow's checks
  it('counts an Actions suite that has not started its jobs as running, and knows each workflow run’s attempt', () => {
    const run = (id: number, name: string, attempt: number) => ({ databaseId: id, runAttempt: attempt, url: `https://github.com/o/r/actions/runs/${id}`, workflow: { name } })
    const read = parsePrState(
      answer({
        suites: [
          { status: 'QUEUED', conclusion: null, app: { slug: 'github-actions' }, checkRuns: { totalCount: 0 }, workflowRun: run(39099662373, 'fixtures', 1) },
          { status: 'COMPLETED', conclusion: 'SUCCESS', app: { slug: 'github-actions' }, checkRuns: { totalCount: 1 }, workflowRun: run(39100211754, 'Lint', 1) },
          { status: 'COMPLETED', conclusion: 'FAILURE', app: { slug: 'github-actions' }, checkRuns: { totalCount: 0 }, workflowRun: run(39099661750, 'broken', 2) },
          { status: 'QUEUED', conclusion: null, app: { slug: 'stuck-app' }, checkRuns: { totalCount: 0 } },
          // G4 final review I2: no workflow run behind it, so nothing is starting
          { status: 'QUEUED', conclusion: null, app: { slug: 'github-actions' }, checkRuns: { totalCount: 0 }, workflowRun: null }
        ],
        contexts: [
          {
            __typename: 'CheckRun', databaseId: 117594766611, name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: false,
            checkSuite: { workflowRun: { databaseId: 39100211754, runAttempt: 3, workflow: { name: 'Lint' } } }
          }
        ]
      })
    )!
    expect(read.suites).toEqual([
      { app: 'github-actions', completed: false },
      { app: 'github-actions', completed: true }
    ])
    expect(read.checks.find((c) => c.name === 'lint')).toMatchObject({ ciRunId: 39100211754, ciRunAttempt: 3 })
    expect(read.checks.find((c) => c.name === 'broken')).toMatchObject({ externalId: 'suite:39099661750', ciRunAttempt: 2 })
  })

  // Review Focus 2
  it('reads the data of an answer that also carries errors', () => {
    const read = parsePrState(answer({ errors: [{ type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'commits'], message: 'x' }] }))
    expect(read?.number).toBe(12)
  })

  // Review Focus 1
  it('keeps the commit the checks belong to apart from the PR head', () => {
    const read = parsePrState(answer({ headRefOid: 'c'.repeat(40), oid: HEAD }))!
    expect(read.headSha).toBe('c'.repeat(40))
    expect(read.commitSha).toBe(HEAD)
  })

  it('a PR with no checks reads as none at all', () => {
    const noRollup = JSON.parse(answer())
    noRollup.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup = null
    expect(parsePrState(JSON.stringify(noRollup))?.checks).toEqual([])
  })

  it('is null for a missing PR and for what is not JSON', () => {
    expect(parsePrState(JSON.stringify({ data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND' }] }))).toBeNull()
    expect(parsePrState('not json')).toBeNull()
  })
})

describe('readPrState', () => {
  it('asks gh api graphql with the owner, name, number and a one-line query', async () => {
    const calls: string[][] = []
    const r = await readPrState(async (args) => (calls.push(args), { ok: true, stdout: answer(), stderr: '' }), '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 12)
    expect(r.ok).toBe(true)
    expect(calls[0].slice(0, 8)).toEqual(['api', 'graphql', '-f', 'owner=o', '-f', 'name=r', '-F', 'number=12'])
    expect(calls[0][8]).toBe('-f')
    expect(calls[0][9]).toBe(`query=${PR_STATE_QUERY.replace(/\s+/g, ' ').trim()}`)
    expect(calls[0][9]).not.toContain('\n')
  })

  it('names the host for GitHub Enterprise', async () => {
    const calls: string[][] = []
    await readPrState(async (args) => (calls.push(args), { ok: true, stdout: answer(), stderr: '' }), '/wt', { host: 'ghe.example.com', owner: 'o', name: 'r' }, 12)
    expect(calls[0].slice(0, 4)).toEqual(['api', 'graphql', '--hostname', 'ghe.example.com'])
  })

  // gh exits 1 whenever the answer carries `errors`, and still prints the data (measured, final review C1)
  it('a missing PR is not-found, read as gh answers it: exit 1 with the data and the error', async () => {
    const failed: GhResult = {
      ok: false,
      stdout: JSON.stringify({ data: { rateLimit: { limit: 5000, remaining: 4990, resetAt: 'T' }, repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', path: ['repository', 'pullRequest'] }] }),
      stderr: 'gh: Could not resolve to a PullRequest with the number of 999.',
      exitCode: 1
    }
    const r = await readPrState(async () => failed, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 999)
    expect(r).toMatchObject({ ok: false, kind: 'not-found' })
  })

  // Review Focus 2 on the real path (final review C1)
  it('reads an answer gh failed only because a leaf field could not be resolved, and says required-ness is unknown', async () => {
    const leaf = ['repository', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'statusCheckRollup', 'contexts', 'nodes', 0, 'isRequired']
    const partial: GhResult = {
      ok: false,
      stdout: answer({ contexts: [{ __typename: 'CheckRun', databaseId: 1, name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: null }], errors: [{ type: 'FORBIDDEN', path: leaf, message: 'x' }] }),
      stderr: 'gh: Resource not accessible by integration',
      exitCode: 1
    }
    const r = await readPrState(async () => partial, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 12)
    expect(r.ok).toBe(true)
    expect(r.ok && r.read.checks.map((c) => c.name)).toEqual(['build'])
    expect(r.ok && r.read.requiredUnknown).toBe(true)
  })

  it('does not read an answer whose checks themselves could not be resolved: that is not "no checks"', async () => {
    const container = ['repository', 'pullRequest', 'commits', 'nodes', 0, 'commit', 'statusCheckRollup']
    const partial: GhResult = { ok: false, stdout: answer({ errors: [{ type: 'FORBIDDEN', path: container, message: 'x' }] }), stderr: 'gh: Resource not accessible by integration', exitCode: 1 }
    const r = await readPrState(async () => partial, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 12)
    expect(r.ok).toBe(false)
  })
})

describe('what a read cannot see (final review M1, M7)', () => {
  it('marks a read whose checks or suites ran past the page as truncated', () => {
    const many = JSON.parse(answer({ contexts: [{ __typename: 'CheckRun', databaseId: 1, name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: false }] }))
    many.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.totalCount = 150
    expect(parsePrState(JSON.stringify(many))?.truncated).toBe(true)
    const suites = JSON.parse(answer({ suites: [{ status: 'COMPLETED', app: { slug: 'x' }, checkRuns: { totalCount: 1 } }] }))
    suites.data.repository.pullRequest.commits.nodes[0].commit.checkSuites.totalCount = 70
    expect(parsePrState(JSON.stringify(suites))?.truncated).toBe(true)
    expect(parsePrState(answer())).not.toHaveProperty('truncated')
  })

  it('orders the checks by name, then id, whatever order GitHub answered in', () => {
    const read = parsePrState(
      answer({
        contexts: [
          { __typename: 'CheckRun', databaseId: 9, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: false },
          { __typename: 'CheckRun', databaseId: 3, name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: false },
          { __typename: 'CheckRun', databaseId: 2, name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', isRequired: false }
        ]
      })
    )!
    expect(read.checks.map((c) => c.externalId)).toEqual(['run:2', 'run:3', 'run:9'])
  })
})
