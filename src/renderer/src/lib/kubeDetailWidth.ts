export const DETAIL_KEY = 'cm.kubeDetailWidth'
export const DETAIL_DEFAULT = 380
export const DETAIL_MIN = 280
/** The table's own minimum, so a wide detail column never squeezes it shut. */
export const TABLE_MIN = 240
/** One arrow key press on the resize handle. */
export const DETAIL_STEP = 16

/** The detail column's width for a wish: at least DETAIL_MIN and at most what leaves TABLE_MIN beside the kind tree.
 *  A body too narrow for both keeps the minimum, since an unreadable detail is worse than a scrolling table. */
export function clampDetailWidth(want: number, bodyWidth: number, treeWidth: number): number {
  const w = Number.isFinite(want) ? Math.round(want) : DETAIL_DEFAULT
  const max = bodyWidth - treeWidth - TABLE_MIN
  return Math.max(DETAIL_MIN, Math.min(w, max))
}

/** The width saved in localStorage, or the default for nothing or junk. */
export function readDetailWidth(raw: string | null): number {
  const v = Number(raw)
  return raw !== null && Number.isFinite(v) && v >= DETAIL_MIN ? v : DETAIL_DEFAULT
}
