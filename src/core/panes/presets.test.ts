import { describe, expect, it } from 'vitest'
import { leaves, type PaneNode } from './tree'
import type { SavedNode, SavedPanels } from './savedLayout'
import {
  MAX_SAVED_PRESETS,
  applySaved,
  presetPanels,
  presetTree,
  readPresets,
  toPresetsRecord,
  withPreset,
  withoutPreset,
  type SavedPreset
} from './presets'

const shape = (root: PaneNode): string[][] => leaves(root).map((l) => l.tabIds)
const activeTabs = (root: PaneNode): string[] => leaves(root).map((l) => l.activeTabId)
const panels: SavedPanels = { sidebar: { open: true, view: 'explorer' }, bottom: { open: true, tab: 'run' } }
const preset = (name: string, tree: SavedNode | null = null): SavedPreset => ({ name, tree, panels, sidebarWidth: 300, bottomHeight: 260 })

describe('built-in presets', () => {
  it('coding puts files left and sessions right', () => {
    const tabs = ['session:s1', 'file:/p/a.ts', 'record:r1', 'session:s2', 'media:/p/i.png', 'kube:c//pods/Pod/x', 'browser:b1', 'app:s1']
    const r = presetTree('coding', tabs, 'session:s2')!
    expect(r.root.kind === 'split' ? [r.root.dir, r.root.ratio] : null).toEqual(['row', 0.5])
    expect(shape(r.root)).toEqual([
      ['file:/p/a.ts', 'record:r1', 'media:/p/i.png', 'kube:c//pods/Pod/x', 'browser:b1'],
      ['session:s1', 'session:s2', 'app:s1']
    ])
    expect(shape(presetTree('coding', ['session:s1', 'session:s2'], null)!.root)).toEqual([['session:s1', 'session:s2']])
    expect(shape(presetTree('coding', ['file:/p/a.ts'], null)!.root)).toEqual([['file:/p/a.ts']])
  })

  it('agents spreads sessions over up to four groups', () => {
    const sessions = (n: number): string[] => Array.from({ length: n }, (_, i) => `session:s${i + 1}`)
    expect(shape(presetTree('agents', sessions(1), null)!.root)).toEqual([['session:s1']])
    const two = presetTree('agents', sessions(2), null)!.root
    expect(two.kind === 'split' && two.dir).toBe('row')
    expect(shape(two)).toEqual([['session:s1'], ['session:s2']])
    expect(shape(presetTree('agents', sessions(3), null)!.root)).toEqual([['session:s1'], ['session:s2'], ['session:s3']])
    // 2x2: a row of two columns; dealt in tab order, so s1 top left, s2 top right, s3 bottom left, s4 bottom right
    const six = presetTree('agents', ['file:/p/a.ts', ...sessions(6)], null)!.root
    expect(six.kind === 'split' && six.dir).toBe('row')
    expect(six.kind === 'split' && [six.a.kind === 'split' && six.a.dir, six.b.kind === 'split' && six.b.dir]).toEqual(['col', 'col'])
    expect(shape(six)).toEqual([
      ['file:/p/a.ts', 'session:s1', 'session:s5'],
      ['session:s3'],
      ['session:s2', 'session:s6'],
      ['session:s4']
    ])
    expect(shape(presetTree('agents', ['file:/p/a.ts'], null)!.root)).toEqual([['file:/p/a.ts']])
  })

  it('agents keeps the first group in tab order, so a mirror or a file does not jump ahead of its session', () => {
    expect(shape(presetTree('agents', ['session:s1', 'app:s1', 'file:/p/a.ts', 'session:s2'], null)!.root)).toEqual([
      ['session:s1', 'app:s1', 'file:/p/a.ts'],
      ['session:s2']
    ])
  })

  it('review, devops and default keep one group in tab order', () => {
    const tabs = ['session:s1', 'file:/p/a.ts', 'session:s2']
    for (const id of ['review', 'devops', 'default'] as const) expect(shape(presetTree(id, tabs, null)!.root)).toEqual([tabs])
    expect(presetTree('default', [], null)).toBeNull()
  })

  it('keeps the active tab active and its group the active one', () => {
    const r = presetTree('coding', ['session:s1', 'file:/p/a.ts', 'file:/p/b.ts'], 'file:/p/b.ts')!
    expect(activeTabs(r.root)).toEqual(['file:/p/b.ts', 'session:s1'])
    expect(r.activePaneId).toBe(leaves(r.root)[0].id)
    const none = presetTree('coding', ['session:s1', 'file:/p/a.ts'], 'session:gone')!
    expect(activeTabs(none.root)).toEqual(['file:/p/a.ts', 'session:s1'])
    expect(none.activePaneId).toBe(leaves(none.root)[0].id)
  })

  it('the panels each preset shows', () => {
    expect(presetPanels('coding')).toEqual({ sidebar: { open: true, view: 'explorer' }, bottom: { open: true, tab: 'run' } })
    expect(presetPanels('review')).toEqual({ sidebar: { open: true, view: 'jobs' }, bottom: { open: true, tab: 'problems' } })
    expect(presetPanels('agents')).toEqual({ sidebar: { open: true, view: 'sessions' }, bottom: { open: false, tab: 'run' } })
    expect(presetPanels('devops')).toEqual({ sidebar: { open: true, view: 'explorer' }, bottom: { open: true, tab: 'kube' }, bottomHeight: 'tall' })
    expect(presetPanels('default')).toEqual({ sidebar: { open: true, view: 'sessions' }, bottom: { open: false, tab: 'run' } })
  })
})

describe('saved presets', () => {
  it('a saved preset puts open tabs back in its groups and the rest in the first', () => {
    const tree: SavedNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.3,
      a: { kind: 'leaf', tabs: ['file:/p/a.ts', 'session:s1'], active: 'file:/p/a.ts' },
      b: { kind: 'split', dir: 'col', ratio: 0.5, a: { kind: 'leaf', tabs: ['session:s2'], active: 'session:s2' }, b: { kind: 'leaf', tabs: ['session:gone'], active: 'session:gone' } }
    }
    const r = applySaved(preset('mine', tree), ['session:s1', 'session:s2', 'file:/p/a.ts', 'session:new'], 'session:s2')!
    expect(shape(r.root)).toEqual([['file:/p/a.ts', 'session:s1', 'session:new'], ['session:s2']])
    expect(r.root.kind === 'split' ? r.root.ratio : null).toBe(0.3)
    expect(leaves(r.root).find((l) => l.id === r.activePaneId)?.tabIds).toEqual(['session:s2'])
    // A preset none of whose tabs is open still arranges the open ones, in one group
    const none = applySaved(preset('old', tree), ['session:x'], null)!
    expect(shape(none.root)).toEqual([['session:x']])
    expect(applySaved(preset('empty'), [], null)).toBeNull()
  })

  it('puts an app mirror it never saw beside its session, not in the first group', () => {
    const tree: SavedNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: { kind: 'leaf', tabs: ['file:/p/a.ts'], active: 'file:/p/a.ts' },
      b: { kind: 'leaf', tabs: ['session:s1'], active: 'session:s1' }
    }
    const r = applySaved(preset('mine', tree), ['file:/p/a.ts', 'session:s1', 'app:s1', 'app:s9'], 'file:/p/a.ts')!
    expect(shape(r.root)).toEqual([['file:/p/a.ts', 'app:s9'], ['session:s1', 'app:s1']])
    expect(activeTabs(r.root)).toEqual(['file:/p/a.ts', 'session:s1'])
  })

  it('reads saved presets defensively', () => {
    expect(readPresets(null)).toEqual([])
    expect(readPresets('{')).toEqual([])
    expect(readPresets('{"v":2,"presets":[]}')).toEqual([])
    const good = preset('  Mine  ')
    const raw = JSON.stringify({
      v: 1,
      presets: [good, preset('x'.repeat(41)), preset('   '), { ...preset('bad'), panels: 1 }, { ...preset('wide'), sidebarWidth: 9999, bottomHeight: 'tall' }, preset('Mine')]
    })
    const read = readPresets(raw)
    expect(read.map((p) => p.name)).toEqual(['Mine', 'wide'])
    expect(read[1]).toMatchObject({ sidebarWidth: 520, bottomHeight: 220 })
    const many = JSON.stringify({ v: 1, presets: Array.from({ length: 25 }, (_, i) => preset(`p${i}`)) })
    expect(readPresets(many)).toHaveLength(MAX_SAVED_PRESETS)
    expect(readPresets(JSON.stringify(toPresetsRecord([good])))[0].name).toBe('Mine')
  })

  it('a same name replaces, the 21st is refused', () => {
    const list = [preset('a'), preset('b')]
    const replaced = withPreset(list, { ...preset(' a '), sidebarWidth: 400 })
    expect(replaced !== 'full' && replaced.map((p) => [p.name, p.sidebarWidth])).toEqual([['a', 400], ['b', 300]])
    const full = Array.from({ length: MAX_SAVED_PRESETS }, (_, i) => preset(`p${i}`))
    expect(withPreset(full, preset('one more'))).toBe('full')
    expect(withPreset(full, preset('p3'))).not.toBe('full')
    expect(withoutPreset(list, 'a').map((p) => p.name)).toEqual(['b'])
  })
})
