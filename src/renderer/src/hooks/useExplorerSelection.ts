import { useReducer } from 'react'
import {
  initialExplorerState,
  operableSelection,
  reduce,
  type ExplorerAction,
  type ExplorerState
} from '../../../core/files/explorerState'

export interface ExplorerSelection {
  selection: Set<string>
  anchor: string | null
  clipboard: { mode: 'cut' | 'copy'; paths: string[] } | null
  dispatch: (action: ExplorerAction) => void
  /** operableSelection(state, root) — the operation targets (root filter + topLevelOnly) */
  selectionPaths: () => string[]
  /** Handles a row click. The return value is "was this a single-selection click" — opening a file or expanding a folder happens on a single click only */
  applyClickSelection: (path: string, ev: React.MouseEvent) => boolean
  /** Selection handling for a right-click. For an item already in the selection the selection is kept, so
   *  the menu targets multiple items; for an item outside it, only that one is selected (VS Code behavior). */
  applyContextSelection: (path: string) => void
}

/** Selection, anchor and clipboard. The state machine itself lives in the pure reducer in
 *  core/files/explorerState.ts (that is what makes it possible to pin the data-loss guards down with unit
 *  tests) and this hook is the shell that attaches it to React.
 *  Why the initial clipboard is taken as an argument: the clipboard has to survive the unmount caused by
 *  the explorer toggle, otherwise cross-project paste does not work — it is restored without comparing
 *  root. */
export function useExplorerSelection(
  root: string | null,
  initialClipboard: ExplorerState['clipboard'],
  flatVisible: () => string[]
): ExplorerSelection {
  const [state, dispatch] = useReducer(reduce, initialClipboard, initialExplorerState)

  /** Selection handling for a row click. Ctrl = toggle, Shift = range from the anchor, plain = single (the
   *  per-branch handling is done by the reducer's rowClicked case). The return value is "was this a
   *  single-selection click" — opening a file and expanding a folder happen on a single click only (VS
   *  Code behavior: a Ctrl/Shift click only changes the selection, it does not open). */
  const applyClickSelection = (path: string, ev: React.MouseEvent): boolean => {
    const mods = { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey }
    // flat is computed only for Shift — flattenVisible walks the whole tree, so there is no need to run it
    // on every click. The reducer does not use flat unless Shift is held.
    dispatch({ type: 'rowClicked', path, mods, flat: mods.shift ? flatVisible() : [] })
    // Only a plain click (no modifiers) opens a file and expands a folder (VS Code behavior)
    return !mods.ctrl && !(mods.shift && state.anchor !== null)
  }

  return {
    selection: state.selection,
    anchor: state.anchor,
    clipboard: state.clipboard,
    dispatch,
    selectionPaths: () => operableSelection(state, root),
    applyClickSelection,
    applyContextSelection: (path) => dispatch({ type: 'rowContextMenu', path })
  }
}
