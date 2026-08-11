/** One choice in a Select. `icon` is deliberately absent — it is a ReactNode and this module stays
 *  node-free and framework-free so it can be unit tested and imported by the renderer (tsconfig.web.json
 *  whitelists core files one by one). The component adds the icon on top of this shape. */
export interface SelectItem {
  value: string
  label: string
  /** Heading this item sits under. A run of items sharing one group gets a single heading above it. */
  group?: string
  /** Secondary text at the right edge — the branch picker's commit date. */
  meta?: string
}

/** A rendered row: either a group heading or an option carrying its index into the items array. */
export type SelectRow =
  | { kind: 'group'; label: string }
  | { kind: 'option'; item: SelectItem; index: number }

/**
 * Moves the keyboard cursor by delta, wrapping at both ends.
 *
 * Written out rather than inlined as `(c + delta) % len` because that yields -1 at the top edge, which
 * points at no item at all. The extra `+ len` before the modulo is the whole reason this exists.
 * An out-of-range cursor (the list shrank while it was open) still lands somewhere valid.
 */
export function nextCursor(current: number, length: number, delta: number): number {
  if (length <= 0) return 0
  const from = ((current % length) + length) % length
  return (from + delta + length) % length
}

/**
 * Expands items into rows, inserting a heading wherever the group changes.
 *
 * The item order is taken as given — callers sort before handing the list over (listBranches sorts by
 * commit date), so regrouping here would silently undo that. A group that appears, stops, and appears
 * again therefore gets two headings, which is the honest rendering of the order it was given.
 *
 * Each option row carries its index into the original array, because that index is what the cursor and
 * the selected-value comparison use — deriving it from the row position would count the headings too.
 */
export function groupRowsOf(items: SelectItem[]): SelectRow[] {
  const rows: SelectRow[] = []
  let prev: string | undefined
  items.forEach((item, index) => {
    if (item.group !== undefined && item.group !== prev) rows.push({ kind: 'group', label: item.group })
    prev = item.group
    rows.push({ kind: 'option', item, index })
  })
  return rows
}
