import { describe, it, expect } from 'vitest'
import type { RunConfig } from './types'
import type { ConfigDraft } from './draft'
import { draftOf, editItem, addItem, removeItem, duplicateItem, commitList, dirtyOf, sameConfig, isSeedId, moveItem, canMoveItem, setFolder, renameFolder, folderNamesOf } from './draft'

const dev: RunConfig = { id: 'user:1', name: 'dev', type: 'npm', script: 'dev' }
const build: RunConfig = { id: 'user:2', name: 'build', type: 'npm', script: 'build' }
const seedTest: RunConfig = { id: 'seed:npm:test', name: 'test', type: 'npm', script: 'test' }
const merged = [dev, build, seedTest]
const stored = [dev, build]
let n = 0
const newId = (): string => `user:new-${(n += 1)}`

describe('draftOf / commitList', () => {
  it('starts from the merged list and commits without the seeds', () => {
    const d = draftOf(merged)
    expect(d.items).toEqual(merged)
    expect(commitList(d)).toEqual([dev, build])
  })
})

describe('editItem', () => {
  it('replaces a stored item in place, keeping its id', () => {
    const { draft, id } = editItem(draftOf(merged), 'user:1', { ...dev, id: 'ignored', script: 'start' }, newId)
    expect(id).toBe('user:1')
    expect(draft.items[0]).toEqual({ ...dev, script: 'start' })
    expect(draft.items).toHaveLength(3)
  })

  // A seed is detected, never stored: the first edit promotes it to a user configuration that takes
  // the seed's place in the list, so the tree shows the copy where the seed was.
  it('promotes a seed into a user copy that takes its place', () => {
    const { draft, id } = editItem(draftOf(merged), 'seed:npm:test', { ...seedTest, script: 'test:ci' }, () => 'user:promoted')
    expect(id).toBe('user:promoted')
    expect(draft.items[2]).toEqual({ ...seedTest, id: 'user:promoted', script: 'test:ci' })
    expect(draft.items.some((c) => c.id === 'seed:npm:test')).toBe(false)
    expect(commitList(draft)).toHaveLength(3)
  })

  it('leaves the draft alone for an unknown id', () => {
    const d = draftOf(merged)
    expect(editItem(d, 'user:nope', dev, newId)).toEqual({ draft: d, id: 'user:nope' })
  })
})

describe('addItem / removeItem / duplicateItem', () => {
  it('appends a draft-only configuration', () => {
    const added: RunConfig = { id: 'user:3', name: 'lint', type: 'npm', script: 'lint' }
    expect(addItem(draftOf(merged), added).items.at(-1)).toEqual(added)
  })

  it('removes a stored item, and refuses to remove a seed', () => {
    const d = draftOf(merged)
    expect(removeItem(d, 'user:1').items.map((c) => c.id)).toEqual(['user:2', 'seed:npm:test'])
    expect(removeItem(d, 'seed:npm:test')).toBe(d)
  })

  it('duplicates after the original, with a new id and a unique name', () => {
    const d = duplicateItem(draftOf(merged), 'user:1', 'user:copy')
    expect(d.items.map((c) => c.id)).toEqual(['user:1', 'user:copy', 'user:2', 'seed:npm:test'])
    expect(d.items[1]).toMatchObject({ id: 'user:copy', type: 'npm', script: 'dev' })
    expect(d.items[1].name).not.toBe('dev')
    expect(d.items.map((c) => c.name).filter((x) => x === d.items[1].name)).toHaveLength(1)
  })

  it('duplicating a seed yields a user configuration', () => {
    const d = duplicateItem(draftOf(merged), 'seed:npm:test', 'user:copy')
    expect(isSeedId(d.items[3].id)).toBe(false)
    expect(commitList(d).map((c) => c.id)).toEqual(['user:1', 'user:2', 'user:copy'])
  })
})

describe('sameConfig', () => {
  // The form rebuilds objects by spreading, so key order drifts from what the disk holds — the
  // comparison must not read that as a change.
  it('ignores key order and treats undefined fields as absent', () => {
    expect(sameConfig({ id: 'a', name: 'x', type: 'npm', script: 's' }, { type: 'npm', script: 's', name: 'x', id: 'a' })).toBe(true)
    expect(sameConfig({ id: 'a', name: 'x', type: 'npm', script: 's', cwd: undefined }, { id: 'a', name: 'x', type: 'npm', script: 's' })).toBe(true)
    expect(sameConfig({ id: 'a', name: 'x', type: 'npm', script: 's', env: { A: '1' } }, { id: 'a', name: 'x', type: 'npm', script: 's', env: { A: '2' } })).toBe(false)
  })
})

describe('dirtyOf', () => {
  it('is clean right after opening', () => {
    expect(dirtyOf(draftOf(merged), stored)).toEqual({ dirty: false, ids: new Set(), deleted: [] })
  })

  it('names an edited item', () => {
    const { draft } = editItem(draftOf(merged), 'user:1', { ...dev, script: 'start' }, newId)
    expect(dirtyOf(draft, stored)).toEqual({ dirty: true, ids: new Set(['user:1']), deleted: [] })
  })

  it('names an added item and a promoted seed', () => {
    const a = addItem(draftOf(merged), { id: 'user:3', name: 'lint', type: 'npm', script: 'lint' })
    const { draft } = editItem(a, 'seed:npm:test', { ...seedTest, script: 'test:ci' }, () => 'user:promoted')
    expect(dirtyOf(draft, stored)).toEqual({ dirty: true, ids: new Set(['user:3', 'user:promoted']), deleted: [] })
  })

  it('reports a deletion separately — there is no row left to mark', () => {
    expect(dirtyOf(removeItem(draftOf(merged), 'user:2'), stored)).toEqual({ dirty: true, ids: new Set(), deleted: ['user:2'] })
  })

  // Tree order is store order (the toolbar's menu follows it), so a reorder alone is a change
  it('is order-sensitive', () => {
    expect(dirtyOf({ items: [build, dev, seedTest] }, stored).dirty).toBe(true)
  })

  it('a ＋ followed by nothing leaves the baseline untouched', () => {
    const d = addItem(draftOf(merged), { id: 'user:3', name: 'lint', type: 'npm', script: 'lint' })
    expect(stored).toEqual([dev, build])
    expect(dirtyOf(draftOf(merged), stored).dirty).toBe(false)
    expect(dirtyOf(d, stored).dirty).toBe(true)
  })
})

const fdev: RunConfig = { id: 'user:1', name: 'dev', type: 'npm', script: 'dev', folder: 'F' }
const fbuild: RunConfig = { id: 'user:2', name: 'build', type: 'npm', script: 'build', folder: 'F' }
const loose: RunConfig = { id: 'user:3', name: 'lint', type: 'npm', script: 'lint' }
const seedT: RunConfig = { id: 'seed:npm:test', name: 'test', type: 'npm', script: 'test' }

describe('moveItem / canMoveItem', () => {
  // The two items swap; anything between them, belonging to another group, stays put
  it('swaps with the neighbour in the same group, across an intervening group', () => {
    const d = draftOf([fdev, loose, fbuild])
    expect(moveItem(d, 'user:2', -1).items.map((c) => c.id)).toEqual(['user:2', 'user:3', 'user:1'])
    expect(canMoveItem(d, 'user:2', -1)).toBe(true)
  })

  it('is a no-op at a group edge', () => {
    const d = draftOf([fdev, fbuild, loose])
    expect(moveItem(d, 'user:1', -1)).toBe(d)
    expect(canMoveItem(d, 'user:1', -1)).toBe(false)
    expect(moveItem(d, 'user:2', 1)).toBe(d)
    expect(canMoveItem(d, 'user:2', 1)).toBe(false)
  })

  // A seed's position is never stored, so moving one would be an edit Apply cannot keep
  it('refuses to move a seed', () => {
    const d = draftOf([seedT, loose])
    expect(moveItem(d, 'seed:npm:test', 1)).toBe(d)
    expect(canMoveItem(d, 'seed:npm:test', 1)).toBe(false)
  })

  it('is a no-op for an unknown id', () => {
    const d = draftOf([fdev])
    expect(moveItem(d, 'user:nope', 1)).toBe(d)
  })
})

describe('setFolder', () => {
  it('files a configuration and keeps its id', () => {
    const { draft, id } = setFolder(draftOf([loose]), 'user:3', 'F', () => 'unused')
    expect(id).toBe('user:3')
    expect(draft.items[0]).toEqual({ ...loose, folder: 'F' })
  })

  it('an empty name takes it out of the folder, leaving no empty string behind', () => {
    const { draft } = setFolder(draftOf([fdev]), 'user:1', '', () => 'unused')
    expect(draft.items[0]).toEqual({ id: 'user:1', name: 'dev', type: 'npm', script: 'dev' })
    expect('folder' in draft.items[0]).toBe(false)
  })

  // Filing a seed is an edit, and an edit to a seed promotes it — 3a's rule
  it('promotes a seed and returns the new id', () => {
    const { draft, id } = setFolder(draftOf([seedT]), 'seed:npm:test', 'F', () => 'user:promoted')
    expect(id).toBe('user:promoted')
    expect(draft.items[0]).toEqual({ ...seedT, id: 'user:promoted', folder: 'F' })
  })
})

describe('renameFolder', () => {
  it('rewrites every member and leaves other groups alone', () => {
    const d = renameFolder(draftOf([fdev, loose, fbuild]), 'F', 'Frontend')
    expect(d.items.map((c) => c.folder)).toEqual(['Frontend', undefined, 'Frontend'])
  })

  it('an empty target takes them all out of the folder', () => {
    const d = renameFolder(draftOf([fdev, fbuild]), 'F', '')
    expect(d.items.every((c) => !('folder' in c))).toBe(true)
  })

  // The folder IS the value, so renaming onto another name is a merge — the honest result
  it('renaming onto an existing folder merges them', () => {
    const other: RunConfig = { id: 'user:4', name: 'x', type: 'npm', script: 'x', folder: 'G' }
    const d = renameFolder(draftOf([fdev, other]), 'F', 'G')
    expect(d.items.map((c) => c.folder)).toEqual(['G', 'G'])
  })

  it('is a no-op when no configuration is in that folder', () => {
    const d = draftOf([loose])
    expect(renameFolder(d, 'F', 'G')).toBe(d)
  })
})

describe('folderNamesOf', () => {
  it('lists each folder once, in the order it first appears', () => {
    const g: RunConfig = { id: 'user:5', name: 'y', type: 'npm', script: 'y', folder: 'G' }
    expect(folderNamesOf(draftOf([fdev, g, fbuild, loose]))).toEqual(['F', 'G'])
  })
})

describe('commitList — the folder field', () => {
  it('drops an empty folder rather than storing one', () => {
    const d: ConfigDraft = { items: [{ ...loose, folder: '' }] }
    expect('folder' in commitList(d)[0]).toBe(false)
  })
})
