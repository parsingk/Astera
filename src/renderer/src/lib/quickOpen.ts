/**
 * What the palette box is asked for, and how a file row reads (spec W2: one entry point, result kinds told apart).
 *
 * The box is one entry point for two lists. A leading `>` asks for an action, the convention people bring from other
 * editors, and is what Ctrl+Shift+P opens with; anything else is a file name under the explorer's project, which is what
 * Ctrl+P opens with. Deleting the `>` turns one into the other without closing the box. A file name's backslashes read
 * as the slashes the list is written with, so a path copied from a Windows terminal finds its file.
 */
export function paletteMode(query: string): { mode: 'actions' | 'files'; text: string } {
  return query.startsWith('>')
    ? { mode: 'actions', text: query.slice(1).trimStart() }
    : { mode: 'files', text: query.trim().replace(/\\/g, '/') }
}

/**
 * Whether Enter has to wait for the file rows: they answer an older query or another project (`current` false), or the
 * first walk of the project has found nothing yet. Rows on screen that answer what is typed, even while a walk goes on,
 * are what the person is choosing from.
 */
export function filesWaiting(s: { mode: 'actions' | 'files'; current: boolean; indexing: boolean; rows: number }): boolean {
  return s.mode === 'files' && (!s.current || (s.indexing && s.rows === 0))
}

/** What Enter does: wait for the rows of what is typed, pick the selected row, or nothing on an empty list. */
export function enterAction(waiting: boolean, selected: number): { do: 'wait' } | { do: 'choose'; index: number } | { do: 'keep' } {
  if (waiting) return { do: 'wait' }
  return selected < 0 ? { do: 'keep' } : { do: 'choose', index: selected }
}

/** What an Enter that waited does as the rows change: keep waiting, open the first row (as Enter on a current list
 *  takes it), or end when the answer has no row. */
export function settleEnter(waiting: boolean, rows: number): 'hold' | 'first' | 'none' {
  if (waiting) return 'hold'
  return rows > 0 ? 'first' : 'none'
}

/**
 * A file row's two parts: the name, which is what the person typed part of, and its folder relative to the project,
 * which tells apart the five `index.ts` files. Main names a file by joining the project folder as given (main/quickOpen.ts),
 * so the folder is the path's start; slashes and, for a drive path, case are compared loosely so a project folder spelled
 * differently still reads as the root. A file not under the root shows its whole folder.
 */
export function displayPath(root: string, abs: string): { name: string; folder: string } {
  const cut = Math.max(abs.lastIndexOf('/'), abs.lastIndexOf('\\'))
  const name = abs.slice(cut + 1)
  const folderAbs = cut === -1 ? '' : abs.slice(0, cut)
  const dir = folderAbs.replace(/\\/g, '/')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  // A drive path is Windows, where case does not tell two folders apart
  const same = /^[a-zA-Z]:/.test(base) ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase() : (a: string, b: string) => a === b
  if (same(dir, base)) return { name, folder: '' }
  const prefix = `${base}/`
  if (dir.length > prefix.length && same(dir.slice(0, prefix.length), prefix)) return { name, folder: dir.slice(prefix.length) }
  return { name, folder: folderAbs }
}
