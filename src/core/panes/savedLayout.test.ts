import { describe, expect, it } from 'vitest'
import { addTab, createGroup, leaves, splitAndMove, type PaneNode } from './tree'
import { mergeTabs, readSaved, restoreTree, toSaved, type SavedNode, type SavedPanels, type SavedTabs } from './savedLayout'

const panels: SavedPanels = { sidebar: { open: true, view: 'explorer' }, bottom: { open: true, tab: 'problems' } }
const noTabs: SavedTabs = { files: {}, records: {}, browsers: {} }
const keepAll = (): boolean => true
/** Each group's tabs and active tab, in leaf order. */
const shape = (root: PaneNode): Array<[string[], string]> => leaves(root).map((l) => [l.tabIds, l.activeTabId])
const leaf = (tabs: string[], active = tabs[0]): SavedNode => ({ kind: 'leaf', tabs, active })
/** A stored record around `tree`, as JSON, for readSaved. */
const stored = (tree: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, tree, active: 0, panels, tabs: noTabs, ...extra })

describe('saved layout', () => {
  it('round-trips a two-group layout', () => {
    const g = createGroup('session:s1')
    const withFile = addTab(g, g.id, 'file:/p/a.ts')
    const split = splitAndMove(withFile, 'session:s2', g.id, 'row', false)!
    const tabs: SavedTabs = { ...noTabs, files: { 'file:/p/a.ts': { path: '/p/a.ts', projectRoot: '/p' } } }
    const saved = readSaved(JSON.stringify(toSaved(split.root, split.paneId, panels, tabs)))!
    expect(saved.panels).toEqual(panels)
    expect(saved.tabs).toEqual(tabs)
    const back = restoreTree(saved.tree, saved.active, keepAll)!
    expect(shape(back.root)).toEqual(shape(split.root))
    expect(back.root.kind === 'split' ? [back.root.dir, back.root.ratio] : null).toEqual(
      split.root.kind === 'split' ? [split.root.dir, split.root.ratio] : null
    )
    expect(leaves(back.root).findIndex((l) => l.id === back.activePaneId)).toBe(
      leaves(split.root).findIndex((l) => l.id === split.paneId)
    )
  })

  it('reads junk, another version or a thrown parse as nothing saved', () => {
    for (const raw of [null, '', '{', '[]', 'null', '{"v":2}', '{"v":1}', stored(leaf(['session:s1']), { v: 2 })]) {
      expect(readSaved(raw)).toBeNull()
    }
  })

  it('skips tabs it cannot read or keep, and collapses the groups they leave empty', () => {
    const tree: SavedNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.3,
      a: leaf(['plugin:x', 'session:dead']),
      b: leaf(['session:s1', 'nonsense'])
    }
    const back = restoreTree(tree, 1, (id) => id !== 'session:dead')!
    expect(back.root.kind).toBe('leaf')
    expect(shape(back.root)).toEqual([[['session:s1'], 'session:s1']])
    expect(back.activePaneId).toBe(leaves(back.root)[0].id)
    expect(restoreTree(leaf(['plugin:x']), 0, keepAll)).toBeNull()
    expect(restoreTree(null, -1, keepAll)).toBeNull()
  })

  it('keeps a tab in the first group that names it', () => {
    const tree: SavedNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: leaf(['session:s1', 'file:/p/a.ts'], 'file:/p/a.ts'),
      b: leaf(['file:/p/a.ts', 'session:s2'], 'file:/p/a.ts')
    }
    const back = restoreTree(tree, 0, keepAll)!
    expect(shape(back.root)).toEqual([
      [['session:s1', 'file:/p/a.ts'], 'file:/p/a.ts'],
      [['session:s2'], 'session:s2']
    ])
  })

  it('falls back to the first tab and the first group', () => {
    const lost = restoreTree(leaf(['session:s1', 'session:s2'], 'session:gone'), 5, keepAll)!
    expect(shape(lost.root)).toEqual([[['session:s1', 'session:s2'], 'session:s1']])
    expect(lost.activePaneId).toBe(leaves(lost.root)[0].id)
    const refused = restoreTree(leaf(['session:s1', 'session:s2'], 'session:s2'), 0, (id) => id !== 'session:s2')!
    expect(shape(refused.root)).toEqual([[['session:s1'], 'session:s1']])
    // The active group is the one dropped: the first that is left takes its place
    const tree: SavedNode = { kind: 'split', dir: 'col', ratio: 0.5, a: leaf(['session:s1']), b: leaf(['session:dead']) }
    const gone = restoreTree(tree, 1, (id) => id !== 'session:dead')!
    expect(gone.activePaneId).toBe(leaves(gone.root)[0].id)
  })

  it('keeps the saved active group when it is still there', () => {
    const tree: SavedNode = { kind: 'split', dir: 'row', ratio: 0.5, a: leaf(['session:dead']), b: leaf(['session:s1']) }
    const tree2: SavedNode = { kind: 'split', dir: 'row', ratio: 0.5, a: tree, b: leaf(['session:s2']) }
    const back = restoreTree(tree2, 1, (id) => id !== 'session:dead')!
    expect(leaves(back.root).find((l) => l.id === back.activePaneId)?.tabIds).toEqual(['session:s1'])
  })

  it('clamps what tampering could put there', () => {
    const ratioOf = (ratio: unknown): number | null => {
      const s = readSaved(stored({ kind: 'split', dir: 'col', ratio, a: leaf(['session:s1']), b: leaf(['session:s2']) }))
      return s?.tree?.kind === 'split' ? s.tree.ratio : null
    }
    expect(ratioOf(7)).toBe(0.9)
    expect(ratioOf(-1)).toBe(0.1)
    expect(ratioOf(null)).toBe(0.5)
    expect(ratioOf('x')).toBe(0.5)
    // Five groups: more than MAX_PANES
    const five = ['s1', 's2', 's3', 's4', 's5'].map((s) => leaf([`session:${s}`]))
    const deep = five.reduce((acc: unknown, l) => (acc === null ? l : { kind: 'split', dir: 'row', ratio: 0.5, a: acc, b: l }), null)
    expect(readSaved(stored(deep))).toBeNull()
    expect(readSaved(stored(leaf(Array.from({ length: 501 }, (_, i) => `session:s${i}`))))).toBeNull()
    expect(readSaved(stored({ kind: 'leaf', tabs: ['session:s1', 7], active: 'session:s1' }))).toBeNull()
    expect(readSaved(stored({ kind: 'split', dir: 'up', ratio: 0.5, a: leaf(['session:s1']), b: leaf(['session:s2']) }))).toBeNull()
    expect(readSaved(stored({ kind: 'leaf', tabs: [], active: '' }))).toBeNull()
    expect(readSaved(stored(leaf(['session:s1']), { tabs: { files: { 'file:/a': { path: 1 } }, records: {}, browsers: {} } }))).toBeNull()
  })

  it('reads a panel value it does not know as the default, so a newer version does not lose the record', () => {
    const s = readSaved(stored(leaf(['session:s1']), { panels: { sidebar: { open: true, view: 'plugins' }, bottom: { open: false, tab: 'terminal-3' } } }))!
    expect(s.panels).toEqual({ sidebar: { open: true, view: 'sessions' }, bottom: { open: false, tab: 'run' } })
    expect(readSaved(stored(leaf(['session:s1']), { panels: { sidebar: { open: 'yes', view: 'jobs' }, bottom: { open: false, tab: 'run' } } }))).toBeNull()
  })

  it("gives restored groups ids that never meet createGroup's", () => {
    const tree: SavedNode = { kind: 'split', dir: 'row', ratio: 0.5, a: leaf(['session:s1']), b: leaf(['session:s2']) }
    const back = restoreTree(tree, 0, keepAll)!
    const later = createGroup('session:s9')
    const ids = [...leaves(back.root).map((l) => l.id), ...(back.root.kind === 'split' ? [back.root.id] : [])]
    expect(ids).not.toContain(later.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  // Final review M7: a record readSaved would refuse whole must never be written
  it('saves at most 500 tabs a group, so a long run does not cost the next start its whole layout', () => {
    const tabs = Array.from({ length: 600 }, (_, i) => `session:s${i}`)
    const g = createGroup(tabs[0])
    const root = { ...g, tabIds: tabs, activeTabId: 'session:s550' }
    const saved = toSaved(root, g.id, panels, noTabs)
    expect(saved.tree?.kind === 'leaf' && [saved.tree.tabs.length, saved.tree.active]).toEqual([500, 'session:s0'])
    expect(readSaved(JSON.stringify(saved))).not.toBeNull()
  })

  // Final review C1: whatever reached the window while the restore waited stays in it
  it('merges the tabs already on screen into a restored tree, behind its first group’s active tab', () => {
    const restored: SavedNode = { kind: 'split', dir: 'row', ratio: 0.5, a: leaf(['file:/p/a.ts']), b: leaf(['session:s1']) }
    const back = restoreTree(restored, 0, keepAll)!
    // On screen meanwhile: s1 (also restored, so not added twice), and a session and an agent preview that arrived
    const g = createGroup('session:s1')
    const now = addTab(addTab(g, g.id, 'session:new'), g.id, 'browser:agent')
    const merged = mergeTabs(back.root, now)
    expect(shape(merged)).toEqual([
      [['file:/p/a.ts', 'session:new', 'browser:agent'], 'file:/p/a.ts'],
      [['session:s1'], 'session:s1']
    ])
    expect(mergeTabs(back.root, null)).toBe(back.root)
  })

  it('saves no app mirror or remote session tab, and no info for a tab not in the tree', () => {
    const g = createGroup('session:s1')
    const root = addTab(addTab(g, g.id, 'app:s1'), g.id, 'session:rt1:s5')
    const tabs: SavedTabs = { ...noTabs, files: { 'file:/p/gone.ts': { path: '/p/gone.ts', projectRoot: '/p' } } }
    const saved = toSaved(root, g.id, panels, tabs)
    expect(saved.tree).toEqual({ kind: 'leaf', tabs: ['session:s1'], active: 'session:s1' })
    expect(saved.tabs.files).toEqual({})
    expect(toSaved(null, null, panels, noTabs)).toMatchObject({ v: 1, tree: null, active: -1 })
  })
})
