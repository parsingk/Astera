import { describe, it, expect, vi } from 'vitest'
import type { OrchState } from '../core/orchestration/state'
import type { ChangedFile } from '../core/git/changedFile'
import { parseHunks } from '../core/git/hunks'
import { findingRef } from '../core/problems/findingRef'
import { taskFoldersOf } from '../core/problems/completionProblems'
import { createFindingAnchorRecorder } from './findingAnchors'

// Phase 3 Part 4: the Host anchors each review finding to the head its review began at and the hunk holding its line
const DIFF = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n const a = 1\n+const b = 2\n const c = 3\n'
const A: ChangedFile = { id: 'fa', path: 'src/a.ts', status: 'modified' }

function stateWith(o: { reviewBase?: string; reviewId?: string; issues?: Array<{ id: string; title: string; file?: string; line?: number }>; anchors?: Record<string, unknown> } = {}): OrchState {
  return {
    jobs: [{ id: 'job1', cwd: 'P' }],
    runs: [{ id: 'run1', jobId: 'job1' }],
    tasks: [
      {
        id: 't1',
        runId: 'run1',
        jobId: 'job1',
        reviewIssues: (o.issues ?? [{ id: 'i1', title: 'b is wrong', file: 'src/a.ts', line: 2 }]).map((i) => ({ severity: 'high', blocking: true, description: '', ...i })),
        ...(o.anchors ? { findingAnchors: o.anchors } : {})
      }
    ],
    dispatches: [
      { id: 'd1', taskId: 't1', cwd: 'P', startedAt: '2026-11-27T10:00:00.000Z', endedAt: '2026-11-27T10:10:00.000Z', git: { base: 'aaaaaaa', head: 'bbbbbbb' } },
      {
        id: o.reviewId ?? 'r1',
        taskId: 't1',
        review: true,
        cwd: 'P',
        startedAt: '2026-11-27T10:12:00.000Z',
        endedAt: '2026-11-27T10:15:00.000Z',
        ...(o.reviewBase !== undefined ? { git: { base: o.reviewBase } } : {})
      }
    ]
  } as unknown as OrchState
}
const refOf = (s: OrchState, title: string, file: string): string => findingRef({ kind: 'review', taskId: 't1', file, base: taskFoldersOf(s, s.tasks[0]), message: title })

function rig(o: { read?: ChangedFile[] | null; diff?: string | null } = {}) {
  const records: Array<{ task: string; anchors: Record<string, Record<string, unknown>> }> = []
  const reads: string[] = []
  const r = createFindingAnchorRecorder({
    record: async (a) => void records.push(a as never),
    read: async (repo, base, head) => {
      reads.push(`${repo} ${base}..${head}`)
      return o.read === undefined ? [A] : o.read
    },
    diff: async () => (o.diff === undefined ? { diff: DIFF, truncated: false } : o.diff === null ? null : { diff: o.diff, truncated: false }),
    log: () => {}
  })
  return { r, records, reads }
}

describe('createFindingAnchorRecorder', () => {
  it('anchors each review finding to the head its review began at, with the fingerprint of its hunk', async () => {
    const { r, records, reads } = rig()
    const s = stateWith({ reviewBase: 'bbbbbbb' })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(reads).toEqual(['P aaaaaaa..bbbbbbb'])
    expect(records[0]).toEqual({
      task: 't1',
      anchors: { [refOf(s, 'b is wrong', 'src/a.ts')]: { review: 'r1', head: 'bbbbbbb', file: 'src/a.ts', line: 2, hunk: parseHunks(DIFF)[0].fingerprint } }
    })
  })

  it('waits for the review attempt’s base, and gives no hunk to a line outside every committed hunk', async () => {
    const { r, records } = rig()
    r.onState(stateWith({ issues: [{ id: 'i1', title: 'far away', file: 'src/a.ts', line: 40 }] }))
    await new Promise((res) => setTimeout(res, 30))
    expect(records).toHaveLength(0)
    const s = stateWith({ reviewBase: 'bbbbbbb', issues: [{ id: 'i1', title: 'far away', file: 'src/a.ts', line: 40 }] })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(records[0].anchors[refOf(s, 'far away', 'src/a.ts')]).toEqual({ review: 'r1', head: 'bbbbbbb', file: 'src/a.ts', line: 40 })
  })

  it('anchors again when a new review round finds the same finding, and once per round', async () => {
    const { r, records } = rig()
    const s = stateWith({ reviewBase: 'bbbbbbb' })
    r.onState(s)
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    const ref = refOf(s, 'b is wrong', 'src/a.ts')
    // The Host's write lands: the same round is not read again
    const recorded = stateWith({ reviewBase: 'bbbbbbb', anchors: { [ref]: { review: 'r1', head: 'bbbbbbb', file: 'src/a.ts', at: 'x' } } })
    r.onState(recorded)
    await new Promise((res) => setTimeout(res, 30))
    expect(records).toHaveLength(1)
    r.onState(stateWith({ reviewBase: 'ccccccc', reviewId: 'r2', anchors: { [ref]: { review: 'r1', head: 'bbbbbbb', file: 'src/a.ts', at: 'x' } } }))
    await vi.waitFor(() => expect(records).toHaveLength(2))
    expect(records[1].anchors[ref]).toMatchObject({ review: 'r2', head: 'ccccccc' })
  })

  it('records the head alone when git cannot read the range', async () => {
    const { r, records } = rig({ read: null })
    const s = stateWith({ reviewBase: 'bbbbbbb' })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(records[0].anchors[refOf(s, 'b is wrong', 'src/a.ts')]).toEqual({ review: 'r1', head: 'bbbbbbb', file: 'src/a.ts', line: 2 })
  })

  it('reads no range when the review began where the work started, and finds a file written with backslashes', async () => {
    const { r, records, reads } = rig()
    const s = stateWith({ reviewBase: 'aaaaaaa', issues: [{ id: 'i1', title: 't', file: 'src\\a.ts', line: 2 }] })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(reads).toEqual([])
    const moved = rig()
    const s2 = stateWith({ reviewBase: 'bbbbbbb', issues: [{ id: 'i1', title: 't', file: 'src\\a.ts', line: 2 }] })
    moved.r.onState(s2)
    await vi.waitFor(() => expect(moved.records).toHaveLength(1))
    expect(moved.records[0].anchors[refOf(s2, 't', 'src\\a.ts')].hunk).toBe(parseHunks(DIFF)[0].fingerprint)
  })
})
