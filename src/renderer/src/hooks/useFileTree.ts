import { useEffect, useRef, useState } from 'react'
import { parentDir } from '../../../core/files/paths'
import { isSubPath } from '../../../core/files/ops'
import { flattenVisible } from '../../../core/files/selection'

export interface Entry {
  name: string
  path: string
  isDir: boolean
}

export interface DirState {
  entries?: Entry[]
  error?: string
}

/** What the explorer tree cache hook returns (from breaking FileExplorer's hooks apart — useFileTree
 *  extracted). It knows nothing about selection, clipboard, file operations or inline editing — it is
 *  responsible for "the tree cache and keeping it up to date" only. */
export interface FileTree {
  dirs: Record<string, DirState>
  expanded: Set<string>
  dirsRef: React.RefObject<Record<string, DirState>>
  loadDir: (dirPath: string) => void
  toggleDir: (dirPath: string) => void
  /** Expands a parent folder (used when paste or create needs the target folder open) */
  expandDir: (dirPath: string) => void
  /** Adopts a preserved tree snapshot as-is (a remount with the same root — the explorer toggle) */
  adoptTree: (s: { expanded: Set<string>; dirs: Record<string, DirState> }) => void
  /** Clears the tree and, if load is given, reloads that folder (no root / root changed / refresh) */
  resetTree: (opts?: { load?: string }) => void
  findEntry: (p: string | null) => Entry | null
  entriesOf: (paths: Iterable<string>) => Entry[]
  /** Flat order of the rows visible on screen (flattenVisible) — an empty array when there is no root */
  flatVisible: () => string[]
}

/** Explorer tree cache — lazy loading (files.list only when a folder is expanded) plus live updates
 *  (the file watcher). Extracted from FileExplorer.tsx with no behavior change. The root-switch vs
 *  remount branching still lives in FileExplorer's `[root]` effect (it is part of the data-loss
 *  guards), which calls this hook's `adoptTree`/`resetTree` to adopt or reset just the tree. */
export function useFileTree(
  root: string | null,
  /** Initial value so a remount with the same root (the explorer toggle) uses the preserved tree from
   *  the very first render. Filling it in from an effect instead shows 'loading…' for one frame — the
   *  ExplorerTreeState snapshot exists precisely to remove that flicker. The root-match check is the
   *  component's job. */
  initialTree: { expanded: Set<string>; dirs: Record<string, DirState> } | null
): FileTree {
  const [expanded, setExpanded] = useState<Set<string>>(() => initialTree?.expanded ?? new Set())
  const [dirs, setDirs] = useState<Record<string, DirState>>(() => initialTree?.dirs ?? {})

  const loadDir = (dirPath: string): void => {
    void window.api.files.list(dirPath).then(
      (entries) => setDirs((prev) => ({ ...prev, [dirPath]: { entries } })),
      (err) => {
        const msg = err instanceof Error ? err.message : String(err)
        // For a folder that is gone, do not cache the error — drop the entry itself. A cached ENOENT
        // left behind means 'Read failed: ENOENT' keeps showing after the folder is recreated under
        // the same name. It has to come out of expanded too, so the recreated folder appears cleanly
        // in a collapsed state.
        // Why the check is done on the string: Electron's IPC serialization does not preserve the
        // error's `code` property, so the renderer only gets message. Other failures (a permission
        // error, etc.) are cached as-is and shown to the user.
        // The dirPath !== root condition: when a child folder is evicted it also drops out of the
        // parent's entries list, so it disappears from the tree entirely and there is no problem, but
        // the root has no parent and renderDir(root, 0) always renders it regardless of the
        // expanded/dirs state — evicting the root takes the !state branch and gets permanently stuck
        // on 'loading…', with no way out because a path that is already gone gets no further watcher
        // events and no re-query either. When the root itself is gone, cache the error as it does now
        // so 'Read failed: ENOENT' shows the reason.
        if (msg.includes('ENOENT') && dirPath !== root) {
          setDirs((prev) => {
            if (!(dirPath in prev)) return prev
            const { [dirPath]: _drop, ...rest } = prev
            return rest
          })
          setExpanded((prev) => {
            if (!prev.has(dirPath)) return prev
            const next = new Set(prev)
            next.delete(dirPath)
            return next
          })
          return
        }
        setDirs((prev) => ({ ...prev, [dirPath]: { error: msg } }))
      }
    )
  }

  const dirsRef = useRef(dirs)
  dirsRef.current = dirs

  // Live updates: start watching the root, and on a change re-query only the cached parent folder.
  // On re-entry the preserved cache can be stale, so the root is re-queried once.
  useEffect(() => {
    if (!root) return
    void window.api.files.watch(root)
    loadDir(root) // re-query the root level on re-entry to pick up recent changes (deeper expanded folders catch up via later events or a refresh)
    const off = window.api.on('files:changed', (c) => {
      if (c.kind === 'change') return // a file content change does not alter the tree structure
      if (c.kind === 'unlinkDir') {
        // Clean up the cache and expanded state for the deleted folder itself and everything under
        // it. Without this, (1) a stale ENOENT cache can survive into a recreate under the same name
        // (a separate path from the ENOENT cleanup in loadDir(a) — the deleted folder itself only
        // disappears from its parent's child list, so loadDir is never called for it again), and
        // (2) repeated multi-deletes keep piling stale keys into dirs/expanded
        setDirs((prev) => {
          const next = { ...prev }
          let changed = false
          for (const key of Object.keys(next)) {
            if (isSubPath(c.path, key)) {
              delete next[key]
              changed = true
            }
          }
          return changed ? next : prev
        })
        setExpanded((prev) => {
          const next = new Set(prev)
          let changed = false
          for (const key of prev) {
            if (isSubPath(c.path, key)) {
              next.delete(key)
              changed = true
            }
          }
          return changed ? next : prev
        })
      }
      const parent = parentDir(c.path)
      if (dirsRef.current[parent]) loadDir(parent) // only refresh cached (expanded) folders — a side effect kept outside the updater
    })
    return () => {
      off()
      void window.api.files.unwatch()
    }
  }, [root])

  const toggleDir = (dirPath: string): void => {
    // Guards against StrictMode double invocation — no IPC (side effect) inside the updater (the same rule as App.tsx's closeFileTab)
    if (!expanded.has(dirPath) && !dirs[dirPath]) loadDir(dirPath)
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dirPath)) next.delete(dirPath)
      else next.add(dirPath)
      return next
    })
  }

  const expandDir = (dirPath: string): void => setExpanded((prev) => new Set(prev).add(dirPath))

  const adoptTree = (s: { expanded: Set<string>; dirs: Record<string, DirState> }): void => {
    setExpanded(s.expanded)
    setDirs(s.dirs)
  }

  const resetTree = (opts?: { load?: string }): void => {
    setExpanded(new Set())
    setDirs({})
    if (opts?.load) loadDir(opts.load)
  }

  /** Collects the Entries for paths out of the cache (the number of cached folders is small, so a linear scan is enough). */
  const entriesOf = (paths: Iterable<string>): Entry[] => {
    const want = new Set(paths)
    const out: Entry[] = []
    for (const state of Object.values(dirs)) {
      for (const en of state.entries ?? []) if (want.has(en.path)) out.push(en)
    }
    return out
  }

  /** A path outside the current root is treated as not existing — the invariant is that anything not
   *  on screen cannot be the target of an operation. During a root switch, an old project's directory
   *  listing can land in the dirs cache the current root is rendering from (the onRestored case), so
   *  being in the cache is not on its own a guarantee of being "a row visible right now". This is the
   *  same check operableSelection (explorerState.ts) makes for the selection, for the same reason —
   *  here it covers findEntry's consumers that that function does not handle (pasteDir, F2 rename).
   *  isSubPath(root, root) is true, but the root itself is not in any entries array anyway, so the
   *  loop below naturally returns null. */
  const findEntry = (p: string | null): Entry | null => {
    if (!p || !root || !isSubPath(root, p)) return null
    for (const state of Object.values(dirs)) {
      const hit = state.entries?.find((en) => en.path === p)
      if (hit) return hit
    }
    return null
  }

  const flatVisible = (): string[] => (root ? flattenVisible(root, dirs, expanded) : [])

  return {
    dirs,
    expanded,
    dirsRef,
    loadDir,
    toggleDir,
    expandDir,
    adoptTree,
    resetTree,
    findEntry,
    entriesOf,
    flatVisible
  }
}
