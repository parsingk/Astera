// Which repos and ranges a Run's or a Task's changed files are read over (remote runtime design Phase 10). A Run's list
// is its root's range plus each Task that worked in a worktree of its own (a parallel Run's Tasks merge into the project
// without passing through the Run's root). Each part's ranges come in the order to try them: the folder's working tree
// first while an attempt is open there, the recorded range after; a finished part reads its recorded range first.
import { describe, it, expect } from 'vitest'
import { attemptRanges, collectChanges, rangesFor, scopeAttempts, ATTRIBUTION_ATTEMPTS_MAX } from './changedFiles'
import type { OrchState } from './state'

type Rec = Record<string, unknown>
const state = (over: { runs?: Rec[]; tasks?: Rec[]; dispatches?: Rec[] }): OrchState =>
  ({
    jobs: [{ id: 'job1', cwd: 'P' }],
    runs: over.runs ?? [{ id: 'run1', jobId: 'job1' }],
    tasks: over.tasks ?? [
      { id: 't1', runId: 'run1', filesModified: ['a.ts'] },
      { id: 't2', runId: 'run1', filesModified: ['a.ts', 'b.ts'] }
    ],
    dispatches: over.dispatches ?? []
  }) as unknown as OrchState

describe('rangesFor a Run', () => {
  it('in its own worktree, finished: the recorded range first, then that folder as it is', () => {
    const s = state({ runs: [{ id: 'run1', jobId: 'job1', worktree: 'W', git: { base: 'b', head: 'h' } }] })
    expect(rangesFor(s, 'run1')).toEqual({
      parts: [{ ranges: [{ repo: 'P', base: 'b', head: 'h' }, { repo: 'W', base: 'b', head: null }] }],
      reported: ['a.ts', 'b.ts']
    })
  })
  it('in the project folder: its working tree only while an attempt is open there', () => {
    const open = state({ runs: [{ id: 'run1', jobId: 'job1', git: { base: 'b', head: 'h' } }], dispatches: [{ id: 'd1', taskId: 't1', cwd: 'P', startedAt: '1' }] })
    expect(rangesFor(open, 'run1')!.parts[0].ranges).toEqual([{ repo: 'P', base: 'b', head: null }, { repo: 'P', base: 'b', head: 'h' }])
    const ended = state({ runs: [{ id: 'run1', jobId: 'job1', git: { base: 'b', head: 'h' } }], dispatches: [{ id: 'd1', taskId: 't1', cwd: 'P', startedAt: '1', endedAt: 'x' }] })
    expect(rangesFor(ended, 'run1')!.parts[0].ranges).toEqual([{ repo: 'P', base: 'b', head: 'h' }])
  })
  it('a Task in a worktree of its own is a part of the Run’s list too', () => {
    const s = state({
      runs: [{ id: 'run1', jobId: 'job1', worktree: 'W', git: { base: 'b', head: 'h' } }],
      dispatches: [
        { id: 'd1', taskId: 't1', cwd: 'T1', startedAt: '1', endedAt: '2', git: { base: 'x1', head: 'y1' } },
        { id: 'd2', taskId: 't2', cwd: 'W', startedAt: '1', endedAt: '2', git: { base: 'x2', head: 'y2' } }
      ]
    })
    expect(rangesFor(s, 'run1')!.parts).toEqual([
      { ranges: [{ repo: 'P', base: 'b', head: 'h' }, { repo: 'W', base: 'b', head: null }] },
      { taskId: 't1', ranges: [{ repo: 'T1', base: 'x1', head: 'y1' }, { repo: 'P', base: 'x1', head: 'y1' }, { repo: 'T1', base: 'x1', head: null }] }
    ])
  })
  it('with no recorded base there is nothing to read, and the worker’s list still answers', () => {
    expect(rangesFor(state({}), 'run1')).toEqual({ parts: [], reported: ['a.ts', 'b.ts'] })
  })
  it('an unknown Run or Task is null', () => {
    expect(rangesFor(state({}), 'run_x')).toBeNull()
    expect(rangesFor(state({}), 'run1', 't9')).toBeNull()
  })
})

describe('rangesFor a Task', () => {
  it('its last attempt’s folder, from the first base recorded there to its last head; review attempts are not its work', () => {
    const s = state({
      dispatches: [
        { id: 'd1', taskId: 't1', cwd: 'T', startedAt: '1', endedAt: '2', git: { base: 'b1', head: 'h1' } },
        { id: 'd2', taskId: 't1', cwd: 'T', startedAt: '3', endedAt: '4', git: { base: 'b2', head: 'h2' } },
        { id: 'd3', taskId: 't1', cwd: 'T', startedAt: '5', review: true, git: { base: 'r', head: 'r' } }
      ]
    })
    expect(rangesFor(s, 'run1', 't1')).toEqual({
      parts: [{ taskId: 't1', ranges: [{ repo: 'T', base: 'b1', head: 'h2' }, { repo: 'P', base: 'b1', head: 'h2' }, { repo: 'T', base: 'b1', head: null }] }],
      reported: ['a.ts']
    })
  })
  it('a retry in a new worktree reads that worktree, from its own base', () => {
    const s = state({
      dispatches: [
        { id: 'd1', taskId: 't1', cwd: 'T1', startedAt: '1', endedAt: '2', git: { base: 'b1', head: 'h1' } },
        { id: 'd2', taskId: 't1', cwd: 'T2', startedAt: '3', git: { base: 'b2' } }
      ]
    })
    expect(rangesFor(s, 'run1', 't1')!.parts[0].ranges).toEqual([{ repo: 'T2', base: 'b2', head: null }])
  })
})

// Phase 3 Part 4: one attempt's own range, the attempts a scope holds, and the range each part was read over
describe('attemptRanges', () => {
  const s = state({
    dispatches: [
      { id: 'd1', taskId: 't1', cwd: 'W1', startedAt: '1', endedAt: '2', git: { base: 'b1', head: 'h1' } },
      { id: 'd2', taskId: 't1', cwd: 'P', startedAt: '3', git: { base: 'b2' } },
      { id: 'd3', taskId: 't1', cwd: 'W1', startedAt: '4', endedAt: '5', git: { base: 'b3' } },
      { id: 'd4', taskId: 't1', cwd: 'W1', startedAt: '6', endedAt: '7' },
      { id: 'r1', taskId: 't1', cwd: 'W1', startedAt: '8', endedAt: '9', review: true, git: { base: 'h1', head: 'h1' } }
    ]
  })
  it('an ended attempt: its own base..head in its folder, then in the project', () => {
    expect(attemptRanges(s, 'run1', 'd1')).toMatchObject({
      parts: [{ taskId: 't1', ranges: [{ repo: 'W1', base: 'b1', head: 'h1' }, { repo: 'P', base: 'b1', head: 'h1' }] }],
      reported: ['a.ts'],
      dispatch: { id: 'd1' }
    })
  })
  it('an open attempt reads its folder’s working tree; one that ended with no head reads its folder as it is', () => {
    expect(attemptRanges(s, 'run1', 'd2')!.parts[0].ranges).toEqual([{ repo: 'P', base: 'b2', head: null }])
    expect(attemptRanges(s, 'run1', 'd3')!.parts[0].ranges).toEqual([{ repo: 'W1', base: 'b3', head: null }])
  })
  it('an attempt with no recorded base has no part', () => {
    expect(attemptRanges(s, 'run1', 'd4')!.parts).toEqual([])
  })
  it('an unknown attempt, a review attempt, or one of another Run is null', () => {
    expect(attemptRanges(s, 'run1', 'nope')).toBeNull()
    expect(attemptRanges(s, 'run1', 'r1')).toBeNull()
    expect(attemptRanges(s, 'run2', 'd1')).toBeNull()
  })
})

describe('scopeAttempts', () => {
  it('the attempts of a Run, a Task or one attempt, oldest first, review attempts left out', () => {
    const s = state({
      dispatches: [
        { id: 'd2', taskId: 't2', cwd: 'P', startedAt: '2' },
        { id: 'd1', taskId: 't1', cwd: 'P', startedAt: '1' },
        { id: 'r1', taskId: 't1', cwd: 'P', startedAt: '3', review: true },
        { id: 'x1', taskId: 'other', cwd: 'P', startedAt: '0' }
      ]
    })
    expect(scopeAttempts(s, 'run1').map((d) => d.id)).toEqual(['d1', 'd2'])
    expect(scopeAttempts(s, 'run1', 't2').map((d) => d.id)).toEqual(['d2'])
    expect(scopeAttempts(s, 'run1', undefined, 'd1').map((d) => d.id)).toEqual(['d1'])
  })
  it('keeps the newest ones past its bound', () => {
    const many = Array.from({ length: ATTRIBUTION_ATTEMPTS_MAX + 5 }, (_, i) => ({ id: `d${i}`, taskId: 't1', cwd: 'P', startedAt: String(1000 + i) }))
    const got = scopeAttempts(state({ dispatches: many }), 'run1', 't1')
    expect(got).toHaveLength(ATTRIBUTION_ATTEMPTS_MAX)
    expect(got[0].id).toBe('d5')
  })
})

describe('collectChanges', () => {
  it('answers the range each part was read over, a part with no files too', async () => {
    const parts = [{ ranges: [{ repo: 'P', base: 'b', head: 'h' }] }, { taskId: 't1', ranges: [{ repo: 'X', base: 'x', head: 'y' }, { repo: 'T1', base: 'c', head: null }] }]
    const got = await collectChanges(parts, async (repo) => (repo === 'P' ? [{ id: 'f', path: 'a.ts', status: 'modified' as const }] : repo === 'T1' ? [] : null))
    expect(got.used).toEqual([
      { range: { repo: 'P', base: 'b', head: 'h' } },
      { taskId: 't1', range: { repo: 'T1', base: 'c', head: null } }
    ])
  })
})
