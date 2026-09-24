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
describe('explainedByHostMerges', () => {
  it('a chain of completed records from the stored head to the new head explains the move', () => {
    const records = [rec({ id: 'm1', headBefore: 'a', headAfter: 'b' }), rec({ id: 'm2', headBefore: 'b', headAfter: 'c' })]
    expect(explainedByHostMerges({ projectPath: 'P', fromHead: 'a', toHead: 'c', records, nowMs: now, samePath: same })).toBe(true)
  })
  it('a gap in the chain (a commit of somebody else in between) does not', () => {
    const records = [rec({ headBefore: 'a', headAfter: 'b' }), rec({ headBefore: 'x', headAfter: 'c' })]
    expect(explainedByHostMerges({ projectPath: 'P', fromHead: 'a', toHead: 'c', records, nowMs: now, samePath: same })).toBe(false)
  })
  it('records of another folder do not count', () => {
    expect(explainedByHostMerges({ projectPath: 'Q', fromHead: 'a', toHead: 'b', records: [rec({})], nowMs: now, samePath: same })).toBe(false)
  })
  it('a record still open and young enough explains any move of its folder (an app that attached mid-merge)', () => {
    const open = rec({ headAfter: undefined, endedAt: undefined, startedAt: new Date(now - 1_000).toISOString() })
    expect(explainedByHostMerges({ projectPath: 'P', fromHead: 'z', toHead: 'y', records: [open], nowMs: now, samePath: same })).toBe(true)
  })
  it('an open record older than MERGE_OPEN_MAX_MS explains nothing (a Host that died mid-merge)', () => {
    const stale = rec({ headAfter: undefined, endedAt: undefined, startedAt: new Date(now - MERGE_OPEN_MAX_MS - 1).toISOString() })
    expect(explainedByHostMerges({ projectPath: 'P', fromHead: 'z', toHead: 'y', records: [stale], nowMs: now, samePath: same })).toBe(false)
  })
  it('no head to start from explains nothing', () => {
    expect(explainedByHostMerges({ projectPath: 'P', fromHead: null, toHead: 'b', records: [rec({})], nowMs: now, samePath: same })).toBe(false)
  })
})
