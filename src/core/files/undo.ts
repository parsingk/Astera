// Undo journal and inverse-operation rules (pure module).
// Deletions go into the journal too. The original decision left them out — "a permanent delete
// cannot be undone, so journalling it would be a false promise" — but Local History actually
// landed, so a snapshot taken just before the delete is always there; restoring that snapshot
// really does undo it, which makes it no false promise. The undo is carried out by recovering the
// snapshot through localHistory.restore.
// node:path is unavailable here, so the caller injects the parent/name extraction.
// describe/describeRestored return a Message (key + params) instead of a finished sentence — this
// file is a pure core module so it cannot call t(), and both the renderer and main call it, so it
// does not know the current language.

import type { Message } from '../i18n'

/** Journal depth cap. Costs no meaningful memory and is effectively unlimited */
export const MAX_DEPTH = 50

export type UndoEntry =
  | { kind: 'created'; paths: string[] }
  | { kind: 'renamed'; from: string; to: string }
  | { kind: 'moved'; items: { from: string; to: string }[] }
  | { kind: 'copied'; paths: string[] }
  | { kind: 'deleted'; items: { id: string; originalPath: string }[] }

/** A single unit of undo execution. The renderer runs these through the existing files.* and
 *  localHistory.* IPC — no new handlers. remove goes through files.remove, so a Local History
 *  snapshot is left behind. restore puts that snapshot back at its original path via
 *  localHistory.restore. */
export type UndoOp =
  | { op: 'remove'; path: string }
  | { op: 'rename'; from: string; newName: string }
  | { op: 'move'; from: string; destDir: string }
  | { op: 'restore'; id: string }

/** Most recent first. Drops the oldest entry once the cap is exceeded. Does not mutate the input. */
export function pushEntry(journal: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  return [entry, ...journal].slice(0, MAX_DEPTH)
}

/** The units that undo this operation. When there are several, apply them in order. */
export function invert(
  entry: UndoEntry,
  parentOf: (p: string) => string,
  nameOf: (p: string) => string
): UndoOp[] {
  switch (entry.kind) {
    case 'created':
    case 'copied':
      // Delete what was created. Destructive, but it goes through files.remove and so lands in
      // Local History, which means content written after the creation can still be recovered
      return entry.paths.map((p) => ({ op: 'remove', path: p }))
    case 'renamed':
      return [{ op: 'rename', from: entry.to, newName: nameOf(entry.from) }]
    case 'moved':
      return entry.items.map((it) => ({ op: 'move', from: it.to, destDir: parentOf(it.from) }))
    case 'deleted':
      return entry.items.map((it) => ({ op: 'restore', id: it.id }))
  }
}

/** The source path an UndoOp points at — for remove the target itself, for rename/move the position
 *  before undoing (i.e. the result path of the original operation). restore is out of scope here
 *  because its source is a snapshot inside userData (outside the project) — it returns null so the
 *  two functions below skip it. Defined once here because both of them share the rule. */
const sourceOf = (op: UndoOp): string | null => {
  switch (op.op) {
    case 'remove':
      return op.path
    case 'rename':
    case 'move':
      return op.from
    case 'restore':
      return null
  }
}

/** The parent directories that need an existence check — deduplicated, keeping first-appearance
 *  order. When several ops share a parent, that parent only has to be listed once — the caller
 *  (useFileOps) uses this list to call files.list exactly once per parent. restore ops (sourceOf is
 *  null) are not looked up, so they are skipped. */
export function undoSourceParents(ops: UndoOp[], parentOf: (p: string) => string): string[] {
  const seen = new Set<string>()
  const parents: string[] = []
  for (const op of ops) {
    const src = sourceOf(op)
    if (src === null) continue
    const pd = parentOf(src)
    if (!seen.has(pd)) {
      seen.add(pd)
      parents.push(pd)
    }
  }
  return parents
}

/** Splits ops into the ones that can still run and the display names of the ones that no longer
 *  line up. listings maps parent directory -> the actual names inside it (the caller fills it in
 *  with files.list for the parents undoSourceParents returned) — a parent whose listing failed goes
 *  in as an empty array. That whole parent is gone, so every target under it counts as mismatched.
 *  Name comparison is exact, case included (Array#includes is case-sensitive) — files.list returns
 *  the real on-disk names, so an untouched item must equal the string we recorded exactly. Both
 *  doable and missing preserve the original order of ops. An operation that bundles several items
 *  (a multi-move, say) has to skip only the mismatched ones and undo the rest, so this does not stop
 *  at the first mismatch but classifies all of them. restore ops (sourceOf is null) are not subject
 *  to this existence check and always go to doable — their source is a Local History snapshot rather
 *  than the project tree, so "was it changed externally in the meantime" is not observable here. If
 *  the snapshot expired or was deleted, the localHistory.restore IPC itself fails, and that failure
 *  is caught by the runBatch-style tallying in the caller's execution step (useFileOps.undo). */
export function splitByExistence(
  ops: UndoOp[],
  parentOf: (p: string) => string,
  nameOf: (p: string) => string,
  listings: Map<string, string[]>
): { doable: UndoOp[]; missing: string[] } {
  const doable: UndoOp[] = []
  const missing: string[] = []
  for (const op of ops) {
    const src = sourceOf(op)
    if (src === null) {
      doable.push(op)
      continue
    }
    const names = listings.get(parentOf(src)) ?? []
    if (names.includes(nameOf(src))) doable.push(op)
    else missing.push(nameOf(src))
  }
  return { doable, missing }
}

/** Description for toast and confirmation text. The renderer translates it with t(). */
export function describe(entry: UndoEntry, nameOf: (p: string) => string): Message {
  switch (entry.kind) {
    case 'created':
      return entry.paths.length === 1
        ? { key: 'files.undo.desc.createdOne', params: { name: nameOf(entry.paths[0]) } }
        : { key: 'files.undo.desc.createdMany', params: { count: entry.paths.length } }
    case 'copied':
      return entry.paths.length === 1
        ? { key: 'files.undo.desc.copiedOne', params: { name: nameOf(entry.paths[0]) } }
        : { key: 'files.undo.desc.copiedMany', params: { count: entry.paths.length } }
    case 'renamed':
      return {
        key: 'files.undo.desc.renamed',
        params: { from: nameOf(entry.from), to: nameOf(entry.to) }
      }
    case 'moved':
      return entry.items.length === 1
        ? { key: 'files.undo.desc.movedOne', params: { name: nameOf(entry.items[0].from) } }
        : { key: 'files.undo.desc.movedMany', params: { count: entry.items.length } }
    case 'deleted':
      return entry.items.length === 1
        ? { key: 'files.undo.desc.deletedOne', params: { name: nameOf(entry.items[0].originalPath) } }
        : { key: 'files.undo.desc.deletedMany', params: { count: entry.items.length } }
  }
}

/** Toast text specific to undoing a delete (restore). The restore in the localHistory store
 *  sidesteps a name that already exists at the destination by picking another one with uniqueName —
 *  describe()'s 'deleted' branch always builds its text from the original name recorded in the
 *  journal, which hides the real landing path whenever the name was sidestepped (the same trap
 *  LocalHistoryDialog.tsx already guards against in doRestore — show the value actually returned or
 *  the message is a lie). files.rename/files.move throw on a collision instead of sidestepping, so
 *  no other kind of undo has this problem — restore is the only op that can succeed while landing
 *  under a different name. items must hold only the entries that were actually restored (the caller
 *  filters failures out before passing them in) — originalPath is the original path recorded in the
 *  journal, to is the real landing path the restore IPC returned. */
export function describeRestored(
  items: { originalPath: string; to: string }[],
  nameOf: (p: string) => string
): Message {
  const renamed = items.filter((it) => nameOf(it.to) !== nameOf(it.originalPath))
  if (renamed.length === 0) {
    // The common case — the name came back unchanged. Keep the same wording as describe()'s
    // 'deleted' branch plus the "undone" tail so this case does not get noisier than it needs to be.
    return items.length === 1
      ? { key: 'files.undo.restored.one', params: { name: nameOf(items[0].originalPath) } }
      : { key: 'files.undo.restored.many', params: { count: items.length } }
  }
  if (items.length === 1) {
    return {
      key: 'files.undo.restored.renamedOne',
      params: { name: nameOf(items[0].originalPath), to: items[0].to }
    }
  }
  // Multiple — the case where only some names changed is covered by this shape too (renamed is a subset of items).
  const shown = renamed.slice(0, 3).map((it) => nameOf(it.to)).join(', ')
  const base = { count: items.length, renamedCount: renamed.length, shown }
  // The "and {n} more" tail cannot be assembled conditionally out of a placeholder, so its presence
  // is encoded in the key instead — the original set that placeholder to an empty string and glued it
  // onto the same sentence.
  return renamed.length > 3
    ? { key: 'files.undo.restored.renamedManyWithMore', params: { ...base, moreCount: renamed.length - 3 } }
    : { key: 'files.undo.restored.renamedMany', params: base }
}
