import { useRef, useState } from 'react'
import { parentDir } from '../../../core/files/paths'
import { validateName, canMove, canCopy, isSubPath } from '../../../core/files/ops'
import {
  pushEntry,
  invert,
  describe,
  describeRestored,
  undoSourceParents,
  splitByExistence
} from '../../../core/files/undo'
import { confirmModal } from '../lib/confirm'
import { toast } from '../lib/toast'
import { useI18n } from '../i18n/I18nProvider'
import type { Entry, FileTree } from './useFileTree'
import type { ExplorerSelection } from './useExplorerSelection'
import type { UndoEntry, UndoOp } from '../../../core/files/undo'
import type { Message } from '../../../core/i18n'

/** Strips the `Error invoking remote method '<channel>': ` prefix Electron attaches to ipcMain.handle
 *  errors — so the toast keeps only the reason. If the prefix is absent the message passes through
 *  unchanged. */
export const errText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/,
    ''
  )

export type Editing =
  | { kind: 'create'; parentDir: string; isDir: boolean }
  | { kind: 'rename'; path: string; initial: string; isDir: boolean }
  | null

/** File operation engine plus inline editing (extracted out of FileExplorer as useFileOps).
 *  It knows nothing about the tree cache (useFileTree) or the selection state machine
 *  (useExplorerSelection) — both are injected. */
export interface FileOps {
  runBatch: (label: string, paths: string[], op: (p: string) => Promise<void>) => Promise<number>
  transferTo: (mode: 'cut' | 'copy', paths: string[], destDir: string) => Promise<number>
  paste: (destDirArg?: string) => Promise<void>
  pasteDir: () => string
  cutOrCopy: (mode: 'cut' | 'copy') => void
  copyPath: (p: string, relative: boolean) => void
  removeSelection: () => Promise<void>
  duplicateSelection: () => Promise<void>
  /** Ctrl+Z. Reverts the journal's most recent entry by applying the inverse operations. */
  undo: () => Promise<void>
  // Inline editing (create and rename are file operations too)
  editing: Editing
  editValue: string
  setEditValue: (v: string) => void
  startCreate: (parentDir: string, isDir: boolean) => void
  startRename: (entry: Entry) => void
  commitEdit: (trigger: 'enter' | 'blur') => Promise<void>
  cancelEdit: () => void
  /** Used by refresh() to close an input row that was being edited. Unlike cancelEdit it does not move
   *  focus — after clicking the refresh button focus has to stay on that button (existing behavior), and
   *  moving it to the tree here would let a Delete key press right after a refresh reach the tree's
   *  onKeyDown, producing a delete that should not have happened. refresh itself stayed in the
   *  component, but editingRef/setEditing are now hidden inside this hook and refresh can no longer
   *  touch them directly, so this minimal entry point exists instead (added to preserve the existing
   *  behavior).
   */
  resetEditingState: () => void
}

export function useFileOps(deps: {
  root: string | null
  tree: FileTree
  sel: ExplorerSelection
  treeRef: React.RefObject<HTMLDivElement | null>
  /** Mirror of the currently committed root (FileExplorer's stateRef, passed straight through). Used to
   *  check whether root changed while undo() was awaiting — the closure's root argument is pinned at
   *  the time undo() was called and cannot see changes during execution. Importing the whole
   *  ExplorerTreeState would create a circular reference, so only the field that is needed is
   *  duck-typed (the same guard mechanism used elsewhere). */
  stateRef: React.RefObject<{ root: string | null } | null>
  undoRef: React.RefObject<UndoEntry[]>
  onPathRenamed: (from: string, to: string) => void
  onPathDeleted: (paths: string[]) => void
}): FileOps {
  const { root, tree, sel, treeRef, stateRef, undoRef, onPathRenamed, onPathDeleted } = deps
  const { dirs, dirsRef, loadDir, findEntry, entriesOf } = tree
  const { t, tm } = useI18n()

  const [editing, setEditing] = useState<Editing>(null)
  const [editValue, setEditValue] = useState('')

  const editingRef = useRef<Editing>(null)
  editingRef.current = editing // mirrored on every render — blocks the stale closure of an unmount blur

  /** Applies the same operation to several items sequentially and reports partial failure in one go.
   *  Why sequential: firing them in parallel scrambles the order of the failures and calls loadDir on
   *  the same parent several times.
   *  Returns the success count. A failure does not stop the rest — whatever succeeded is kept. */
  const runBatch = async (
    label: string,
    paths: string[],
    op: (p: string) => Promise<void>
  ): Promise<number> => {
    const failed: string[] = []
    for (const p of paths) {
      try {
        await op(p)
      } catch (err) {
        failed.push(`${p.split(/[\\/]/).pop() ?? p} (${errText(err)})`)
      }
    }
    if (failed.length > 0) {
      const shown = failed.slice(0, 3).join(', ')
      const more = failed.length > 3 ? t('files.batch.moreCount', { count: failed.length - 3 }) : ''
      toast.error(
        t('files.batch.partialFail', { label, total: paths.length, failed: failed.length, shown, more })
      )
    }
    return paths.length - failed.length
  }

  const startCreate = (parentDirPath: string, isDir: boolean): void => {
    tree.expandDir(parentDirPath) // expand the parent
    if (!dirs[parentDirPath]) loadDir(parentDirPath)
    setEditing({ kind: 'create', parentDir: parentDirPath, isDir })
    setEditValue('')
  }

  const startRename = (entry: Entry): void => {
    setEditing({ kind: 'rename', path: entry.path, initial: entry.name, isDir: entry.isDir })
    setEditValue(entry.name)
  }

  /** Collapses the editingRef/setEditing/focus trio into one call (shared by the Escape handler and
   *  commitEdit's blur-cancel path). The ref has to be cleared synchronously before the state, so the
   *  stale closure of an unmount blur sees it already cleared and stops quietly. */
  const cancelEdit = (): void => {
    editingRef.current = null
    setEditing(null)
    treeRef.current?.focus()
  }

  const resetEditingState = (): void => {
    editingRef.current = null
    setEditing(null)
  }

  const commitEdit = async (trigger: 'enter' | 'blur'): Promise<void> => {
    const e = editingRef.current
    if (!e) return // already committed/cancelled — a duplicate call from an unmount blur
    const name = editValue.trim()
    if (validateName(name) !== null) {
      // On Enter, keep the row open and keep showing the reason. On blur, cancel —
      // an input row left behind without focus gives the user no way out.
      if (trigger === 'blur') cancelEdit()
      return
    }
    editingRef.current = null // cleared synchronously before the state lands — blocks a duplicate commit
    setEditing(null)
    treeRef.current?.focus()
    try {
      if (e.kind === 'create') {
        const created = await window.api.files.create(e.parentDir, name, e.isDir)
        loadDir(e.parentDir)
        sel.dispatch({ type: 'selectionSet', paths: [created] })
        undoRef.current = pushEntry(undoRef.current, { kind: 'created', paths: [created] })
      } else {
        if (name === e.initial) return // no change
        const to = await window.api.files.rename(e.path, name)
        onPathRenamed(e.path, to)
        loadDir(parentDir(e.path))
        sel.dispatch({ type: 'selectionSet', paths: [to] })
        undoRef.current = pushEntry(undoRef.current, { kind: 'renamed', from: e.path, to })
      }
    } catch (err) {
      const action = e.kind === 'create' ? t('files.action.create') : t('files.action.rename')
      toast.error(t('files.commit.failed', { action, detail: errText(err) }))
    }
  }

  const removeSelection = async (): Promise<void> => {
    const paths = sel.selectionPaths()
    if (paths.length === 0) return
    // The value to pass as files.remove's second argument (projectRoot) — required so the snapshot key
    // matches exactly the root this explorer is showing. Having a selection in the tree means the tree
    // is already expanded from root, so in practice this cannot be null, but the type is string | null
    // so it is guarded defensively — no root means there is nothing to delete either, so it quietly
    // does nothing.
    if (!root) return
    const entries = entriesOf(paths)
    // Paths not in the cache (e.g. a folder under the same root that has not been expanded yet) fall back to the basename
    const nameByPath = new Map(entries.map((e) => [e.path, e.name]))
    const nameOf = (p: string): string => nameByPath.get(p) ?? (p.split(/[\\/]/).pop() ?? p)
    // Deletes can now be undone with Ctrl+Z and Local History, reversing the earlier decision that they
    // were permanent — the same hint is attached to all four bodies below. Items over 50MB and items
    // whose snapshot failed cannot be undone, so that exception is stated as well.
    // The wording says "up to" — selectEvictions (localHistory.ts) first discards anything older than
    // 30 days, and if the total still exceeds MAX_TOTAL_BYTES (200MB per project) it keeps discarding
    // the oldest of what remains, regardless of age. With repeated deletes pushing the total near that
    // limit, an item from a few days ago can be evicted before it reaches 30 days, so "kept for 30
    // days" would be over-promising. The 200MB budget is not put in the text —
    // a single "up to" is enough to signal the cap without going beyond the specificity the user chose
    // (30 days, 50MB).
    // A failed snapshot (permission error, etc.) is also unrecoverable, but that is not covered here —
    // a separate toast right after the delete (the skipped.failed branch) already says so, and
    // stretching this to three clauses means the confirm modal does not get read.
    const undoHint = t('files.delete.undoHint')
    let body: string
    if (paths.length === 1) {
      // For a single item, count the descendants exactly and show the number
      const only = entries[0]
      const name = nameOf(paths[0])
      body = t('files.delete.confirmOne', { name, undoHint })
      if (only?.isDir) {
        try {
          const n = await window.api.files.countEntries(only.path)
          body = t('files.delete.confirmDirWithCount', {
            name,
            count: n >= 9999 ? '9999+' : n,
            undoHint
          })
        } catch {
          body = t('files.delete.confirmDirAll', { name, undoHint })
        }
      }
    } else {
      // For a multi-select, countEntries is not called per item — that is N round trips, which is slow, and it is unnecessary for a display-only number
      const dirCount = entries.filter((e) => e.isDir).length
      const dirNote = dirCount > 0 ? t('files.delete.dirNote', { count: dirCount }) : ''
      // List up to 5 names — at the delete confirmation the user has to be able to check what is about
      // to go (recovery via Ctrl+Z and Local History exists, but confirming the targets before deleting
      // is still the right thing)
      const names = paths.map(nameOf)
      const shown = names.slice(0, 5).join(', ')
      const more = names.length > 5 ? t('files.delete.moreNames', { count: names.length - 5 }) : ''
      body = t('files.delete.confirmMany', { shown, more, total: paths.length, dirNote, undoHint })
    }
    const ok = await confirmModal({
      title: t('files.action.delete'),
      body,
      confirmLabel: t('files.action.delete')
    })
    if (!ok) return
    const removed: string[] = []
    const touched = new Set<string>()
    // Collect only the items that can be undone (the ones with a snapshot) — this is for the journal. A
    // different array from removed (below): removed is "everything deleted", used for closing tabs and
    // cleaning up the selection, while this holds only the "undoable" subset of that
    //.
    const snapshotted: { id: string; originalPath: string }[] = []
    // Across the whole batch, report each kind of skipped-snapshot reason exactly once (same reason as
    // runBatch's failure aggregation) — a toast per item during a multi-delete is noisy
    const skipped = { tooLarge: false, failed: false }
    await runBatch(t('files.action.delete'), paths, async (p) => {
      const { snapshotSkipped, snapshotId } = await window.api.files.remove(p, root)
      if (snapshotSkipped === 'too-large') skipped.tooLarge = true
      else if (snapshotSkipped === 'failed') skipped.failed = true
      if (snapshotId !== null) snapshotted.push({ id: snapshotId, originalPath: p })
      removed.push(p)
      touched.add(parentDir(p))
    })
    if (skipped.tooLarge) toast.info(t('files.delete.skippedTooLarge'))
    if (skipped.failed) toast.info(t('files.delete.skippedFailed'))
    // If there is no snapshot at all, do not create a journal entry — Ctrl+Z should reach the previous
    // operation instead (pushing an entry with no way to undo it means Ctrl+Z at that entry always ends
    // in failure)
    if (snapshotted.length > 0) {
      undoRef.current = pushEntry(undoRef.current, { kind: 'deleted', items: snapshotted })
    }
    if (removed.length > 0) onPathDeleted(removed) // close tabs only for the ones that succeeded
    for (const d of touched) if (dirsRef.current[d]) loadDir(d)
    // Clear the selection, and clear the clipboard too if an item pending a cut was deleted — pasting it would only fail
    sel.dispatch({ type: 'pathsRemoved', removed })
  }

  const duplicateSelection = async (): Promise<void> => {
    const paths = sel.selectionPaths()
    if (paths.length === 0) return
    const touched = new Set<string>()
    const last: string[] = []
    await runBatch(t('files.action.duplicate'), paths, async (p) => {
      const to = await window.api.files.copy(p, parentDir(p))
      touched.add(parentDir(p))
      last.push(to)
    })
    for (const d of touched) loadDir(d)
    // Select the duplicated results (same behavior as the earlier single-item duplicate)
    if (last.length > 0) {
      sel.dispatch({ type: 'selectionSet', paths: last })
      // Only successes are recorded — last is pushed to inside runBatch's op callback only right after a
      // successful await, so failures can never get in
      undoRef.current = pushEntry(undoRef.current, { kind: 'copied', paths: last })
    }
  }

  const copyPath = (p: string, relative: boolean): void => {
    const text = relative && root ? p.slice(root.length).replace(/^[\\/]/, '') : p
    window.api.clipboard.writeText(text)
  }

  const cutOrCopy = (mode: 'cut' | 'copy'): void => {
    const paths = sel.selectionPaths()
    if (paths.length === 0) return
    sel.dispatch({ type: 'cutOrCopied', mode, paths })
    // The path text also goes on the OS clipboard — so it can be pasted into the session terminal or an
    // external app. The files themselves cannot be put there (no CF_HDROP support), so 'paste' outside
    // the app does not work.
    window.api.clipboard.writeText(paths.join('\n'))
    toast.info(
      mode === 'cut'
        ? t('files.clipboard.cutDone', { count: paths.length })
        : t('files.clipboard.copyDone', { count: paths.length })
    )
  }

  /** Paste target folder. If the last clicked item (anchor) is a folder then inside it, if it is a file
   *  then its parent, and if there is no anchor or it has vanished from the cache then the root
   *  (VS Code behavior). */
  const pasteDir = (): string => {
    if (!sel.anchor) return root!
    const en = findEntry(sel.anchor)
    if (!en) return root!
    return en.isDir ? en.path : parentDir(sel.anchor)
  }

  // transferTo is called both from paste (menu and Ctrl+V) and from the drop handler, and it is async,
  // so overlapping calls from key auto-repeat or rapid clicking race over the same paths and misreport
  // items that succeeded as failures
  const transferBusyRef = useRef(false)
  // Ctrl+Z auto-repeats (holding it fires repeatedly) — for the same reason as transferBusyRef,
  // overlapping calls are blocked with a ref rather than state. State only lands on the next render,
  // which cannot block an overlap between auto-repeats.
  // Why it is declared before transferTo: undo() and transferTo() have to cross-check each other's busy
  // ref (the two functions just below) — hitting Ctrl+V or dropping immediately after Ctrl+Z (while its
  // await is still in flight) lets two flows touch the same path at once, which either raises a failure
  // toast or, with just two clicks inside the app, triggers the known limitation that partitionInvOps
  // only checks that a name exists and not the item's identity (which we decided not to fix).
  const undoBusyRef = useRef(false)

  /** Engine that moves (cut) or copies (copy) several items into destDir. Returns the success count.
   *  Paste (Ctrl+V and the menu) and the drag-and-drop drop handler must use the **same** one —
   *  cycle detection, partial-failure aggregation, open-tab path succession, refreshing the source and
   *  destination folders, and selecting the results all have to live here together, or the two entry
   *  points drift apart.
   *  Guarding against rapid repeats and duplicate drops happens here too — an overlapping call does
   *  nothing and returns 0. A caller that guards its follow-up work with `ok > 0` filters that case out
   *  naturally. */
  const transferTo = async (
    mode: 'cut' | 'copy',
    paths: string[],
    destDir: string
  ): Promise<number> => {
    // Guard against rapid repeats (of itself), and do not run overlapped while an undo is in flight —
    // nothing worth telling the user, so it is ignored silently (see where undoBusyRef is declared)
    if (transferBusyRef.current || undoBusyRef.current) return 0
    transferBusyRef.current = true
    try {
      // The clipboard may cross project boundaries — no out-of-root filter is applied.
      // For cut, canMove filters out cycles (into itself) and no-ops (already in that location).
      // For copy, the same folder is allowed (uniqueName sidesteps it with ' copy') while copying into
      // itself is filtered out by canCopy — rather than incidentally relying on EINVAL from Node's fs.cp.
      // Both functions decide on absolute paths, so a clipboard holding another project's paths cannot
      // produce a false cycle verdict.
      const reasons = new Map<string, Message>()
      for (const p of paths) {
        const why = mode === 'cut' ? canMove(p, destDir) : canCopy(p, destDir)
        if (why) reasons.set(p, why)
      }
      const doable = paths.filter((p) => !reasons.has(p))
      if (doable.length === 0) {
        const why = reasons.get(paths[0])
        const reason = why ? tm(why) ?? t('files.paste.invalidTarget') : t('files.paste.invalidTarget')
        toast.error(t('files.paste.blocked', { reason }))
        return 0
      }
      // A move has to refresh the source folder too — refreshing only the destination leaves a ghost entry at the source
      const touched = new Set<string>([destDir])
      const landed: string[] = []
      // {from,to} pairs for undoing a move — filled only inside the op callback, where both are in hand (cut only)
      const movedPairs: { from: string; to: string }[] = []
      const ok = await runBatch(
        mode === 'cut' ? t('files.action.move') : t('files.action.copy'),
        doable,
        async (p) => {
          if (mode === 'cut') {
            const to = await window.api.files.move(p, destDir)
            onPathRenamed(p, to) // open tabs inherit the new path (a move is treated the same as a rename)
            touched.add(parentDir(p))
            landed.push(to)
            movedPairs.push({ from: p, to })
          } else {
            landed.push(await window.api.files.copy(p, destDir))
          }
        }
      )
      // Only successes are recorded — movedPairs/landed are pushed to inside runBatch's op callback only
      // right after a successful await, so failures do not get in. Paste (Ctrl+V and the menu) and the
      // drag-and-drop drop both go through this one transferTo, so recording here once makes all three
      // entry points undoable. Multiple items are bundled into a single journal entry too — one Ctrl+Z
      // has to undo the whole operation.
      if (mode === 'cut' && movedPairs.length > 0) {
        undoRef.current = pushEntry(undoRef.current, { kind: 'moved', items: movedPairs })
      } else if (mode === 'copy' && landed.length > 0) {
        undoRef.current = pushEntry(undoRef.current, { kind: 'copied', paths: landed })
      }
      tree.expandDir(destDir)
      for (const d of touched) if (dirsRef.current[d] || d === destDir) loadDir(d)
      // For a cross-project paste the source is not on screen, so the result is invisible — tell the
      // user where it went. (Within the same project it appears in the tree right away, so stay quiet)
      const crossProject = root !== null && doable.some((p) => !isSubPath(root, p))
      if (crossProject && ok > 0) {
        const destName = destDir.split(/[\\/]/).filter(Boolean).pop() ?? destDir
        toast.info(
          mode === 'cut'
            ? t('files.transfer.movedTo', { count: ok, dest: destName })
            : t('files.transfer.copiedTo', { count: ok, dest: destName })
        )
      }
      if (reasons.size > 0) {
        const reason = tm([...reasons.values()][0]) ?? ''
        toast.info(t('files.transfer.skipped', { count: reasons.size, reason }))
      }
      // Select the pasted results — same convention as rename and duplicate. Without it the selection
      // keeps holding the pre-move paths, so a following Ctrl+X operates on paths that already moved
      if (landed.length > 0) sel.dispatch({ type: 'selectionSet', paths: landed })
      return ok
    } finally {
      transferBusyRef.current = false
    }
  }

  /** If destDirArg is given, paste there (the empty-space context menu — same interpretation of "here"
   *  as dirForCreate). Without it (Ctrl+V) the target is decided as before by the anchor-based pasteDir(). */
  const paste = async (destDirArg?: string): Promise<void> => {
    const clip = sel.clipboard
    if (!clip) {
      // The menu's Paste item is disabled: clipboard === null, so it never reaches this path — only
      // Ctrl+V does. That is why it has to report here: without a message the user cannot tell "the
      // clipboard is empty" from "the paste failed" (a silent failure)
      toast.info(t('files.paste.empty'))
      return
    }
    const ok = await transferTo(clip.mode, clip.paths, destDirArg ?? pasteDir())
    // A cut pastes only once (same as OS file managers). If everything failed, or the call was ignored
    // as a rapid repeat, the clipboard is kept so it can be retried — transferTo returns 0 for an
    // overlapping call, so this guard covers that case too.
    if (clip.mode === 'cut' && ok > 0) sel.dispatch({ type: 'clipboardCleared' })
  }

  // Fallback basename used only by undo() — matches the convention of the same fallback in
  // removeSelection(:159). Paths held in the journal may not be in the tree cache (already moved to
  // another folder, or inside a collapsed folder), so an entriesOf-based name cannot be used — and
  // since it is display-only anyway, the basename is enough.
  const nameOf = (p: string): string => p.split(/[\\/]/).pop() ?? p

  /** Checks whether the source a journal entry points at was changed externally in the meantime, and
   *  splits the ops into runnable and mismatched. The decision itself (deduplicating the parents to
   *  query, comparing name existence, how a failed parent listing is treated, the doable/missing
   *  contract) was pulled out into pure functions in undo.ts (undoSourceParents, splitByExistence) —
   *  this function only makes the files.list IPC calls and leaves the rest to them (unit tests live in
   *  undo.test.ts). There is no IPC for an existence check, so files.list(parent) is used instead to see
   *  whether the same name is in there. If the parent itself is gone, files.list throws, so an empty
   *  array is stored and every target under that parent is treated as mismatched (if the exception were
   *  not swallowed the whole undo would die quietly). An operation bundling several items has to skip
   *  only the mismatched ones and undo the rest, so this does not stop at the first mismatch but splits
   *  all of them — the old findMismatch reported only the first mismatch, and because of that one it
   *  skipped the entire rest, permanently losing any way to undo the remaining items once the entry was
   *  removed from the journal. */
  const partitionInvOps = async (
    ops: UndoOp[]
  ): Promise<{ doable: UndoOp[]; missing: string[] }> => {
    const listings = new Map<string, string[]>()
    for (const pd of undoSourceParents(ops, parentDir)) {
      try {
        listings.set(pd, (await window.api.files.list(pd)).map((e) => e.name))
      } catch {
        listings.set(pd, [])
      }
    }
    return splitByExistence(ops, parentDir, nameOf, listings)
  }

  const undo = async (): Promise<void> => {
    // Guard against rapid repeats (of itself), and do not run overlapped while a paste or drop is in
    // flight — nothing worth telling the user, so it is ignored silently. The paste finishes shortly,
    // so pressing Ctrl+Z again right after works (see where undoBusyRef is declared).
    if (undoBusyRef.current || transferBusyRef.current) return
    const entry = undoRef.current[0]
    if (!entry) {
      toast.info(t('files.undo.empty'))
      return
    }
    undoBusyRef.current = true
    try {
      const invOps = invert(entry, parentDir, nameOf)
      // When entry is 'deleted', this maps ids back to names so the failure toast for a restore op
      // (which carries only an id, per undo.ts's UndoOp contract) can show the original name — an id
      // alone gives no human-readable name (used in the catch below).
      const restoreNameById =
        entry.kind === 'deleted' ? new Map(entry.items.map((it) => [it.id, it.originalPath])) : null
      const { doable, missing } = await partitionInvOps(invOps)
      // Whether it passed or mismatched (all of it or only part), this entry is removed from the
      // journal — even a partial run consumes the entry. Leaving it half there makes the next Ctrl+Z
      // ambiguous between "undo the rest of this entry" and "retry this entry from the start". It also
      // does not automatically advance to the next journal entry (decided: skip and notify). Removal is
      // by reference, not slice(1) — if another operation pushed a new entry to the front of the journal
      // while partitionInvOps was awaiting, index 0 is no longer entry, and index-based removal would
      // delete the unrelated entry that just arrived.
      undoRef.current = undoRef.current.filter((e) => e !== entry)
      if (doable.length === 0) {
        // Everything mismatched — keep the existing behavior: run nothing and only raise a failure toast
        // (the entry was already removed from the journal above). For a single item (the most common
        // case — create and rename have only one op) the existing wording is reused to avoid a
        // regression.
        const detail =
          missing.length === 1
            ? t('files.undo.changedOne', { name: missing[0] })
            : t('files.undo.changedMany', {
                shown: missing.slice(0, 3).join(', '),
                more: missing.length > 3 ? t('files.batch.moreCount', { count: missing.length - 3 }) : ''
              })
        const d = describe(entry, nameOf)
        toast.error(t('files.undo.blocked', { desc: t(d.key, d.params), detail }))
        return
      }
      // If the root changed while partitionInvOps was awaiting (a session switch, etc.) this entry now
      // points at a different project that is not on screen — do not run it. The closure's root
      // argument is pinned at the start of undo and can be stale, so it is re-checked against stateRef,
      // which is updated in the same commit as the [root] effect (the same guard as
      // LocalHistoryDialog's onRestored).
      if (stateRef.current?.root !== root) return

      const touched = new Set<string>() // plain refresh targets — refreshed only when already in the cache (same convention as removeSelection:214)
      // Restore destinations — like transferTo's destDir (around :322-323) these are always expanded and
      // refreshed regardless of whether they are cached. A move's destDir and a rename's
      // parentDir(op.from) are "where the item comes back and has to be visible again", and while
      // collapsed the undone result cannot be confirmed on screen. A remove's parent is where the item
      // disappears, so it is not put here — it stays in touched and keeps the existing treatment.
      const restoreDirs = new Set<string>()
      const removed: string[] = []
      // The final paths a rename/move undo landed on — the selection is moved to these (same convention
      // as commitEdit:152, duplicateSelection:234 and transferTo's landed). Undoing a remove (i.e.
      // undoing a create/duplicate) is handled through removed/pathsRemoved rather than landed —
      // invert (undo.ts) produces only homogeneous ops per entry.kind, so one undo() call's invOps are
      // either all remove or all rename/move, which means removed and landed are never filled in the
      // same call (this is why the two dispatches below never overlap in one run).
      const landed: string[] = []
      // Only a delete undo (restore) can land somewhere other than its original name (store.restore's
      // uniqueName sidestep, see where describeRestored is declared) — only successful restores are
      // collected as original-path/actual-landing-path pairs, which is what lets the success toast
      // (below) show the real path.
      const restoredLandings: { originalPath: string; to: string }[] = []
      const failed: string[] = []
      const skipped = { tooLarge: false, failed: false }
      let attempted = 0
      for (const op of doable) {
        // Every op has an await in it, so the root can change even mid-sequence — re-check before each
        // op to stop the remaining ops from continuing to apply to the old project. This is a quiet
        // abort, not a failure (the same call as transferBusyRef ignoring overlapping calls).
        if (stateRef.current?.root !== root) break
        attempted++
        try {
          if (op.op === 'remove') {
            if (!root) continue // cannot happen, but the same defense as removeSelection(:155)
            const { snapshotSkipped } = await window.api.files.remove(op.path, root)
            if (snapshotSkipped === 'too-large') skipped.tooLarge = true
            else if (snapshotSkipped === 'failed') skipped.failed = true
            removed.push(op.path)
            touched.add(parentDir(op.path))
          } else if (op.op === 'rename') {
            const to = await window.api.files.rename(op.from, op.newName)
            onPathRenamed(op.from, to)
            restoreDirs.add(parentDir(op.from)) // a rename does not change folders, so the destination is the original parent
            landed.push(to)
          } else if (op.op === 'move') {
            const to = await window.api.files.move(op.from, op.destDir)
            onPathRenamed(op.from, to)
            restoreDirs.add(op.destDir) // restore destination
            touched.add(parentDir(op.from)) // plain refresh — where the item leaves from
            landed.push(to)
          } else {
            // op.op === 'restore' — a delete undo. root is needed for the same reason as the
            // files.remove branch (:479).
            if (!root) continue
            const to = await window.api.localHistory.restore(root, op.id)
            // Restore destination — treated like a move's destDir (:489): always expanded and refreshed
            // regardless of whether it is cached. Not touched — touched is where an item "leaves from"
            // and this is where an item "comes back to".
            restoreDirs.add(parentDir(to))
            landed.push(to)
            // restoreNameById is only populated when entry.kind === 'deleted', and op.op === 'restore'
            // only ever comes from that kind (see invert()) — so a value must always be there, but a Map
            // lookup's type allows undefined, hence the optional guard (same convention as the catch
            // block below).
            const originalPath = restoreNameById?.get(op.id)
            if (originalPath !== undefined) restoredLandings.push({ originalPath, to })
            // No tab is opened — there was never a requirement that a restore automatically reopens a
            // tab the delete had closed, and neither onPathRenamed (path succession) nor onPathDeleted
            // (closing tabs) means "open the file a restore produced in a tab".
          }
        } catch (err) {
          const src =
            op.op === 'remove'
              ? op.path
              : op.op === 'restore'
                ? restoreNameById?.get(op.id) ?? op.id
                : op.from
          failed.push(`${nameOf(src)} (${errText(err)})`)
        }
      }
      // Same aggregation wording as runBatch(:84-88) — attempted is the number actually tried. Ops left
      // over after a root-switch abort were never attempted rather than failed, so they are excluded
      // from the denominator.
      if (failed.length > 0) {
        const shown = failed.slice(0, 3).join(', ')
        const more = failed.length > 3 ? t('files.batch.moreCount', { count: failed.length - 3 }) : ''
        toast.error(t('files.undo.partialFail', { attempted, failed: failed.length, shown, more }))
      }
      // Items skipped as mismatched — doable.length > 0 here (an all-mismatch case has already returned
      // above), so reaching this point means only some of them were out of sync. A separate toast from
      // failed (IPC errors during execution) — these were filtered out by the existence check before
      // execution was even attempted, so the cause is different. The rule is: skip only the mismatched
      // ones, undo the rest, then report the partial failure.
      if (missing.length > 0) {
        const shown = missing.slice(0, 3).join(', ')
        const more = missing.length > 3 ? t('files.batch.moreCount', { count: missing.length - 3 }) : ''
        toast.error(t('files.undo.partialMissing', { total: invOps.length, missing: missing.length, shown, more }))
      }
      // Wording specific to the undo context — the one from removeSelection (around :211-212) is not
      // reused. There the delete confirmation modal has already been shown, so the framing "the user
      // asked for a delete" fits; here it is only a Ctrl+Z, and undo() deliberately shows no
      // confirmation modal, relying on Local History as the safety net instead.
      // too-large and failed are exactly the cases where that safety net is absent or broke, so without
      // a message a permanent delete happens silently — toast.error states plainly that it cannot be
      // recovered, and the wording is "removed by the undo" rather than "deleted" (the user never asked
      // for a delete). There is no IPC to know the size up front (snapshotSkipped is only known after
      // the delete), so no pre-confirmation modal is added — a modal on every Ctrl+Z would stop it from
      // being an undo.
      if (skipped.tooLarge) toast.error(t('files.undo.permanentTooLarge'))
      if (skipped.failed) toast.error(t('files.undo.permanentSnapshotFailed'))
      if (removed.length > 0) {
        onPathDeleted(removed) // close the tabs the undo removed (undoing a created/copied entry)
        sel.dispatch({ type: 'pathsRemoved', removed }) // clean up selection and clipboard — same reason as removeSelection
      }
      for (const d of touched) if (dirsRef.current[d]) loadDir(d)
      // Expanding the restore destinations and moving the selection re-check the root by the same test
      // as the loop's break. The touched loop just above is filtered naturally when dirsRef has already
      // been reset to the new root and the old paths are not in the cache, but expandDir has no dirsRef
      // guard and plants keys in expanded regardless of the cache, and selectionSet overwrites the
      // selection unconditionally — neither has that protection. Running them as-is would, after a root
      // change (aborted via break, or changed right after the last op), stick old-root paths into the
      // tree and selection of the (new) root currently on screen. Same pattern as the guard above: async
      // cleanup touching a live tree/sel with old paths.
      if (stateRef.current?.root === root) {
        for (const d of restoreDirs) {
          tree.expandDir(d)
          loadDir(d)
        }
        if (landed.length > 0) sel.dispatch({ type: 'selectionSet', paths: landed })
      }
      if (attempted - failed.length > 0) {
        // A delete undo can land somewhere other than its original name, so describeRestored is used to
        // reflect the actual landing path — the other kinds (created/renamed/moved/copied) throw on a
        // collision and do not have this problem, so they keep using describe as before (their toasts
        // are left unchanged).
        const d = describe(entry, nameOf)
        const msg: Message =
          entry.kind === 'deleted' && restoredLandings.length > 0
            ? describeRestored(restoredLandings, nameOf)
            : { key: 'files.undo.done', params: { desc: t(d.key, d.params) } }
        toast.info(t(msg.key, msg.params))
      }
    } finally {
      undoBusyRef.current = false
    }
  }

  return {
    runBatch,
    transferTo,
    paste,
    pasteDir,
    cutOrCopy,
    copyPath,
    removeSelection,
    duplicateSelection,
    undo,
    editing,
    editValue,
    setEditValue,
    startCreate,
    startRename,
    commitEdit,
    cancelEdit,
    resetEditingState
  }
}
