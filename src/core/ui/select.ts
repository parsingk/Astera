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

/** Which side of the trigger the menu opens on, and the height it has to fit into.
 *
 *  `maxHeight` is null when the menu fits as it is — the component then leaves the CSS cap alone and
 *  only caps the menu when neither side can hold it. */
export interface MenuPlacement {
  side: 'below' | 'above'
  maxHeight: number | null
}

/**
 * Picks the side the dropdown opens on.
 *
 * `trigger` and `clip` are in one coordinate space (the component passes getBoundingClientRect values):
 * `clip` is the visible box the menu must stay inside — the nearest scrolling ancestor's client box
 * intersected with the window, whichever is tighter.
 *
 * Below is the default and only loses when it cannot hold the menu: a menu that jumps above the trigger
 * when it did not have to would move under the pointer that just clicked. That is what this fixes,
 * though — `.sel-menu` used to be pinned below unconditionally, so a select at the bottom of a
 * scrolling panel (the terminal font pickers, last rows of the settings General tab) opened a 240px
 * menu into 20px of space and showed 22px of it, with 374px sitting free above.
 *
 * When neither side fits, the wider one wins and the caller caps the menu to it rather than letting it
 * run past the edge. The floor at 0 matters: a negative max-height is an invalid CSS value, so a
 * trigger scrolled out of view would otherwise drop the declaration and clip as before.
 */
export function menuPlacement(
  trigger: { top: number; bottom: number },
  clip: { top: number; bottom: number },
  menuHeight: number,
  gap: number
): MenuPlacement {
  const below = clip.bottom - trigger.bottom - gap
  const above = trigger.top - clip.top - gap
  if (menuHeight <= below) return { side: 'below', maxHeight: null }
  if (menuHeight <= above) return { side: 'above', maxHeight: null }
  const side = above > below ? 'above' : 'below'
  return { side, maxHeight: Math.max(0, side === 'above' ? above : below) }
}
