// The Run Configurations dialog's draft. Everything the dialog does to its list — edit a field, ＋,
// −, ⧉ — happens here, to a copy of the merged list it was opened with, and nothing reaches the store
// until Apply sends commitList() in one IPC (run.saveConfigs). Pure functions, so the rules the dialog
// lives by are tested under vitest's `environment: 'node'`, where the dialog itself cannot be.
import type { RunConfig } from './types'
import { promoteSeed } from './config'
import { uniqueName } from '../files/ops'

export interface ConfigDraft {
  /** The list as the tree shows it: stored configurations and detected seeds, in tree order */
  items: RunConfig[]
}

/** A detected configuration — derived from the project's files, never stored */
export function isSeedId(id: string): boolean {
  return id.startsWith('seed:')
}

export function draftOf(merged: RunConfig[]): ConfigDraft {
  return { items: [...merged] }
}

/** Rewrites every reference to `from` in the draft's beforeLaunch and members lists: to `to`, or
 *  removed entirely when `to` is null. Only the items that actually hold the reference are rebuilt,
 *  so a draft with no references is returned untouched item by item. */
function retarget(items: readonly RunConfig[], from: string, to: string | null): RunConfig[] {
  const rewrite = (ids: string[]): string[] =>
    to === null ? ids.filter((x) => x !== from) : ids.map((x) => (x === from ? to : x))
  return items.map((c) => {
    const holdsBefore = (c.beforeLaunch ?? []).includes(from)
    const holdsMember = c.type === 'compound' && c.members.includes(from)
    if (!holdsBefore && !holdsMember) return c
    const next = { ...c } as RunConfig & { beforeLaunch?: string[]; members?: string[] }
    if (holdsBefore) next.beforeLaunch = rewrite(c.beforeLaunch ?? [])
    if (holdsMember && next.members) next.members = rewrite(next.members)
    return next as RunConfig
  })
}

/** Replaces an item's fields. The id stays: the form hands back whatever object it assembled, and the
 *  tree's identity is the draft's, not the form's. A seed is promoted first — the promoted copy takes
 *  the seed's place, so the tree shows the copy where the seed was and the next keystroke edits the
 *  copy rather than promoting again. Returns the id now holding the edit. */
export function editItem(
  d: ConfigDraft,
  id: string,
  next: RunConfig,
  newId: () => string
): { draft: ConfigDraft; id: string } {
  const i = d.items.findIndex((c) => c.id === id)
  if (i < 0) return { draft: d, id }
  const replacement = isSeedId(id) ? promoteSeed(next, newId()) : { ...next, id }
  const items = d.items.map((c, k) => (k === i ? replacement : c))
  // A promoted seed gets a new id; every task pointing at the seed has to follow it.
  const result = replacement.id === id ? items : retarget(items, id, replacement.id)
  return { draft: { items: result }, id: replacement.id }
}

/** ＋: a draft-only configuration, appended. Nothing is stored until Apply — a ＋ followed by Cancel
 *  leaves no trace. */
export function addItem(d: ConfigDraft, config: RunConfig): ConfigDraft {
  return { items: [...d.items, config] }
}

/** −: a seed cannot be removed (it is detected, not stored); the tree disables the button and this is
 *  a no-op for it. */
export function removeItem(d: ConfigDraft, id: string): ConfigDraft {
  if (isSeedId(id)) return d
  // Deleting a configuration takes it out of everyone's chips in the same gesture. Apply commits the
  // whole list atomically, so a reference to a row that is gone is never what gets stored.
  return { items: retarget(d.items.filter((c) => c.id !== id), id, null) }
}

/** ⧉: the same configuration under a new user id and a name the tree can tell apart, inserted right
 *  after the original. promoteSeed is already "the same configuration under a new id", so a seed
 *  duplicates into an ordinary user configuration through the rule an edit would have promoted it with. */
export function duplicateItem(d: ConfigDraft, id: string, newId: string): ConfigDraft {
  const i = d.items.findIndex((c) => c.id === id)
  if (i < 0) return d
  const src = d.items[i]
  const copy = { ...promoteSeed(src, newId), name: uniqueName(d.items.map((c) => c.name), src.name) }
  return { items: [...d.items.slice(0, i + 1), copy, ...d.items.slice(i + 1)] }
}

/** The group a configuration belongs to, for ordering purposes: its folder, or its kind. Deliberately
 *  a local rule rather than a call into ./grouping — that module answers "how is the list drawn",
 *  which walks the whole list, while this answers "who is this item's neighbour", which is a
 *  comparison between two items. Keeping them apart means neither has to grow the other's shape. */
function groupKeyOf(c: RunConfig): string {
  const folder = c.folder ?? ''
  return folder === '' ? `type:${c.type}` : `folder:${folder}`
}

/** The index of the item ↑ or ↓ would swap `i` with: the nearest one in the same group. -1 when the
 *  item is already at that group's edge. */
function neighbourIndex(items: readonly RunConfig[], i: number, dir: -1 | 1): number {
  const key = groupKeyOf(items[i])
  for (let k = i + dir; k >= 0 && k < items.length; k += dir) {
    // A seat a seed holds is not a seat: its order is never stored, so swapping into one is a move
    // Apply cannot keep. Skipped rather than treated as a wall, so a stored configuration separated
    // from its neighbour by a seed still moves.
    if (isSeedId(items[k].id)) continue
    if (groupKeyOf(items[k]) === key) return k
  }
  return -1
}

/** Whether ↑ / ↓ can act — what the buttons' disabled state reads. */
export function canMoveItem(d: ConfigDraft, id: string, dir: -1 | 1): boolean {
  const i = d.items.findIndex((c) => c.id === id)
  // A seed's order is never stored (commitList strips it), so moving one would be an edit Apply
  // cannot keep — the tree disables the buttons rather than letting the row drift back on reopen.
  if (i < 0 || isSeedId(id)) return false
  return neighbourIndex(d.items, i, dir) >= 0
}

/** ↑↓: swaps the item with its neighbour inside its own group. Only those two positions change, so a
 *  group whose members are separated by another group still reorders correctly. Returns the draft
 *  unchanged — the same object — when the move is not available. */
export function moveItem(d: ConfigDraft, id: string, dir: -1 | 1): ConfigDraft {
  const i = d.items.findIndex((c) => c.id === id)
  if (i < 0 || isSeedId(id)) return d
  const j = neighbourIndex(d.items, i, dir)
  if (j < 0) return d
  const items = [...d.items]
  ;[items[i], items[j]] = [items[j], items[i]]
  return { items }
}

/** The folder picker and the 📁 button. An empty name clears the field rather than storing '' — the
 *  store never holds an empty folder. Returns the id now holding the configuration: filing a seed is
 *  an edit, and an edit to a seed promotes it, so the selection has to follow the copy. */
export function setFolder(
  d: ConfigDraft,
  id: string,
  folder: string,
  newId: () => string
): { draft: ConfigDraft; id: string } {
  const i = d.items.findIndex((c) => c.id === id)
  if (i < 0) return { draft: d, id }
  const withFolder = (c: RunConfig): RunConfig => {
    const next = { ...c } as RunConfig & { folder?: string }
    if (folder === '') delete next.folder
    else next.folder = folder
    return next
  }
  const replacement = isSeedId(id) ? withFolder(promoteSeed(d.items[i], newId())) : withFolder(d.items[i])
  const items = d.items.map((c, k) => (k === i ? replacement : c))
  const result = replacement.id === id ? items : retarget(items, id, replacement.id)
  return { draft: { items: result }, id: replacement.id }
}

/** Renames a folder across every member at once. `to` empty takes them all out of it; `to` naming
 *  another folder merges the two, which is what a field whose value *is* the folder must do. */
export function renameFolder(d: ConfigDraft, from: string, to: string): ConfigDraft {
  // '' is not a folder — it is how "no folder" is stored. Renaming *from* it would file every
  // configuration that has none, which no caller means and none can currently ask for.
  if (from === '') return d
  if (!d.items.some((c) => (c.folder ?? '') === from)) return d
  return {
    items: d.items.map((c) => {
      if ((c.folder ?? '') !== from) return c
      const next = { ...c } as RunConfig & { folder?: string }
      if (to === '') delete next.folder
      else next.folder = to
      return next
    })
  }
}

/** The folders in use, in the order they first appear — the picker's item list. */
export function folderNamesOf(d: ConfigDraft): string[] {
  const out: string[] = []
  for (const c of d.items) {
    const f = c.folder ?? ''
    if (f !== '' && !out.includes(f)) out.push(f)
  }
  return out
}

/** What Apply sends: the items minus the seeds, in tree order. */
export function commitList(d: ConfigDraft): RunConfig[] {
  return d.items.filter((c) => !isSeedId(c.id)).map((c) => {
    if (c.folder !== '') return c
    // '' never reaches the store: absent and empty mean the same thing, and one of them is canonical
    const next = { ...c } as RunConfig & { folder?: string }
    delete next.folder
    return next
  })
}

// A key-order-insensitive serialisation. The form rebuilds configurations by spreading, so the key
// order drifts from what run-configs.json holds; JSON.stringify would call that a change. `undefined`
// fields are dropped, the same as JSON does, so `cwd: undefined` equals an absent cwd.
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

export function sameConfig(a: RunConfig, b: RunConfig): boolean {
  return stable(a) === stable(b)
}

/** The draft against the stored baseline. `ids` names every item whose stored form would differ —
 *  edited, added, or promoted — for the tree's ● marker; a deleted item has no row to mark, so it is
 *  reported separately. Order counts: tree order is store order. */
export function dirtyOf(d: ConfigDraft, baseline: RunConfig[]): { dirty: boolean; ids: Set<string>; deleted: string[] } {
  const commit = commitList(d)
  const base = new Map(baseline.map((c) => [c.id, c]))
  const ids = new Set<string>()
  for (const c of commit) {
    const b = base.get(c.id)
    if (!b || !sameConfig(b, c)) ids.add(c.id)
  }
  const committed = new Set(commit.map((c) => c.id))
  const deleted = baseline.filter((c) => !committed.has(c.id)).map((c) => c.id)
  const sameOrder = commit.length === baseline.length && commit.every((c, i) => c.id === baseline[i].id)
  return { dirty: ids.size > 0 || deleted.length > 0 || !sameOrder, ids, deleted }
}
