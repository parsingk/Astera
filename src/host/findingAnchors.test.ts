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
const FP = parseHunks(DIFF)[0].fingerprint

type Issue = { id: string; title: string; file?: string; line?: number }
type Review = { id: string; base?: string; start: string; end?: string }

function stateWith(o: { reviews?: Review[]; reviewBase?: string; reviewId?: string; issues?: Issue[]; anchors?: Record<string, unknown>; cwd?: string } = {}): OrchState {
  const cwd = o.cwd ?? 'P'
  const reviews: Review[] = o.reviews ?? [{ id: o.reviewId ?? 'r1', ...(o.reviewBase !== undefined ? { base: o.reviewBase } : {}), start: '10:12', end: '10:15' }]
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
      { id: 'd1', taskId: 't1', cwd, startedAt: '2026-11-27T10:00:00.000Z', endedAt: '2026-11-27T10:10:00.000Z', git: { base: 'aaaaaaa', head: 'bbbbbbb' } },
      ...reviews.map((r) => ({
        id: r.id,
        taskId: 't1',
        review: true,
        cwd,
        startedAt: `2026-11-27T${r.start}:00.000Z`,
        ...(r.end !== undefined ? { endedAt: `2026-11-27T${r.end}:00.000Z` } : {}),
        ...(r.base !== undefined ? { git: { base: r.base } } : {})
      }))
    ]
  } as unknown as OrchState
}
const refOf = (s: OrchState, title: string, file: string): string => findingRef({ kind: 'review', taskId: 't1', file, base: taskFoldersOf(s, s.tasks[0]), message: title })

function rig(o: { read?: Record<string, ChangedFile[] | null>; diff?: string | null; truncated?: boolean; reply?: unknown; throws?: boolean; clock?: { now: number } } = {}) {
  const records: Array<{ task: string; anchors: Record<string, Record<string, unknown>> }> = []
  const reads: string[] = []
  const logs: string[] = []
  const r = createFindingAnchorRecorder({
    record: async (a) => {
      records.push(a as never)
      if (o.throws) throw new Error('the Host is busy')
      return o.reply ?? { status: 200, body: {} }
    },
    read: async (repo, base, head) => {
      reads.push(`${repo} ${base}..${head}`)
      if (o.read === undefined) return [A]
      return o.read[repo] ?? null
    },
    diff: async () => (o.diff === null ? null : { diff: o.diff ?? DIFF, truncated: o.truncated === true }),
    log: (m) => void logs.push(m),
    ...(o.clock ? { now: () => o.clock!.now } : {})
  })
  return { r, records, reads, logs }
}
const settle = (): Promise<void> => new Promise((res) => setTimeout(res, 30))

describe('createFindingAnchorRecorder', () => {
  it('anchors each review finding to the head its review began at, with its issue and the fingerprint of its hunk', async () => {
    const { r, records, reads } = rig()
    const s = stateWith({ reviewBase: 'bbbbbbb' })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(reads).toEqual(['P aaaaaaa..bbbbbbb'])
    expect(records[0]).toEqual({
      task: 't1',
      anchors: { [refOf(s, 'b is wrong', 'src/a.ts')]: { review: 'r1', issue: 'i1', head: 'bbbbbbb', file: 'src/a.ts', line: 2, hunk: FP } }
    })
  })

  it('waits for the review attempt’s base, and gives no hunk to a line outside every committed hunk', async () => {
    const { r, records } = rig()
    r.onState(stateWith({ issues: [{ id: 'i1', title: 'far away', file: 'src/a.ts', line: 40 }] }))
    await settle()
    expect(records).toHaveLength(0)
    const s = stateWith({ reviewBase: 'bbbbbbb', issues: [{ id: 'i1', title: 'far away', file: 'src/a.ts', line: 40 }] })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(records[0].anchors[refOf(s, 'far away', 'src/a.ts')]).toEqual({ review: 'r1', issue: 'i1', head: 'bbbbbbb', file: 'src/a.ts', line: 40 })
  })

  it('anchors again when a new round finds the same finding under a new issue, and once per round', async () => {
    const { r, records } = rig()
    const s = stateWith({ reviewBase: 'bbbbbbb' })
    r.onState(s)
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    const ref = refOf(s, 'b is wrong', 'src/a.ts')
    const anchored = { [ref]: { review: 'r1', issue: 'i1', head: 'bbbbbbb', file: 'src/a.ts', at: 'x' } }
    r.onState(stateWith({ reviewBase: 'bbbbbbb', anchors: anchored }))
    await settle()
    expect(records).toHaveLength(1)
    r.onState(stateWith({ reviews: [{ id: 'r1', base: 'bbbbbbb', start: '10:12', end: '10:15' }, { id: 'r2', base: 'ccccccc', start: '10:40', end: '10:45' }], issues: [{ id: 'i2', title: 'b is wrong', file: 'src/a.ts', line: 2 }], anchors: anchored }))
    await vi.waitFor(() => expect(records).toHaveLength(2))
    expect(records[1].anchors[ref]).toMatchObject({ review: 'r2', issue: 'i2', head: 'ccccccc' })
  })

  // Final review I2: a review that ends with no verdict leaves the last round's issues; they keep their anchors
  it('leaves a round’s anchors alone when a later review ends without new issues', async () => {
    const { r, records } = rig()
    const s0 = stateWith({ reviewBase: 'bbbbbbb' })
    const ref = refOf(s0, 'b is wrong', 'src/a.ts')
    const anchored = { [ref]: { review: 'r1', issue: 'i1', head: 'bbbbbbb', file: 'src/a.ts', line: 2, hunk: FP, at: 'x' } }
    r.onState(stateWith({ reviews: [{ id: 'r1', base: 'bbbbbbb', start: '10:12', end: '10:15' }, { id: 'r2', base: 'ccccccc', start: '10:40', end: '10:45' }], anchors: anchored }))
    await settle()
    expect(records).toHaveLength(0)
  })

  // Final review I2: the newest review's head, not an older review's, even while the newest one's base is not recorded
  it('waits for the newest review’s base rather than anchoring new issues to an older review', async () => {
    const { r, records } = rig()
    const reviews: Review[] = [{ id: 'r1', base: 'bbbbbbb', start: '10:12', end: '10:15' }, { id: 'r2', start: '10:40', end: '10:45' }]
    r.onState(stateWith({ reviews, issues: [{ id: 'i2', title: 'new', file: 'src/a.ts', line: 2 }] }))
    await settle()
    expect(records).toHaveLength(0)
    reviews[1].base = 'ccccccc'
    r.onState(stateWith({ reviews, issues: [{ id: 'i2', title: 'new', file: 'src/a.ts', line: 2 }] }))
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(Object.values(records[0].anchors)[0]).toMatchObject({ review: 'r2', head: 'ccccccc' })
  })

  // Final review I3: a line that is not a positive line goes without one, and a refused write is said, not taken as done
  it('records no line that is not a positive line, and says when the Host refuses the write', async () => {
    const zero = rig()
    const s = stateWith({ reviewBase: 'bbbbbbb', issues: [{ id: 'i1', title: 'file level', file: 'src/a.ts', line: 0 }] })
    zero.r.onState(s)
    await vi.waitFor(() => expect(zero.records).toHaveLength(1))
    expect(zero.records[0].anchors[refOf(s, 'file level', 'src/a.ts')]).toEqual({ review: 'r1', issue: 'i1', head: 'bbbbbbb', file: 'src/a.ts' })
    const refused = rig({ reply: { status: 400, body: { error: 'bad anchor' } } })
    refused.r.onState(stateWith({ reviewBase: 'bbbbbbb' }))
    await vi.waitFor(() => expect(refused.logs.some((l) => /refused/.test(l) && /bad anchor/.test(l))).toBe(true))
    refused.r.onState(stateWith({ reviewBase: 'bbbbbbb' }))
    await settle()
    expect(refused.records).toHaveLength(1)
  })

  it('records the head alone when git cannot read the range', async () => {
    const { r, records } = rig({ read: {} })
    const s = stateWith({ reviewBase: 'bbbbbbb' })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(records[0].anchors[refOf(s, 'b is wrong', 'src/a.ts')]).toEqual({ review: 'r1', issue: 'i1', head: 'bbbbbbb', file: 'src/a.ts', line: 2 })
  })

  // Final review I1: the review's worktree reaped by a merge, the range is read in the project folder
  it('reads the range in the project folder when the review’s folder is gone', async () => {
    const { r, records, reads } = rig({ read: { P: [A] } })
    const s = stateWith({ reviewBase: 'bbbbbbb', cwd: 'W' })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(reads).toEqual(['W aaaaaaa..bbbbbbb', 'P aaaaaaa..bbbbbbb'])
    expect(records[0].anchors[refOf(s, 'b is wrong', 'src/a.ts')].hunk).toBe(FP)
  })

  // Final review M1: a cut diff names no real hunk
  it('gives no hunk when the diff was cut at its byte bound', async () => {
    const { r, records } = rig({ truncated: true })
    const s = stateWith({ reviewBase: 'bbbbbbb' })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(records[0].anchors[refOf(s, 'b is wrong', 'src/a.ts')].hunk).toBeUndefined()
  })

  // Final review M13: a project in a subfolder of its repository names files from the folder
  it('finds a subfolder project’s file by its one ending in the repository', async () => {
    const { r, records } = rig({ read: { P: [{ id: 'fa', path: 'pkg/src/a.ts', status: 'modified' }] } })
    const s = stateWith({ reviewBase: 'bbbbbbb' })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    expect(records[0].anchors[refOf(s, 'b is wrong', 'src/a.ts')].hunk).toBe(FP)
  })

  // Final review M12: a write that throws is tried again after a wait, not on every commit
  it('tries a failed write again after a wait, not on the next commit', async () => {
    const clock = { now: 0 }
    const { r, records, reads } = rig({ throws: true, clock })
    const s = stateWith({ reviewBase: 'bbbbbbb' })
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(1))
    await settle()
    r.onState(s)
    await settle()
    expect(reads).toHaveLength(1)
    clock.now = 61_000
    r.onState(s)
    await vi.waitFor(() => expect(records).toHaveLength(2))
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
    expect(moved.records[0].anchors[refOf(s2, 't', 'src\\a.ts')].hunk).toBe(FP)
  })
})
