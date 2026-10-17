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
    expect(read!.checks).toHaveLength(4)
    expect(read!.checks[0]).toEqual({
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
      ['test', 'in-progress', undefined, true],
      ['lint', 'completed', 'failure', false],
      ['odd', 'completed', 'unknown', false],
      ['ci/ext', 'queued', undefined, true],
      ['ci/err', 'completed', 'failure', false]
    ])
    expect(read.checks[3]).toMatchObject({ externalId: 'status:ci/ext', detailsUrl: 'https://ci.example/1' })
    expect(read.checks[4]).not.toHaveProperty('detailsUrl')
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

  it('a missing PR is not-found', async () => {
    const failed: GhResult = { ok: false, stdout: '', stderr: 'gh: Could not resolve to a PullRequest with the number of 999.', exitCode: 1 }
    const r = await readPrState(async () => failed, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 999)
    expect(r).toMatchObject({ ok: false, kind: 'not-found' })
  })
})
