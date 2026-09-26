import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMergeRecorder } from './mergeRecords'
import { HOST_MERGES_KEPT, HOST_MERGES_KEPT_PER_PROJECT, parseHostMerges, type HostMergeRecord } from '../core/git/hostMerges'

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
  // Limit L4 (2026-09-26). The kept rule is proven on a file seeded once with synthetic records and one
  // begin + end, not on HOST_MERGES_KEPT real cycles: each cycle reads, writes a tmp file and renames
  // it, and a few hundred of those overran the suite's timeout under full-suite load.
  describe('what the file keeps', () => {
    const at = '2026-09-24T10:00:00.000Z'
    const synthetic = (project: string, n: number, tag = project): HostMergeRecord[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `${tag}-${i}`,
        projectPath: path.join(dir, project),
        headBefore: `a${i}`,
        headAfter: `b${i}`,
        startedAt: at,
        endedAt: at
      }))
    const seed = async (records: HostMergeRecord[]) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, JSON.stringify({ merges: records }), 'utf8')
    }
    const recorder = (kept?: { total: number; perProject: number }) =>
      createMergeRecorder({ file, headOf: async () => 'h', now: () => at, log: () => {}, ...(kept ? { kept } : {}) })
    const countOf = (records: HostMergeRecord[], project: string) =>
      records.filter((r) => r.projectPath === path.join(dir, project)).length

    it('keeps the newest HOST_MERGES_KEPT records in all, oldest dropped first, in file order', async () => {
      const projects = Math.ceil(HOST_MERGES_KEPT / HOST_MERGES_KEPT_PER_PROJECT) + 1
      const per = Math.ceil(HOST_MERGES_KEPT / projects) // under the per-project cap, so only the total bites
      const earlier = Array.from({ length: projects }, (_, p) => synthetic(`p${p}`, per)).flat()
      expect(earlier.length).toBeGreaterThanOrEqual(HOST_MERGES_KEPT)
      await seed(earlier)
      const rec = recorder()
      const id = await rec.begin(path.join(dir, 'fresh'))
      await rec.end(id)
      const kept = await read()
      expect(kept).toHaveLength(HOST_MERGES_KEPT)
      expect(kept.map((r) => r.id)).toEqual([...earlier.slice(earlier.length + 1 - HOST_MERGES_KEPT).map((r) => r.id), id])
      expect(kept.at(-1)).toMatchObject({ id, projectPath: path.join(dir, 'fresh'), headAfter: 'h', endedAt: at })
    })
    it("a busy project does not push out another project's records", async () => {
      const quiet = synthetic('quiet', 3)
      await seed([...quiet, ...synthetic('busy', HOST_MERGES_KEPT)])
      const rec = recorder()
      const id = await rec.begin(path.join(dir, 'busy'))
      await rec.end(id)
      const kept = await read()
      expect(kept.slice(0, 3).map((r) => r.id)).toEqual(quiet.map((r) => r.id))
      expect(countOf(kept, 'busy')).toBe(HOST_MERGES_KEPT_PER_PROJECT)
      expect(kept.at(-1)?.id).toBe(id)
    })
    it('keeps the newest HOST_MERGES_KEPT_PER_PROJECT records of one project', async () => {
      const earlier = synthetic('one', HOST_MERGES_KEPT_PER_PROJECT)
      await seed([...synthetic('other', 2), ...earlier])
      const rec = recorder()
      const id = await rec.begin(path.join(dir, 'one'))
      await rec.end(id)
      const kept = await read()
      expect(countOf(kept, 'other')).toBe(2)
      expect(kept.filter((r) => r.projectPath === path.join(dir, 'one')).map((r) => r.id)).toEqual([
        ...earlier.slice(1).map((r) => r.id),
        id
      ])
    })
    it('the rule holds over real begin/end cycles, with small caps', async () => {
      const rec = recorder({ total: 4, perProject: 2 })
      const ids: Record<string, string[]> = {}
      for (const p of ['a', 'b', 'a', 'a', 'b', 'c', 'a']) {
        const id = await rec.begin(path.join(dir, p))
        await rec.end(id)
        ;(ids[p] ??= []).push(id)
      }
      const kept = await read()
      // Each write applies the rule: a keeps its newest 2 (a3, a4), and when c's record made five, the
      // oldest in all (b's first) went.
      expect(kept.map((r) => r.id)).toEqual([ids.a![2], ids.b![1], ids.c![0], ids.a![3]])
      expect(kept.every((r) => r.endedAt === at)).toBe(true)
    })
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
