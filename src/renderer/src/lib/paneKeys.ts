// Where the tab and pane keys go: Ctrl+Tab and Ctrl+PageUp/Down cycle the tabs of the active group, Ctrl+Shift+arrow
// moves to the neighbouring group. With one group, Ctrl+Shift+left/right cycle its tabs as well, which is how they
// felt before panes could be split; with a split, a direction that has no neighbour goes nowhere rather than
// cycling, so the key passes on to the terminal. Both wrap around. Null means there is nothing to do.

import type { ActionId } from '../../../core/keys/binding'
import { countLeaves, findNeighbor, firstLeaf, leafOf, type MoveDir, type PaneNode } from '../../../core/panes/tree'

export type PaneKeyTarget = { kind: 'pane'; paneId: string } | { kind: 'tab'; tabId: string }

export function paneKeyTarget(action: ActionId, layout: PaneNode | null, activePaneId: string | null): PaneKeyTarget | null {
  const focusMove = action.startsWith('pane.focus')
  if (!focusMove && action !== 'sessionTab.prev' && action !== 'sessionTab.next') return null
  const delta = action === 'sessionTab.prev' || action === 'pane.focusLeft' || action === 'pane.focusUp' ? -1 : 1
  const vertical = action === 'pane.focusUp' || action === 'pane.focusDown'
  if (focusMove && layout && activePaneId && countLeaves(layout) >= 2) {
    const dir: MoveDir = vertical ? (delta < 0 ? 'up' : 'down') : delta < 0 ? 'left' : 'right'
    const next = findNeighbor(layout, activePaneId, dir)
    return next ? { kind: 'pane', paneId: next } : null
  }
  if (vertical) return null // unsplit, there is no cycling up or down
  const group = layout && ((activePaneId && leafOf(layout, activePaneId)) || firstLeaf(layout))
  if (!group || group.tabIds.length < 2) return null
  const i = group.tabIds.indexOf(group.activeTabId)
  if (i < 0) return null
  const n = group.tabIds.length
  return { kind: 'tab', tabId: group.tabIds[(i + delta + n) % n] }
}
