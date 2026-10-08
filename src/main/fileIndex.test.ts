import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createFileIndex, FILE_INDEX_ROOTS_KEPT } from './fileIndex'

describe('createFileIndex', () => {
  let root: string

  const write = async (rel: string, text = 'x'): Promise<void> => {
    const file = path.join(root, rel)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text, 'utf8')
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'astera-idx-'))
    await write('README.md')
    await write('src/app.ts')
    await write('src/core/conversation.ts')
    await write('node_modules/pkg/index.js')
    await write('dist/bundle.js')
    await write('secret/keys.txt')
    await write('.gitignore', 'secret/\n')
  })
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {})
  })

  // The whole value of the list is what is NOT in it: a repository's node_modules is larger than the
  // repository, and a menu that offers it offers nothing.
  it('leaves out what the curated list and the .gitignore exclude', async () => {
    const all = await createFileIndex().search(root, '', 100)
    expect(all).toContain('README.md')
    expect(all).toContain('src/core/conversation.ts')
    expect(all.some((p) => p.includes('node_modules'))).toBe(false)
    expect(all.some((p) => p.startsWith('dist/'))).toBe(false)
    expect(all.some((p) => p.startsWith('secret/'))).toBe(false)
  })

  it('answers root-relative paths with forward slashes, whatever the platform writes', async () => {
    const found = await createFileIndex().search(root, 'conversation', 10)
    expect(found).toEqual(['src/core/conversation.ts'])
  })

  it('answers an empty list for a root that is not there, rather than throwing', async () => {
    await expect(createFileIndex().search(path.join(root, 'nope'), '', 10)).resolves.toEqual([])
    await expect(createFileIndex().search('', '', 10)).resolves.toEqual([])
  })

  // Typing a name is one call per keystroke; walking the tree again on each would make the menu
  // slower the larger the project is, which is exactly backwards.
  it('walks once and reuses the list until it goes stale', async () => {
    let clock = 0
    const index = createFileIndex(() => clock)
    expect(await index.search(root, 'app', 10)).toEqual(['src/app.ts'])

    await write('src/added.ts')
    expect(await index.search(root, 'added', 10)).toEqual([]) // still the walked list

    clock += 60_000
    expect(await index.search(root, 'added', 10)).toEqual(['src/added.ts'])
  })
})

// A tree held in memory, so a test can count what the walk asks for and hold a directory open.
type FakeEntry = { name: string; isDirectory(): boolean; isFile(): boolean }
const fileEntry = (name: string): FakeEntry => ({ name, isDirectory: () => false, isFile: () => true })
const dirEntry = (name: string): FakeEntry => ({ name, isDirectory: () => true, isFile: () => false })

/** `dirs` maps a root-relative folder ('' for the root) to its entries. */
function fakeFs(dirs: Record<string, FakeEntry[]>, hold?: Promise<void>) {
  const calls: string[] = []
  const readdir = async (abs: string): Promise<FakeEntry[]> => {
    const rel = path.relative('/fake', abs).split(path.sep).join('/')
    calls.push(rel)
    if (hold) await hold
    const entries = dirs[rel]
    if (!entries) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    return entries
  }
  const readFile = async (): Promise<string> => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
  }
  return { calls, readdir, readFile }
}

/** The root probe answering that the root is there — these tests are about the walk. */
const reachable = async (): Promise<'present'> => 'present'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {}
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('createFileIndex — one walk, never blocking', () => {
  const ROOT = path.resolve('/fake')

  // Two keystrokes during a walk used to start two walks of the same tree.
  it('shares one in-flight walk per root: later callers await it', async () => {
    const gate = deferred()
    const fs1 = fakeFs({ '': [fileEntry('a.ts'), dirEntry('src')], src: [fileEntry('b.ts')] }, gate.promise)
    const index = createFileIndex(Date.now, { probe: reachable, readdir: fs1.readdir, readFile: fs1.readFile })
    const first = index.search(ROOT, '', 10)
    const second = index.search(ROOT, 'b', 10)
    const third = index.lookup(ROOT, '', 10)
    await new Promise((r) => setTimeout(r, 5))
    gate.resolve()
    expect(await first).toEqual(expect.arrayContaining(['a.ts', 'src/b.ts']))
    expect(await second).toEqual(['src/b.ts'])
    await third
    expect(fs1.calls.filter((c) => c === '')).toHaveLength(1)
    expect(fs1.calls.filter((c) => c === 'src')).toHaveLength(1)
  })

  // Breadth-first with queue.shift() is O(n²) in the folder count — every shift moves the whole queue.
  // Counted, not timed: the walk takes nothing off the front of an array, and asks for each folder once.
  it('walks the queue by index — no Array.prototype.shift, one readdir per folder', async () => {
    const dirs: Record<string, FakeEntry[]> = { '': [] }
    for (let i = 0; i < 300; i++) {
      dirs[''].push(dirEntry(`d${i}`))
      dirs[`d${i}`] = [fileEntry('f.ts'), dirEntry('inner')]
      dirs[`d${i}/inner`] = [fileEntry('g.ts')]
    }
    const f = fakeFs(dirs)
    const index = createFileIndex(Date.now, { probe: reachable, readdir: f.readdir, readFile: f.readFile })
    const shift = vi.spyOn(Array.prototype, 'shift')
    let shifts = 0
    try {
      await index.search(ROOT, '', 1)
      shifts = shift.mock.calls.length
    } finally {
      shift.mockRestore()
    }
    expect(shifts).toBe(0)
    expect(f.calls).toHaveLength(1 + 300 + 300)
    expect(new Set(f.calls).size).toBe(f.calls.length)
  })

  // A folder of thousands of entries answered at once is one long synchronous loop on main. The walk
  // gives the event loop a turn now and then, so a timer set before it runs before it ends.
  it('gives the event loop a turn during a large walk', async () => {
    const entries: FakeEntry[] = []
    for (let i = 0; i < 5_000; i++) entries.push(fileEntry(`f${i}.ts`))
    const f = fakeFs({ '': entries })
    const index = createFileIndex(Date.now, { probe: reachable, readdir: f.readdir, readFile: f.readFile })
    let ticked = false
    setImmediate(() => (ticked = true))
    let tickedBeforeEnd = false
    await index.search(ROOT, '', 1).then(() => (tickedBeforeEnd = ticked))
    expect(tickedBeforeEnd).toBe(true)
  })

  // lookup answers the menu now: while the first walk runs it says so, with what has been found so far.
  it('lookup during a slow first walk answers indexing, with the partial list', async () => {
    const gate = deferred()
    const dirs = { '': [fileEntry('top.ts'), dirEntry('deep')], deep: [fileEntry('low.ts')] }
    let released = false
    const readdir = async (abs: string): Promise<FakeEntry[]> => {
      const rel = path.relative('/fake', abs).split(path.sep).join('/')
      if (rel === 'deep' && !released) await gate.promise
      return (dirs as Record<string, FakeEntry[]>)[rel]
    }
    const index = createFileIndex(Date.now, { probe: reachable, readdir, readFile: async () => '', graceMs: 5 })
    const early = await index.lookup(ROOT, '', 10)
    expect(early).toEqual({ paths: ['top.ts'], indexing: true })
    released = true
    gate.resolve()
    await index.search(ROOT, '', 10) // joins the same walk
    const late = await index.lookup(ROOT, '', 10)
    expect(late.indexing).toBe(false)
    expect(late.paths).toEqual(expect.arrayContaining(['top.ts', 'deep/low.ts']))
  })

  it('lookup answers a walk that finishes within the grace period in full', async () => {
    const f = fakeFs({ '': [fileEntry('a.ts')] })
    const index = createFileIndex(Date.now, { probe: reachable, readdir: f.readdir, readFile: f.readFile, graceMs: 1_000 })
    expect(await index.lookup(ROOT, '', 10)).toEqual({ paths: ['a.ts'], indexing: false })
  })

  // After the list goes stale, the menu keeps answering from it while the new walk runs.
  it('lookup serves the stale list while a refresh walks in the background', async () => {
    let clock = 0
    const dirs: Record<string, FakeEntry[]> = { '': [fileEntry('old.ts')] }
    const gate = deferred()
    let holding = false
    const readdir = async (abs: string): Promise<FakeEntry[]> => {
      const rel = path.relative('/fake', abs).split(path.sep).join('/')
      if (holding) await gate.promise
      return dirs[rel]
    }
    const index = createFileIndex(() => clock, { probe: reachable, readdir, readFile: async () => '', graceMs: 5 })
    await index.search(ROOT, '', 10)
    dirs[''] = [fileEntry('old.ts'), fileEntry('new.ts')]
    clock += 60_000
    holding = true
    expect(await index.lookup(ROOT, '', 10)).toEqual({ paths: ['old.ts'], indexing: false })
    holding = false
    gate.resolve()
    await index.search(ROOT, '', 10)
    expect((await index.lookup(ROOT, 'new', 10)).paths).toEqual(['new.ts'])
  })

  it('a walk that throws answers empty and does not leave a rejection behind', async () => {
    const index = createFileIndex(Date.now, {
      probe: reachable,
      readdir: async () => {
        throw new Error('EIO')
      },
      readFile: async () => {
        throw new Error('EIO')
      },
      graceMs: 5
    })
    expect(await index.search(ROOT, '', 10)).toEqual([])
    // the root itself not reading means there is no list: the menu says so and stops asking (review I3)
    expect(await index.lookup(ROOT, '', 10)).toEqual({ paths: [], indexing: false, unavailable: true })
  })
})

// Stage 2 final review, I3: on a dead folder the walk never settled, lookup answered `indexing` forever,
// and the `@` menu asked again every 400 ms without end. The root is probed first, and a walk that runs
// past its limit ends as unavailable.
describe('createFileIndex — a root that does not answer', () => {
  const ROOT = path.resolve('/fake')

  it('a root whose probe times out is unavailable at once, with no readdir', async () => {
    const readdir = vi.fn(async (): Promise<FakeEntry[]> => [])
    const index = createFileIndex(Date.now, { probe: async () => 'timeout', readdir, readFile: async () => '', graceMs: 5 })
    expect(await index.lookup(ROOT, '', 10)).toEqual({ paths: [], indexing: false, unavailable: true })
    expect(readdir).not.toHaveBeenCalled()
    // remembered for a while: the next ask does not probe again at once
    expect(await index.lookup(ROOT, 'x', 10)).toEqual({ paths: [], indexing: false, unavailable: true })
  })

  it('a walk stuck past its limit stops saying indexing and says unavailable, with what it found', async () => {
    vi.useFakeTimers()
    try {
      const never = new Promise<FakeEntry[]>(() => {})
      const readdir = async (abs: string): Promise<FakeEntry[]> => {
        const rel = path.relative('/fake', abs).split(path.sep).join('/')
        return rel === '' ? [fileEntry('top.ts'), dirEntry('stuck')] : never
      }
      const index = createFileIndex(Date.now, { probe: reachable, readdir, readFile: async () => '', graceMs: 5, walkTimeoutMs: 1_000 })
      const early = index.lookup(ROOT, '', 10)
      await vi.advanceTimersByTimeAsync(5)
      expect(await early).toEqual({ paths: ['top.ts'], indexing: true })
      const searched = index.search(ROOT, '', 10)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(await searched).toEqual(['top.ts']) // search does not wait on the stuck walk either
      expect(await index.lookup(ROOT, '', 10)).toEqual({ paths: ['top.ts'], indexing: false, unavailable: true })
    } finally {
      vi.useRealTimers()
    }
  })
})

// Performance audit M6: every project root ever searched kept its list (up to 20,000 paths) for the life of the app.
describe('createFileIndex — bounded', () => {
  it('keeps the lists of the most recently searched roots only', async () => {
    const dirs: Record<string, FakeEntry[]> = {}
    for (let i = 0; i <= FILE_INDEX_ROOTS_KEPT; i++) dirs[`p${i}`] = [fileEntry(`f${i}.ts`)]
    const f = fakeFs(dirs)
    const index = createFileIndex(() => 0, { probe: reachable, readdir: f.readdir, readFile: f.readFile })
    for (let i = 0; i <= FILE_INDEX_ROOTS_KEPT; i++) await index.search(path.resolve(`/fake/p${i}`), '', 10)
    await index.search(path.resolve(`/fake/p${FILE_INDEX_ROOTS_KEPT}`), '', 10)
    expect(f.calls.filter((c) => c === `p${FILE_INDEX_ROOTS_KEPT}`)).toHaveLength(1)
    expect(await index.search(path.resolve('/fake/p0'), '', 10)).toEqual(['f0.ts'])
    expect(f.calls.filter((c) => c === 'p0')).toHaveLength(2)
  })
})
