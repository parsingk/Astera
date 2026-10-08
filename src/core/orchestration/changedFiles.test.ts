// Which repo and range a Run's or a Task's changed files are read over (remote runtime design Phase 10), in the order
// to try them: the live folder first while the work can still change, then the recorded range in the project, which
// outlives a reaped worktree.
import { describe, it, expect } from 'vitest'
import { rangesFor } from './changedFiles'
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
  it('in its own worktree: that folder against its base, then the recorded range in the project', () => {
    const s = state({ runs: [{ id: 'run1', jobId: 'job1', worktree: 'W', git: { base: 'b', head: 'h' } }] })
    expect(rangesFor(s, 'run1')).toEqual({
      ranges: [
        { repo: 'W', base: 'b', head: null },
        { repo: 'P', base: 'b', head: 'h' }
      ],
      reported: ['a.ts', 'b.ts']
    })
  })
  it('in the project folder: the working tree only while an attempt is open', () => {
    const open = state({ runs: [{ id: 'run1', jobId: 'job1', git: { base: 'b', head: 'h' } }], dispatches: [{ id: 'd1', taskId: 't1', cwd: 'P' }] })
    expect(rangesFor(open, 'run1')).toMatchObject({ ranges: [{ repo: 'P', base: 'b', head: null }, { repo: 'P', base: 'b', head: 'h' }] })
    const ended = state({ runs: [{ id: 'run1', jobId: 'job1', git: { base: 'b', head: 'h' } }], dispatches: [{ id: 'd1', taskId: 't1', cwd: 'P', endedAt: 'x' }] })
    expect(rangesFor(ended, 'run1')).toMatchObject({ ranges: [{ repo: 'P', base: 'b', head: 'h' }] })
  })
  it('with no recorded base there is no range, and the worker’s list still answers', () => {
    expect(rangesFor(state({}), 'run1')).toEqual({ ranges: [], reported: ['a.ts', 'b.ts'] })
  })
  it('an unknown Run or Task is null', () => {
    expect(rangesFor(state({}), 'run_x')).toBeNull()
    expect(rangesFor(state({}), 'run1', 't9')).toBeNull()
  })
})

describe('rangesFor a Task', () => {
  it('from its first attempt’s base to its last attempt’s head, in their folder; review attempts are not its work', () => {
    const s = state({
      dispatches: [
        { id: 'd1', taskId: 't1', cwd: 'T', startedAt: '1', endedAt: '2', git: { base: 'b1', head: 'h1' } },
        { id: 'd2', taskId: 't1', cwd: 'T', startedAt: '3', endedAt: '4', git: { base: 'b2', head: 'h2' } },
        { id: 'd3', taskId: 't1', cwd: 'T', startedAt: '5', review: true, git: { base: 'r', head: 'r' } }
      ]
    })
    expect(rangesFor(s, 'run1', 't1')).toEqual({
      ranges: [
        { repo: 'T', base: 'b1', head: 'h2' },
        { repo: 'P', base: 'b1', head: 'h2' }
      ],
      reported: ['a.ts']
    })
  })
  it('an attempt still open reads its folder’s working tree first', () => {
    const s = state({ dispatches: [{ id: 'd1', taskId: 't1', cwd: 'T', startedAt: '1', git: { base: 'b1' } }] })
    expect(rangesFor(s, 'run1', 't1')).toMatchObject({ ranges: [{ repo: 'T', base: 'b1', head: null }] })
  })
})
