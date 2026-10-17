import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ISSUE_JOB_ASSOCIATIONS,
  parseIssue,
  readIssue,
  repoOf,
  issueFrom,
  issueBodyHash,
  type GhIssue
} from './issue'
import type { GhResult, GhRunner } from './gh'

// Both fixtures are `gh api repos/{owner}/{repo}/issues/<n>` against parsingk/Astera, gh 2.97.0,
// 2026-10-02, exit 0, trimmed of fields the parser does not read (user and labels cut to a few keys,
// reactions, assignees and the like removed). issue.json is issue #7; issue-pr.json is #3, a pull
// request, which the issues endpoint answers with a `pull_request` key. A missing number
// (issues/99999) measured exit 1 with stderr "gh: Not Found (HTTP 404)".
const ISSUE = readFileSync(join(__dirname, 'fixtures/issue.json'), 'utf8')
const PR = readFileSync(join(__dirname, 'fixtures/issue-pr.json'), 'utf8')

const result = (over: Partial<GhResult>): GhResult => ({ ok: false, stdout: '', stderr: '', ...over })

const issue = (over: Partial<GhIssue> = {}): GhIssue => ({
  number: 12,
  title: 'Crash on start',
  body: 'Steps:\n1. open the app',
  state: 'open',
  labels: ['bug'],
  author: 'someone',
  authorAssociation: 'MEMBER',
  url: 'https://github.com/o/r/issues/12',
  isPullRequest: false,
  ...over
})

describe('parseIssue', () => {
  it('parses a real issue', () => {
    const i = parseIssue(ISSUE)!
    expect({ ...i, body: i.body.slice(0, 40) }).toEqual({
      number: 7,
      title: 'Bring the Contributing section of the Korean, Japanese and Spanish READMEs up to date',
      body: 'The README comes in English (`README.md`',
      state: 'open',
      labels: ['documentation', 'good first issue'],
      author: 'parsingk',
      authorAssociation: 'OWNER',
      url: 'https://github.com/parsingk/Astera/issues/7',
      isPullRequest: false,
      updatedAt: '2026-09-30T13:13:31Z'
    })
  })

  it('a pull request number reads as isPullRequest', () => {
    const i = parseIssue(PR)!
    expect(i).toMatchObject({ number: 3, state: 'closed', isPullRequest: true, labels: [] })
  })

  it('a null body reads as empty', () => {
    const raw = { ...JSON.parse(ISSUE), body: null }
    expect(parseIssue(JSON.stringify(raw))!.body).toBe('')
  })

  it('malformed JSON or a missing field is null', () => {
    expect(parseIssue('nope')).toBeNull()
    expect(parseIssue('[]')).toBeNull()
    const { user: _user, ...noUser } = JSON.parse(ISSUE)
    expect(parseIssue(JSON.stringify(noUser))).toBeNull()
    expect(parseIssue(JSON.stringify({ ...JSON.parse(ISSUE), state: 'weird' }))).toBeNull()
  })
})

describe('readIssue', () => {
  it('asks the REST issues endpoint, gh filling owner and repo from the folder', async () => {
    const seen: { args: string[]; cwd: string }[] = []
    const run: GhRunner = async (args, cwd) => {
      seen.push({ args, cwd })
      return result({ ok: true, stdout: ISSUE })
    }
    const r = await readIssue(run, 'D:/repo', 7)
    expect(seen).toEqual([{ args: ['api', 'repos/{owner}/{repo}/issues/7'], cwd: 'D:/repo' }])
    expect(r.ok && r.issue.number).toBe(7)
  })

  it('a 404 is not-found', async () => {
    const r = await readIssue(async () => result({ stderr: 'gh: Not Found (HTTP 404)' }), 'd', 99999)
    expect(r).toMatchObject({ ok: false, kind: 'not-found' })
  })

  it('a non-issue answer is a failure', async () => {
    const r = await readIssue(async () => result({ ok: true, stdout: '{}' }), 'd', 1)
    expect(r).toMatchObject({ ok: false, kind: 'other' })
  })
})

describe('constants and repoOf', () => {
  it('only members of the repository can turn an issue into a Job', () => {
    expect(ISSUE_JOB_ASSOCIATIONS).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR'])
  })

  it('repoOf reads owner/repo off the html_url', () => {
    expect(repoOf('https://github.com/parsingk/Astera/issues/7')).toBe('parsingk/Astera')
    expect(repoOf('https://ghe.corp.example/team/app/pull/3')).toBe('team/app')
  })
})

describe('the issue as a Job saw it (GitHub lifecycle §6)', () => {
  it('reads updated_at', () => {
    const issue = issueFrom({ number: 5, title: 't', body: 'b', state: 'open', user: { login: 'pk' }, author_association: 'OWNER', html_url: 'u', updated_at: '2026-10-18T00:00:00Z' })
    expect(issue?.updatedAt).toBe('2026-10-18T00:00:00Z')
  })
  it('hashes a body to sha256 hex, the same body to the same hash', () => {
    expect(issueBodyHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(issueBodyHash('abc')).toBe(issueBodyHash('abc'))
  })
})
