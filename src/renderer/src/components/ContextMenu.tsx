import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type ActionItem = {
  label: string
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  icon?: React.ReactNode
  /** Tooltip, mostly to say why a disabled item is disabled */
  title?: string
}
export type SubmenuItem = { label: string; icon?: React.ReactNode; submenu: MenuItem[] }
export type MenuItem = ActionItem | SubmenuItem | { heading: string } | 'separator'

export const isSub = (it: MenuItem): it is SubmenuItem => it !== 'separator' && 'submenu' in it
const isAction = (it: MenuItem): it is ActionItem => it !== 'separator' && 'onSelect' in it
/** Items the cursor can rest on: not separators, not headings, not disabled actions */
export const focusable = (it: MenuItem): boolean => isSub(it) || (isAction(it) && !it.disabled)
const focusableIdx = (items: MenuItem[]): number[] => items.flatMap((it, i) => (focusable(it) ? [i] : []))

/** Cursor step over the focusable indices. No cursor (-1): ↓ goes to the first, ↑ to the last. */
export function step(items: MenuItem[], cur: number, delta: 1 | -1): number {
  const idxs = focusableIdx(items)
  if (idxs.length === 0) return cur
  const at = idxs.indexOf(cur)
  if (at < 0) return delta === 1 ? idxs[0] : idxs[idxs.length - 1]
  return idxs[(at + delta + idxs.length) % idxs.length]
}

/** Where the cursor is: in the parent menu (`cursor`), possibly with a group's submenu open (`openSub`),
 *  and whether the keyboard is inside that submenu (`inSub`, with `subCursor`). */
export type MenuState = { cursor: number; openSub: number | null; subCursor: number; inSub: boolean }
export const INITIAL_MENU_STATE: MenuState = { cursor: -1, openSub: null, subCursor: -1, inSub: false }

const subItems = (items: MenuItem[], i: number | null): MenuItem[] => {
  const it = i === null ? undefined : items[i]
  return it && isSub(it) ? it.submenu : []
}
const openGroup = (items: MenuItem[], i: number): MenuState => ({
  cursor: i,
  openSub: i,
  // An all-disabled submenu leaves this at -1, so Enter inside it does nothing
  subCursor: step(subItems(items, i), -1, 1),
  inSub: true
})
const closeSub = (s: MenuState): MenuState => ({ ...s, openSub: null, subCursor: -1, inSub: false })

/** The pointer enters row `i` of the parent menu. Any row that is not a group item closes an open
 *  submenu, disabled rows, headings and separators included. */
export function menuHover(s: MenuState, items: MenuItem[], i: number): MenuState {
  const it = items[i]
  if (it && isSub(it)) return { cursor: i, openSub: i, subCursor: -1, inSub: false }
  return { ...closeSub(s), cursor: it && focusable(it) ? i : s.cursor }
}

/** One key press: the next state, whether the menu closes, and the action to run (if any). */
export function menuKey(
  s: MenuState,
  key: string,
  items: MenuItem[]
): { state: MenuState; close: boolean; select: ActionItem | null } {
  const stay = { state: s, close: false, select: null }
  const list = s.inSub ? subItems(items, s.openSub) : items
  switch (key) {
    case 'Escape':
      // First Escape: back to the parent menu with the group item still under the cursor
      return s.openSub !== null ? { ...stay, state: closeSub(s) } : { ...stay, close: true }
    case 'ArrowDown':
    case 'ArrowUp': {
      const delta = key === 'ArrowDown' ? 1 : -1
      if (s.inSub) return { ...stay, state: { ...s, subCursor: step(list, s.subCursor, delta) } }
      // Moving the cursor off a group item closes its submenu
      return { ...stay, state: { ...closeSub(s), cursor: step(list, s.cursor, delta) } }
    }
    case 'ArrowRight': {
      const cur = items[s.cursor]
      return !s.inSub && cur && isSub(cur) ? { ...stay, state: openGroup(items, s.cursor) } : stay
    }
    case 'ArrowLeft':
      return s.openSub !== null ? { ...stay, state: closeSub(s) } : stay
    case 'Enter': {
      const cur = list[s.inSub ? s.subCursor : s.cursor]
      if (!cur || cur === 'separator') return stay
      if (isSub(cur)) return { ...stay, state: openGroup(items, s.cursor) }
      if (isAction(cur) && !cur.disabled) return { ...stay, close: true, select: cur }
      return stay
    }
    default:
      return stay
  }
}

function Icon({ icon }: { icon?: React.ReactNode }): React.JSX.Element | null {
  return icon ? <span className="context-menu-icon">{icon}</span> : null
}

/** The nested menu. It opens to the right of its group item and flips to the left (and up) when the
 *  measured box would cross the screen edge. */
export function Submenu({
  items,
  cursor,
  onHover,
  onPick
}: {
  items: MenuItem[]
  cursor: number
  onHover: (i: number) => void
  onPick: (it: ActionItem) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [flip, setFlip] = useState({ left: false, up: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setFlip({ left: r.right > window.innerWidth, up: Math.max(0, r.bottom - window.innerHeight) })
  }, [])
  return (
    <div
      className={`context-menu context-submenu${flip.left ? ' flip-left' : ''}`}
      style={flip.up ? { top: -flip.up } : undefined}
      ref={ref}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it, i) => {
        if (it === 'separator') return <div key={`sep-${i}`} className="context-menu-sep" />
        if ('heading' in it)
          return (
            <div key={`head-${i}`} className="context-menu-heading">
              {it.heading}
            </div>
          )
        if (!isAction(it)) return null
        return (
          <div
            key={`item-${i}`}
            role="menuitem"
            aria-disabled={it.disabled}
            title={it.title}
            className={`context-menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}${i === cursor ? ' cursor' : ''}`}
            onMouseEnter={() => !it.disabled && onHover(i)}
            onClick={() => !it.disabled && onPick(it)}
          >
            <Icon icon={it.icon} />
            {it.label}
          </div>
        )
      })}
    </div>
  )
}

/** General-purpose right-click menu. It follows AccountSelect's dropdown conventions (close on outside
 *  click and Escape, ↑↓ and Enter, roles assigned). It opens at the cursor coordinates, flipping to the
 *  opposite side when it would cross a screen edge.
 *  An item with `submenu` opens a nested menu on hover, on → and on Enter; ← closes it, Escape closes it
 *  first and the menu second. Headings are labels only and the cursor skips them.
 *  It takes nothing but an array of items so it can be reused outside the explorer (session tabs, etc.). */
export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [ms, setMs] = useState<MenuState>(INITIAL_MENU_STATE)
  const { cursor, openSub, subCursor } = ms

  // Refs for reading the latest values from inside effects
  const msRef = useRef(ms)
  msRef.current = ms
  const itemsRef = useRef(items)
  itemsRef.current = items
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Flip against the edges using the measured size — once, after the render
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { innerWidth, innerHeight } = window
    const r = el.getBoundingClientRect()
    setPos({
      left: x + r.width > innerWidth ? Math.max(0, x - r.width) : x,
      top: y + r.height > innerHeight ? Math.max(0, y - r.height) : y
    })
  }, [x, y])

  const pick = (it: ActionItem): void => {
    onCloseRef.current()
    it.onSelect()
  }

  // Register the listeners once, on mount/unmount — the latest values come through refs
  useEffect(() => {
    const onDocDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') e.stopPropagation()
      else if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter'].includes(e.key)) return
      const r = menuKey(msRef.current, e.key, itemsRef.current)
      // The arrows scroll the page and Enter submits, so they are claimed; ← and → only when they act
      const vertical = e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter'
      if (e.key !== 'Escape' && (vertical || r.state !== msRef.current)) e.preventDefault()
      setMs(r.state)
      if (r.close) onCloseRef.current()
      if (r.select) r.select.onSelect()
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey, true) // capture phase — caught before the bubble handlers inside the tree
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [])

  return (
    <div className="context-menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu">
      {items.map((it, i) => {
        if (it === 'separator')
          return <div key={`sep-${i}`} className="context-menu-sep" onMouseEnter={() => setMs((m) => menuHover(m, items, i))} />
        if ('heading' in it)
          return (
            <div key={`head-${i}`} className="context-menu-heading" onMouseEnter={() => setMs((m) => menuHover(m, items, i))}>
              {it.heading}
            </div>
          )
        if (isSub(it)) {
          return (
            <div
              key={`item-${i}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={openSub === i}
              className={`context-menu-item has-sub${i === cursor ? ' cursor' : ''}`}
              onMouseEnter={() => setMs((m) => menuHover(m, items, i))}
              onClick={() => setMs(openGroup(items, i))}
            >
              <Icon icon={it.icon} />
              {it.label}
              <span className="context-menu-arrow" aria-hidden="true">
                ▸
              </span>
              {openSub === i && (
                <Submenu
                  items={it.submenu}
                  cursor={subCursor}
                  onHover={(j) => {
                    setMs((m) => ({ ...m, subCursor: j, inSub: true }))
                  }}
                  onPick={pick}
                />
              )}
            </div>
          )
        }
        return (
          <div
            key={`item-${i}`}
            role="menuitem"
            aria-disabled={it.disabled}
            title={it.title}
            className={`context-menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}${i === cursor ? ' cursor' : ''}`}
            onMouseEnter={() => setMs((m) => menuHover(m, items, i))}
            onClick={() => {
              if (it.disabled) return
              onClose()
              it.onSelect()
            }}
          >
            <Icon icon={it.icon} />
            {it.label}
          </div>
        )
      })}
    </div>
  )
}
