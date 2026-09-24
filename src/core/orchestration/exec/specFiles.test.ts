import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { staleSpecFiles, sweepStaleSpecFiles } from './specFiles'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-specs-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('sweepStaleSpecFiles', () => {
  it('removes the spec files no open Dispatch names and keeps the rest', async () => {
    await fs.writeFile(path.join(dir, 'tsk_1-dsp_1.md'), 'open'); await fs.writeFile(path.join(dir, 'tsk_2-dsp_2.md'), 'closed')
    const removed = await sweepStaleSpecFiles({ dir, state: { dispatches: [{ specPath: path.join(dir, 'tsk_1-dsp_1.md') }, { specPath: path.join(dir, 'tsk_2-dsp_2.md'), endedAt: 'T' }], runs: [] }, live: new Set() })
    expect(removed).toEqual(['tsk_2-dsp_2.md'])
    expect(await fs.readdir(dir)).toEqual(['tsk_1-dsp_1.md'])
  })
  it('answers [] for a folder that is not there', async () => {
    expect(await sweepStaleSpecFiles({ dir: path.join(dir, 'nope'), state: { dispatches: [], runs: [] }, live: undefined })).toEqual([])
  })
})

describe('staleSpecFiles and the files kept beside a spec', () => {
  // A convergence reviewer writes its verdict to `<spec>.review.json`, next to its spec, and reports a
  // few seconds later. `worker-done` reads that file; a missing one reads as "no issues". So the file
  // lives exactly as long as its spec does: an open review keeps both, a closed one loses both.
  it("keeps an open review's verdict file and sweeps a closed one's", () => {
    const files = ['tsk_1-dsp_2.md', 'tsk_1-dsp_2.md.review.json', 'tsk_3-dsp_4.md', 'tsk_3-dsp_4.md.review.json']
    const stale = staleSpecFiles({
      files,
      dispatches: [{ specPath: 'C:\\u\\orch\\specs\\tsk_1-dsp_2.md' }, { specPath: '/u/orch/specs/tsk_3-dsp_4.md', endedAt: 'T' }],
      runs: [],
      live: new Set()
    })
    expect(stale).toEqual(['tsk_3-dsp_4.md', 'tsk_3-dsp_4.md.review.json'])
  })
  it('keeps any file named after an open spec plus a suffix, and nothing that only shares a prefix', () => {
    const stale = staleSpecFiles({
      files: ['tsk_1-dsp_2.md', 'tsk_1-dsp_2.md.review.json.tmp', 'tsk_1-dsp_2.mdx', 'tsk_1-dsp_22.md'],
      dispatches: [{ specPath: '/s/tsk_1-dsp_2.md' }],
      runs: [],
      live: new Set()
    })
    expect(stale).toEqual(['tsk_1-dsp_2.mdx', 'tsk_1-dsp_22.md'])
  })
  it('lets an empty specPath keep nothing, not even a file that starts with a dot', () => {
    expect(staleSpecFiles({ files: ['.review.json'], dispatches: [{ specPath: '' }], runs: [], live: new Set() })).toEqual(['.review.json'])
  })
  it("the sweep leaves an open review's verdict file on disk", async () => {
    await fs.writeFile(path.join(dir, 'tsk_1-dsp_2.md'), 'spec'); await fs.writeFile(path.join(dir, 'tsk_1-dsp_2.md.review.json'), '{"issues":[]}')
    const removed = await sweepStaleSpecFiles({ dir, state: { dispatches: [{ specPath: path.join(dir, 'tsk_1-dsp_2.md') }], runs: [] }, live: new Set() })
    expect(removed).toEqual([])
    expect((await fs.readdir(dir)).sort()).toEqual(['tsk_1-dsp_2.md', 'tsk_1-dsp_2.md.review.json'])
  })
})
