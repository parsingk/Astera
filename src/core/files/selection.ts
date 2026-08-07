// Multi-selection maths (pure module). Shift+click range selection is defined by the on-screen
// order, so this has to reproduce FileExplorer's renderDir traversal order exactly — if it drifts,
// the selected span stops matching the span the user sees. Like ops.ts and paths.ts, it uses string
// operations only, no node:path.

/** The cached listing of one folder in the tree — a structural shape holding just the part of
 *  FileExplorer's DirState this module uses. Why DirState is not imported directly: to keep a pure
 *  module from depending on renderer types. */
export interface VisibleDir {
  entries?: { path: string; isDir: boolean }[]
}

/** The flat order of the items visible on screen. Reproduces renderDir's traversal exactly — it walks
 *  the child listing in order and recurses into an expanded folder in place (so a folder's children
 *  come before that folder's siblings).
 *  A folder that is expanded but has no cache yet (still loading) is skipped — it has no children on
 *  screen either. */
export function flattenVisible(
  root: string,
  dirs: Record<string, VisibleDir>,
  expanded: Set<string>
): string[] {
  const out: string[] = []
  const walk = (dirPath: string): void => {
    const entries = dirs[dirPath]?.entries
    if (!entries) return
    for (const e of entries) {
      out.push(e.path)
      if (e.isDir && expanded.has(e.path)) walk(e.path)
    }
  }
  walk(root)
  return out
}

/** The span between a and b in the flat order, both ends included. Which one comes first does not
 *  matter. If only one of them is in the list, just that one; if neither is, an empty array — the
 *  case where the cache was refreshed and the anchor disappeared. */
export function rangeBetween(flat: string[], a: string, b: string): string[] {
  const i = flat.indexOf(a)
  const j = flat.indexOf(b)
  if (i < 0 && j < 0) return []
  if (i < 0) return [b]
  if (j < 0) return [a]
  return flat.slice(Math.min(i, j), Math.max(i, j) + 1)
}
