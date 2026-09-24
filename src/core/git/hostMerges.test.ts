import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { parseHostMerges, readHostMerges } from './hostMerges'

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
