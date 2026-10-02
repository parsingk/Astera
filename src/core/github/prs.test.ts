import { describe, it, expect } from 'vitest'
import { parsePrList, prForBranch, PR_LIST_ARGS, PR_LIST_LIMIT } from './prs'
import type { GhResult, GhRunner } from './gh'

type Row = Record<string, unknown>
const row = (over: Row): Row => ({
  number: 1,
  title: 'a title',
  state: 'OPEN',
  isDraft: false,
  url: 'https://github.com/o/r/pull/1',
  headRefName: 'feat/a',
  statusCheckRollup: [],
  ...over
})
const feed = (rows: Row[]): string => JSON.stringify(rows)

describe('parsePrList', () => {
  it('maps one open PR onto its head branch', () => {
    const map = parsePrList(feed([row({ number: 7, headRefName: 'feat/x' })]))
    expect(map).toEqual({
      'feat/x': {
        number: 7,
        title: 'a title',
        state: 'open',
        isDraft: false,
        url: 'https://github.com/o/r/pull/1',
        checks: null
      }
    })
  })

  it('folds checks: any failure wins, then any pending, then passing', () => {
    const failing = [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }
    ]
    const pending = [
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null },
      { __typename: 'StatusContext', state: 'SUCCESS' }
    ]
    const passing = [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', state: 'SUCCESS' }
    ]
    expect(parsePrList(feed([row({ statusCheckRollup: failing })]))!['feat/a'].checks).toBe('failing')
    expect(parsePrList(feed([row({ statusCheckRollup: pending })]))!['feat/a'].checks).toBe('pending')
    expect(parsePrList(feed([row({ statusCheckRollup: passing })]))!['feat/a'].checks).toBe('passing')
    expect(parsePrList(feed([row({ statusCheckRollup: [] })]))!['feat/a'].checks).toBeNull()
  })

  it('a StatusContext ERROR or PENDING counts like its CheckRun cousin', () => {
    const err = [{ __typename: 'StatusContext', state: 'ERROR' }]
    const pend = [{ __typename: 'StatusContext', state: 'PENDING' }]
    expect(parsePrList(feed([row({ statusCheckRollup: err })]))!['feat/a'].checks).toBe('failing')
    expect(parsePrList(feed([row({ statusCheckRollup: pend })]))!['feat/a'].checks).toBe('pending')
  })

  it('an open PR beats a newer merged one on the same branch', () => {
    // gh returns newest first — the merged retry sits above the older still-open PR
    const map = parsePrList(
      feed([
        row({ number: 9, state: 'MERGED', headRefName: 'feat/x' }),
        row({ number: 5, state: 'OPEN', headRefName: 'feat/x' })
      ])
    )
    expect(map!['feat/x'].number).toBe(5)
    expect(map!['feat/x'].state).toBe('open')
  })

  it('without an open PR, the newest (first listed) wins', () => {
    const map = parsePrList(
      feed([
        row({ number: 9, state: 'MERGED', headRefName: 'feat/x' }),
        row({ number: 5, state: 'CLOSED', headRefName: 'feat/x' })
      ])
    )
    expect(map!['feat/x'].number).toBe(9)
    expect(map!['feat/x'].state).toBe('merged')
  })

  it('unparseable output returns null, an empty list returns {}', () => {
    expect(parsePrList('gh: command failed')).toBeNull()
    expect(parsePrList('[]')).toEqual({})
  })

  it('rows missing required fields are skipped, not fatal', () => {
    const map = parsePrList(feed([{ number: 3 }, row({ number: 4, headRefName: 'ok' })]))
    expect(map).not.toBeNull()
    expect(Object.keys(map!)).toEqual(['ok'])
  })

  it('the argv embeds the window constant', () => {
    expect(PR_LIST_ARGS).toContain(String(PR_LIST_LIMIT))
    expect(PR_LIST_ARGS.slice(0, 2)).toEqual(['pr', 'list'])
  })
})

describe('prForBranch', () => {
  const result = (over: Partial<GhResult>): GhResult => ({ ok: false, stdout: '', stderr: '', ...over })

  it("lists the branch's PRs with the coordinator's fields and picks the branch's one", async () => {
    const seen: { args: string[]; cwd: string }[] = []
    const run: GhRunner = async (args, cwd) => {
      seen.push({ args, cwd })
      return result({ ok: true, stdout: feed([row({ number: 9, headRefName: 'feat/x' })]) })
    }
    const r = await prForBranch(run, 'D:/repo', 'feat/x')
    expect(seen).toEqual([
      {
        args: ['pr', 'list', '--head', 'feat/x', '--state', 'all', '--limit', '5', '--json', PR_LIST_ARGS.at(-1)],
        cwd: 'D:/repo'
      }
    ])
    expect(r).toMatchObject({ ok: true, pr: { number: 9, state: 'open' } })
  })

  it('no PR for the branch is pr: null', async () => {
    const r = await prForBranch(async () => result({ ok: true, stdout: '[]' }), 'd', 'feat/x')
    expect(r).toEqual({ ok: true, pr: null })
  })

  it('a gh failure maps to a sentence, output that is not JSON to other', async () => {
    expect(await prForBranch(async () => result({ stderr: 'no git remotes found' }), 'd', 'b')).toMatchObject({
      ok: false,
      kind: 'no-remote'
    })
    expect(await prForBranch(async () => result({ ok: true, stdout: 'x' }), 'd', 'b')).toMatchObject({
      ok: false,
      kind: 'other'
    })
  })
})
