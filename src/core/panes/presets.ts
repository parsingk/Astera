// Layout presets (spec W3): arrangements of the tabs already open, and of the sidebar and the bottom panel. A preset
// never opens a tab, starts a session or runs anything; it only moves what is there and shows or hides panels. The
// built-in ones are named for what the person is doing; a saved one is a layout the person kept under a name.
// node: no imports, the renderer imports this.
import { MAX_PANES, activateTab, createGroup, createSplit, firstLeaf, leaves, type PaneLeaf, type PaneNode } from './tree'
import { parseTab, sessionTab } from './tabId'
import { readNode, readPanels, restoreTree, savedLeaves, type SavedNode, type SavedPanels } from './savedLayout'

export type PresetId = 'coding' | 'review' | 'agents' | 'devops' | 'default'

/** How many presets a person may keep, and how long a name may be. */
export const MAX_SAVED_PRESETS = 20
export const MAX_PRESET_NAME = 40

/** Sizes as the app bounds them where they are dragged (App.tsx sidebar and run panel resizers). */
const SIDEBAR_WIDTH = { min: 160, max: 520, initial: 500 }
const BOTTOM_HEIGHT = { min: 120, max: 800, initial: 220 }

export type SavedPreset = {
  name: string
  tree: SavedNode | null
  panels: SavedPanels
  sidebarWidth: number
  bottomHeight: number
}

type Placed = { root: PaneNode; activePaneId: string }

/** Sessions and their app mirrors stand on one side; everything a person reads stands on the other. */
const isAgentTab = (tabId: string): boolean => {
  const kind = parseTab(tabId)?.kind
  return kind === 'session' || kind === 'app'
}

function group(tabs: string[], activeTabId: string | null): PaneLeaf {
  return { ...createGroup(tabs[0]), tabIds: tabs, activeTabId: activeTabId !== null && tabs.includes(activeTabId) ? activeTabId : tabs[0] }
}

/** The groups laid out side by side, then 2x2 for four: a row of two columns, the first column holding the first and
 *  third group, so groups dealt in order read left to right, then top to bottom. */
function arrange(groups: PaneLeaf[]): PaneNode {
  const [a, b, c, d] = groups
  if (!b) return a
  if (!c) return createSplit('row', 0.5, a, b)
  if (!d) return createSplit('row', 0.5, a, createSplit('col', 0.5, b, c))
  return createSplit('row', 0.5, createSplit('col', 0.5, a, c), createSplit('col', 0.5, b, d))
}

function placed(root: PaneNode, activeTabId: string | null): Placed {
  const act = activeTabId !== null ? activateTab(root, activeTabId) : null
  return act ? { root: act.root, activePaneId: act.paneId } : { root, activePaneId: firstLeaf(root).id }
}

/** The tabs as preset `id` arranges them, or null when there are none. `tabIds` is every open tab in leaf order. */
export function presetTree(id: PresetId, tabIds: readonly string[], activeTabId: string | null): Placed | null {
  if (tabIds.length === 0) return null
  const all = [...tabIds]
  if (id === 'coding') {
    const work = all.filter((t) => !isAgentTab(t))
    const agents = all.filter(isAgentTab)
    if (work.length === 0 || agents.length === 0) return placed(group(all, activeTabId), activeTabId)
    return placed(createSplit('row', 0.5, group(work, activeTabId), group(agents, activeTabId)), activeTabId)
  }
  if (id === 'agents') {
    const sessions = all.filter((t) => parseTab(t)?.kind === 'session')
    if (sessions.length === 0) return placed(group(all, activeTabId), activeTabId)
    const count = Math.min(MAX_PANES, sessions.length)
    // Sessions are dealt round-robin; everything that is not a session (files, mirrors) stays with the first group.
    // Each group keeps tab order, so a mirror does not jump ahead of the session it shows.
    const groupOf = new Map(sessions.map((s, i) => [s, i % count]))
    const dealt: string[][] = Array.from({ length: count }, () => [])
    for (const t of all) dealt[groupOf.get(t) ?? 0].push(t)
    return placed(arrange(dealt.map((tabs) => group(tabs, activeTabId))), activeTabId)
  }
  return placed(group(all, activeTabId), activeTabId)
}

/** The sidebar and bottom panel preset `id` shows. DevOps also asks for a taller bottom panel, for the cluster view. */
export function presetPanels(id: PresetId): SavedPanels & { bottomHeight?: 'tall' } {
  switch (id) {
    case 'coding':
      return { sidebar: { open: true, view: 'explorer' }, bottom: { open: true, tab: 'run' } }
    case 'review':
      return { sidebar: { open: true, view: 'jobs' }, bottom: { open: true, tab: 'problems' } }
    case 'devops':
      return { sidebar: { open: true, view: 'explorer' }, bottom: { open: true, tab: 'kube' }, bottomHeight: 'tall' }
    case 'agents':
    case 'default':
      return { sidebar: { open: true, view: 'sessions' }, bottom: { open: false, tab: 'run' } }
  }
}

/** The open tabs as saved preset `p` arranges them: each tab it names goes back to its group, a tab it never saw joins
 *  the first group, and a group none of whose tabs is open disappears. Null when no tab is open. */
export function applySaved(p: SavedPreset, tabIds: readonly string[], activeTabId: string | null): Placed | null {
  if (tabIds.length === 0) return null
  const open = new Set(tabIds)
  const restored = restoreTree(p.tree, -1, (t) => open.has(t))
  if (!restored) return placed(group([...tabIds], activeTabId), activeTabId)
  const groups = leaves(restored.root)
  const inTree = new Set(groups.flatMap((l) => l.tabIds))
  // A tab the preset never saw joins the first group, except an app mirror (a preset never keeps one), which joins
  // the group its session is in
  const extra = new Map<string, string[]>()
  for (const t of tabIds) {
    if (inTree.has(t)) continue
    const ref = parseTab(t)
    const home = (ref?.kind === 'app' && groups.find((l) => l.tabIds.includes(sessionTab(ref.id)))) || groups[0]
    extra.set(home.id, [...(extra.get(home.id) ?? []), t])
  }
  return placed(withExtraTabs(restored.root, extra), activeTabId)
}

/** The tree with each group's extra tabs appended after its own, its active tab unchanged. */
function withExtraTabs(node: PaneNode, extra: ReadonlyMap<string, string[]>): PaneNode {
  if (node.kind === 'leaf') {
    const more = extra.get(node.id)
    return more ? { ...node, tabIds: [...node.tabIds, ...more] } : node
  }
  return { ...node, a: withExtraTabs(node.a, extra), b: withExtraTabs(node.b, extra) }
}

const clampSize = (v: unknown, bounds: { min: number; max: number; initial: number }): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(bounds.max, Math.max(bounds.min, Math.round(v))) : bounds.initial

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function readPreset(v: unknown): SavedPreset | null {
  if (!isObject(v) || typeof v.name !== 'string') return null
  const name = v.name.trim()
  if (name === '' || name.length > MAX_PRESET_NAME) return null
  const tree = v.tree === null ? null : readNode(v.tree)
  if (tree === undefined || (tree && savedLeaves(tree).length > MAX_PANES)) return null
  const panels = readPanels(v.panels)
  if (!panels) return null
  return { name, tree, panels, sidebarWidth: clampSize(v.sidebarWidth, SIDEBAR_WIDTH), bottomHeight: clampSize(v.bottomHeight, BOTTOM_HEIGHT) }
}

/** The stored presets: those that read, the first of each name, at most MAX_SAVED_PRESETS. Junk reads as none. */
export function readPresets(raw: string | null): SavedPreset[] {
  if (!raw) return []
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!isObject(data) || data.v !== 1 || !Array.isArray(data.presets)) return []
  const out: SavedPreset[] = []
  for (const entry of data.presets) {
    const p = readPreset(entry)
    if (p && !out.some((q) => q.name === p.name)) out.push(p)
    if (out.length === MAX_SAVED_PRESETS) break
  }
  return out
}

export function toPresetsRecord(list: readonly SavedPreset[]): { v: 1; presets: SavedPreset[] } {
  return { v: 1, presets: [...list] }
}

/** The list with `p` kept under its trimmed name: a preset of the same name is replaced where it stood, a new one is
 *  added at the end, or 'full' when there is no room for it. */
export function withPreset(list: readonly SavedPreset[], p: SavedPreset): SavedPreset[] | 'full' {
  const kept = { ...p, name: p.name.trim() }
  const at = list.findIndex((q) => q.name === kept.name)
  if (at >= 0) return list.map((q, i) => (i === at ? kept : q))
  if (list.length >= MAX_SAVED_PRESETS) return 'full'
  return [...list, kept]
}

export function withoutPreset(list: readonly SavedPreset[], name: string): SavedPreset[] {
  return list.filter((q) => q.name !== name)
}
