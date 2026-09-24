import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { explainedByHostMerges, MERGE_OPEN_MAX_MS, parseHostMerges, readHostMerges, type HostMergeRecord } from './hostMerges'

describe('parseHostMerges', () => {
  it('drops entries that are not records, and never throws', () => {
    const good = { id: 'm1', projectPath: 'p', headBefore: 'a', startedAt: '2026-09-24T10:00:00.000Z' }
    expect(parseHostMerges(JSON.stringify({ merges: [good, { id: 3 }, null] }))).toEqual([good])
    expect(parseHostMerges('{ nope')).toEqual([])
    expect(parseHostMerges('[]')).toEqual([])
  })
})
describe('readHostMerges', () => {
  it('answers [] for a file that is not there', async () => {
    expect(await readHostMerges(path.join(os.tmpdir(), 'astera-no-such-dir', 'merges.json'))).toEqual([])
  })
})

const same = (a: string, b: string): boolean => a === b
const rec = (o: Partial<HostMergeRecord>): HostMergeRecord => ({ id: 'm', projectPath: 'P', headBefore: 'a', headAfter: 'b', startedAt: '2026-09-24T10:00:00.000Z', endedAt: '2026-09-24T10:00:01.000Z', ...o })
const now = Date.parse('2026-09-24T12:00:00.000Z')
/** Defaults `sameBranch`/`sinceMs`/`nowMs`/`samePath` so each test states only what it means to vary —
 *  most tests are about the chain or the open-record rule, not the branch or the snapshot bound. */
const explain = (o: {
  projectPath: string
  fromHead: string | null
  toHead: string | null
  records: HostMergeRecord[]
  nowMs?: number
  sameBranch?: boolean
  sinceMs?: number
}): boolean =>
  explainedByHostMerges({ nowMs: now, sameBranch: true, sinceMs: 0, samePath: same, ...o })

describe('explainedByHostMerges', () => {
  it('a chain of completed records from the stored head to the new head explains the move', () => {
    const records = [rec({ id: 'm1', headBefore: 'a', headAfter: 'b' }), rec({ id: 'm2', headBefore: 'b', headAfter: 'c' })]
    expect(explain({ projectPath: 'P', fromHead: 'a', toHead: 'c', records })).toBe(true)
  })
  it('a gap in the chain (a commit of somebody else in between) does not', () => {
    const records = [rec({ headBefore: 'a', headAfter: 'b' }), rec({ headBefore: 'x', headAfter: 'c' })]
    expect(explain({ projectPath: 'P', fromHead: 'a', toHead: 'c', records })).toBe(false)
  })
  it('records of another folder do not count', () => {
    expect(explain({ projectPath: 'Q', fromHead: 'a', toHead: 'b', records: [rec({})] })).toBe(false)
  })
  it('a record still open and young enough explains any move of its folder (an app that attached mid-merge)', () => {
    const open = rec({ headAfter: undefined, endedAt: undefined, startedAt: new Date(now - 1_000).toISOString() })
    expect(explain({ projectPath: 'P', fromHead: 'z', toHead: 'y', records: [open] })).toBe(true)
  })
  it('an open record older than MERGE_OPEN_MAX_MS explains nothing (a Host that died mid-merge)', () => {
    const stale = rec({ headAfter: undefined, endedAt: undefined, startedAt: new Date(now - MERGE_OPEN_MAX_MS - 1).toISOString() })
    expect(explain({ projectPath: 'P', fromHead: 'z', toHead: 'y', records: [stale] })).toBe(false)
  })
  it('no head to start from explains nothing', () => {
    expect(explain({ projectPath: 'P', fromHead: null, toHead: 'b', records: [rec({})] })).toBe(false)
  })

  // ── fix round 1 (review I1/m1/m3/m4) ──────────────────────────────────

  it('an open record whose startedAt is in the future explains nothing — a clock set back must not swallow every move (m3)', () => {
    const future = rec({ headAfter: undefined, endedAt: undefined, startedAt: new Date(now + 1_000).toISOString() })
    expect(explain({ projectPath: 'P', fromHead: 'z', toHead: 'y', records: [future] })).toBe(false)
  })

  it('a same-head branch switch is not explained away by an aborted or no-op merge\'s a→a record (I1)', () => {
    // git checkout -b (or any switch onto a) after a merge that landed back where it started —
    // classifyTransition calls this a branch-switch, not a "none", because the branch differs.
    const records = [rec({ headBefore: 'a', headAfter: 'a' })]
    expect(explain({ projectPath: 'P', fromHead: 'a', toHead: 'a', records, sameBranch: false })).toBe(false)
  })

  it('a completed record the app already caught up past cannot explain a later, unrelated move back to the same heads (redo, or another branch reaching a head the Host once produced) (I1)', () => {
    const records = [rec({ headBefore: 'a', headAfter: 'b', endedAt: '2026-09-24T09:00:00.000Z' })]
    // sinceMs is the stored snapshot's own capturedAt — here, after the record ended, so the app had
    // already moved past headAfter='b' before this new a→b move was even seen.
    expect(explain({ projectPath: 'P', fromHead: 'a', toHead: 'b', records, sinceMs: Date.parse('2026-09-24T10:00:00.000Z') })).toBe(false)
  })

  it('a failed merge (a null headAfter) does not hide a later successful record to the same target (m1)', () => {
    const records = [
      rec({ id: 'm1', headBefore: 'a', headAfter: null, endedAt: '2026-09-24T10:00:00.000Z' }),
      rec({ id: 'm2', headBefore: 'a', headAfter: 'c', endedAt: '2026-09-24T10:00:02.000Z' })
    ]
    expect(explain({ projectPath: 'P', fromHead: 'a', toHead: 'c', records })).toBe(true)
  })

  it('a failed merge alone (a null headAfter, nothing else to reach the target) explains nothing (m4)', () => {
    const records = [rec({ headBefore: 'a', headAfter: null })]
    expect(explain({ projectPath: 'P', fromHead: 'a', toHead: 'c', records })).toBe(false)
  })

  it('a cycle in the records terminates instead of looping forever (m4)', () => {
    const records = [rec({ id: 'm1', headBefore: 'a', headAfter: 'b' }), rec({ id: 'm2', headBefore: 'b', headAfter: 'a' })]
    expect(explain({ projectPath: 'P', fromHead: 'a', toHead: 'c', records })).toBe(false)
  })
})
