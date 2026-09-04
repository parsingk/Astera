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
  return { draft: { items: d.items.map((c, k) => (k === i ? replacement : c)) }, id: replacement.id }
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
  return { items: d.items.filter((c) => c.id !== id) }
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

/** What Apply sends: the items minus the seeds, in tree order. */
export function commitList(d: ConfigDraft): RunConfig[] {
  return d.items.filter((c) => !isSeedId(c.id))
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
