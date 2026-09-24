import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMergeRecorder } from './mergeRecords'
import { HOST_MERGES_KEPT, parseHostMerges } from '../core/git/hostMerges'

/** A read that fails with something other than ENOENT (review m1): EMFILE or a busy file past its
 *  retries cannot be produced portably by a real file, so the read is failed here once. */
const readFails = vi.hoisted(() => ({ next: null as NodeJS.ErrnoException | null }))
vi.mock('../core/renameRetry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../core/renameRetry')>()
  return {
    ...real,
    readFileRetrying: async (file: string) => {
      const err = readFails.next
      readFails.next = null
      if (err) throw err
      return real.readFileRetrying(file)
    }
  }
})

let dir: string
let file: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-merges-'))
  file = path.join(dir, 'host', 'merges.json')
})
afterEach(async () => {
  readFails.next = null
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
  // Review m1: a read that fails must not wipe the history on the next write.
  describe('what it finds on disk before a write', () => {
    const at = '2026-09-24T10:00:00.000Z'
    const earlier = [
      { id: 'm1', projectPath: 'p1', headBefore: 'a', headAfter: 'b', startedAt: at, endedAt: at },
      { id: 'm2', projectPath: 'p2', headBefore: 'c', headAfter: 'd', startedAt: at, endedAt: at }
    ]
    const seed = async (text: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, text, 'utf8')
    }
    it('no file (ENOENT) is an empty history', async () => {
      const rec = createMergeRecorder({ file, headOf: async () => 'c0', now: () => at, log: () => {} })
      const id = await rec.begin(path.join(dir, 'repo'))
      expect((await read()).map((r) => r.id)).toEqual([id])
      await expect(fs.stat(`${file}.bak`)).rejects.toThrow()
    })
    it('keeps earlier records and appends', async () => {
      await seed(JSON.stringify({ merges: earlier }))
      const rec = createMergeRecorder({ file, headOf: async () => 'c0', now: () => at, log: () => {} })
      const id = await rec.begin(path.join(dir, 'repo'))
      expect((await read()).map((r) => r.id)).toEqual(['m1', 'm2', id])
    })
    it('a damaged file is kept as merges.json.bak, the history starts fresh, and it says so', async () => {
      await seed('{bad')
      const logs: string[] = []
      const rec = createMergeRecorder({ file, headOf: async () => 'c0', now: () => at, log: (m) => logs.push(m) })
      const id = await rec.begin(path.join(dir, 'repo'))
      expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('{bad')
      expect((await read()).map((r) => r.id)).toEqual([id])
      expect(logs.join('\n')).toMatch(/merges\.json.*damaged.*merges\.json\.bak/)
    })
    it('a file that is JSON but not the record file counts as damaged too', async () => {
      await seed('[]')
      const rec = createMergeRecorder({ file, headOf: async () => 'c0', now: () => at, log: () => {} })
      await rec.begin(path.join(dir, 'repo'))
      expect(await fs.readFile(`${file}.bak`, 'utf8')).toBe('[]')
    })
    it('any other read error skips the write and logs it: the history stays, and begin still answers an id', async () => {
      const text = JSON.stringify({ merges: earlier })
      await seed(text)
      const logs: string[] = []
      const rec = createMergeRecorder({ file, headOf: async () => 'c0', now: () => at, log: (m) => logs.push(m) })
      readFails.next = Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' })
      const id = await rec.begin(path.join(dir, 'repo'))
      expect(typeof id).toBe('string')
      expect(await fs.readFile(file, 'utf8')).toBe(text)
      await expect(fs.stat(`${file}.bak`)).rejects.toThrow()
      expect(logs.join('\n')).toMatch(new RegExp(`merge record ${id} could not be written: .*EMFILE`))
      // The next write reads again and keeps what was there.
      await rec.end(await rec.begin(path.join(dir, 'repo2')))
      expect((await read()).map((r) => r.id).slice(0, 2)).toEqual(['m1', 'm2'])
    })
  })
})
