/** Session pane layout tree.
 *
 *  computeRects flattens the layout into percentages and the renderer (PaneGrid) positions
 *  everything absolutely — drawing the tree as nested DOM would change the DOM parent of a
 *  terminal slot on every split, so React would unmount->remount it and the xterm instance
 *  and its scrollback would be lost.
 *  This module knows nothing about the DOM (core convention). */

import { reorder } from '../reorder'

export type PaneDir = 'row' | 'col'

export type PaneLeaf = {
  kind: 'leaf'
  id: string
  /** Tab order within this group. Never empty — when the last tab leaves, the group itself disappears from the tree */
  sessionIds: string[]
  /** The group's active tab. Always one of sessionIds */
  activeSessionId: string
}
export type PaneSplit = {
  kind: 'split'
  id: string
  dir: PaneDir
  /** Fraction taken by a, in [0,1]. The left side for row, the top side for col. */
  ratio: number
  a: PaneNode
  b: PaneNode
}
export type PaneNode = PaneLeaf | PaneSplit

/** Upper bound on how many panes can be open at once */
export const MAX_PANES = 4
/** Minimum width/height in pixels for a single pane — any narrower and a terminal stops being usable */
export const MIN_PANE_PX = 240

let seq = 0
function nextId(): string {
  return `pane-${++seq}`
}

export function createGroup(sessionId: string): PaneLeaf {
  return { kind: 'leaf', id: nextId(), sessionIds: [sessionId], activeSessionId: sessionId }
}

export function leaves(node: PaneNode): PaneLeaf[] {
  return node.kind === 'leaf' ? [node] : [...leaves(node.a), ...leaves(node.b)]
}

export function countLeaves(node: PaneNode): number {
  return leaves(node).length
}

export function leafOf(root: PaneNode, paneId: string): PaneLeaf | null {
  return leaves(root).find((l) => l.id === paneId) ?? null
}

/** The group a session belongs to. At most one, thanks to invariant 1 (a session lives in exactly one group). */
export function groupOfSession(root: PaneNode, sessionId: string): PaneLeaf | null {
  return leaves(root).find((l) => l.sessionIds.includes(sessionId)) ?? null
}

export function firstLeaf(node: PaneNode): PaneLeaf {
  return node.kind === 'leaf' ? node : firstLeaf(node.a)
}

/** Recursively substitutes nodes. If fn returns a different reference, that node's children are
 *  not walked — the replacement already carries the subtree we want (setRatio relies on this). */
function mapNode(node: PaneNode, fn: (n: PaneNode) => PaneNode): PaneNode {
  const mapped = fn(node)
  if (mapped !== node) return mapped
  if (node.kind === 'leaf') return node
  const a = mapNode(node.a, fn)
  const b = mapNode(node.b, fn)
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** The leaf with one tab removed. null if it was the last tab (meaning the group must disappear).
 *  If the removed tab was the active one, the tab that took its slot becomes active, or the
 *  previous one if there is none — the browser/IntelliJ convention. */
function withoutTab(leaf: PaneLeaf, sessionId: string): PaneLeaf | null {
  const i = leaf.sessionIds.indexOf(sessionId)
  if (i < 0) return leaf
  const rest = leaf.sessionIds.filter((s) => s !== sessionId)
  if (rest.length === 0) return null
  const active =
    leaf.activeSessionId === sessionId ? (rest[i] ?? rest[i - 1]) : leaf.activeSessionId
  return { ...leaf, sessionIds: rest, activeSessionId: active }
}

/** Removes a group from the tree and promotes its sibling into the parent's slot. null if that group was the whole root. */
function dropGroup(root: PaneNode, paneId: string): PaneNode | null {
  if (root.kind === 'leaf') return root.id === paneId ? null : root
  return liftSibling(root, paneId)
}

function liftSibling(node: PaneSplit, paneId: string): PaneNode {
  if (node.a.kind === 'leaf' && node.a.id === paneId) return node.b
  if (node.b.kind === 'leaf' && node.b.id === paneId) return node.a
  const a = node.a.kind === 'split' ? liftSibling(node.a, paneId) : node.a
  const b = node.b.kind === 'split' ? liftSibling(node.b, paneId) : node.b
  return a === node.a && b === node.b ? node : { ...node, a, b }
}

/** The sibling subtree of the paneId group. null when the tree is unsplit or the id does not exist. */
function siblingOf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === 'leaf') return null
  if (node.a.kind === 'leaf' && node.a.id === paneId) return node.b
  if (node.b.kind === 'leaf' && node.b.id === paneId) return node.a
  return siblingOf(node.a, paneId) ?? siblingOf(node.b, paneId)
}

export function setRatio(root: PaneNode, splitId: string, ratio: number): PaneNode {
  return mapNode(root, (n) => (n.kind === 'split' && n.id === splitId ? { ...n, ratio } : n))
}

/** Inserts a tab at the group's insertBefore position (the end by default) and makes it the active tab.
 *  Caller contract: sessionId must not be in the tree yet (use moveTab if it already is). */
export function addTab(
  root: PaneNode,
  paneId: string,
  sessionId: string,
  insertBefore?: number
): PaneNode {
  return mapNode(root, (n) => {
    if (n.kind !== 'leaf' || n.id !== paneId) return n
    const ids = n.sessionIds.slice()
    const at = Math.min(Math.max(insertBefore ?? ids.length, 0), ids.length)
    ids.splice(at, 0, sessionId)
    return { ...n, sessionIds: ids, activeSessionId: sessionId }
  })
}

/** Makes the session the active tab of the group it belongs to, and returns that group's id
 *  alongside. App makes the returned paneId the active pane. */
export function activateTab(
  root: PaneNode,
  sessionId: string
): { root: PaneNode; paneId: string } | null {
  const g = groupOfSession(root, sessionId)
  if (!g) return null
  if (g.activeSessionId === sessionId) return { root, paneId: g.id }
  return {
    root: mapNode(root, (n) => (n === g ? { ...g, activeSessionId: sessionId } : n)),
    paneId: g.id
  }
}

/** Removes a tab. Promotes the sibling if the group empties, and returns null if it was the last tab in the whole tree. */
export function removeTab(root: PaneNode, sessionId: string): PaneNode | null {
  const g = groupOfSession(root, sessionId)
  if (!g) return root
  const shrunk = withoutTab(g, sessionId)
  return shrunk ? mapNode(root, (n) => (n === g ? shrunk : n)) : dropGroup(root, g.id)
}

/** Moves a tab to another group. When source == target this is a reorder within the same group. */
export function moveTab(
  root: PaneNode,
  sessionId: string,
  toPaneId: string,
  insertBefore?: number
): PaneNode | null {
  const from = groupOfSession(root, sessionId)
  const to = leafOf(root, toPaneId)
  if (!from || !to) return null
  if (from.id === to.id) {
    const ids = reorder(
      from.sessionIds,
      from.sessionIds.indexOf(sessionId),
      insertBefore ?? from.sessionIds.length
    )
    return mapNode(root, (n) =>
      n === from ? { ...from, sessionIds: ids, activeSessionId: sessionId } : n
    )
  }
  const shrunk = withoutTab(from, sessionId)
  // from.id !== to.id, so there are at least 2 groups — dropGroup cannot return null
  const detached = shrunk
    ? mapNode(root, (n) => (n === from ? shrunk : n))
    : (dropGroup(root, from.id) as PaneNode)
  return addTab(detached, toPaneId, sessionId, insertBefore)
}

/** Splits the target group and places sessionId in the new group (IntelliJ Split and Move).
 *  If sessionId already lives in some group it is moved out of there; otherwise it is just
 *  placed — the latter is the path that opens a new session straight into a new group. */
export function splitAndMove(
  root: PaneNode,
  sessionId: string,
  targetPaneId: string,
  dir: PaneDir,
  placeBefore: boolean
): { root: PaneNode; paneId: string } | null {
  if (countLeaves(root) >= MAX_PANES) return null
  const target0 = leafOf(root, targetPaneId)
  if (!target0) return null
  const from = groupOfSession(root, sessionId)
  // Source == target with only one tab: after the split the remaining side is empty and collapses
  // again, so the result equals the input. That is not a failure but "already in that state", so
  // the caller does not even raise a toast.
  if (from && from.id === target0.id && from.sessionIds.length < 2) return null
  // Remove from the source group first — inserting the new group first would put sessionId in two
  // groups and leave removeTab ambiguous about which one to strip. Not null, thanks to the guard above.
  const detached = from ? (removeTab(root, sessionId) as PaneNode) : root
  // The removal above can change node references, so look the target up by id again. The only way
  // the target group disappears is "from === target && one tab", which the guard above already
  // rejected, so this is not null
  const target = leafOf(detached, targetPaneId) as PaneLeaf
  const group = createGroup(sessionId)
  const split: PaneSplit = {
    kind: 'split',
    id: nextId(),
    dir,
    ratio: 0.5,
    a: placeBefore ? group : target,
    b: placeBefore ? target : group
  }
  return { root: mapNode(detached, (n) => (n === target ? split : n)), paneId: group.id }
}

/** Removes a group and appends its tabs to the end of the sibling group (IntelliJ Unsplit). The
 *  sessions are not killed. If the sibling is a split, the tabs join that subtree's firstLeaf —
 *  geometrically the left/top one, the same direction sibling promotion uses. The absorbing group
 *  keeps its own active tab. */
export function unsplit(root: PaneNode, paneId: string): PaneNode {
  const group = leafOf(root, paneId)
  const sibling = group ? siblingOf(root, paneId) : null
  if (!group || !sibling) return root // unsplit tree, or a paneId that does not exist
  const hostId = firstLeaf(sibling).id
  const dropped = dropGroup(root, paneId) as PaneNode // not null, since a sibling exists
  return mapNode(dropped, (n) =>
    n.kind === 'leaf' && n.id === hostId
      ? { ...n, sessionIds: [...n.sessionIds, ...group.sessionIds] }
      : n
  )
}

/** Swaps only the session id, keeping the tab's slot and ordering. Shared by restart and rolling. */
export function replaceSessionId(root: PaneNode, oldId: string, newId: string): PaneNode {
  return mapNode(root, (n) => {
    if (n.kind !== 'leaf' || !n.sessionIds.includes(oldId)) return n
    return {
      ...n,
      sessionIds: n.sessionIds.map((s) => (s === oldId ? newId : s)),
      activeSessionId: n.activeSessionId === oldId ? newId : n.activeSessionId
    }
  })
}

/** Screen rectangle — units are % (0-100). The renderer drops these straight into left/top/width/height. */
export type Rect = { x: number; y: number; w: number; h: number }
export type DropZone = 'left' | 'right' | 'up' | 'down' | 'center'
export type MoveDir = 'left' | 'right' | 'up' | 'down'

const FULL: Rect = { x: 0, y: 0, w: 100, h: 100 }
/** Absorbs floating-point error (unit: %) */
const EPS = 0.01

/** Flattens every leaf in the tree into screen coordinates. */
export function computeRects(root: PaneNode): Map<string, Rect> {
  const out = new Map<string, Rect>()
  walkRects(root, FULL, out)
  return out
}

function walkRects(node: PaneNode, r: Rect, out: Map<string, Rect>): void {
  if (node.kind === 'leaf') {
    out.set(node.id, r)
    return
  }
  if (node.dir === 'row') {
    const aw = r.w * node.ratio
    walkRects(node.a, { x: r.x, y: r.y, w: aw, h: r.h }, out)
    walkRects(node.b, { x: r.x + aw, y: r.y, w: r.w - aw, h: r.h }, out)
  } else {
    const ah = r.h * node.ratio
    walkRects(node.a, { x: r.x, y: r.y, w: r.w, h: ah }, out)
    walkRects(node.b, { x: r.x, y: r.y + ah, w: r.w, h: r.h - ah }, out)
  }
}

/** For each split node: the boundary line to put a resizer on (rect) and the sub-area that split
 *  divides (area). For row it is a zero-width vertical line, for col a zero-height horizontal one.
 *  area is used to convert a nested split's drag into a ratio relative to the parent area rather
 *  than the whole screen. */
export function splitBoundaries(
  root: PaneNode
): Array<{ splitId: string; dir: PaneDir; rect: Rect; area: Rect }> {
  const out: Array<{ splitId: string; dir: PaneDir; rect: Rect; area: Rect }> = []
  walkBounds(root, FULL, out)
  return out
}

function walkBounds(
  node: PaneNode,
  r: Rect,
  out: Array<{ splitId: string; dir: PaneDir; rect: Rect; area: Rect }>
): void {
  if (node.kind === 'leaf') return
  if (node.dir === 'row') {
    const aw = r.w * node.ratio
    out.push({
      splitId: node.id,
      dir: 'row',
      rect: { x: r.x + aw, y: r.y, w: 0, h: r.h },
      area: r
    })
    walkBounds(node.a, { x: r.x, y: r.y, w: aw, h: r.h }, out)
    walkBounds(node.b, { x: r.x + aw, y: r.y, w: r.w - aw, h: r.h }, out)
  } else {
    const ah = r.h * node.ratio
    out.push({
      splitId: node.id,
      dir: 'col',
      rect: { x: r.x, y: r.y + ah, w: r.w, h: 0 },
      area: r
    })
    walkBounds(node.a, { x: r.x, y: r.y, w: r.w, h: ah }, out)
    walkBounds(node.b, { x: r.x, y: r.y + ah, w: r.w, h: r.h - ah }, out)
  }
}

/** The neighbouring pane in a direction. Geometry-based rather than walking up the tree — the
 *  on-screen position is the answer, and with at most 4 panes the cost of comparing all of them
 *  is irrelevant. */
export function findNeighbor(root: PaneNode, paneId: string, dir: MoveDir): string | null {
  const rects = computeRects(root)
  const cur = rects.get(paneId)
  if (!cur) return null
  const horizontal = dir === 'left' || dir === 'right'
  let best: { id: string; primary: number; secondary: number } | null = null
  for (const [id, r] of rects) {
    if (id === paneId) continue
    // Only a pane whose span overlaps on the axis perpendicular to the move counts as "visible in that direction"
    const overlaps = horizontal
      ? r.y < cur.y + cur.h - EPS && r.y + r.h > cur.y + EPS
      : r.x < cur.x + cur.w - EPS && r.x + r.w > cur.x + EPS
    if (!overlaps) continue
    let primary: number
    if (dir === 'right') {
      if (r.x < cur.x + cur.w - EPS) continue
      primary = r.x
    } else if (dir === 'left') {
      if (r.x + r.w > cur.x + EPS) continue
      primary = -(r.x + r.w)
    } else if (dir === 'down') {
      if (r.y < cur.y + cur.h - EPS) continue
      primary = r.y
    } else {
      if (r.y + r.h > cur.y + EPS) continue
      primary = -(r.y + r.h)
    }
    const secondary = horizontal ? r.y : r.x
    if (
      !best ||
      primary < best.primary - EPS ||
      (Math.abs(primary - best.primary) <= EPS && secondary < best.secondary)
    )
      best = { id, primary, secondary }
  }
  return best?.id ?? null
}

/** Maps pane-relative coordinates (0-1) to a drop zone. The outer 25% splits, the centre replaces. */
export function dropZoneOf(fx: number, fy: number): DropZone {
  if (fx >= 0.25 && fx <= 0.75 && fy >= 0.25 && fy <= 0.75) return 'center'
  // On a tie the earlier entry wins — left > right > up > down
  const candidates: Array<[DropZone, number]> = [
    ['left', fx],
    ['right', 1 - fx],
    ['up', fy],
    ['down', 1 - fy]
  ]
  let best = candidates[0]
  for (const c of candidates) if (c[1] < best[1]) best = c
  return best[0]
}

/** Clamps ratio so both panes keep the minimum width. Splits evenly if the container is narrower than twice the minimum. */
export function clampRatio(ratio: number, containerPx: number, minPx = MIN_PANE_PX): number {
  if (containerPx < minPx * 2) return 0.5
  const min = minPx / containerPx
  return Math.min(1 - min, Math.max(min, ratio))
}
