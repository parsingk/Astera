import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { parentDir } from '../../../core/files/paths'
import { validateName, isSubPath, canMove, canCopy } from '../../../core/files/ops'
import { resolveFileIcon, resolveFolderIcon } from '../../../core/files/icons'
import { FileIcon } from './FileIcon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { LocalHistoryDialog } from './LocalHistoryDialog'
import { RootReading, FileOpStatusLine, ROOT_SLOW_MS } from './ExplorerLoading'
import { ExplorerRow, type RowActions } from './ExplorerRow'
import {
  buildTreeRows,
  rowOffsets,
  visibleRange,
  revealScrollTop,
  moveCursor,
  entryPaths,
  editRowKey,
  drawnRows,
  resolveReveal,
  cursorOrigin,
  type PendingReveal,
  ROW_H,
  OVERSCAN,
  DEFAULT_VIEWPORT_H,
  type CursorKey,
  type TreeRow
} from './explorerRows'
import { toast } from '../lib/toast'
import { useFileTree, type Entry, type DirState } from '../hooks/useFileTree'
import { useExplorerSelection, type ExplorerSelection } from '../hooks/useExplorerSelection'
import { useFileOps, errText } from '../hooks/useFileOps'
import { useGitStatus } from '../hooks/useGitStatus'
import { useKubeKinds } from '../hooks/useKubeKinds'
import { normKubePath } from '../hooks/useKubeOps'
import { useI18n } from '../i18n/I18nProvider'
import type { UndoEntry } from '../../../core/files/undo'
import type { KubeFileKind } from '../../../core/kube/types'
import type { MessageKey } from '../../../core/i18n'
import { runnableKindForFile } from '../../../core/run/runFile'
import { CloudUpload, GitCompare, RefreshCw, Trash2, X } from 'lucide-react'
import { deleteKey, isMac, modKey } from '../lib/platformKeys'
import { isWindowsPath, revealFor, treeKeysTo, type FolderReveal } from '../lib/folderLink'

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

/** How long a requested reveal waits for its row to appear (a pasted file's folder is still being re-read) */
const REVEAL_WAIT_MS = 3000

/** Keys that move the selection over the tree's rows */
const CURSOR_KEYS: Record<string, CursorKey> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown'
}

export type KubeVerb = 'compare' | 'apply' | 'reload' | 'delete'

/** The "Kubernetes" group item of the context menu, or null when nothing in the selection can be a target.
 *  A manifest, a kustomization or a folder (which may hold manifests; the real planning is the main
 *  process's) is a target. Helm templates are not: when they are all there is, the group still shows,
 *  disabled, saying why. Reload is for exactly one manifest file. */
export function kubeMenuItems(args: {
  selection: string[]
  kinds: Record<string, KubeFileKind>
  isDir(p: string): boolean
  heading: string
  t: (k: MessageKey, p?: Record<string, string | number>) => string
  on: Record<KubeVerb, () => void>
}): MenuItem | null {
  const { selection, kinds, isDir, heading, t, on } = args
  const applicable = selection.some(
    (p) => isDir(p) || kinds[p] === 'manifest' || kinds[p] === 'kustomization'
  )
  const helmOnly = !applicable && selection.some((p) => kinds[p] === 'helm-template')
  if (!applicable && !helmOnly) return null
  const onlyManifest = selection.length === 1 && !isDir(selection[0]) && kinds[selection[0]] === 'manifest'
  const helmTitle = helmOnly ? t('kube.menu.helm') : undefined
  const reloadOff = helmOnly || !onlyManifest
  // A kustomization holds a list, not an object; a Kustomize member is refused once its target is known.
  const oneKustomization = selection.length === 1 && kinds[selection[0]] === 'kustomization'
  return {
    label: t('kube.menu.group'),
    icon: <FileIcon id="kubernetes" tone="blue" />,
    submenu: [
      { heading },
      { label: t('kube.menu.compare'), icon: <GitCompare size={14} />, onSelect: on.compare, disabled: helmOnly, title: helmTitle },
      { label: t('kube.menu.apply'), icon: <CloudUpload size={14} />, onSelect: on.apply, disabled: helmOnly, title: helmTitle },
      {
        label: t('kube.menu.reload'),
        icon: <RefreshCw size={14} />,
        onSelect: on.reload,
        disabled: reloadOff,
        title: helmOnly
          ? helmTitle
          : oneKustomization
            ? t('kube.menu.reloadKustomize')
            : reloadOff
              ? t('kube.menu.reloadOnlyOne')
              : undefined
      },
      'separator',
      { label: t('kube.menu.delete'), icon: <Trash2 size={14} />, onSelect: on.delete, danger: true, disabled: helmOnly, title: helmTitle },
      'separator',
      { heading: t('kube.menu.footnote') }
    ]
  }
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
  onPathDeleted,
  onRunFile,
  onKube,
  kubeFailed,
  revealFolder,
  onRevealDone
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
  /** Runs a file from the context menu. The explorer does not own the run panel, so what a started run
   *  does to the screen stays in one place — the App's own run-start path. */
  onRunFile: (path: string) => void
  /** A Kubernetes verb picked from the context menu, with the operation targets. Absent: no Kubernetes item. */
  onKube?: (verb: KubeVerb, selection: string[]) => void
  /** Files whose last Kubernetes operation failed: their rows carry a warning mark. */
  kubeFailed?: ReadonlySet<string>
  /** A folder a terminal link named under this root (D2, 2026-10-14), as its names below the root: each level is
   *  expanded and the folder selected and scrolled to. A new `seq` asks again for the same folder. */
  revealFolder?: FolderReveal | null
  /** The request with this seq is handled (or was for another root): the App clears it, so a remount does not run it
   *  again (final review I2). */
  onRevealDone?: (seq: number) => void
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
  /** The spacer inside the tree that is as tall as every row — a right-click on it is on empty space */
  const spaceRef = useRef<HTMLDivElement>(null)
  /** The row a drag started on — kept drawn while the drag lasts, since its dragend fires on it */
  const dragSourceRef = useRef<string | null>(null)

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
  const { dirs, expanded, dirsRef, toggleDir, findEntry, entriesOf } = tree

  // The root's first read on a big folder or a shared drive can take seconds. Past ROOT_SLOW_MS the tree
  // says it is still reading, instead of sitting blank; below that nothing shows, so a fast folder does
  // not flash a message for one frame.
  const rootPending = !!root && !dirs[root]
  // A refresh keeps the tree on screen, so this is the one sign it is working: the icon turns while the root is
  // read again. tree.loading lags a read by ROW_SPINNER_DELAY_MS, so a quick refresh does not flicker it.
  const refreshing = root !== null && tree.loading.has(root)
  const [rootSlow, setRootSlow] = useState(false)
  useEffect(() => {
    setRootSlow(false)
    if (!rootPending) return
    const timer = setTimeout(() => setRootSlow(true), ROOT_SLOW_MS)
    return () => clearTimeout(timer)
  }, [rootPending, root])

  // git status for the tree rows — the hook re-queries on its own when root changes
  const gitStatus = useGitStatus(root)

  // The selection/anchor/clipboard state machine lives in the pure reducer in
  // core/files/explorerState.ts (extracted into useExplorerSelection so the data-loss guards can be
  // pinned down by unit tests) and this hook wires it into React. The initial clipboard is read from
  // clipboardRef, not from the per-root savedTree — the clipboard has to survive both the unmount caused
  // by the explorer toggle and a root change, otherwise cross-project paste does not work.
  const sel = useExplorerSelection(root, clipboardRef.current ?? null, tree.flatVisible)

  // A row to bring into view once it exists: what an operation just selected (create, rename,
  // duplicate, paste, drop, a Local History restore) and the row being edited. The tree is virtualized,
  // so that row may be far outside the drawn window — or not listed yet, while its folder is re-read.
  const [reveal, setReveal] = useState<PendingReveal | null>(null)
  const requestReveal = (key: string): void => setReveal({ key, until: Date.now() + REVEAL_WAIT_MS })
  /** The selection as the file operations see it: the same, except that a selection an operation sets
   *  is also revealed */
  const opsSel: ExplorerSelection = {
    ...sel,
    dispatch: (action) => {
      sel.dispatch(action)
      // The last path — the one the reducer makes the anchor, so the row scrolled to is the row a
      // following Shift click or keyboard move starts from
      if (action.type === 'selectionSet' && action.paths.length > 0)
        requestReveal(action.paths[action.paths.length - 1])
    }
  }

  // A folder link's reveal: the keys are found by listing each level as the tree does (folderLink.ts treeKeysTo), so a
  // link spelled in another case still finds the rows; then every level is expanded and the folder selected, which
  // brings it into view (requestReveal through opsSel). A request for another root, or one that no longer matches the
  // disk, does nothing.
  useEffect(() => {
    if (!revealFolder) return
    const segments = revealFor(revealFolder, root)
    if (segments === null || !root) {
      // Made for another root: it can never apply here, and must not when this root's tree has the same names
      onRevealDone?.(revealFolder.seq)
      return
    }
    let cancelled = false
    void treeKeysTo(root, segments, (dir) => window.api.files.list(dir), isWindowsPath(root)).then((keys) => {
      if (cancelled) return
      onRevealDone?.(revealFolder.seq)
      if (keys === null) {
        // Gone since the link resolved, as the system file manager's path says too (final review m7)
        toast.error(t('files.openFolder.notFolder'))
        return
      }
      for (const key of keys) {
        tree.expandDir(key)
        tree.loadDir(key)
      }
      if (keys.length > 0) opsSel.dispatch({ type: 'selectionSet', paths: [keys[keys.length - 1]] })
    })
    return () => {
      cancelled = true
    }
    // The request's seq is the trigger; tree and opsSel are this render's, read when it fires
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealFolder?.seq, root])

  // Mirror of the currently committed root, independent of the per-root map — useFileOps needs to know
  // whether root changed while an async op was in flight, and a map has no single "current root" of its
  // own to ask.
  const currentRootRef = useRef<{ root: string | null }>({ root })

  // The file operation engine plus inline editing live in useFileOps — it does not reimplement the tree
  // cache or the selection state machine, it takes tree and sel injected as-is.
  const ops = useFileOps({
    root,
    tree,
    sel: opsSel,
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
    pasteFromEvent,
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
      dragSourceRef.current = null
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
      dragSourceRef.current = null
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
    // The folders the person opened stay open and are read again (planRefresh); resetting the tree here
    // closed every one of them (2026-10-12).
    tree.refreshTree()
    // The selection and an open input row are still cleared. A refresh is the person asking for the disk as
    // it is, and what they had selected may be gone from it: a selection naming a deleted file is silently
    // filtered out by selectionPaths() and F2/Delete then do nothing, and an input row could be left behind
    // with its parent gone. The clipboard stays, as it does on a root switch: a cut or copy survives a
    // refresh, and a source that is gone is reported when it is pasted.
    sel.dispatch({ type: 'refreshed' })
    resetEditingState()
    // The undo journal is deliberately NOT cleared here — this is the intentional exception to the
    // "the journal follows the same rule as selection" principle (see the undoRef comment in the [root]
    // effect above). That rule is about undo aimed at paths that are not on screen (root gone or
    // changed) being dangerous, but a refresh keeps root the same — and the journal's accuracy does not
    // depend on this tree cache, it depends on re-checking the actual disk with files.list at undo()
    // time (partitionInvOps), so re-reading the cache does not make the journal stale. Clearing it here
    // would instead silently throw away undoable operations on every refresh (behavior is left as it
    // is; this comment documents the decision).
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
              ? t('explorer.menu.deleteCount', { count: targetCount, del: deleteKey() })
              : t('explorer.menu.delete', { del: deleteKey() }),
          onSelect: () => void removeSelection(),
          danger: true
        }
      )
      items.push(
        'separator',
        { label: t('explorer.menu.cut', { mod: modKey() }), onSelect: () => cutOrCopy('cut') },
        { label: t('explorer.menu.copy', { mod: modKey() }), onSelect: () => cutOrCopy('copy') }
      )
    }
    items.push('separator', {
      label: t('explorer.menu.paste', { mod: modKey() }),
      onSelect: () => void paste(dirForCreate), // same interpretation of "here" as New File/New Folder
      // Enabled by either clipboard: the app's own, or the OS one holding files copied in Explorer or
      // Finder. Read while the menu is being built, which is the moment it is shown.
      disabled: sel.clipboard === null && !window.api.clipboard.hasFiles()
    })
    // Only for a file whose name implies a runnable kind. A file it does not — a Dockerfile, a .ts —
    // gets no item at all, rather than one that would refuse when pressed.
    if (entry && !entry.isDir && runnableKindForFile(entry.name)) {
      items.push('separator', {
        label: t('run.explorer.runFile', { name: entry.name }),
        onSelect: () => onRunFile(entry.path)
      })
    }
    // Kubernetes targets are the selected rows. A right-click outside the selection acts on that row alone.
    if (entry && onKube) {
      const paths = sel.selection.has(entry.path) ? sel.selectionPaths() : [entry.path]
      const dirPaths = new Set(rows.flatMap((r) => (r.kind === 'entry' && r.entry.isDir ? [r.entry.path] : [])))
      const kube = kubeMenuItems({
        selection: paths,
        kinds: kubeKinds,
        isDir: (p) => dirPaths.has(p),
        heading: t('kube.menu.heading', { count: paths.length }),
        t,
        on: {
          compare: () => onKube('compare', paths),
          apply: () => onKube('apply', paths),
          reload: () => onKube('reload', paths),
          delete: () => onKube('delete', paths)
        }
      })
      if (kube) items.push('separator', kube)
    }
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
        label: t(isMac() ? 'explorer.menu.revealMac' : 'explorer.menu.reveal'),
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
      dragSourceRef.current = entry.path
      setDragging(true)
      ev.dataTransfer.effectAllowed = 'copyMove'
      // For external apps — validity inside this app is decided from dragPathsRef (this value cannot be read during dragover)
      ev.dataTransfer.setData('text/plain', paths.join('\n'))
    },
    onDragEnd: () => {
      dragPathsRef.current = []
      dragSourceRef.current = null
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
      dragSourceRef.current = null
      setDragging(false)
      setDropDir(null)
      if (paths.length === 0) return
      void ops.transferTo(copy ? 'copy' : 'cut', paths, dest)
    }
  })

  const editRow = (key: string, depth: number, isDir: boolean, top: number, height: number): React.JSX.Element => {
    const reason = tm(validateName(editValue.trim()))
    return (
      <div
        key={key}
        className="fx-row fx-edit"
        style={{ position: 'absolute', left: 0, right: 0, top, height, paddingLeft: depth * 14 + 8 }}
      >
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

  // ---- The virtualized tree ----
  // The visible tree is flattened into rows (explorerRows.ts) and only the rows overlapping the viewport,
  // plus OVERSCAN on each side, are drawn — absolutely placed inside a spacer as tall as all the rows
  // together, so the scrollbar still measures the whole tree. The rows are rebuilt only when the tree
  // or the edit target changes, never on scroll.
  const rows = useMemo(
    () => (root ? buildTreeRows(root, dirs, expanded, editing, { rootSlow }) : []),
    [root, dirs, expanded, editing, rootSlow]
  )
  // The edit row grows by a line while it shows why the name is invalid — the same test editRow uses
  const editTall = !!editing && editValue !== '' && !!tm(validateName(editValue.trim()))
  const offsets = useMemo(() => rowOffsets(rows, editTall), [rows, editTall])
  // Kubernetes kinds of the YAML rows the tree lists (non-YAML paths never reach the IPC)
  const rowPaths = useMemo(() => entryPaths(rows), [rows])
  const kubeKinds = useKubeKinds(root, rowPaths)
  const [viewport, setViewport] = useState({ top: 0, h: DEFAULT_VIEWPORT_H })
  const range = visibleRange(offsets, viewport.top, viewport.h, OVERSCAN)
  // What the scroll handler and the reveal compare against — the latest render's layout
  const layoutRef = useRef({ offsets, range, h: viewport.h })
  layoutRef.current = { offsets, range, h: viewport.h }

  /** Reads the tree's scroll position and height, and renders again only if that changes which rows
   *  are drawn — scrolling within one row's height costs nothing. */
  const syncViewport = (): void => {
    const el = treeRef.current
    if (!el) return
    const h = el.clientHeight || DEFAULT_VIEWPORT_H
    const top = el.scrollTop
    const cur = layoutRef.current
    const r = visibleRange(cur.offsets, top, h, OVERSCAN)
    if (r.start !== cur.range.start || r.end !== cur.range.end || h !== cur.h) setViewport({ top, h })
  }
  useLayoutEffect(() => {
    const el = treeRef.current
    if (!el) return
    syncViewport()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => syncViewport())
    ro.observe(el)
    return () => ro.disconnect()
  }, [root])

  /** Scrolls the least distance that brings row index wholly into view, and draws the new window at once
   *  (not a frame later, when the scroll event arrives) */
  const scrollToRow = (index: number): void => {
    const el = treeRef.current
    if (!el || index < 0) return
    const h = el.clientHeight || DEFAULT_VIEWPORT_H
    const next = revealScrollTop(layoutRef.current.offsets, index, el.scrollTop, h)
    if (next !== el.scrollTop) el.scrollTop = next
    syncViewport()
  }

  // A pending reveal is resolved after each render: once its row exists it is scrolled to. Past
  // REVEAL_WAIT_MS it is dropped without scrolling even if the row has just appeared — a paste into a
  // collapsed folder that is expanded much later must not jump the view (resolveReveal).
  useLayoutEffect(() => {
    if (!reveal) return
    const { index, done } = resolveReveal(rows, reveal, Date.now())
    if (index >= 0) scrollToRow(index)
    if (done) setReveal(null)
  })

  // The row being edited is brought into view when editing starts — F2 on a selected row the user has
  // scrolled away from, or New File in a folder far down. Before virtualization the input's autoFocus
  // did this on its own; now the row is also kept drawn (below) so the input exists to be focused.
  const editKey = editRowKey(editing)
  useEffect(() => {
    if (editKey) requestReveal(editKey)
  }, [editKey])

  /** The moving end of the last keyboard move — with Shift the anchor stays put and this end moves.
   *  A click or right-click forgets it (the anchor is then where the next move starts). */
  const keyCursorRef = useRef<string | null>(null)

  /** Arrow keys, Home/End and PageUp/PageDown move the selection over the entry rows; with Shift they
   *  extend the range from the anchor, like a Shift click. The target may be outside the drawn window:
   *  it is selected by path, then scrolled into view. */
  const moveSelection = (key: CursorKey, extend: boolean): void => {
    const paths = entryPaths(rows)
    const from = cursorOrigin(paths, sel.selection, sel.anchor, keyCursorRef.current)
    const pageSize = Math.max(1, Math.floor(layoutRef.current.h / ROW_H) - 1)
    const next = moveCursor(paths, from, key, pageSize)
    if (next === null) return
    keyCursorRef.current = next
    // The reducer's Shift click: the range from the anchor to next, anchor kept (with no anchor it
    // selects next alone and makes it the anchor)
    if (extend) sel.dispatch({ type: 'rowClicked', path: next, mods: { ctrl: false, shift: true }, flat: paths })
    else sel.dispatch({ type: 'selectionSet', paths: [next] })
    scrollToRow(rows.findIndex((r) => r.key === next))
  }

  // The rows' event handlers: one object for the component's whole life, calling the latest closures
  // through a ref — a new object per render would re-render every memoised row on every render
  const rowActionsRef = useRef<RowActions | null>(null)
  rowActionsRef.current = {
    click: (entry, ev) => {
      keyCursorRef.current = null
      // A folder expands on a single-selection click; a file only selects (it opens on the double click)
      if (sel.applyClickSelection(entry.path, ev) && entry.isDir) toggleDir(entry.path)
    },
    doubleClick: (entry, ev) => {
      if (entry.isDir) return
      // Ctrl/Shift only change the selection, they never open — the same rule the single click follows
      // (applyClickSelection's return value)
      if (ev.ctrlKey || ev.metaKey || ev.shiftKey) return
      onOpenFile(entry.path)
    },
    contextMenu: (entry, ev) => {
      ev.preventDefault()
      keyCursorRef.current = null
      sel.applyContextSelection(entry.path)
      setMenu({ x: ev.clientX, y: ev.clientY, entry })
    },
    dragStart: (entry, ev) => dragHandlers(entry).onDragStart?.(ev),
    dragEnd: (entry, ev) => dragHandlers(entry).onDragEnd?.(ev),
    dragOver: (entry, ev) => dropHandlers(entry).onDragOver?.(ev),
    dragLeave: (entry, ev) => dropHandlers(entry).onDragLeave?.(ev),
    drop: (entry, ev) => dropHandlers(entry).onDrop?.(ev)
  }
  const rowActions = useMemo<RowActions>(
    () => ({
      click: (e, ev) => rowActionsRef.current!.click(e, ev),
      doubleClick: (e, ev) => rowActionsRef.current!.doubleClick(e, ev),
      contextMenu: (e, ev) => rowActionsRef.current!.contextMenu(e, ev),
      dragStart: (e, ev) => rowActionsRef.current!.dragStart(e, ev),
      dragEnd: (e, ev) => rowActionsRef.current!.dragEnd(e, ev),
      dragOver: (e, ev) => rowActionsRef.current!.dragOver(e, ev),
      dragLeave: (e, ev) => rowActionsRef.current!.dragLeave(e, ev),
      drop: (e, ev) => rowActionsRef.current!.drop(e, ev)
    }),
    []
  )

  // Cut items are dimmed (VS Code behavior). Descendants of a cut folder go away with it, so they are dimmed too.
  const isCut = (p: string): boolean =>
    sel.clipboard?.mode === 'cut' && sel.clipboard.paths.some((c) => isSubPath(c, p))

  const renderRow = (row: TreeRow, top: number, height: number): React.JSX.Element => {
    const place = { position: 'absolute', left: 0, right: 0, top, height } as const
    switch (row.kind) {
      case 'entry': {
        const p = row.entry.path
        const isDir = row.entry.isDir
        return (
          <ExplorerRow
            key={row.key}
            entry={row.entry}
            depth={row.depth}
            top={top}
            open={row.open}
            selected={sel.selection.has(p)}
            cut={isCut(p)}
            dragging={dragging && dragPathsRef.current.includes(p)}
            dropInto={isDir && dropDir === p}
            gitState={isDir ? undefined : gitStatus.fileState[p]}
            gitCount={isDir ? (gitStatus.folderCount[p] ?? 0) : 0}
            kubeKind={isDir ? undefined : kubeKinds[p]}
            kubeFailed={isDir ? undefined : kubeFailed?.has(normKubePath(p))}
            busy={ops.busyRows.has(p)}
            loading={isDir && tree.loading.has(p) && !!dirs[p]}
            actions={rowActions}
          />
        )
      }
      case 'edit':
        return editRow(row.key, row.depth, row.isDir, top, height)
      case 'rootReading':
        return (
          <div key={row.key} style={place}>
            <RootReading slow={rootSlow} />
          </div>
        )
      case 'note':
        return (
          <div
            key={row.key}
            className="fx-note"
            style={{ ...place, display: 'flex', alignItems: 'center', paddingLeft: row.depth * 14 + 24 }}
          >
            {row.note === 'loading'
              ? t('explorer.dir.loading')
              : row.note === 'readFailed'
                ? t('explorer.dir.readFailed', { detail: row.detail ?? '' })
                : t('explorer.dir.empty')}
          </div>
        )
    }
  }

  // The drawn rows: the window, plus the rows that must stay mounted wherever the scroll is — the edit
  // row (unmounting its focused input would blur it, and a blur commits the edit) and the row a drag
  // started on (dragend is dispatched on that element; unmounted, the drag would never end). All under
  // one parent in index order, so a row moving in or out of the window is never re-parented or moved.
  const pinKeys = dragging ? [editKey, dragSourceRef.current] : [editKey]
  const drawn = drawnRows(
    range,
    pinKeys.flatMap((k) => (k === null ? [] : [rows.findIndex((r) => r.key === k)])).filter((i) => i >= 0)
  )

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
              <X size={14} />
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
      // Ctrl+V, and the paste the menu's Paste item asks main for. The file list the OS clipboard is
      // holding exists only on this event — nothing in main can read it back out — so the paste is
      // taken here rather than on the key, and pasteFromEvent decides between this list and the app's
      // own clipboard. An in-app cut/copy carries no files, so its event arrives with an empty list
      // and falls through to the internal paste, which is what used to happen on the key.
      onPaste={(ev) => {
        // The same guards as onKeyDown below, for the same reasons: nothing while a name is being
        // edited or while a menu or modal sits over the tree, and a paste aimed at a text field is
        // left alone.
        if (editing || menu || historyOpen) return
        const target = ev.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
        ev.preventDefault()
        const files = Array.from(ev.clipboardData.files)
        void pasteFromEvent(files.map((f) => window.api.files.pathForFile(f)))
      }}
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
          // Ctrl+V is deliberately absent: it is handled in onPaste below, on the event the browser
          // raises **because** the default was not suppressed here. That event is the only way the
          // renderer can see what the OS clipboard holds, so taking the key here and calling paste()
          // would make pasting a file copied in Explorer impossible.
          if (k === 'a' || k === 'x' || k === 'c' || k === 'z') {
            ev.preventDefault() // suppress the browser default (select all / copy) and the global listeners
            if (k === 'a') sel.dispatch({ type: 'selectAll', paths: tree.flatVisible() })
            else if (k === 'x') cutOrCopy('cut')
            else if (k === 'c') cutOrCopy('copy')
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
            <RefreshCw size={14} className={refreshing ? 'fx-refreshing' : undefined} />
          </button>
          <button
            className="icon-btn"
            aria-label={t('common.close')}
            title={t('common.close')}
            onClick={onClose}
          >
            <X size={14} />
          </button>
        </div>
      </header>
      {/* git did not answer the last status query: the badges below are the previous answer, dimmed */}
      {gitStatus.stale && (
        <div className="fx-note fx-git-stale" role="status">
          {t('explorer.git.unavailable')}
        </div>
      )}
      {/* A delete or paste past OP_STATUS_DELAY_MS: what it is doing and how many entries so far */}
      <FileOpStatusLine status={ops.opStatus} />
      <div
        className={`fx-tree${gitStatus.stale ? ' git-stale' : ''}`}
        ref={treeRef}
        tabIndex={0}
        onScroll={syncViewport}
        onContextMenu={(ev) => {
          if (ev.target === ev.currentTarget || ev.target === spaceRef.current) {
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
          const cursorKey = CURSOR_KEYS[ev.key]
          if (cursorKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
            ev.preventDefault() // the tree's own scrolling is replaced by moving the selection
            moveSelection(cursorKey, ev.shiftKey)
            return
          }
          if (ev.key === 'F2') {
            // Rename needs exactly one target — with several there is no way to decide which one to change
            if (sel.selection.size !== 1) return
            const entry = findEntry([...sel.selection][0])
            if (!entry) return
            ev.preventDefault()
            startRename(entry)
          } else if (ev.key === 'Delete' || (isMac() && ev.metaKey && ev.key === 'Backspace')) {
            // A Mac keyboard has no forward Delete without fn; Cmd+Backspace is the Finder's delete
            if (sel.selection.size === 0) return
            ev.preventDefault()
            void removeSelection()
          }
        }}
        {...dropHandlers(null)}
      >
        <div ref={spaceRef} style={{ position: 'relative', height: offsets[rows.length] }}>
          {drawn.map((i) => renderRow(rows[i], offsets[i], offsets[i + 1] - offsets[i]))}
        </div>
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
            opsSel.dispatch({ type: 'selectionSet', paths: [path] })
            setHistoryOpen(false)
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </section>
  )
}
