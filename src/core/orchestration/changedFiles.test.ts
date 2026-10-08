// Which repos and ranges a Run's or a Task's changed files are read over (remote runtime design Phase 10). A Run's list
// is its root's range plus each Task that worked in a worktree of its own (a parallel Run's Tasks merge into the project
// without passing through the Run's root). Each part's ranges come in the order to try them: the folder's working tree
// first while an attempt is open there, the recorded range after; a finished part reads its recorded range first.
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
