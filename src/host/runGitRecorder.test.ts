// The Host records the git range each Run and each attempt worked over (remote runtime design Phase 10), as the state
// moves and around every merge, since nothing can rebuild it once a merge reaps the worktree.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRunGitRecorder } from './runGitRecorder'
import type { OrchState } from '../core/orchestration/state'

type Rec = Record<string, unknown>

function rig(o: { heads?: Record<string, string>; bases?: Record<string, string>; dirs?: string[]; baseRefs?: Record<string, string> } = {}) {
  const records: Rec[] = []
  const reads: string[] = []
  const heads = { ...o.heads }
  const rec = createRunGitRecorder({
    record: async (args) => void records.push(args),
    headOf: async (cwd) => {
      reads.push(`head ${cwd}`)
      return heads[cwd] ?? null
    },
    mergeBase: async (cwd, ref) => {
      reads.push(`merge-base ${cwd} ${ref}`)
      return o.bases?.[`${cwd} ${ref}`] ?? null
    },
    baseRefOf: (p) => o.baseRefs?.[p] ?? null,
    isDir: (p) => (o.dirs ?? []).includes(p),
    log: () => {}
  })
  return { rec, records, reads, heads }
}

const state = (over: { runs?: Rec[]; dispatches?: Rec[] }): OrchState =>
  ({
    jobs: [{ id: 'job1', cwd: 'P' }],
    runs: over.runs ?? [],
    tasks: [{ id: 't1', runId: 'run1' }],
    dispatches: over.dispatches ?? []
  }) as unknown as OrchState

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe('createRunGitRecorder', () => {
  it('a Run in its own worktree starts where that worktree forked from its base', async () => {
    const r = rig({ baseRefs: { W: 'main' }, bases: { 'W main': 'fork1' }, dirs: ['W'] })
    r.rec.onState(state({ runs: [{ id: 'run1', jobId: 'job1', worktree: 'W' }] }))
    await settle()
    expect(r.records).toEqual([{ runId: 'run1', base: 'fork1' }])
  })

  it('a Run in the project folder starts at its HEAD once it has an attempt', async () => {
    const r = rig({ heads: { P: 'p1' }, dirs: ['P'] })
    r.rec.onState(state({ runs: [{ id: 'run1', jobId: 'job1' }] }))
    await settle()
    expect(r.records).toEqual([])
    r.rec.onState(
      state({ runs: [{ id: 'run1', jobId: 'job1' }], dispatches: [{ id: 'd1', taskId: 't1', cwd: 'P', startedAt: '1', git: { base: 'x' } }] })
    )
    await settle()
    expect(r.records).toEqual([{ runId: 'run1', base: 'p1' }])
  })

  it('an attempt records its base when it starts and its head when it ends, with its Run’s head', async () => {
    const r = rig({ heads: { D: 'd0', W: 'w0' }, dirs: ['D', 'W'] })
    const run = { id: 'run1', jobId: 'job1', worktree: 'W', git: { base: 'b' } }
    r.rec.onState(state({ runs: [run], dispatches: [{ id: 'd1', taskId: 't1', cwd: 'D' }] }))
    await settle()
    expect(r.records).toEqual([{ dispatchId: 'd1', base: 'd0' }])
    r.heads.D = 'd1'
    r.heads.W = 'w1'
    r.rec.onState(state({ runs: [run], dispatches: [{ id: 'd1', taskId: 't1', cwd: 'D', git: { base: 'd0' }, endedAt: 'x' }] }))
    await settle()
    expect(r.records.slice(1)).toEqual([
      { runId: 'run1', head: 'w1' },
      { dispatchId: 'd1', head: 'd1' }
    ])
  })

  it('reads each thing once, even when the state moves again before the answer', async () => {
    const r = rig({ heads: { D: 'd0' }, dirs: ['D'] })
    const s = state({ runs: [{ id: 'run1', jobId: 'job1', git: { base: 'b' } }], dispatches: [{ id: 'd1', taskId: 't1', cwd: 'D' }] })
    r.rec.onState(s)
    r.rec.onState(s)
    await settle()
    r.rec.onState(s)
    await settle()
    expect(r.reads.filter((x) => x === 'head D')).toEqual(['head D'])
  })

  it('a merge records a Run’s head from its worktree before it, and a Run root’s head after it', async () => {
    const r = rig({ heads: { W: 'tip', R: 'root0' }, dirs: ['W', 'R'] })
    r.rec.onState(
      state({
        runs: [
          { id: 'run1', jobId: 'job1', worktree: 'W', git: { base: 'b' } },
          { id: 'run2', jobId: 'job1', worktree: 'R', git: { base: 'b2' } }
        ]
      })
    )
    await settle()
    r.records.length = 0
    await r.rec.beforeIntegrate('P', ['W'])
    r.heads.R = 'root1'
    await r.rec.afterIntegrate('R')
    expect(r.records).toEqual([
      { runId: 'run1', head: 'tip' },
      { runId: 'run2', head: 'root1' }
    ])
  })

  it('a git that cannot answer records nothing and throws nothing', async () => {
    const r = rig({ dirs: ['W'] })
    r.rec.onState(state({ runs: [{ id: 'run1', jobId: 'job1', worktree: 'W' }] }))
    await settle()
    await r.rec.beforeIntegrate('P', ['W'])
    expect(r.records).toEqual([])
  })
})

// Phase 10 review I1: work from before this phase is not given today's HEAD as its range, a read that failed is tried
// again, and a state full of attempts does not start every git at once.
describe('createRunGitRecorder with work it did not see start', () => {
  it('records no base for an attempt that already ended, and no head for one without a base', async () => {
    const r = rig({ heads: { D: 'd0', P: 'p0' }, dirs: ['D', 'P'] })
    r.rec.onState(
      state({
        runs: [{ id: 'run1', jobId: 'job1' }],
        dispatches: [{ id: 'd1', taskId: 't1', cwd: 'D', startedAt: '1', endedAt: 'x' }]
      })
    )
    await settle()
    expect(r.records).toEqual([])
    expect(r.reads).toEqual([])
  })
  it('a Run in its own worktree with no attempt open gets a base only from where it forked', async () => {
    const r = rig({ heads: { W: 'w0' }, dirs: ['W'] })
    r.rec.onState(state({ runs: [{ id: 'run1', jobId: 'job1', worktree: 'W' }] }))
    await settle()
    expect(r.records).toEqual([])
  })
  it('a read that failed is tried again on a later state', async () => {
    const r = rig({ dirs: ['D'] })
    const s = state({ runs: [{ id: 'run1', jobId: 'job1', git: { base: 'b' } }], dispatches: [{ id: 'd1', taskId: 't1', cwd: 'D', startedAt: '1' }] })
    r.rec.onState(s)
    await settle()
    expect(r.records).toEqual([])
    r.heads.D = 'd0'
    r.rec.onState(s)
    await settle()
    expect(r.records).toEqual([{ dispatchId: 'd1', base: 'd0' }])
  })
  it('runs at most a few git reads at once', async () => {
    let inFlight = 0
    let most = 0
    const records: unknown[] = []
    const rec = createRunGitRecorder({
      record: async (a) => void records.push(a),
      headOf: async () => {
        inFlight++
        most = Math.max(most, inFlight)
        await new Promise((res) => setTimeout(res, 5))
        inFlight--
        return 'h0'
      },
      mergeBase: async () => null,
      baseRefOf: () => null,
      isDir: () => true,
      log: () => {}
    })
    const dispatches = Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, taskId: 't1', cwd: `D${i}`, startedAt: '1' }))
    rec.onState(state({ runs: [{ id: 'run1', jobId: 'job1', git: { base: 'b' } }], dispatches }))
    await new Promise((res) => setTimeout(res, 200))
    expect(records.length).toBe(12)
    expect(most).toBeLessThanOrEqual(4)
  })
})

describe('the Host wires the recorder', () => {
  const read = (f: string): string => readFileSync(path.join(__dirname, f), 'utf8')
  it('feeds it every committed state and records through the Host’s own runs-git-record', () => {
    const index = read('index.ts')
    expect(index).toMatch(/onState: \(state, version\) => \{[\s\S]{0,200}?runGit\?\.onState\(state\)/)
    expect(index).toContain("record: (args) => orch.handle('runs-git-record', args)")
    expect(index).toContain('integrateHooks: () => runGit')
  })
  it('the one merge path tells it before and after', () => {
    const wt = read('worktrees.ts')
    const merge = wt.slice(wt.indexOf('const integrateInto = async'), wt.indexOf('return result', wt.indexOf('const integrateInto = async')))
    expect(merge.indexOf('beforeIntegrate')).toBeGreaterThan(-1)
    expect(merge.indexOf('beforeIntegrate')).toBeLessThan(merge.indexOf('integrateWorktrees('))
    expect(merge.indexOf('afterIntegrate')).toBeGreaterThan(merge.indexOf('integrateWorktrees('))
  })
})
