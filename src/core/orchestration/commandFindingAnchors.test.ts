// `tasks-anchors-record`, the Host's own write of where each review finding was made (Phase 3 Part 4): the head the
// review began at and the fingerprint of the hunk holding its line. Only the Host calls it: anyone else could move a
// finding onto another line.
import { describe, it, expect } from 'vitest'
import { handleCommand, type OrchServerDeps } from './command'
import { emptyState, type OrchState } from './state'
import { HOST_CALLER } from '../host/driver'
import { TASK_FINDING_ANCHORS_MAX, type FindingAnchor } from './types'

const NOW = '2026-11-27T12:00:00.000Z'
const REF = 'review:t1:aaaaaaaaaaaa'

const makeDeps = (anchors?: Record<string, FindingAnchor>): OrchServerDeps => {
  const box = {
    state: { ...emptyState(), tasks: [{ id: 't1', runId: 'run1', status: 'failed', ...(anchors ? { findingAnchors: anchors } : {}) }] } as unknown as OrchState
  }
  return {
    getState: () => box.state,
    setState: async (next: OrchState) => void (box.state = next),
    now: () => NOW
  } as unknown as OrchServerDeps
}
const host = (deps: OrchServerDeps, args: Record<string, unknown>) => handleCommand(deps, { sessionId: HOST_CALLER }, 'tasks-anchors-record', args)
const anchorsOf = (deps: OrchServerDeps): Record<string, FindingAnchor> | undefined => deps.getState().tasks[0].findingAnchors

describe('tasks-anchors-record', () => {
  it('records each finding’s anchor on its Task, merged by its reference', async () => {
    const deps = makeDeps()
    const first = { review: 'r1', issue: 'i1', head: 'abcdef1', file: 'src/a.ts', line: 3, hunk: '0123abcd' }
    expect((await host(deps, { task: 't1', anchors: { [REF]: first } })).status).toBe(200)
    expect(anchorsOf(deps)).toEqual({ [REF]: { ...first, at: NOW } })
    expect((await host(deps, { task: 't1', anchors: { 'review:t1:bbbbbbbbbbbb': { review: 'r1', issue: 'i2', head: 'abcdef1', file: 'src/b.ts' } } })).status).toBe(200)
    expect(Object.keys(anchorsOf(deps) ?? {})).toEqual([REF, 'review:t1:bbbbbbbbbbbb'])
  })

  it('keeps at most 100 anchors on a Task, the newest', async () => {
    const old: Record<string, FindingAnchor> = {}
    for (let i = 0; i < TASK_FINDING_ANCHORS_MAX; i++) old[`review:t1:${String(i).padStart(12, '0')}`] = { review: 'r0', issue: 'i0', head: 'abcdef1', file: 'a.ts', at: `2026-11-26T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` }
    const deps = makeDeps(old)
    expect((await host(deps, { task: 't1', anchors: { [REF]: { review: 'r1', issue: 'i1', head: 'abcdef1', file: 'src/a.ts' } } })).status).toBe(200)
    const kept = anchorsOf(deps) ?? {}
    expect(Object.keys(kept)).toHaveLength(TASK_FINDING_ANCHORS_MAX)
    expect(kept[REF]).toBeDefined()
    expect(kept['review:t1:000000000000']).toBeUndefined()
  })

  it('refuses tasks-anchors-record from anyone but the Host, and malformed anchors', async () => {
    const deps = makeDeps()
    const good = { review: 'r1', issue: 'i1', head: 'abcdef1', file: 'src/a.ts' }
    for (const sessionId of ['', 'sess-worker', 'astera:app'])
      expect((await handleCommand(deps, { sessionId }, 'tasks-anchors-record', { task: 't1', anchors: { [REF]: good } })).status).toBe(403)
    expect((await host(deps, { task: 'nope', anchors: { [REF]: good } })).status).toBe(404)
    for (const bad of [
      { ...good, head: 'zzz' },
      { ...good, hunk: 'not-hex!' },
      { ...good, line: 0 },
      { ...good, line: 1.5 },
      { ...good, file: '' },
      { ...good, file: 'x'.repeat(1025) },
      { ...good, review: '' },
      { ...good, issue: '' }
    ])
      expect((await host(deps, { task: 't1', anchors: { [REF]: bad } })).status, JSON.stringify(bad).slice(0, 60)).toBe(400)
    expect((await host(deps, { task: 't1', anchors: 'x' })).status).toBe(400)
    expect(anchorsOf(deps)).toBeUndefined()
  })
})
