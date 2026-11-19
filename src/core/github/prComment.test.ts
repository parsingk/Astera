// The gh calls that carry the run report to a pull request (run report C2, §10), on a recording fake runner.
import { describe, it, expect } from 'vitest'
import type { GhResult } from './gh'
import { editIssueComment, findReportComment, postPrComment } from './prComment'

const github = { host: 'github.com', owner: 'o', name: 'r' }
const ghe = { host: 'ghe.example.com', owner: 'o', name: 'r' }
const answering = (r: Partial<GhResult>) => {
  const calls: string[][] = []
  const run = async (args: string[]): Promise<GhResult> => (calls.push(args), { ok: true, stdout: '', stderr: '', ...r })
  return { run, calls }
}

describe('postPrComment', () => {
  it('comments on the pull request and reads the comment id from the URL it prints', async () => {
    const g = answering({ stdout: 'https://github.com/o/r/pull/7#issuecomment-123\n' })
    expect(await postPrComment(g.run, '/wt', github, 7, 'Body')).toEqual({ ok: true, id: 123, url: 'https://github.com/o/r/pull/7#issuecomment-123' })
    expect(g.calls[0]).toEqual(['pr', 'comment', '7', '--repo', 'o/r', '--body', 'Body'])
  })
  it('names the host of an enterprise repository', async () => {
    const g = answering({ stdout: 'https://ghe.example.com/o/r/pull/7#issuecomment-9' })
    await postPrComment(g.run, '/wt', ghe, 7, 'B')
    expect(g.calls[0]).toEqual(['pr', 'comment', '7', '--repo', 'ghe.example.com/o/r', '--body', 'B'])
  })
  it('refuses a success that names no comment', async () => {
    const g = answering({ stdout: 'done' })
    expect(await postPrComment(g.run, '/wt', github, 7, 'B')).toEqual({ ok: false, kind: 'other', message: 'gh pr comment answered without the comment URL' })
  })
  it('says a failure through the gh sentence', async () => {
    const g = answering({ ok: false, stderr: 'HTTP 404: Not Found' })
    expect(await postPrComment(g.run, '/wt', github, 7, 'B')).toMatchObject({ ok: false, kind: 'not-found' })
  })
})

describe('editIssueComment', () => {
  it('patches the comment by its id', async () => {
    const g = answering({ stdout: '{}' })
    expect(await editIssueComment(g.run, '/wt', github, 123, 'New')).toEqual({ ok: true })
    expect(g.calls[0]).toEqual(['api', '--method', 'PATCH', 'repos/o/r/issues/comments/123', '-f', 'body=New'])
  })
  it('names the host of an enterprise repository', async () => {
    const g = answering({})
    await editIssueComment(g.run, '/wt', ghe, 5, 'N')
    expect(g.calls[0]).toEqual(['api', '--hostname', 'ghe.example.com', '--method', 'PATCH', 'repos/o/r/issues/comments/5', '-f', 'body=N'])
  })
  it('answers not-found for a comment that is gone', async () => {
    const g = answering({ ok: false, stderr: 'gh: Not Found (HTTP 404)\nHTTP 404: Not Found' })
    expect(await editIssueComment(g.run, '/wt', github, 123, 'N')).toMatchObject({ ok: false, kind: 'not-found' })
  })
})

describe('findReportComment', () => {
  const MARK = '<!-- astera-run-report:run-1 -->'
  it('lists the pull request comments and keeps the first match', async () => {
    const g = answering({ stdout: '55 https://github.com/o/r/pull/7#issuecomment-55\n77 https://github.com/o/r/pull/7#issuecomment-77\n' })
    expect(await findReportComment(g.run, '/wt', github, 7, MARK)).toEqual({ ok: true, found: { id: 55, url: 'https://github.com/o/r/pull/7#issuecomment-55' } })
    expect(g.calls[0]).toEqual([
      'api',
      '--paginate',
      'repos/o/r/issues/7/comments?per_page=100',
      '--jq',
      `.[] | select(.body | contains("${MARK}")) | "\\(.id) \\(.html_url)"`
    ])
  })
  it('names the host of an enterprise repository', async () => {
    const g = answering({})
    await findReportComment(g.run, '/wt', ghe, 7, MARK)
    expect(g.calls[0].slice(0, 3)).toEqual(['api', '--hostname', 'ghe.example.com'])
  })
  it('finds nothing in an empty answer', async () => {
    const g = answering({ stdout: '' })
    expect(await findReportComment(g.run, '/wt', github, 7, MARK)).toEqual({ ok: true, found: null })
  })
  it('says a failure through the gh sentence', async () => {
    const g = answering({ ok: false, stderr: 'HTTP 401: Bad credentials' })
    expect(await findReportComment(g.run, '/wt', github, 7, MARK)).toMatchObject({ ok: false, kind: 'auth' })
  })
})
