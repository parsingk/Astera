// The window's pane layout as a record that outlives a restart (spec W3). The tree stays ignorant of tab kinds (tree.ts
// head comment); this module is where the kinds matter, because what can come back depends on them: a session only
// while it still runs, a file only while it is there, an app mirror never (its session's workspace places it again).
// Which of those still hold is the caller's to find out (it asks main); this module only drops what it is told to.
//
// The record is versioned and read defensively. It lives in the person's localStorage, an older or newer app may have
// written it, and nothing here may stop the window from opening: whatever does not read as a layout reads as none.
// node: no imports, the renderer imports this.
import { pluginKeyOf, type SidebarView } from '../ui/sidebar'
import { MAX_PANES, createGroup, createSplit, firstLeaf, leaves, type PaneDir, type PaneLeaf, type PaneNode } from './tree'
import { isRemoteSessionKey, parseTab, sessionTab } from './tabId'

export const SAVED_LAYOUT_VERSION = 1
/** The most tabs one stored group may hold; a longer list is not a layout a person made. */
const MAX_TABS_PER_GROUP = 500

export type SavedNode =
  | { kind: 'leaf'; tabs: string[]; active: string }
  | { kind: 'split'; dir: PaneDir; ratio: number; a: SavedNode; b: SavedNode }

/** The bottom panel tabs a layout remembers. A terminal's or a log's tab is gone after a restart, so it reads as 'run'. */
export type BottomTab = 'run' | 'kube' | 'problems'

export type SavedPanels = {
  sidebar: { open: boolean; view: SidebarView }
  bottom: { open: boolean; tab: BottomTab }
}

/** What a tab needs besides its id to be drawn again. Sessions, media and kube tabs need nothing: their id is the
 *  whole record (tabId.ts). */
export type SavedTabs = {
  files: Record<string, { path: string; projectRoot: string }>
  records: Record<string, { recordId: string; title: string; projectRoot: string }>
  browsers: Record<string, { url: string; title: string; projectRoot: string }>
  /** A plugin panel's title and its plugin's name, drawn while its tab is held, and the project its panel was opened in
   *  (`''` for none). Optional on read: a record written before plugin panels has none. */
  plugins: Record<string, { title: string; pluginName: string; projectRoot: string }>
}

export type SavedLayout = {
  v: typeof SAVED_LAYOUT_VERSION
  tree: SavedNode | null
  /** The active group's index in leaf order, -1 for none. */
  active: number
  panels: SavedPanels
  tabs: SavedTabs
}

const SIDEBAR_VIEWS: readonly SidebarView[] = ['explorer', 'jobs', 'understanding', 'sessions']
const BOTTOM_TABS: readonly BottomTab[] = ['run', 'kube', 'problems']

/** The bottom tab a layout keeps for `tab`: itself when it outlives a restart, else 'run'. */
export const asBottomTab = (tab: unknown): BottomTab => (BOTTOM_TABS.includes(tab as BottomTab) ? (tab as BottomTab) : 'run')

/** Whether a tab is kept in the record: not an app mirror (its workspace places it again), not a paired Runtime's
 *  session (the Runtime is asked again on its own terms), not an id nobody can read. */
function saves(tabId: string): boolean {
  const ref = parseTab(tabId)
  if (!ref || ref.kind === 'app') return false
  return !(ref.kind === 'session' && isRemoteSessionKey(ref.id))
}

function saveNode(node: PaneNode): SavedNode | null {
  if (node.kind === 'leaf') {
    // Never more than readSaved accepts: a group past the bound would make the next start read no layout at all
    const tabs = node.tabIds.filter(saves).slice(0, MAX_TABS_PER_GROUP)
    if (tabs.length === 0) return null
    return { kind: 'leaf', tabs, active: tabs.includes(node.activeTabId) ? node.activeTabId : tabs[0] }
  }
  const a = saveNode(node.a)
  const b = saveNode(node.b)
  if (!a || !b) return a ?? b
  return { kind: 'split', dir: node.dir, ratio: node.ratio, a, b }
}

export function savedLeaves(node: SavedNode): Array<Extract<SavedNode, { kind: 'leaf' }>> {
  return node.kind === 'leaf' ? [node] : [...savedLeaves(node.a), ...savedLeaves(node.b)]
}

/** The record for the window as it is. Tab info is kept only for the tabs the record keeps. */
export function toSaved(root: PaneNode | null, activePaneId: string | null, panels: SavedPanels, tabs: SavedTabs): SavedLayout {
  const tree = root ? saveNode(root) : null
  // saveNode drops exactly the groups with no kept tab and keeps the rest in order, so the indices line up
  const active = root && tree ? leaves(root).filter((l) => l.tabIds.some(saves)).findIndex((l) => l.id === activePaneId) : -1
  const inTree = new Set(tree ? savedLeaves(tree).flatMap((l) => l.tabs) : [])
  const pick = <T>(m: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(m).filter(([id]) => inTree.has(id)))
  return {
    v: SAVED_LAYOUT_VERSION,
    tree,
    active,
    panels: { sidebar: { ...panels.sidebar }, bottom: { open: panels.bottom.open, tab: asBottomTab(panels.bottom.tab) } },
    tabs: { files: pick(tabs.files), records: pick(tabs.records), browsers: pick(tabs.browsers), plugins: pick(tabs.plugins) }
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A stored split's share, kept where both sides stay visible; anything that is not a number splits evenly. */
const clampShare = (r: unknown): number => (typeof r === 'number' && Number.isFinite(r) ? Math.min(0.9, Math.max(0.1, r)) : 0.5)

/** A stored node, or undefined when it does not read as one. Depth is bounded before the group count is known, so a
 *  deeply nested record cannot exhaust the stack. */
export function readNode(v: unknown, depth = 0): SavedNode | undefined {
  if (!isObject(v) || depth > MAX_PANES) return undefined
  if (v.kind === 'leaf') {
    const { tabs, active } = v
    if (!Array.isArray(tabs) || tabs.length === 0 || tabs.length > MAX_TABS_PER_GROUP) return undefined
    if (!tabs.every((t) => typeof t === 'string') || typeof active !== 'string') return undefined
    return { kind: 'leaf', tabs: [...(tabs as string[])], active }
  }
  if (v.kind === 'split') {
    if (v.dir !== 'row' && v.dir !== 'col') return undefined
    const a = readNode(v.a, depth + 1)
    const b = readNode(v.b, depth + 1)
    if (!a || !b) return undefined
    return { kind: 'split', dir: v.dir, ratio: clampShare(v.ratio), a, b }
  }
  return undefined
}

/** Stored panels, or null when they do not read as panels. A view or a tab this version does not know (a newer app
 *  wrote it) reads as the default rather than losing the record. */
export function readPanels(v: unknown): SavedPanels | null {
  if (!isObject(v) || !isObject(v.sidebar) || !isObject(v.bottom)) return null
  const { sidebar, bottom } = v
  if (typeof sidebar.open !== 'boolean' || typeof bottom.open !== 'boolean') return null
  // A plugin's view is kept by its key (Phase 2 remaining); whether the plugin still offers it is the app's to check
  const view =
    SIDEBAR_VIEWS.includes(sidebar.view as SidebarView) || (typeof sidebar.view === 'string' && pluginKeyOf(sidebar.view) !== null)
      ? (sidebar.view as SidebarView)
      : 'sessions'
  return { sidebar: { open: sidebar.open, view }, bottom: { open: bottom.open, tab: asBottomTab(bottom.tab) } }
}

/** A stored map of tab info, or null when an entry is not all strings. Ids no tab could have (`__proto__` among them)
 *  are skipped. */
function readMap<K extends string>(v: unknown, keys: readonly K[]): Record<string, Record<K, string>> | null {
  if (!isObject(v)) return null
  const entries = Object.entries(v)
  if (entries.length > MAX_PANES * MAX_TABS_PER_GROUP) return null
  const out: Record<string, Record<K, string>> = {}
  for (const [id, e] of entries) {
    if (!isObject(e) || !keys.every((k) => typeof e[k] === 'string')) return null
    if (parseTab(id) === null) continue
    out[id] = Object.fromEntries(keys.map((k) => [k, e[k]])) as Record<K, string>
  }
  return out
}

function readTabs(v: unknown): SavedTabs | null {
  if (!isObject(v)) return null
  const files = readMap(v.files, ['path', 'projectRoot'] as const)
  const records = readMap(v.records, ['recordId', 'title', 'projectRoot'] as const)
  const browsers = readMap(v.browsers, ['url', 'title', 'projectRoot'] as const)
  // Absent in a record written before plugin panels: read as none, so that record keeps its layout
  const plugins = v.plugins === undefined ? {} : readMap(v.plugins, ['title', 'pluginName', 'projectRoot'] as const)
  return files && records && browsers && plugins ? { files, records, browsers, plugins } : null
}

/** The stored record, or null for nothing, junk, or another version. Never throws. */
export function readSaved(raw: string | null): SavedLayout | null {
  if (!raw) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isObject(data) || data.v !== SAVED_LAYOUT_VERSION) return null
  const tree = data.tree === null ? null : readNode(data.tree)
  if (tree === undefined || (tree && savedLeaves(tree).length > MAX_PANES)) return null
  if (typeof data.active !== 'number' || !Number.isInteger(data.active)) return null
  const panels = readPanels(data.panels)
  const tabs = readTabs(data.tabs)
  if (!panels || !tabs) return null
  return { v: SAVED_LAYOUT_VERSION, tree, active: data.active, panels, tabs }
}

/** `target` with every tab of `from` it does not hold appended to its first group, that group's active tab unchanged:
 *  what reached the window while the restore waited on main (a session the Host handed back, a file the person opened,
 *  an agent's preview) stays on screen when the restored tree replaces the one being drawn. An app's mirror tab goes
 *  to the group of its session when the tree has it, as applySaved places one (presets.ts). */
export function mergeTabs(target: PaneNode, from: PaneNode | null): PaneNode {
  if (!from) return target
  const groups = leaves(target)
  const held = new Set(groups.flatMap((l) => l.tabIds))
  const extra = leaves(from).flatMap((l) => l.tabIds.filter((t) => !held.has(t)))
  if (extra.length === 0) return target
  const byGroup = new Map<string, string[]>()
  for (const t of extra) {
    const ref = parseTab(t)
    const home = (ref?.kind === 'app' && groups.find((l) => l.tabIds.includes(sessionTab(ref.id)))) || groups[0]
    byGroup.set(home.id, [...(byGroup.get(home.id) ?? []), t])
  }
  const add = (node: PaneNode): PaneNode => {
    if (node.kind !== 'leaf') return { ...node, a: add(node.a), b: add(node.b) }
    const more = byGroup.get(node.id)
    return more ? { ...node, tabIds: [...node.tabIds, ...more] } : node
  }
  return add(target)
}

/**
 * A live tree from a stored one, with fresh pane ids. A tab is kept when its id reads (parseTab), `keep` says it can
 * come back, and no group before it holds it (a tab lives in one group); a group left with no tab disappears and its
 * sibling takes the split's place, the way closing its last tab does. The active tab falls back to the group's first,
 * the active group to the first group. Null when no tab is left.
 */
export function restoreTree(
  tree: SavedNode | null,
  active: number,
  keep: (tabId: string) => boolean
): { root: PaneNode; activePaneId: string } | null {
  if (!tree) return null
  const activeLeaf = savedLeaves(tree)[active] ?? null
  const seen = new Set<string>()
  let activePaneId: string | null = null
  const build = (node: SavedNode): PaneNode | null => {
    if (node.kind === 'split') {
      const a = build(node.a)
      const b = build(node.b)
      if (!a || !b) return a ?? b
      return createSplit(node.dir, clampShare(node.ratio), a, b)
    }
    const tabs: string[] = []
    for (const id of node.tabs) {
      if (seen.has(id) || parseTab(id) === null || !keep(id)) continue
      seen.add(id)
      tabs.push(id)
    }
    if (tabs.length === 0) return null
    const group: PaneLeaf = { ...createGroup(tabs[0]), tabIds: tabs, activeTabId: tabs.includes(node.active) ? node.active : tabs[0] }
    if (node === activeLeaf) activePaneId = group.id
    return group
  }
  const root = build(tree)
  if (!root) return null
  return { root, activePaneId: activePaneId ?? firstLeaf(root).id }
}
