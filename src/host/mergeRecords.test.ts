import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMergeRecorder } from './mergeRecords'
import { HOST_MERGES_KEPT, parseHostMerges } from '../core/git/hostMerges'

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-merges-'))
  file = path.join(dir, 'host', 'merges.json')
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})
const read = async () => parseHostMerges(await fs.readFile(file, 'utf8'))

describe('createMergeRecorder (carry 1)', () => {
  it('writes the record with the head before the merge, then completes it with the head after', async () => {
    let head = 'c0'
    const rec = createMergeRecorder({ file, headOf: async () => head, now: () => '2026-09-24T10:00:00.000Z', log: () => {} })
    const id = await rec.begin(path.join(dir, 'repo'))
    expect(await read()).toEqual([{ id, projectPath: path.join(dir, 'repo'), headBefore: 'c0', startedAt: '2026-09-24T10:00:00.000Z' }])
    head = 'c1'
    await rec.end(id)
    expect(await read()).toMatchObject([{ id, headBefore: 'c0', headAfter: 'c1', endedAt: '2026-09-24T10:00:00.000Z' }])
  })
  it('keeps the newest HOST_MERGES_KEPT records', async () => {
    const rec = createMergeRecorder({ file, headOf: async () => 'h', now: () => '2026-09-24T10:00:00.000Z', log: () => {} })
    for (let i = 0; i < HOST_MERGES_KEPT + 3; i++) await rec.end(await rec.begin(path.join(dir, `r${i}`)))
    const kept = await read()
    expect(kept).toHaveLength(HOST_MERGES_KEPT)
    expect(kept.at(-1)?.projectPath).toBe(path.join(dir, `r${HOST_MERGES_KEPT + 2}`))
  })
  it('a file it cannot write costs the merge nothing: begin still answers an id, and the failure is logged', async () => {
    await fs.mkdir(file, { recursive: true }) // a directory where the file should be
    const logs: string[] = []
    const rec = createMergeRecorder({ file, headOf: async () => 'c0', now: () => '2026-09-24T10:00:00.000Z', log: (m) => logs.push(m) })
    const id = await rec.begin(path.join(dir, 'repo'))
    await rec.end(id)
    expect(typeof id).toBe('string')
    expect(logs.join('\n')).toMatch(/merge record/)
  })
})
