// The open PR of a Run's branch (GitHub lifecycle §7): from this repository, this head, this base.
import { describe, it, expect } from 'vitest'
import type { GhRunner } from './gh'
import { findOpenPrs } from './prBinding'

const row = (over: Record<string, unknown> = {}) => ({ number: 12, url: 'https://github.com/o/r/pull/12', headRefName: 'u/a', baseRefName: 'develop', isCrossRepository: false, ...over })

describe('findOpenPrs', () => {
  it('asks for open PRs of the branch into the base, and keeps only this repository’s exact matches', async () => {
    const calls: string[][] = []
    const run: GhRunner = async (args) => (
      calls.push(args),
      { ok: true, stderr: '', stdout: JSON.stringify([row(), row({ number: 13, isCrossRepository: true }), row({ number: 14, baseRefName: 'main' })]) }
    )
    const r = await findOpenPrs(run, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 'u/a', 'develop')
    expect(r).toEqual({ ok: true, prs: [{ number: 12, url: 'https://github.com/o/r/pull/12' }] })
    expect(calls[0]).toEqual([
      'pr', 'list', '--repo', 'o/r', '--head', 'u/a', '--base', 'develop', '--state', 'open', '--limit', '5',
      '--json', 'number,url,headRefName,baseRefName,isCrossRepository'
    ])
  })

  it('passes a gh failure on', async () => {
    const run: GhRunner = async () => ({ ok: false, stdout: '', stderr: 'HTTP 401: Bad credentials', exitCode: 1 })
    expect(await findOpenPrs(run, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 'u/a', 'develop')).toMatchObject({ ok: false, kind: 'auth' })
  })

  it('refuses an answer that is not a list', async () => {
    const run: GhRunner = async () => ({ ok: true, stdout: '{}', stderr: '' })
    expect(await findOpenPrs(run, '/wt', { host: 'github.com', owner: 'o', name: 'r' }, 'u/a', 'develop')).toMatchObject({ ok: false, kind: 'other' })
  })
})
