import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { createTextSearch, TEXT_SEARCH_MAX_FILE_BYTES, TEXT_SEARCH_ROWS, type TextSearchDeps } from './textSearch'

const ROOT = path.resolve('/proj')
const OTHER = path.resolve('/worktree')
const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'))

type FakeFile = { text?: string; bytes?: Buffer; size?: number; link?: true; grew?: true }

/** A project held in memory: the index lists `files`' keys in order; `lstat` and `read` count what is touched. */
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
    lstat: async (p) => {
      statted.push(p)
      const f = byAbs.get(p)
      if (!f) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      const bytes = f.bytes ?? Buffer.from(f.text ?? '', 'utf8')
      return { isFile: () => f.link !== true, size: f.size ?? bytes.length }
    },
    readUpTo: async (p, max) => {
      read.push(p)
      if (gate) await gate
      const f = byAbs.get(p)!
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

/** Asks until the search is done, as the renderer polls. */
async function settle(ask: ReturnType<typeof createTextSearch>, owner: number, root: string, query: string) {
  for (let i = 0; i < 100; i++) {
    const a = await ask(owner, root, query)
    if (!a.searching) return a
  }
  throw new Error('search never finished')
}

describe('createTextSearch', () => {
  it('refuses a root the path guard refuses, and reads nothing', async () => {
    const p = fakeProject({ 'a.ts': { text: 'hit' } })
    const ask = createTextSearch({
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
    const ask = createTextSearch(fakeProject({}).deps)
    await expect(ask(1, 42, 'a')).rejects.toThrow()
    await expect(ask(1, '', 'a')).rejects.toThrow()
    await expect(ask(1, ROOT, null)).rejects.toThrow()
  })

  it('answers the matching lines with absolute paths named as the explorer names them', async () => {
    const p = fakeProject({ 'src/a.ts': { text: 'const hit = 1\nnone\nhit()' }, 'b.md': { text: 'nothing' } })
    const a = await settle(createTextSearch(p.deps), 1, ROOT, 'hit')
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
    const ask = createTextSearch(p.deps)
    await settle(ask, 1, ROOT, 'x')
    await ask(1, ROOT, 'y', true)
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
    const a = await settle(createTextSearch(p.deps), 1, ROOT, 'hit')
    expect(a.matches.map((m) => m.path)).toEqual([abs(ROOT, 'ok.ts')])
    expect([...p.read].sort()).toEqual([abs(ROOT, 'blob.bin'), abs(ROOT, 'ok.ts')])
    // Credential files are not even looked at
    expect(p.statted).not.toContain(abs(ROOT, '.env'))
    expect(p.statted).not.toContain(abs(ROOT, 'keys/server.pem'))
  })

  // Review focus 5: the read is bounded by what lstat said, so a file growing as it is read is never read past the cap.
  it('reads no more than lstat said plus one byte, and skips a file that grew since', async () => {
    const p = fakeProject({ 'growing.log': { text: 'hit', grew: true }, 'ok.ts': { text: 'hit' } })
    const readUpTo = vi.fn(p.deps.readUpTo!)
    const a = await settle(createTextSearch({ ...p.deps, readUpTo }), 1, ROOT, 'hit')
    expect(a.matches.map((m) => m.path)).toEqual([abs(ROOT, 'ok.ts')])
    expect(readUpTo).toHaveBeenCalledWith(abs(ROOT, 'growing.log'), 4)
  })

  it('stops at the row cap and says more lines match', async () => {
    const many = Array.from({ length: TEXT_SEARCH_ROWS + 5 }, () => 'hit').join('\n')
    const files: Record<string, FakeFile> = { 'a.ts': { text: many } }
    for (let i = 0; i < 20; i++) files[`b${i}.ts`] = { text: 'hit' }
    const p = fakeProject(files)
    const a = await settle(createTextSearch({ ...p.deps, concurrency: 1 }), 1, ROOT, 'hit')
    expect(a.matches).toHaveLength(TEXT_SEARCH_ROWS)
    expect(a.truncated).toBe(true)
    // Full and known to be truncated: nothing more is read
    expect(p.read).toEqual([abs(ROOT, 'a.ts')])
  })

  it('does not say more lines match when exactly the cap matches', async () => {
    const exact = Array.from({ length: TEXT_SEARCH_ROWS }, () => 'hit').join('\n')
    const p = fakeProject({ 'a.ts': { text: exact }, 'b.ts': { text: 'none' } })
    const a = await settle(createTextSearch(p.deps), 1, ROOT, 'hit')
    expect(a.matches).toHaveLength(TEXT_SEARCH_ROWS)
    expect(a.truncated).toBeUndefined()
  })

  it('says when only the shallow part of a large project was searched, or the project could not be listed', async () => {
    const partial = fakeProject({ 'a.ts': { text: 'hit' } }, { truncated: true })
    expect((await settle(createTextSearch(partial.deps), 1, ROOT, 'hit')).partial).toBe(true)
    const gone = fakeProject({}, { unavailable: true })
    expect(await settle(createTextSearch(gone.deps), 1, ROOT, 'hit')).toEqual({ matches: [], searching: false, unavailable: true })
  })

  // Spec W2: a newer request is never overwritten by an older one, and a superseded search stops reading.
  it('a new query stops the search under way; asking the same query again answers its progress', async () => {
    const files: Record<string, FakeFile> = {}
    for (let i = 0; i < 40; i++) files[`f${i}.ts`] = { text: i % 2 ? 'old new' : 'old' }
    const p = fakeProject(files)
    const ask = createTextSearch({ ...p.deps, concurrency: 2 })
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
    const ask = createTextSearch({ ...p.deps, concurrency: 1 })
    const release = p.hold()
    await ask(1, ROOT, 'hit')
    expect(await ask(1, ROOT, '')).toEqual({ matches: [], searching: false })
    release()
    await new Promise((r) => setTimeout(r, 20))
    expect(p.read.length).toBeLessThanOrEqual(2)
    expect(await ask(1, ROOT, '   ')).toEqual({ matches: [], searching: false })
  })

  it('one renderer does not stop another', async () => {
    const p = fakeProject({ 'a.ts': { text: 'alpha beta' } })
    const ask = createTextSearch(p.deps)
    const release = p.hold()
    await ask(1, ROOT, 'alpha')
    await ask(2, ROOT, 'beta')
    release()
    expect((await settle(ask, 1, ROOT, 'alpha')).matches).toHaveLength(1)
    expect((await settle(ask, 2, ROOT, 'beta')).matches).toHaveLength(1)
  })

  it('keeps projects apart: a search of one root lists no file of another', async () => {
    const p = fakeProject({ 'a.ts': { text: 'hit' } })
    const a = await settle(createTextSearch(p.deps), 1, OTHER, 'hit')
    expect(a.matches).toEqual([])
  })

  it('answers nothing for a query longer than the cap, without listing', async () => {
    const p = fakeProject({ 'a.ts': { text: 'x'.repeat(300) } })
    expect(await createTextSearch(p.deps)(1, ROOT, 'x'.repeat(257))).toEqual({ matches: [], searching: false })
    expect(p.calls).toEqual([])
  })
})
