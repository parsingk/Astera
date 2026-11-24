import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { createQuickOpen, QUICK_OPEN_MATCHES } from './quickOpen'
import type { FileIndexAnswer } from './fileIndex'

const ROOT = path.resolve('/proj')
const OTHER = path.resolve('/worktree')

/** An index holding one list per root, the way createFileIndex keys them. */
function fakeIndex(lists: Record<string, FileIndexAnswer>) {
  const calls: string[] = []
  return {
    calls,
    lookup: vi.fn(async (root: string) => {
      calls.push(`lookup ${root}`)
      return lists[root] ?? { paths: [], indexing: false }
    }),
    expire: vi.fn((root: string) => {
      calls.push(`expire ${root}`)
    })
  }
}
const allowAll = async (p: string): Promise<string> => p

describe('createQuickOpen', () => {
  it('refuses a root the path guard refuses, and reads nothing', async () => {
    const index = fakeIndex({})
    const ask = createQuickOpen({
      index,
      allowedRoot: async () => {
        throw new Error('not allowed')
      }
    })
    await expect(ask(ROOT, 'a', true)).rejects.toThrow('not allowed')
    expect(index.lookup).not.toHaveBeenCalled()
    expect(index.expire).not.toHaveBeenCalled()
  })

  // The box asks for a fresh list as it opens (the watcher runs only while the explorer is open); typing does not.
  it('walks the project again when asked to refresh, before answering, and only then', async () => {
    const index = fakeIndex({ [ROOT]: { paths: ['a.ts'], indexing: false } })
    const ask = createQuickOpen({ index, allowedRoot: allowAll })
    await ask(ROOT, '', true)
    await ask(ROOT, 'a')
    await ask(ROOT, 'a', 'yes')
    expect(index.calls).toEqual([`expire ${ROOT}`, `lookup ${ROOT}`, `lookup ${ROOT}`, `lookup ${ROOT}`])
  })

  it('refuses arguments that are not a root and a query', async () => {
    const index = fakeIndex({})
    const ask = createQuickOpen({ index, allowedRoot: allowAll })
    await expect(ask(42, 'a')).rejects.toThrow()
    await expect(ask('', 'a')).rejects.toThrow()
    await expect(ask(ROOT, null)).rejects.toThrow()
    expect(index.lookup).not.toHaveBeenCalled()
  })

  // Review: a pasted wall of text read as "Could not list this folder's files". No file name is that long, so the honest
  // answer is no match.
  it('answers no match for a query longer than any file name, without asking the index', async () => {
    const index = fakeIndex({ [ROOT]: { paths: ['a.ts'], indexing: false } })
    const ask = createQuickOpen({ index, allowedRoot: allowAll })
    expect(await ask(ROOT, 'x'.repeat(257))).toEqual({ paths: [], indexing: false })
    expect(index.lookup).not.toHaveBeenCalled()
  })

  // The box keeps asking while the held list answers during a re-walk, and says when a large project was cut.
  it('passes on that the list is being refreshed, or was cut at the cap', async () => {
    const ask = createQuickOpen({
      index: fakeIndex({ [ROOT]: { paths: ['a.ts'], indexing: false, refreshing: true, truncated: true } }),
      allowedRoot: allowAll
    })
    expect(await ask(ROOT, '')).toEqual({ paths: [path.join(ROOT, 'a.ts')], indexing: false, refreshing: true, truncated: true })
  })

  // The explorer names a file path.join(folder, name) in main (files.list), and a tab is keyed by that exact string, so
  // a file opened from here and from the explorer has to be named the same way to be one tab.
  it('answers absolute paths joined the way the explorer names them, in the index order', async () => {
    const ask = createQuickOpen({
      index: fakeIndex({ [ROOT]: { paths: ['src/app.ts', 'README.md'], indexing: true } }),
      allowedRoot: allowAll
    })
    expect(await ask(ROOT, 'a')).toEqual({
      paths: [path.join(ROOT, 'src', 'app.ts'), path.join(ROOT, 'README.md')],
      indexing: true
    })
  })

  it('passes on that the list is unavailable', async () => {
    const ask = createQuickOpen({
      index: fakeIndex({ [ROOT]: { paths: [], indexing: false, unavailable: true } }),
      allowedRoot: allowAll
    })
    expect(await ask(ROOT, '')).toEqual({ paths: [], indexing: false, unavailable: true })
  })

  // A worktree is its own root: what one project holds never answers for another.
  it('asks the index for the root it was given, with its own cap', async () => {
    const index = fakeIndex({
      [ROOT]: { paths: ['main.ts'], indexing: false },
      [OTHER]: { paths: ['branch.ts'], indexing: false }
    })
    const ask = createQuickOpen({ index, allowedRoot: allowAll })
    expect((await ask(OTHER, '')).paths).toEqual([path.join(OTHER, 'branch.ts')])
    expect(index.lookup).toHaveBeenCalledWith(OTHER, '', QUICK_OPEN_MATCHES)
  })
})
