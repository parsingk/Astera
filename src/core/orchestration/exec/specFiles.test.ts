import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepStaleSpecFiles } from './specFiles'

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
