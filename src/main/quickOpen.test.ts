import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'
import { createQuickOpen, QUICK_OPEN_MATCHES } from './quickOpen'
import type { FileIndexAnswer } from './fileIndex'

const ROOT = path.resolve('/proj')
const OTHER = path.resolve('/worktree')

/** An index holding one list per root, the way createFileIndex keys them. */
function fakeIndex(lists: Record<string, FileIndexAnswer>) {
  return { lookup: vi.fn(async (root: string) => lists[root] ?? { paths: [], indexing: false }) }
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
    await expect(ask(ROOT, 'a')).rejects.toThrow('not allowed')
    expect(index.lookup).not.toHaveBeenCalled()
  })

  it('refuses arguments that are not a root and a query', async () => {
    const index = fakeIndex({})
    const ask = createQuickOpen({ index, allowedRoot: allowAll })
    await expect(ask(42, 'a')).rejects.toThrow()
    await expect(ask('', 'a')).rejects.toThrow()
    await expect(ask(ROOT, null)).rejects.toThrow()
    await expect(ask(ROOT, 'x'.repeat(257))).rejects.toThrow()
    expect(index.lookup).not.toHaveBeenCalled()
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
