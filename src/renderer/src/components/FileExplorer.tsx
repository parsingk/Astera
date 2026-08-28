import { useEffect, useRef, useState } from 'react'
import { parentDir } from '../../../core/files/paths'
import { validateName, isSubPath, canMove, canCopy } from '../../../core/files/ops'
import { resolveFileIcon, resolveFolderIcon } from '../../../core/files/icons'
import { FileIcon } from './FileIcon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { LocalHistoryDialog } from './LocalHistoryDialog'
import { toast } from '../lib/toast'
import { useFileTree, type Entry, type DirState } from '../hooks/useFileTree'
import { useExplorerSelection } from '../hooks/useExplorerSelection'
import { useFileOps, errText } from '../hooks/useFileOps'
import { useGitStatus } from '../hooks/useGitStatus'
import { useI18n } from '../i18n/I18nProvider'
import type { UndoEntry } from '../../../core/files/undo'
import type { GitState } from '../../../core/git/status'

/** Tree snapshot the App holds on to, so that even when the explorer toggle unmounts FileExplorer the tree can be handed back on remount */
export interface ExplorerTreeState {
  root: string | null
  expanded: Set<string>
  dirs: Record<string, DirState>
  /** The clipboard exists precisely to cross project boundaries, so it is preserved regardless of root.
   *  selection/anchor are the opposite — they are keyed to root, because once the root changes they go
   *  stale with nothing on screen to show it, which is dangerous. */
  clipboard: { mode: 'cut' | 'copy'; paths: string[] } | null
}

/** File explorer. Root = the active session's cwd, lazy loading — files.list is called only when a folder is expanded. */
export function FileExplorer({
  root,
  onOpenFile,
  onClose,
  stateRef,
  clipboardRef,
  undoRef,
  onPathRenamed,
  onPathDeleted
}: {
  root: string | null
  onOpenFile: (path: string) => void
  onClose: () => void
  /** Per-root tree snapshots, keyed by root so each project's expansion survives both an explorer
   *  toggle (unmount/remount) and the tree root changing to a different project. */
  stateRef: React.RefObject<Map<string, ExplorerTreeState>>
  /** The clipboard exists precisely to cross project boundaries, so it is not part of the per-root map
   *  above — it is its own ref, held by the App so it survives both an explorer toggle and a root change. */
  clipboardRef: React.RefObject<ExplorerTreeState['clipboard']>
  /** Ctrl+Z undo journal. The App holds it — its lifetime differs from ExplorerTreeState (the per-root
   *  tree snapshot), so the two are not stored in the same place (see the explorerUndoRef comment in App.tsx) */
  undoRef: React.RefObject<UndoEntry[]>
  /** When a rename or move changes a path, the App adjusts the open tabs */
  onPathRenamed: (from: string, to: string) => void
  /** On delete the App closes the matching tabs (including ones under the deleted path). Why an array:
   *  calling this once per item during a multi-delete makes the dirty-confirm modals eat each other —
   *  confirmModal returns false immediately when a modal is already open. The App takes the array and
   *  processes it sequentially. */
  onPathDeleted: (paths: string[]) => void
}): React.JSX.Element {
  const { t, tm } = useI18n()
  const [menu, setMenu] = useState<{ x: number; y: number; entry: Entry | null } | null>(null)
  // entry=null means a right-click on the root's empty space (a menu targeting the root)
  // Whether the Local History modal is open. The history is per-project, so it is unrelated to entry.
  const [historyOpen, setHistoryOpen] = useState(false)

  /** Paths currently being dragged. Why a ref instead of dataTransfer: during dragover the contents of
   *  dataTransfer cannot be read (for security only the types are exposed), so canMove cannot decide
   *  valid/invalid at hover time. Why a ref and not state: dragover fires dozens of times per second,
   *  and state would re-render just as often */
  const dragPathsRef = useRef<string[]>([])
  /** The current drop target folder. State because it drives the highlight — null means no valid target */
  const [dropDir, setDropDir] = useState<string | null>(null)
  /** Whether a drag is in progress (dims the source rows) — separate because dragPathsRef cannot trigger a render */
  const [dragging, setDragging] = useState(false)

  // After editing ends (commit/cancel/Escape) focus goes back to the tree so F2/Delete can be used repeatedly
  const treeRef = useRef<HTMLDivElement>(null)

  // The map is keyed by root, so looking a snapshot up is just a get() — no root-match filtering needed
  // to find the right entry (that part is handled by the key itself).
  const savedTree = root ? (stateRef.current?.get(root) ?? null) : null
  // Initial value so that a remount with the same root (explorer toggle) shows the preserved tree from
  // the very first render — filling it in from an effect instead would show 'loading…' for one frame.
  // Why the root-match check lives here and not inside useFileTree: the three branches of the [root]
  // effect below make the same check (`s.root === root`), so keeping the check in this component is what
  // stops the two from drifting apart. The map's key is already the root, so this check can only ever be
  // true here — it is kept anyway so both places enforce the same rule instead of one relying on the
  // other's guarantee.
  // This initial value is only used as useState's lazy initializer, so it applies exactly once, on this
  // hook instance's first render — it does not cover the case where root later becomes equal to this
  // value while still mounted, and that path is still handled by the same branch of the [root] effect
  // (`tree.adoptTree(s)`). Both places make the same comparison, but at different times (here once at
  // mount, the effect on every root change), so it is not duplication.
  const tree = useFileTree(root, savedTree && savedTree.root === root ? savedTree : null)
  // Destructured to keep the existing identifiers, so extracting useFileTree touched the rest of the code as little as possible
  const { dirs, expanded, dirsRef, loadDir, toggleDir, findEntry, entriesOf } = tree

  // git status for the tree rows — the hook re-queries on its own when root changes
  const gitStatus = useGitStatus(root)

  // The selection/anchor/clipboard state machine lives in the pure reducer in
  // core/files/explorerState.ts (extracted into useExplorerSelection so the data-loss guards can be
  // pinned down by unit tests) and this hook wires it into React. The initial clipboard is read from
  // clipboardRef, not from the per-root savedTree — the clipboard has to survive both the unmount caused
  // by the explorer toggle and a root change, otherwise cross-project paste does not work.
  const sel = useExplorerSelection(root, clipboardRef.current ?? null, tree.flatVisible)

  // Mirror of the currently committed root, independent of the per-root map — useFileOps needs to know
  // whether root changed while an async op was in flight, and a map has no single "current root" of its
  // own to ask.
  const currentRootRef = useRef<{ root: string | null }>({ root })

  // The file operation engine plus inline editing live in useFileOps — it does not reimplement the tree
  // cache or the selection state machine, it takes tree and sel injected as-is.
  const ops = useFileOps({
    root,
    tree,
    sel,
    treeRef,
    stateRef: currentRootRef,
    undoRef,
    onPathRenamed,
    onPathDeleted
  })
  const {
    editing,
    editValue,
    setEditValue,
    commitEdit,
    cancelEdit,
    startCreate,
    startRename,
    removeSelection,
    duplicateSelection,
    undo,
    cutOrCopy,
    copyPath,
    paste,
    resetEditingState
  } = ops

  // If the root is unchanged (a remount caused by the explorer toggle) adopt the preserved tree; if it
  // actually changed (session/project switch) reset and reload. The reducer treats selection and
  // clipboard differently per branch — selection is implicit state so it is cleared (leaving it means it
  // goes stale with nothing on screen to show it, and then a delete hits another project's files),
  // while the clipboard is something the user explicitly put there, so it is kept.
  useEffect(() => {
    // Stop a hover auto-expand timer armed against the old root from firing after the switch — the old
    // project folder usually still exists so loadDir succeeds (it does not self-heal via ENOENT
    // eviction), which plants dirs/expanded keys for paths outside the current root, and those then
    // come back on every remount through the stateRef mirror
    disarmHoverExpand()
    if (!root) {
      // Even if the root disappears mid-drag (session ended, etc.) the source row unmounts, so dragend
      // never arrives — the payload has to be cleared here or a stale path left in dragPathsRef gets
      // used by the next drop
      //
      dragPathsRef.current = []
      setDragging(false)
      tree.resetTree()
      sel.dispatch({ type: 'rootCleared' })
      // The Local History modal is tied to the project it was opened for — if the open flag stays true
      // after the session is gone, it abruptly reopens against whatever project fills root next.
      setHistoryOpen(false)
      // Clear the undo journal too — the journal follows the same rule as selection, not the clipboard:
      // the clipboard is something the user explicitly put there and it has on-screen feedback (cut
      // items are dimmed, etc.) so it may cross projects, but the journal holds only paths and has no
      // on-screen presence, so if it survives the active session going away, Ctrl+Z fires against
      // whichever other project is opened next (same rule as explorerState.ts's ExplorerState.selection).
      // This rule applies when root disappears or changes — a refresh (refresh()) on the same root is
      // the deliberate exception and does not clear the journal. See the comment at refresh() for why.
      undoRef.current = []
      return
    }
    const s = stateRef.current?.get(root) ?? null
    if (s && s.root === root) {
      // This branch is only reachable after an unmount→remount (see the comment in the else branch) —
      // and on a remount historyOpen is already false from its useState(false) initial value. So there
      // is nothing to close here.
      tree.adoptTree(s)
      sel.dispatch({ type: 'rootRestored' })
    } else {
      // If the root actually changes mid-drag (session/project switch) the source row unmounts and
      // dragend never reaches React's delegated root listener — the payload has to be cleared here or a
      // stale path left in dragPathsRef gets used by the next drop.
      // The rootRestored branch above does not need to clear it, and the reason is not "the row is
      // still alive" — that branch is only reachable after an unmount→remount in the first place
      // (stateRef is held by the App so it survives unmount, and while we stay mounted the mirror
      // effect keeps stateRef.current up to date for the current root, so a lookup for the new root
      // can only find a stale entry if the App itself put one there under that key — s.root === root
      // can never hold here). On a remount dragPathsRef is a fresh instance's empty ref and is
      // therefore already empty — the drag payload is not preserved through stateRef.
      dragPathsRef.current = []
      setDragging(false)
      tree.resetTree({ load: root })
      // Put focus back on the tree — a project switch usually happens by clicking the Run toolbar's
      // "Go to" button, the history, or a session tab, and when that click target unmounts, focus falls
      // to <body>. With focus on body there is no event that could bubble up to the section's
      // onKeyDown, so Ctrl+V reaches nothing at all. It is not called in the !root branch (no tree) or
      // in the same-root remount branch (where we cannot know what the user just had focus on).
      treeRef.current?.focus()
      sel.dispatch({ type: 'rootChanged' })
      // This component does not unmount when root changes — an open Local History modal would stay
      // holding the previous project's projectPath, so a restore would put the file back into a project
      // the user is not looking at and then try to select that path in the current (new) tree. Close it
      // so the next instance the user opens sees the current root.
      setHistoryOpen(false)
      // Clear the undo journal too — same reason as the !root branch (see the undoRef comment above).
      // The rootRestored branch (the if above) does not clear it — that is a return to the same
      // project, so it is kept just like the tree.
      undoRef.current = []
    }
  }, [root])

  // Mirror the tree state into the App-owned per-root map on every change — the latest state is there
  // right up to the moment of unmount. Nothing is saved for a null root — there is no project to key the
  // entry on, and the branch above already resets the tree in that case.
  // The clipboard is mirrored into its own App-owned ref (not the map) — that is what keeps it alive
  // across both an explorer toggle and a root change, so cross-project paste works.
  // currentRootRef is mirrored here too, for the same reason as the map: useFileOps needs to see the
  // latest committed root right up to the moment of unmount.
  useEffect(() => {
    if (root) stateRef.current?.set(root, { root, expanded, dirs, clipboard: sel.clipboard })
    clipboardRef.current = sel.clipboard
    currentRootRef.current = { root }
  }, [root, expanded, dirs, sel.clipboard])

  const refresh = (): void => {
    tree.resetTree()
    // Clear selection, editing and clipboard too. If the selection survives, selectionPaths() silently
    // filters out paths it can no longer find in the new cache and F2/Delete then do nothing; if the
    // clipboard survives, pasteDir() cannot find the anchor entry and falls back to root, so Ctrl+V
    // pastes in the wrong place (the root). An open input row would also be left behind with its parent
    // gone, so it is closed as well.
    sel.dispatch({ type: 'refreshed' })
    resetEditingState()
    // The undo journal is deliberately NOT cleared here — this is the intentional exception to the
    // "the journal follows the same rule as selection" principle (see the undoRef comment in the [root]
    // effect above). That rule is about undo aimed at paths that are not on screen (root gone or
    // changed) being dangerous, but a refresh keeps root the same — and the journal's accuracy does not
    // depend on this tree cache, it depends on re-checking the actual disk with files.list at undo()
    // time (partitionInvOps), so emptying the cache does not make the journal stale. Clearing it here
    // would instead silently throw away undoable operations on every refresh (behavior is left as it
    // is; this comment documents the decision).
    if (root) loadDir(root)
    gitStatus.refresh() // refresh git status along with the explorer — appended after the existing behavior, which is unchanged
  }

  const menuItemsFor = (entry: Entry | null): MenuItem[] => {
    // entry=null (root empty space) is treated as the root folder. For a file, New File/New Folder are created in its parent (VS Code behavior)
    // root!: this menu only opens from the tree, and the tree only renders when root exists, so root is always non-null.
    const dirForCreate = entry === null ? root! : entry.isDir ? entry.path : parentDir(entry.path)
    // Menu labels and disabled states must use the real number of targets. selection.size is only the
    // number of highlighted rows, so selecting a folder together with files inside it makes the
    // displayed count disagree with the real operation count (selectionPaths, after collapsing a folder
    // with its descendants). menuItemsFor runs during render, so selectionPaths() is computed once and
    // reused.
    const targetCount = sel.selectionPaths().length
    const items: MenuItem[] = [
      { label: t('explorer.menu.newFile'), onSelect: () => startCreate(dirForCreate, false) },
      { label: t('explorer.menu.newFolder'), onSelect: () => startCreate(dirForCreate, true) }
    ]
    if (entry) {
      items.push(
        'separator',
        {
          label: t('explorer.menu.rename'),
          onSelect: () => startRename(entry),
          disabled: targetCount > 1 // the target must be exactly one
        },
        {
          label:
            targetCount > 1
              ? t('explorer.menu.duplicateCount', { count: targetCount })
              : t('files.action.duplicate'),
          onSelect: () => void duplicateSelection()
        },
        {
          label:
            targetCount > 1
              ? t('explorer.menu.deleteCount', { count: targetCount })
              : t('explorer.menu.delete'),
          onSelect: () => void removeSelection(),
          danger: true
        }
      )
      items.push(
        'separator',
        { label: t('explorer.menu.cut'), onSelect: () => cutOrCopy('cut') },
        { label: t('explorer.menu.copy'), onSelect: () => cutOrCopy('copy') }
      )
    }
    items.push('separator', {
      label: t('explorer.menu.paste'),
      onSelect: () => void paste(dirForCreate), // same interpretation of "here" as New File/New Folder
      disabled: sel.clipboard === null
    })
    // The history is per-project, so this is always shown regardless of entry — it sits outside the
    // if (entry) block above and therefore also appears in the root empty-space menu (entry===null).
    // 'Local History' is a feature name (a proper noun) and is left untranslated in every locale.
    items.push('separator', { label: 'Local History…', onSelect: () => setHistoryOpen(true) })
    const target = entry?.path ?? root!
    items.push(
      'separator',
      { label: t('explorer.menu.copyPath'), onSelect: () => copyPath(target, false) },
      {
        label: t('explorer.menu.copyRelativePath'),
        onSelect: () => copyPath(target, true),
        disabled: entry === null
      },
      {
        label: t('explorer.menu.reveal'),
        onSelect: () =>
          void window.api.files.reveal(target).catch((err: unknown) => {
            toast.error(t('explorer.reveal.failed', { detail: errText(err) }))
          })
      }
    )
    return items
  }

  /** Where a drop on this row lands. A folder means inside it, a file means its parent, entry null
   *  (empty space) means the root.
   *  Uses the same interpretation of "here" as dirForCreate and pasteDir — "here" must not diverge
   *  within one menu or one tree.
   *  root!: this helper is only called after the tree has rendered (only during a drag), and the tree
   *  only renders when root exists. */
  const dropTargetOf = (entry: Entry | null): string =>
    entry === null ? root! : entry.isDir ? entry.path : parentDir(entry.path)

  /** Whether the drop is allowed. If there is any blocking reason it returns false, which turns off
   *  both the highlight and the dropEffect.
   *  For cut (move) canMove filters out cycles and no-ops (already in that location); for copy canCopy
   *  filters out cycles only (copying into the same folder is fine, because uniqueName sidesteps it
   *  with ' copy').
   *  Why some: when dragging several items the drop is allowed even if only part of them can move —
   *  transferTo reports the rest with a 'skipped' toast. Only an all-blocked drag is refused. */
  const dropAllowed = (destDir: string, copy: boolean): boolean => {
    const paths = dragPathsRef.current
    if (paths.length === 0) return false
    return paths.some((p) => (copy ? canCopy(p, destDir) : canMove(p, destDir)) === null)
  }

  /** Drag start/end. Shared by file rows and folder rows, so it is pulled out into a helper (avoids duplication). */
  const dragHandlers = (entry: Entry): React.HTMLAttributes<HTMLDivElement> => ({
    draggable: true,
    onDragStart: (ev) => {
      // Dragging a row outside the selection selects just that row first (VS Code / file manager behavior)
      if (!sel.selection.has(entry.path)) sel.applyContextSelection(entry.path)
      // applyContextSelection is a dispatch, so it is not reflected in this render's sel.selection.
      // If the row the drag started on was outside the selection, take just that row as the target
      // rather than the selection we only just dispatched.
      const paths = sel.selection.has(entry.path) ? sel.selectionPaths() : [entry.path]
      dragPathsRef.current = paths
      setDragging(true)
      ev.dataTransfer.effectAllowed = 'copyMove'
      // For external apps — validity inside this app is decided from dragPathsRef (this value cannot be read during dragover)
      ev.dataTransfer.setData('text/plain', paths.join('\n'))
    },
    onDragEnd: () => {
      dragPathsRef.current = []
      setDragging(false)
      setDropDir(null)
      disarmHoverExpand()
    }
  })

  /** Hover auto-expand — hovering over a collapsed folder expands it so items can be dropped inside.
   *  Without this there is no way to drop into a closed folder. The timer is re-armed when the target changes. */
  const hoverExpandRef = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null)
  const armHoverExpand = (entry: Entry | null): void => {
    const path = entry?.isDir ? entry.path : null
    if (hoverExpandRef.current?.path === path) return // same target — keep the timer running
    if (hoverExpandRef.current) clearTimeout(hoverExpandRef.current.timer)
    hoverExpandRef.current = null
    if (!path || tree.expanded.has(path)) return
    hoverExpandRef.current = {
      path,
      timer: setTimeout(() => {
        hoverExpandRef.current = null
        tree.expandDir(path)
        if (!tree.dirsRef.current[path]) tree.loadDir(path)
      }, 500)
    }
  }
  const disarmHoverExpand = (): void => {
    if (hoverExpandRef.current) clearTimeout(hoverExpandRef.current.timer)
    hoverExpandRef.current = null
  }
  // Clear any pending timer on unmount — otherwise the callback runs after unmount and calls
  // tree.expandDir/loadDir
  useEffect(() => () => disarmHoverExpand(), [])

  /** Auto-scroll at the tree's edges during a drag — so items can be dragged to folders scrolled out of
   *  view. dragover arrives dozens of times per second, so scrollTop is touched directly inside it (no
   *  separate rAF loop needed). */
  const EDGE = 40
  const STEP = 12
  const autoScroll = (ev: React.DragEvent): void => {
    const el = treeRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    if (ev.clientY - r.top < EDGE) el.scrollTop -= STEP
    else if (r.bottom - ev.clientY < EDGE) el.scrollTop += STEP
  }

  /** Drop handling. Shared by file rows, folder rows and the tree container (entry=null, empty
   *  space → root).
   *  Why onDragOver calls stopPropagation first: these rows are all nested inside the .fx-tree
   *  container, so without it the same dragover bubbles up to the ancestor (.fx-tree, which decides
   *  entry=null→root) and overwrites this row's decision — if the drop is blocked on this row (e.g.
   *  onto itself) but allowed for root, the cursor wrongly reads as "allowed". onDrop calls
   *  stopPropagation for the same reason. */
  const dropHandlers = (entry: Entry | null): React.HTMLAttributes<HTMLDivElement> => ({
    onDragOver: (ev) => {
      ev.stopPropagation()
      // Before the validity check — scrolling has to work even over an invalid target (e.g. a cycle),
      // otherwise you cannot drag to a folder that is off screen
      autoScroll(ev)
      // External (OS) drags are not handled — out of scope. preventDefault is required here to stop
      // Chromium from navigating the frame to the dropped file. dataTransfer's 'data' cannot be read
      // during dragover but 'types' can, which is how an external file drag is detected.
      // Without this check, a stale path left in dragPathsRef would let an external drag pass
      // dropAllowed and move files the user never dragged
      if (ev.dataTransfer.types.includes('Files')) {
        ev.preventDefault()
        ev.dataTransfer.dropEffect = 'none'
        setDropDir(null)
        disarmHoverExpand()
        return
      }
      const dest = dropTargetOf(entry)
      const copy = ev.ctrlKey || ev.metaKey
      if (!dropAllowed(dest, copy)) {
        ev.dataTransfer.dropEffect = 'none'
        setDropDir(null)
        disarmHoverExpand()
        return
      }
      ev.preventDefault() // drop only fires if preventDefault is called
      ev.dataTransfer.dropEffect = copy ? 'copy' : 'move'
      setDropDir(dest)
      armHoverExpand(entry) // end of the success path — a new timer is armed only when the target changed
    },
    onDragLeave: (ev) => {
      // dragleave also fires when moving into a child, so check whether we actually left
      if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) {
        setDropDir(null)
        disarmHoverExpand()
      }
    },
    onDrop: (ev) => {
      ev.preventDefault()
      ev.stopPropagation() // keep the parent row/container from handling the same drop twice
      disarmHoverExpand()
      const dest = dropTargetOf(entry)
      const copy = ev.ctrlKey || ev.metaKey
      const paths = dragPathsRef.current
      dragPathsRef.current = []
      setDragging(false)
      setDropDir(null)
      if (paths.length === 0) return
      void ops.transferTo(copy ? 'copy' : 'cut', paths, dest)
    }
  })

  const renaming = (entry: Entry): boolean => editing?.kind === 'rename' && editing.path === entry.path

  // git status → display letter and tooltip key. The letters are language-neutral, so they are not translated.
  const GIT_MARK: Record<GitState, string> = {
    new: 'U',
    modified: 'M',
    deleted: 'D',
    conflict: 'C'
  }
  const GIT_LABEL: Record<GitState, 'explorer.git.new' | 'explorer.git.modified' | 'explorer.git.deleted' | 'explorer.git.conflict'> = {
    new: 'explorer.git.new',
    modified: 'explorer.git.modified',
    deleted: 'explorer.git.deleted',
    conflict: 'explorer.git.conflict'
  }

  const editRow = (depth: number, isDir: boolean): React.JSX.Element => {
    const reason = tm(validateName(editValue.trim()))
    return (
      <div className="fx-row fx-edit" style={{ paddingLeft: depth * 14 + 8 }}>
        <span className="fx-caret" />
        <FileIcon
          {...(isDir
            ? resolveFolderIcon(editValue || 'folder', false)
            : resolveFileIcon(editValue || 'file'))}
        />
        <div className="fx-edit-box">
          <input
            autoFocus
            className={reason && editValue !== '' ? 'invalid' : ''}
            value={editValue}
            onChange={(ev) => setEditValue(ev.target.value)}
            onFocus={(ev) => {
              // For a rename, select only the part before the extension (VS Code behavior)
              if (editing?.kind === 'rename') {
                const dot = editValue.lastIndexOf('.')
                ev.target.setSelectionRange(0, dot > 0 ? dot : editValue.length)
              }
            }}
            onKeyDown={(ev) => {
              ev.stopPropagation() // isolate from the tree's F2/Delete and the global listeners
              if (ev.key === 'Enter') void commitEdit('enter')
              else if (ev.key === 'Escape') cancelEdit()
            }}
            onBlur={() => void commitEdit('blur')}
          />
          {reason && editValue !== '' && <span className="fx-edit-reason">{reason}</span>}
        </div>
      </div>
    )
  }

  const renderDir = (dirPath: string, depth: number): React.JSX.Element => {
    // Cut items are dimmed (VS Code behavior). Descendants of a cut folder go away with it, so they are dimmed too.
    const isCut = (p: string): boolean =>
      sel.clipboard?.mode === 'cut' && sel.clipboard.paths.some((c) => isSubPath(c, p))

    // If a create edit is open for this folder, put the input row at the top — attached to all four
    // return paths, including loading / read failure / empty folder. That is what makes the New
    // File/New Folder input row visible even in a folder that has never been expanded or is empty.
    const creating = editing?.kind === 'create' && editing.parentDir === dirPath
    const createRow = creating ? editRow(depth, editing.isDir) : null

    const state = dirs[dirPath]
    if (!state)
      return (
        <>
          {createRow}
          <div className="fx-note" style={{ paddingLeft: depth * 14 + 24 }}>
            {t('explorer.dir.loading')}
          </div>
        </>
      )
    if (state.error)
      return (
        <>
          {createRow}
          <div className="fx-note" style={{ paddingLeft: depth * 14 + 24 }}>
            {t('explorer.dir.readFailed', { detail: state.error })}
          </div>
        </>
      )
    if (!state.entries || state.entries.length === 0)
      return (
        <>
          {createRow}
          <div className="fx-note" style={{ paddingLeft: depth * 14 + 24 }}>
            {t('explorer.dir.empty')}
          </div>
        </>
      )
    return (
      <>
        {createRow}
        {state.entries.map((entry) => {
          if (!entry.isDir) {
            if (renaming(entry)) return <div key={entry.path}>{editRow(depth, entry.isDir)}</div>
            return (
              <div
                key={entry.path}
                // No drop-into here — dropping on a file targets its parent, and highlighting the
                // parent folder row is what reads correctly as "where this is going". Highlighting the
                // file row itself would look like dropping inside that file.
                className={`fx-row file${sel.selection.has(entry.path) ? ' selected' : ''}${isCut(entry.path) ? ' cut' : ''}${dragging && dragPathsRef.current.includes(entry.path) ? ' dragging' : ''}`}
                style={{ paddingLeft: depth * 14 + 8 }}
                title={entry.path}
                onClick={(ev) => {
                  sel.applyClickSelection(entry.path, ev)
                }}
                // Opening is the double click's job, so that a single click leaves focus on the tree.
                // Opening a file hands the cursor to the editor (FileEditor's focused effect), and with
                // the cursor in CodeMirror the next Ctrl+C is CodeMirror's copy, which on an empty
                // selection copies the cursor's line — that is how "copy the file, paste it into the
                // session" used to paste the file's first line instead of its path.
                onDoubleClick={(ev) => {
                  // Ctrl/Shift only change the selection, they never open — the same rule the single
                  // click follows (applyClickSelection's return value)
                  if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return
                  onOpenFile(entry.path)
                }}
                onContextMenu={(ev) => {
                  ev.preventDefault()
                  sel.applyContextSelection(entry.path)
                  setMenu({ x: ev.clientX, y: ev.clientY, entry })
                }}
                {...dragHandlers(entry)}
                {...dropHandlers(entry)}
              >
                <span className="fx-caret" />
                <FileIcon {...resolveFileIcon(entry.name)} />
                <span className={`fx-name${gitStatus.fileState[entry.path] ? ` git-${gitStatus.fileState[entry.path]}` : ''}`}>
                  {entry.name}
                </span>
                {gitStatus.fileState[entry.path] && (
                  <span
                    className={`fx-git-mark git-${gitStatus.fileState[entry.path]}`}
                    title={t(GIT_LABEL[gitStatus.fileState[entry.path]])}
                    aria-label={t(GIT_LABEL[gitStatus.fileState[entry.path]])}
                  >
                    {GIT_MARK[gitStatus.fileState[entry.path]]}
                  </span>
                )}
              </div>
            )
          }
          // The caret, the icon and the child render must all see the same expanded state — read it once and share it across the three
          const isOpen = expanded.has(entry.path)
          return (
            <div key={entry.path}>
              {renaming(entry) ? (
                editRow(depth, entry.isDir)
              ) : (
                <div
                  className={`fx-row${sel.selection.has(entry.path) ? ' selected' : ''}${isCut(entry.path) ? ' cut' : ''}${dragging && dragPathsRef.current.includes(entry.path) ? ' dragging' : ''}${dropDir === entry.path ? ' drop-into' : ''}`}
                  style={{ paddingLeft: depth * 14 + 8 }}
                  onClick={(ev) => {
                    if (sel.applyClickSelection(entry.path, ev)) toggleDir(entry.path)
                  }}
                  onContextMenu={(ev) => {
                    ev.preventDefault()
                    sel.applyContextSelection(entry.path)
                    setMenu({ x: ev.clientX, y: ev.clientY, entry })
                  }}
                  {...dragHandlers(entry)}
                  {...dropHandlers(entry)}
                >
                  <span className="fx-caret">{isOpen ? '▾' : '▸'}</span>
                  <FileIcon {...resolveFolderIcon(entry.name, isOpen)} />
                  <span className="fx-name">{entry.name}</span>
                  {gitStatus.folderCount[entry.path] > 0 && (
                    <span
                      className="fx-git-count"
                      title={t('explorer.git.folderCount', { count: gitStatus.folderCount[entry.path] })}
                    >
                      {gitStatus.folderCount[entry.path]}
                    </span>
                  )}
                </div>
              )}
              {isOpen && renderDir(entry.path, depth + 1)}
            </div>
          )
        })}
      </>
    )
  }

  if (!root) {
    return (
      <section className="file-explorer">
        <header className="panel-header">
          <h2>{t('explorer.title')}</h2>
          <div className="panel-actions">
            <button
              className="icon-btn"
              aria-label={t('common.close')}
              title={t('common.close')}
              onClick={onClose}
            >
              ✕
            </button>
          </div>
        </header>
        <p className="empty">{t('explorer.noActiveSession')}</p>
      </section>
    )
  }

  const rootName = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  return (
    <section
      className="file-explorer"
      onKeyDown={(ev) => {
        // Only Ctrl+A/X/C/V/Z are widened to the whole panel — switching projects means clicking the
        // Run toolbar's "Go to" button, the history, a session tab and so on, and that click steals
        // focus from the tree, so if these lived only on the tree's onKeyDown, Ctrl+V would never
        // arrive anywhere. Events raised in the tree bubble up here too, so they keep working while the
        // tree has focus. F2/Delete are not widened here — unlike the Ctrl combinations, which have no
        // default action, they are single keys that do have one, and a bare Delete while focus is on
        // the header ⟳/✕ buttons must not be able to delete files.
        // The inline-edit <input> (editRow) calls stopPropagation unconditionally at the top of its
        // onKeyDown, so while editing no event reaches this handler — Ctrl+Z keeps the input's native
        // undo (no special handling needed). The editing guard below is a second line of defense
        // independent of that.
        // historyOpen (the Local History modal) is guarded too — the modal renders inside this
        // <section> (`<LocalHistoryDialog>` below) so in DOM terms it is inside this onKeyDown, and ContextMenu gives itself
        // neither focus() nor tabIndex on mount, so opening the modal with Enter from the menu leaves
        // focus on .fx-tree — without the guard, Ctrl+Z/Ctrl+V would fire on the tree behind the open
        // modal with no confirmation. This guard means "every overlay on top of the explorer" — any
        // modal added later must have its open flag added here as well.
        if (editing || menu || historyOpen) return
        const target = ev.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return // defensive — the inline-edit input already calls stopPropagation
        if ((ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !ev.altKey) {
          const k = ev.key.toLowerCase()
          if (k === 'a' || k === 'x' || k === 'c' || k === 'v' || k === 'z') {
            ev.preventDefault() // suppress the browser default (select all / copy) and the global listeners
            if (k === 'a') sel.dispatch({ type: 'selectAll', paths: tree.flatVisible() })
            else if (k === 'x') cutOrCopy('cut')
            else if (k === 'c') cutOrCopy('copy')
            else if (k === 'v') void paste()
            else void undo() // Ctrl+Shift+Z (redo) is caught by the !ev.shiftKey check above and never reaches this block — redo is out of scope
          }
        }
      }}
    >
      <header className="panel-header">
        {/* The root gets the same folder icon as the tree rows — CSS shrinks it to 12px to match the header type scale (10.5px) */}
        <h2 title={root}>
          <FileIcon {...resolveFolderIcon(rootName, true)} />
          <span className="fx-root-name">{rootName}</span>
        </h2>
        <div className="panel-actions">
          <button
            className="icon-btn"
            aria-label={t('explorer.refresh')}
            title={t('explorer.refresh')}
            onClick={refresh}
          >
            ⟳
          </button>
          <button
            className="icon-btn"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={onClose}
          >
            ✕
          </button>
        </div>
      </header>
      <div
        className="fx-tree"
        ref={treeRef}
        tabIndex={0}
        onContextMenu={(ev) => {
          if (ev.target === ev.currentTarget) {
            ev.preventDefault()
            setMenu({ x: ev.clientX, y: ev.clientY, entry: null })
          }
        }}
        onKeyDown={(ev) => {
          // Tree focus only, not global — this must not disturb F2/Delete in the editor or the terminal
          // Ignored while the menu is open too — running a shortcut over the menu buries the confirm
          // modal underneath it
          // historyOpen (the Local History modal) is ignored as well — in DOM terms the modal renders
          // inside this tree (`<LocalHistoryDialog>` below), and if it was opened with Enter from the context menu, focus is
          // still on .fx-tree, so without the guard F2/Delete over the modal would reach the tree
          // behind it. This guard means "every overlay on top of the explorer" — when a modal is added,
          // widen this too.
          // Ctrl+A/X/C/V are not here — they moved to the section's onKeyDown. Events raised in the
          // tree bubble up there, so they keep working while the tree has focus. F2/Delete are keys
          // that have a default action, so they stay narrowed to the tree — a Delete while focus is on
          // the header ⟳/✕ buttons must not delete a file
          if (editing || menu || historyOpen) return
          if (ev.key === 'Escape' && sel.clipboard) {
            ev.preventDefault()
            sel.dispatch({ type: 'clipboardCleared' })
            return
          }
          if (ev.key === 'F2') {
            // Rename needs exactly one target — with several there is no way to decide which one to change
            if (sel.selection.size !== 1) return
            const entry = findEntry([...sel.selection][0])
            if (!entry) return
            ev.preventDefault()
            startRename(entry)
          } else if (ev.key === 'Delete') {
            if (sel.selection.size === 0) return
            ev.preventDefault()
            void removeSelection()
          }
        }}
        {...dropHandlers(null)}
      >
        {renderDir(root, 0)}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItemsFor(menu.entry)} onClose={() => setMenu(null)} />
      )}
      {historyOpen && root && (
        <LocalHistoryDialog
          projectPath={root}
          onRestored={(path) => {
            // doRestore is async, so it keeps running regardless of unmount. This callback is a closure
            // from the moment the modal rendered, so the root inside it is pinned to "the root when the
            // modal was opened". If the user changes the root while the restore is in progress (via a
            // session tab, etc. — even though the else branch closes the modal with
            // setHistoryOpen(false)), a result arriving in the meantime touches tree.loadDir and
            // sel.dispatch for this closure's root, which has nothing to do with what is on screen: the
            // old project's directory listing gets planted in the dirs cache the current tree renders
            // from, and selection/anchor get overwritten with old paths — after which Ctrl+V and F2
            // find that off-screen path as their target. currentRootRef.current.root is updated to the
            // current root by the mirror effect (above) on every commit, so comparing it against this
            // closure's root tells us exactly whether the root changed in between. toast.success has
            // already been shown inside LocalHistoryDialog — the restore really did happen, so it is
            // not suppressed. When the user closes the modal themselves (root unchanged) this guard
            // does not trip and the tree is refreshed normally.
            if (currentRootRef.current.root !== root) return
            // Same ordering convention as transferTo (paste/drop) — the parent has to be expanded and
            // re-read, otherwise the item just restored stays hidden behind a collapsed folder. Without
            // the expand, the selectionSet right after it would be a selection that is not visible on
            // screen, which makes it pointless.
            tree.expandDir(parentDir(path))
            tree.loadDir(parentDir(path))
            sel.dispatch({ type: 'selectionSet', paths: [path] })
            setHistoryOpen(false)
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </section>
  )
}
