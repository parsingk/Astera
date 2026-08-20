import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  groupRowsOf, menuAlignment, menuPlacement, nextCursor,
  type MenuAlignment, type MenuPlacement, type SelectItem
} from '../../../core/ui/select'
import { useI18n } from '../i18n/I18nProvider'

/** An item plus the icon the component draws for it. The icon is a ReactNode, so it cannot live in
 *  core/ui/select.ts (that module is framework-free to stay testable). */
export interface SelectOption extends SelectItem {
  icon?: React.ReactNode
  /** Renders this row's label and meta in the given CSS font-family. The font picker uses it to draw
   *  each family in itself, which is what lets the user see at a glance whether a font has Hangul —
   *  a font without it shows the sample as tofu. */
  font?: string
}

const Chevron = (): React.JSX.Element => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6.5 8 10.5l4-4" />
  </svg>
)

const Check = (): React.JSX.Element => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.5 8.5 6.5 11.5l6-7" />
  </svg>
)

/** Distance between trigger and menu. Must stay equal to the 4px in .sel-menu's `top`/`bottom`. */
const MENU_GAP = 4
/** .sel-menu's own max-height. Needed here because the side decision depends on how tall the menu can
 *  get, and the CSS cap is the answer for any list longer than the cap. */
const MENU_MAX_H = 240
/** .sel-menu's own max-width, `min(420px, 70vw)`. Same reason as MENU_MAX_H, and it has to be read at
 *  measure time because the viewport half of it moves. */
const menuMaxW = (): number => Math.min(420, window.innerWidth * 0.7)

/** The box the menu has to stay inside: every scrolling or clipping ancestor intersected with the
 *  window. Both kinds have to count — the settings modal clips with `overflow: hidden` while the panel
 *  inside it scrolls with `overflow-y: auto`, and the tighter of the two is what the user sees. */
function clipBoxOf(el: HTMLElement): { top: number; bottom: number; left: number; right: number } {
  let top = 0
  let bottom = window.innerHeight
  let left = 0
  let right = window.innerWidth
  for (let p = el.parentElement; p; p = p.parentElement) {
    const style = getComputedStyle(p)
    // Either axis being non-visible clips both: a box with `overflow-y: auto` and no overflow-x of its
    // own still computes overflow-x to auto, so it cuts sideways as well.
    if (style.overflowY === 'visible' && style.overflowX === 'visible') continue
    const box = p.getBoundingClientRect()
    top = Math.max(top, box.top)
    bottom = Math.min(bottom, box.bottom)
    left = Math.max(left, box.left)
    right = Math.min(right, box.right)
  }
  return { top, bottom, left, right }
}

/**
 * The app's one dropdown. Everything that picks from a list uses this, so there is a single look and a
 * single set of keyboard rules.
 *
 * Why not a native `<select>`: an `<option>` renders text only, so a per-row icon — the provider badge on
 * an account, the branch glyph on a branch — is impossible in one. That constraint is why AccountSelect was
 * already custom before this component existed; this generalises it rather than adding a second style.
 *
 * The cost of leaving native behind is that keyboard handling, outside-click dismissal and the ARIA roles
 * are ours to get right, which is what most of this file is.
 */
export function Select({
  items,
  value,
  onChange,
  placeholder,
  className,
  noCheck = false,
  ariaLabel
}: {
  items: SelectOption[]
  value: string
  onChange: (value: string) => void
  /** Shown when nothing matches `value`. Defaults to the shared "not selected" string. */
  placeholder?: string
  className?: string
  /** Drops the trailing check mark. For a list whose icons already differ per row — accounts, where the
   *  Claude/Codex badge is the row's identity — a check would make two marks compete for the eye. Selection
   *  still shows in the label colour. */
  noCheck?: boolean
  ariaLabel?: string
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLUListElement>(null)
  const [box, setBox] = useState<MenuPlacement & MenuAlignment>({
    side: 'below',
    maxHeight: null,
    align: 'left',
    maxWidth: null
  })

  const selected = items.find((it) => it.value === value) ?? null
  const rows = groupRowsOf(items)
  // Reserve the icon column for every row once any row has an icon, so labels line up in a mixed list
  // (the account filter's "All accounts" row has no badge). This is what provider-badge-spacer used to do.
  const anyIcon = items.some((it) => it.icon !== undefined)

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  /** Which side and which edge to open from, measured after the menu is in the DOM but before the
   *  browser paints it —
   *  useLayoutEffect, not useEffect, or the first frame shows the menu below and it jumps.
   *
   *  Measured from scrollHeight rather than the rendered height: the rendered one is already capped
   *  (by the CSS, or by the max-height this very effect sets), so feeding it back in would let a menu
   *  that flipped once stay stuck at that height. The ResizeObserver is what catches the font pickers,
   *  whose lists arrive asynchronously — the menu opens one row tall ("checking installed fonts…") and
   *  grows to full height a second later, long after this effect first ran. */
  useLayoutEffect(() => {
    if (!open) return
    const measure = (): void => {
      const trigger = triggerRef.current
      const menu = menuRef.current
      if (!trigger || !menu) return
      const rect = trigger.getBoundingClientRect()
      const clip = clipBoxOf(trigger)
      // offsetWidth - clientWidth is the gutter scrollWidth leaves out: the 1px border on each side
      // (box-sizing is border-box app-wide) plus the vertical scrollbar, which a list past the height
      // cap always has. Measured on the reported case: 297 + 12 = the 309 the menu actually renders at,
      // where scrollWidth alone would have understated it by the scrollbar and let a menu 10px too wide
      // pass as fitting.
      const gutter = menu.offsetWidth - menu.clientWidth
      const next = {
        ...menuPlacement(rect, clip, Math.min(menu.scrollHeight, MENU_MAX_H), MENU_GAP),
        ...menuAlignment(rect, clip, Math.min(menu.scrollWidth + gutter, menuMaxW()))
      }
      setBox((prev) =>
        prev.side === next.side && prev.maxHeight === next.maxHeight &&
        prev.align === next.align && prev.maxWidth === next.maxWidth
          ? prev
          : next
      )
    }
    measure()
    const menu = menuRef.current
    if (!menu) return
    const ro = new ResizeObserver(measure)
    ro.observe(menu)
    return () => ro.disconnect()
  }, [open, items.length])

  const openList = (): void => {
    setCursor(Math.max(0, items.findIndex((it) => it.value === value)))
    setOpen(true)
  }

  const commit = (item: SelectOption): void => {
    onChange(item.value)
    setOpen(false)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault()
        openList()
      }
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => nextCursor(c, items.length, e.key === 'ArrowDown' ? 1 : -1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const item = items[cursor]
      if (item) commit(item)
    }
  }

  const iconCell = (item: SelectOption): React.JSX.Element | null =>
    anyIcon ? <span className="sel-icon">{item.icon}</span> : null

  return (
    <div className={className ? `sel ${className}` : 'sel'} data-open={open} ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="sel-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        {selected ? (
          <>
            {iconCell(selected)}
            <span className="sel-value" style={selected.font ? { fontFamily: selected.font } : undefined}>
              {selected.label}
            </span>
          </>
        ) : (
          <span className="sel-value empty">{placeholder ?? t('account.select.none')}</span>
        )}
        <span className="sel-caret" aria-hidden="true">
          <Chevron />
        </span>
      </button>
      {open && (
        <ul
          ref={menuRef}
          className={
            'sel-menu' + (box.side === 'above' ? ' above' : '') + (box.align === 'right' ? ' right' : '')
          }
          style={{
            ...(box.maxHeight === null ? null : { maxHeight: box.maxHeight }),
            ...(box.maxWidth === null ? null : { maxWidth: box.maxWidth })
          }}
          role="listbox"
        >
          {rows.map((row) =>
            row.kind === 'group' ? (
              // role=presentation: a heading is not selectable, and without this a screen reader would
              // count it as an option and misreport the list length
              <li key={`g-${row.label}`} className="sel-group" role="presentation">
                {row.label}
              </li>
            ) : (
              <li
                key={`o-${row.index}-${row.item.value}`}
                role="option"
                aria-selected={row.item.value === value}
                className={`sel-option${row.index === cursor ? ' cursor' : ''}`}
                onMouseEnter={() => setCursor(row.index)}
                onClick={() => commit(row.item)}
              >
                {iconCell(row.item)}
                <span className="sel-value" style={items[row.index].font ? { fontFamily: items[row.index].font } : undefined}>
                  {row.item.label}
                </span>
                {row.item.meta && (
                  <span className="sel-meta" style={items[row.index].font ? { fontFamily: items[row.index].font } : undefined}>
                    {row.item.meta}
                  </span>
                )}
                {!noCheck && (
                  <span className="sel-check" aria-hidden="true">
                    <Check />
                  </span>
                )}
              </li>
            )
          )}
        </ul>
      )}
    </div>
  )
}
