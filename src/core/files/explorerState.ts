// Explorer selection and clipboard state machine (pure module). This repo has no convention for
// renderer tests (vitest environment: 'node', jsdom not adopted), so state kept inside a hook has
// no way of being verified. That is why this state machine — the one carrying the data-loss guards
// — is pulled out as pure functions and pinned down by unit tests.
// Like ops.ts and selection.ts, it uses string operations only, no node:path.
import { isSubPath, topLevelOnly } from './ops'
import { rangeBetween } from './selection'

export interface ExplorerState {
  /** The selected paths. Implicit state, so it is cleared when the root changes — left behind it
   *  goes stale with nothing on screen to show it. */
  selection: Set<string>
  /** The last clicked item. Both the anchor for Shift ranges and the basis for working out the paste target folder. */
  anchor: string | null
  /** The app-internal clipboard. The user put it there explicitly with Ctrl+X/C, so it survives a
   *  root change — pasting across projects is the whole point of the feature. */
  clipboard: { mode: 'cut' | 'copy'; paths: string[] } | null
}

export interface ClickMods {
  ctrl: boolean
  shift: boolean
}

export type ExplorerAction =
  /** root became null (no active session) */
  | { type: 'rootCleared' }
  /** the root switched to a different project/session */
  | { type: 'rootChanged' }
  /** remounted with the same root (explorer toggle) — changes nothing */
  | { type: 'rootRestored' }
  /** refresh (⟳) — the tree cache is emptied, so selection and clipboard become meaningless too */
  | { type: 'refreshed' }
  /** a tree row was clicked. flat is the on-screen order (for computing Shift ranges) */
  | { type: 'rowClicked'; path: string; mods: ClickMods; flat: string[] }
  | { type: 'rowContextMenu'; path: string }
  | { type: 'selectAll'; paths: string[] }
  /** make the result of an operation (create/rename/duplicate/paste) the selection */
  | { type: 'selectionSet'; paths: string[] }
  | { type: 'cutOrCopied'; mode: 'cut' | 'copy'; paths: string[] }
  | { type: 'clipboardCleared' }
  /** the items that were deleted successfully. Clears the selection, and the clipboard too if what was deleted was in it */
  | { type: 'pathsRemoved'; removed: string[] }

export const initialExplorerState = (
  clipboard: ExplorerState['clipboard'] = null
): ExplorerState => ({ selection: new Set(), anchor: null, clipboard })

export function reduce(state: ExplorerState, action: ExplorerAction): ExplorerState {
  switch (action.type) {
    case 'rootRestored':
      return state // we are back in the same project, so keep everything (down to the same references)
    case 'rootCleared':
    case 'rootChanged':
      // Clear only the selection and anchor; keep the clipboard
      return { selection: new Set(), anchor: null, clipboard: state.clipboard }
    case 'refreshed':
      return initialExplorerState()
    case 'rowClicked': {
      const { path, mods, flat } = action
      if (mods.ctrl) {
        const selection = new Set(state.selection)
        if (selection.has(path)) selection.delete(path)
        else selection.add(path)
        return { ...state, selection, anchor: path }
      }
      if (mods.shift && state.anchor) {
        // Keep the anchor — repeated Shift clicks from the same anchor have to be able to grow and shrink the range
        return { ...state, selection: new Set(rangeBetween(flat, state.anchor, path)) }
      }
      return { ...state, selection: new Set([path]), anchor: path }
    }
    case 'rowContextMenu':
      // If the item is already in the selection, keep the selection so the menu targets all of them (VS Code behaviour)
      return {
        ...state,
        selection: state.selection.has(action.path) ? state.selection : new Set([action.path]),
        anchor: action.path
      }
    case 'selectAll':
      return { ...state, selection: new Set(action.paths) }
    case 'selectionSet':
      return {
        ...state,
        selection: new Set(action.paths),
        anchor: action.paths.length > 0 ? action.paths[action.paths.length - 1] : state.anchor
      }
    case 'cutOrCopied':
      return { ...state, clipboard: { mode: action.mode, paths: action.paths } }
    case 'clipboardCleared':
      return { ...state, clipboard: null }
    case 'pathsRemoved': {
      const invalidated =
        state.clipboard !== null &&
        state.clipboard.paths.some((p) => action.removed.some((r) => isSubPath(r, p)))
      return {
        selection: new Set(),
        anchor: null,
        clipboard: invalidated ? null : state.clipboard
      }
    }
  }
}

/** The paths an operation may act on. It does two things:
 *  1. Filters out paths outside the current root — if the root changed while a selection lingered,
 *     it would be possible to delete files of another project that are not even on screen. The root
 *     itself is excluded too.
 *  2. If a folder and its descendants are selected together, keeps only the top level — once the
 *     parent has moved, operating on a child path fails.
 *  This is the safety net that keeps cut/copy/delete/duplicate to "only what is visible under the
 *  current root".
 *  Paste deliberately skips this function and uses clipboard.paths as-is so it can target anywhere —
 *  the clipboard is explicit state, and moving/copying across projects is its purpose. Do not put
 *  this filter on paste. */
export function operableSelection(state: ExplorerState, root: string | null): string[] {
  if (!root) return []
  return topLevelOnly([...state.selection].filter((p) => isSubPath(root, p) && !isSubPath(p, root)))
}
