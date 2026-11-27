import { describe, it, expect } from 'vitest'
import type { OrchState } from '../orchestration/state'
import { parseHunks } from '../git/hunks'
import { findingRef } from '../problems/findingRef'
import { taskFoldersOf } from '../problems/completionProblems'
import { diffFindings } from './diffFindings'

// Phase 3 Part 4: a file's review findings placed on the diff that is shown: on their line, found on another revision, or
// on the file
const HEADER = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n'
const HUNK = '@@ -1,2 +1,3 @@\n const a = 1\n+const b = 2\n const c = 3\n'
const DIFF = HEADER + HUNK
const FP = parseHunks(DIFF)[0].fingerprint

function stateWith(o: { anchor?: Record<string, unknown> | null; issueFile?: string; state?: string; otherTask?: boolean } = {}): OrchState {
  const issue = { id: 'i1', severity: 'high', blocking: true, title: 'b is wrong', description: '', file: o.issueFile ?? 'src/a.ts', line: 2 }
  const s = {
    jobs: [{ id: 'job1', cwd: 'F:\\Proj' }],
    runs: [{ id: 'run1', jobId: 'job1' }],
    tasks: [
      { id: 't1', runId: 'run1', jobId: 'job1', reviewIssues: [issue] },
      ...(o.otherTask ? [{ id: 't2', runId: 'run1', jobId: 'job1', reviewIssues: [{ ...issue, id: 'i9', title: 'another task' }] }] : [])
    ],
    dispatches: [{ id: 'd1', taskId: 't1', cwd: 'F:\\Proj', startedAt: '1', endedAt: '2', git: { base: 'aaaaaaa', head: 'bbbbbbb' } }]
  } as unknown as OrchState
  const ref = findingRef({ kind: 'review', taskId: 't1', file: issue.file, base: taskFoldersOf(s, s.tasks[0]), message: issue.title })
  if (o.anchor !== null) (s.tasks[0] as { findingAnchors?: unknown }).findingAnchors = { [ref]: { review: 'r1', head: 'bbbbbbb', file: issue.file, line: 2, hunk: FP, at: 'x', ...o.anchor } }
  if (o.state) (s.tasks[0] as { findingStates?: unknown }).findingStates = { [ref]: { kind: 'review', state: o.state, history: [{ at: 'T', by: 'person', from: 'open', to: o.state, revision: 'bbbbbbb' }] } }
  return s
}
const place = (s: OrchState, o: Partial<Parameters<typeof diffFindings>[1]> = {}) =>
  diffFindings(s, { taskIds: ['t1'], path: 'src/a.ts', repo: 'F:\\Proj', head: 'bbbbbbb', diff: DIFF, truncated: false, platform: 'win32', ...o })

describe('diffFindings', () => {
  it('places a finding on its line when the diff is of the reviewed head and its hunk is there, even moved', () => {
    const [f] = place(stateWith({ state: 'repair-requested' }))
    expect(f).toMatchObject({ taskId: 't1', title: 'b is wrong', severity: 'high', line: 2, state: 'repair-requested', head: 'bbbbbbb', placement: { line: 2 } })
    // The words a repair request carries, as the Problems rows give them (taskFindings)
    expect(f.text).toBe('error src/a.ts:2 Review: b is wrong')
    expect(f.history).toHaveLength(1)
    const moved = HEADER + '@@ -1,2 +5,3 @@\n const a = 1\n+const b = 2\n const c = 3\n'
    expect(place(stateWith({ anchor: { line: 6 } }), { diff: moved })[0].placement).toEqual({ line: 6 })
  })

  it('lists a finding anchored to a head that was rebased away as found on another revision', () => {
    const [f] = place(stateWith(), { head: 'ccccccc' })
    expect(f.placement).toBe('other-revision')
    expect(f.state).toBe('open')
    expect(place(stateWith(), { head: null })[0].placement).toBe('other-revision')
  })

  it('lists a finding on the file when its hunk is past a truncated cut, or it has no anchor or no hunk', () => {
    expect(place(stateWith(), { diff: HEADER + '@@ -1,2 +1,3 @@\n const a = 1\n', truncated: true })[0].placement).toBe('file')
    expect(place(stateWith({ anchor: null }))[0].placement).toBe('file')
    expect(place(stateWith({ anchor: { hunk: undefined } }))[0].placement).toBe('file')
  })

  it('matches an issue’s file written with backslashes or another case to the diff’s path on win32', () => {
    expect(place(stateWith({ issueFile: 'Src\\A.ts' }))).toHaveLength(1)
    expect(place(stateWith({ issueFile: 'F:\\proj\\src\\a.ts' }))).toHaveLength(1)
    expect(place(stateWith({ issueFile: 'src/other.ts' }))).toHaveLength(0)
  })

  it('keeps findings of Tasks outside the scope out', () => {
    const s = stateWith({ otherTask: true })
    expect(place(s).map((f) => f.taskId)).toEqual(['t1'])
    expect(place(s, { taskIds: ['t1', 't2'] }).map((f) => f.taskId)).toEqual(['t1', 't2'])
  })
})
