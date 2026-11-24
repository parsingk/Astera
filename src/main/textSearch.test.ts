import { describe, it, expect, vi, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createTextSearch,
  readBounded,
  statFile,
  TEXT_SEARCH_MAX_FILE_BYTES,
  TEXT_SEARCH_ROWS,
  type TextSearchDeps
} from './textSearch'
import { TEXT_SEARCH_LINES_PER_FILE } from '../core/files/textMatch'

const ROOT = path.resolve('/proj')
const OTHER = path.resolve('/worktree')
const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'))

type FakeFile = { text?: string; bytes?: Buffer; size?: number; link?: true; grew?: true; swapped?: true }

/** A project held in memory: the index lists `files`' keys in order; `stat` and `readUpTo` count what is touched. */
function fakeProject(files: Record<string, FakeFile>, listed: { truncated?: boolean; unavailable?: boolean } = {}) {
  const read: string[] = []
  const statted: string[] = []
  const calls: string[] = []
  const byAbs = new Map<string, FakeFile>()
  for (const [rel, f] of Object.entries(files)) byAbs.set(abs(ROOT, rel), f)
  let gate: Promise<void> | null = null
  const deps: TextSearchDeps = {
    index: {
      list: vi.fn(async (root: string) => {
        calls.push(`list ${root}`)
        if (listed.unavailable) return { paths: [], truncated: false, unavailable: true }
        return { paths: root === ROOT ? Object.keys(files) : [], truncated: listed.truncated === true, unavailable: false }
      }),
      expire: vi.fn((root: string) => {
        calls.push(`expire ${root}`)
      })
    },
    allowedRoot: async (p) => p,
    stat: async (p) => {
      statted.push(p)
      const f = byAbs.get(p)
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const bytes = f.bytes ?? Buffer.from(f.text ?? '', 'utf8')
      return { isFile: f.link !== true, size: f.size ?? bytes.length, id: `id:${p}` }
    },
    readUpTo: async (p, max, id) => {
      read.push(p)
      if (gate) await gate
      const f = byAbs.get(p)!
      // What the real reader answers when the file it opened is not the one stat saw
      if (f.swapped || id !== `id:${p}`) return null
      let bytes = f.bytes ?? Buffer.from(f.text ?? '', 'utf8')
      if (f.grew) bytes = Buffer.concat([bytes, Buffer.from(' and more')])
      return bytes.subarray(0, max)
    },
    graceMs: 50
  }
  return {
    deps,
    read,
    statted,
    calls,
    hold: () => {
      let release = (): void => {}
      gate = new Promise<void>((r) => (release = r))
      return () => {
        gate = null
        release()
      }
    }
  }
}

type Ask = ReturnType<typeof createTextSearch>['ask']

/** Asks until the search is done, as the renderer polls. */
async function settle(ask: Ask, owner: number, root: string, query: string) {
  for (let i = 0; i < 100; i++) {
    const a = await ask(owner, root, query)
    if (!a.searching) return a
  }
  throw new Error('search never finished')
}

/** `count` lines that each hold `word`. */
const lines = (count: number, word = 'hit'): string => Array.from({ length: count }, (_, i) => `${word} ${i}`).join('\n')

describe('createTextSearch', () => {
  it('refuses a root the path guard refuses, and reads nothing', async () => {
    const p = fakeProject({ 'a.ts': { text: 'hit' } })
    const { ask } = createTextSearch({
      ...p.deps,
      allowedRoot: async () => {
        throw new Error('not allowed')
      }
    })
    await expect(ask(1, ROOT, 'hit')).rejects.toThrow('not allowed')
    expect(p.calls).toEqual([])
    expect(p.read).toEqual([])
  })

  it('refuses arguments that are not a root and a query', async () => {
    const { ask } = createTextSearch(fakeProject({}).deps)
    await expect(ask(1, 42, 'a')).rejects.toThrow()
    await expect(ask(1, '', 'a')).rejects.toThrow()
    await expect(ask(1, ROOT, null)).rejects.toThrow()
  })

  it('answers the matching lines with absolute paths named as the explorer names them', async () => {
    const p = fakeProject({ 'src/a.ts': { text: 'const hit = 1\nnone\nhit()' }, 'b.md': { text: 'nothing' } })
    const a = await settle(createTextSearch(p.deps).ask, 1, ROOT, 'hit')
    expect(a).toEqual({
      matches: [
        { path: abs(ROOT, 'src/a.ts'), line: 1, col: 7, preview: 'const hit = 1', ranges: [[6, 9]] },
        { path: abs(ROOT, 'src/a.ts'), line: 3, col: 1, preview: 'hit()', ranges: [[0, 3]] }
      ],
      searching: false
    })
  })

  // The box asks for a fresh list as it opens (the watcher runs only while the explorer is open); typing does not.
  it('walks the project again when asked to refresh, before listing it', async () => {
    const p = fakeProject({ 'a.ts': { text: 'x' } })
    const { ask } = createTextSearch(p.deps)
    await settle(ask, 1, ROOT, 'x')
    await ask(1, ROOT, 'y', true)
    expect(p.calls).toEqual([`list ${ROOT}`, `expire ${ROOT}`, `list ${ROOT}`])
  })

  // Review I1: the box opened again on the query it last searched got the old rows, files edited since and all.
  it('starts over on a refresh even for the query it last searched', async () => {
    const p = fakeProject({ 'a.ts': { text: 'x' } })
    const { ask } = createTextSearch(p.deps)
    await settle(ask, 1, ROOT, 'x')
    await settle(ask, 1, ROOT, 'x')
    expect(p.calls).toEqual([`list ${ROOT}`])
    await ask(1, ROOT, 'x', true)
    expect(p.calls).toEqual([`list ${ROOT}`, `expire ${ROOT}`, `list ${ROOT}`])
  })

  it('does not read binaries, files over the size cap, credential files or links, and lists no line of them', async () => {
    const p = fakeProject({
      'ok.ts': { text: 'hit' },
      'blob.bin': { bytes: Buffer.from([0x68, 0x69, 0x74, 0x00]) },
      'big.log': { text: 'hit', size: TEXT_SEARCH_MAX_FILE_BYTES + 1 },
      '.env': { text: 'hit=secret' },
      'keys/server.pem': { text: 'hit' },
      'linked.ts': { text: 'hit', link: true }
    })
    const a = await settle(createTextSearch(p.deps).ask, 1, ROOT, 'hit')
    expect(a.matches.map((m) => m.path)).toEqual([abs(ROOT, 'ok.ts')])
    expect([...p.read].sort()).toEqual([abs(ROOT, 'blob.bin'), abs(ROOT, 'ok.ts')])
    // Credential files are not even looked at
    expect(p.statted).not.toContain(abs(ROOT, '.env'))
    expect(p.statted).not.toContain(abs(ROOT, 'keys/server.pem'))
  })

  // Review focus 5: the read is bounded by what stat said, so a file growing as it is read is never read past the cap,
  // and a file swapped for another (a link) after stat is not read at all.
  it('reads no more than stat said plus one byte, and skips a file that grew or was swapped since', async () => {
    const p = fakeProject({ 'growing.log': { text: 'hit', grew: true }, 'swapped.ts': { text: 'hit', swapped: true }, 'ok.ts': { text: 'hit' } })
    const readUpTo = vi.fn(p.deps.readUpTo!)
    const a = await settle(createTextSearch({ ...p.deps, readUpTo }).ask, 1, ROOT, 'hit')
    expect(a.matches.map((m) => m.path)).toEqual([abs(ROOT, 'ok.ts')])
    expect(readUpTo).toHaveBeenCalledWith(abs(ROOT, 'growing.log'), 4, `id:${abs(ROOT, 'growing.log')}`)
  })

  // Review I2: a root lockfile filled all 300 rows and halted the search before `src/` was read.
  it('lists at most TEXT_SEARCH_LINES_PER_FILE lines of a file, goes on to the others, and says a file was cut', async () => {
    const p = fakeProject({ 'package-lock.json': { text: lines(400, 'react') }, 'src/a.tsx': { text: "import React from 'react'" } })
    const a = await settle(createTextSearch({ ...p.deps, concurrency: 1 }).ask, 1, ROOT, 'react')
    expect(a.matches.filter((m) => m.path.endsWith('package-lock.json'))).toHaveLength(TEXT_SEARCH_LINES_PER_FILE)
    expect(a.matches.map((m) => m.path)).toContain(abs(ROOT, 'src/a.tsx'))
    expect(a.fileCut).toBe(true)
    expect(a.truncated).toBeUndefined()
    const whole = await settle(createTextSearch(fakeProject({ 'a.ts': { text: lines(TEXT_SEARCH_LINES_PER_FILE) } }).deps).ask, 1, ROOT, 'hit')
    expect(whole.fileCut).toBeUndefined()
  })

  it('stops at the row cap, says more lines match, and reads nothing more', async () => {
    const files: Record<string, FakeFile> = {}
    const filesToFill = TEXT_SEARCH_ROWS / TEXT_SEARCH_LINES_PER_FILE
    for (let i = 0; i < filesToFill + 5; i++) files[`f${String(i).padStart(2, '0')}.ts`] = { text: lines(TEXT_SEARCH_LINES_PER_FILE + 5) }
    const p = fakeProject(files)
    const a = await settle(createTextSearch({ ...p.deps, concurrency: 1 }).ask, 1, ROOT, 'hit')
    expect(a.matches).toHaveLength(TEXT_SEARCH_ROWS)
    expect(a.truncated).toBe(true)
    expect(p.read).toHaveLength(filesToFill)
  })

  it('does not say more lines match when exactly the cap matches', async () => {
    const files: Record<string, FakeFile> = { 'none.ts': { text: 'none' } }
    for (let i = 0; i < TEXT_SEARCH_ROWS / TEXT_SEARCH_LINES_PER_FILE; i++) files[`f${i}.ts`] = { text: lines(TEXT_SEARCH_LINES_PER_FILE) }
    const a = await settle(createTextSearch(fakeProject(files).deps).ask, 1, ROOT, 'hit')
    expect(a.matches).toHaveLength(TEXT_SEARCH_ROWS)
    expect(a.truncated).toBeUndefined()
  })

  it('says when only the shallow part of a large project was searched, or the project could not be listed', async () => {
    const partial = fakeProject({ 'a.ts': { text: 'hit' } }, { truncated: true })
    expect((await settle(createTextSearch(partial.deps).ask, 1, ROOT, 'hit')).partial).toBe(true)
    const gone = fakeProject({}, { unavailable: true })
    expect(await settle(createTextSearch(gone.deps).ask, 1, ROOT, 'hit')).toEqual({ matches: [], searching: false, unavailable: true })
  })

  // Spec W2: a newer request is never overwritten by an older one, and a superseded search stops reading.
  it('a new query stops the search under way; asking the same query again answers its progress', async () => {
    const files: Record<string, FakeFile> = {}
    for (let i = 0; i < 40; i++) files[`f${i}.ts`] = { text: i % 2 ? 'old new' : 'old' }
    const p = fakeProject(files)
    const { ask } = createTextSearch({ ...p.deps, concurrency: 2 })
    const release = p.hold()
    const first = await ask(1, ROOT, 'old')
    expect(first.searching).toBe(true)
    const again = await ask(1, ROOT, 'old')
    expect(again.searching).toBe(true)
    expect(p.calls.filter((c) => c.startsWith('list'))).toHaveLength(1)
    const readBefore = p.read.length
    const next = ask(1, ROOT, 'new')
    release()
    const done = await settle(ask, 1, ROOT, 'new')
    await next
    expect(done.matches.every((m) => m.preview === 'old new')).toBe(true)
    expect(done.matches).toHaveLength(20)
    // The old search read at most its two files in flight before stopping; the new one read all forty
    expect(p.read.length).toBeLessThanOrEqual(readBefore + 40 + 2)
  })

  it('an empty or blank query stops the search under way and answers nothing', async () => {
    const files: Record<string, FakeFile> = {}
    for (let i = 0; i < 20; i++) files[`f${i}.ts`] = { text: 'hit' }
    const p = fakeProject(files)
    const { ask } = createTextSearch({ ...p.deps, concurrency: 1 })
    const release = p.hold()
    await ask(1, ROOT, 'hit')
    expect(await ask(1, ROOT, '')).toEqual({ matches: [], searching: false })
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(p.read.length).toBeLessThanOrEqual(2)
    expect(await ask(1, ROOT, '   ')).toEqual({ matches: [], searching: false })
  })

  // Review I1: the guard is a real await for a project known only from history; a cancel sent meanwhile found nothing to
  // stop, and the ask then searched the whole project for a box already closed.
  it('a cancel that arrives while an ask waits on the path guard keeps the search stopped', async () => {
    const files: Record<string, FakeFile> = {}
    for (let i = 0; i < 20; i++) files[`f${i}.ts`] = { text: 'hit' }
    const p = fakeProject(files)
    let releaseGuard = (): void => {}
    const guard = new Promise<void>((r) => (releaseGuard = r))
    const { ask } = createTextSearch({
      ...p.deps,
      allowedRoot: async (r) => {
        await guard
        return r
      }
    })
    const first = ask(1, ROOT, 'hit', true)
    await ask(1, ROOT, '') // the box closed
    releaseGuard()
    expect(await first).toEqual({ matches: [], searching: false })
    await new Promise((r) => setTimeout(r, 20))
    expect(p.calls).toEqual([])
    expect(p.read).toEqual([])
  })

  it('a newer query that arrives while an older ask waits on the guard is the one searched', async () => {
    const p = fakeProject({ 'a.ts': { text: 'alpha beta' } })
    let releaseGuard = (): void => {}
    const guard = new Promise<void>((r) => (releaseGuard = r))
    let held = true
    const { ask } = createTextSearch({
      ...p.deps,
      allowedRoot: async (r) => {
        if (held) {
          held = false
          await guard
        }
        return r
      }
    })
    const older = ask(1, ROOT, 'alpha')
    const newer = await settle(ask, 1, ROOT, 'beta')
    releaseGuard()
    expect(await older).toEqual({ matches: [], searching: false })
    expect(newer.matches.map((m) => m.preview)).toEqual(['alpha beta'])
    expect((await ask(1, ROOT, 'beta')).matches).toHaveLength(1)
  })

  // A reloaded renderer runs no cleanup and keeps its webContents id; ipc.ts stops every search on a new document.
  it('stopAll stops every search, and the next ask starts a new one', async () => {
    const files: Record<string, FakeFile> = {}
    for (let i = 0; i < 20; i++) files[`f${i}.ts`] = { text: 'hit' }
    const p = fakeProject(files)
    const search = createTextSearch({ ...p.deps, concurrency: 1 })
    const release = p.hold()
    await search.ask(1, ROOT, 'hit')
    search.stopAll()
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(p.read.length).toBeLessThanOrEqual(2)
    expect((await settle(search.ask, 1, ROOT, 'hit')).matches).toHaveLength(20)
    expect(p.calls.filter((c) => c.startsWith('list'))).toHaveLength(2)
  })

  it('one renderer does not stop another', async () => {
    const p = fakeProject({ 'a.ts': { text: 'alpha beta' } })
    const { ask } = createTextSearch(p.deps)
    const release = p.hold()
    await ask(1, ROOT, 'alpha')
    await ask(2, ROOT, 'beta')
    release()
    expect((await settle(ask, 1, ROOT, 'alpha')).matches).toHaveLength(1)
    expect((await settle(ask, 2, ROOT, 'beta')).matches).toHaveLength(1)
  })

  it('keeps projects apart: a search of one root lists no file of another', async () => {
    const p = fakeProject({ 'a.ts': { text: 'hit' } })
    const a = await settle(createTextSearch(p.deps).ask, 1, OTHER, 'hit')
    expect(a.matches).toEqual([])
  })

  it('answers nothing for a query longer than the cap, without listing', async () => {
    const p = fakeProject({ 'a.ts': { text: 'x'.repeat(300) } })
    expect(await createTextSearch(p.deps).ask(1, ROOT, 'x'.repeat(257))).toEqual({ matches: [], searching: false })
    expect(p.calls).toEqual([])
  })
})

// The real reader: a file is read only if the one opened is the one stat saw, so a file swapped for another (a link to
// something outside the project, say) between the two is not read.
describe('statFile and readBounded', () => {
  let dir = ''
  afterEach(async () => {
    if (dir) await fs.rm(dir, { recursive: true, force: true })
    dir = ''
  })

  it('reads at most the bytes asked for, of the file stat saw', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ts-'))
    const file = path.join(dir, 'a.txt')
    await fs.writeFile(file, 'hello world')
    const st = await statFile(file)
    expect(st).toEqual({ isFile: true, size: 11, id: expect.any(String) })
    expect((await readBounded(file, 5, st.id))?.toString()).toBe('hello')
    expect((await readBounded(file, st.size + 1, st.id))?.toString()).toBe('hello world')
  })

  it('reads nothing when the file at that path is no longer the one stat saw', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ts-'))
    const file = path.join(dir, 'a.txt')
    const other = path.join(dir, 'b.txt')
    await fs.writeFile(file, 'first')
    await fs.writeFile(other, 'second')
    const st = await statFile(file)
    await fs.rm(file)
    await fs.rename(other, file)
    expect(await readBounded(file, 100, st.id)).toBeNull()
  })

  it('says a folder is not a file', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-ts-'))
    expect((await statFile(dir)).isFile).toBe(false)
  })
})
