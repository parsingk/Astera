import { describe, it, expect } from 'vitest'
import { activateTab, addTab, createGroup, splitAndMove, type PaneNode } from '../../../core/panes/tree'
import { paneKeyTarget } from './paneKeys'

/** One group holding the given tabs, the given one active. */
function group(tabs: string[], active: string): PaneNode {
  let root: PaneNode = createGroup(tabs[0])
  for (const t of tabs.slice(1)) root = addTab(root, root.id, t)
  return activateTab(root, active)!.root
}

describe('paneKeyTarget, one group', () => {
  const root = group(['a', 'b', 'c'], 'b')

  it('cycles the tabs left and right, wrapping, for tab and pane keys alike', () => {
    expect(paneKeyTarget('sessionTab.next', root, root.id)).toEqual({ kind: 'tab', tabId: 'c' })
    expect(paneKeyTarget('sessionTab.prev', root, root.id)).toEqual({ kind: 'tab', tabId: 'a' })
    expect(paneKeyTarget('pane.focusRight', root, root.id)).toEqual({ kind: 'tab', tabId: 'c' })
    expect(paneKeyTarget('pane.focusLeft', root, root.id)).toEqual({ kind: 'tab', tabId: 'a' })
    const last = activateTab(root, 'c')!.root
    expect(paneKeyTarget('sessionTab.next', last, last.id)).toEqual({ kind: 'tab', tabId: 'a' })
  })

  it('has nothing up or down, and nothing to cycle with one tab', () => {
    expect(paneKeyTarget('pane.focusUp', root, root.id)).toBeNull()
    expect(paneKeyTarget('pane.focusDown', root, root.id)).toBeNull()
    const single = group(['a'], 'a')
    expect(paneKeyTarget('sessionTab.next', single, single.id)).toBeNull()
  })

  it('uses the first group when no pane is active, and nothing when there is no layout', () => {
    expect(paneKeyTarget('sessionTab.next', root, null)).toEqual({ kind: 'tab', tabId: 'c' })
    expect(paneKeyTarget('sessionTab.next', null, null)).toBeNull()
  })
})

describe('paneKeyTarget, split', () => {
  // left group (a, b) | right group (c)
  const start = group(['a', 'b', 'c'], 'c')
  const split = splitAndMove(start, 'c', start.id, 'row', false)!
  const left = start.id
  const right = split.paneId

  it('moves to the neighbouring pane in that direction', () => {
    expect(paneKeyTarget('pane.focusRight', split.root, left)).toEqual({ kind: 'pane', paneId: right })
    expect(paneKeyTarget('pane.focusLeft', split.root, right)).toEqual({ kind: 'pane', paneId: left })
  })

  it('has nothing where there is no neighbour, and does not fall back to cycling tabs', () => {
    expect(paneKeyTarget('pane.focusLeft', split.root, left)).toBeNull()
    expect(paneKeyTarget('pane.focusUp', split.root, left)).toBeNull()
  })

  it('still cycles tabs within the active group for the tab keys', () => {
    const r = activateTab(split.root, 'a')!.root
    expect(paneKeyTarget('sessionTab.next', r, left)).toEqual({ kind: 'tab', tabId: 'b' })
  })
})
