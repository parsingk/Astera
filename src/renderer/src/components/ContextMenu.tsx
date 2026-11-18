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

const isSub = (it: MenuItem): it is SubmenuItem => it !== 'separator' && 'submenu' in it
const isAction = (it: MenuItem): it is ActionItem => it !== 'separator' && 'onSelect' in it
/** Items the cursor can rest on: not separators, not headings, not disabled actions */
const focusable = (it: MenuItem): boolean => isSub(it) || (isAction(it) && !it.disabled)
const focusableIdx = (items: MenuItem[]): number[] => items.flatMap((it, i) => (focusable(it) ? [i] : []))

/** Cursor step over the focusable indices. No cursor (-1): ↓ goes to the first, ↑ to the last. */
function step(items: MenuItem[], cur: number, delta: 1 | -1): number {
  const idxs = focusableIdx(items)
  if (idxs.length === 0) return cur
  const at = idxs.indexOf(cur)
  if (at < 0) return delta === 1 ? idxs[0] : idxs[idxs.length - 1]
  return idxs[(at + delta + idxs.length) % idxs.length]
}

function Icon({ icon }: { icon?: React.ReactNode }): React.JSX.Element | null {
  return icon ? <span className="context-menu-icon">{icon}</span> : null
}

/** The nested menu. It opens to the right of its group item and flips to the left (and up) when the
 *  measured box would cross the screen edge. */
function Submenu({
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
  onClose,
  initialSubmenu
}: {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  /** Index of a group item whose submenu is open from the start (tests render the opened state) */
  initialSubmenu?: number
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [cursor, setCursor] = useState(initialSubmenu ?? -1)
  // The open group item, the cursor inside its submenu, and whether the keyboard is in the submenu
  const [openSub, setOpenSub] = useState<number | null>(initialSubmenu ?? null)
  const [subCursor, setSubCursor] = useState(-1)
  const [inSub, setInSub] = useState(false)

  // Refs for reading the latest values from inside effects
  const state = { cursor, openSub, subCursor, inSub, items }
  const stateRef = useRef(state)
  stateRef.current = state
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

  const subItemsOf = (i: number | null): MenuItem[] => {
    const it = i === null ? undefined : stateRef.current.items[i]
    return it && isSub(it) ? it.submenu : []
  }
  const openGroup = (i: number): void => {
    setCursor(i)
    setOpenSub(i)
    setSubCursor(step(subItemsOf(i), -1, 1))
    setInSub(true)
  }
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
      const s = stateRef.current
      const list = s.inSub ? subItemsOf(s.openSub) : s.items
      if (e.key === 'Escape') {
        e.stopPropagation()
        if (s.openSub !== null) {
          // First Escape: back to the parent menu with the group item still under the cursor
          setOpenSub(null)
          setInSub(false)
          setSubCursor(-1)
        } else onCloseRef.current()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        if (s.inSub) setSubCursor(step(list, s.subCursor, delta))
        else {
          setCursor(step(list, s.cursor, delta))
          setOpenSub(null) // moving the cursor off a group item closes its submenu
        }
      } else if (e.key === 'ArrowRight') {
        const cur = s.items[s.cursor]
        if (!s.inSub && cur && isSub(cur)) {
          e.preventDefault()
          openGroup(s.cursor)
        }
      } else if (e.key === 'ArrowLeft') {
        if (s.openSub !== null) {
          e.preventDefault()
          setOpenSub(null)
          setInSub(false)
          setSubCursor(-1)
        }
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cur = list[s.inSub ? s.subCursor : s.cursor]
        if (!cur || cur === 'separator') return
        if (isSub(cur)) openGroup(s.cursor)
        else if (isAction(cur) && !cur.disabled) pick(cur)
      }
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey, true) // capture phase — caught before the bubble handlers inside the tree
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey, true)
    }
    // openGroup and pick only touch setters and refs, so the one-time registration stays current
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="context-menu" ref={ref} style={{ left: pos.left, top: pos.top }} role="menu">
      {items.map((it, i) => {
        if (it === 'separator') return <div key={`sep-${i}`} className="context-menu-sep" />
        if ('heading' in it)
          return (
            <div key={`head-${i}`} className="context-menu-heading">
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
              onMouseEnter={() => {
                setCursor(i)
                setOpenSub(i)
                setSubCursor(-1)
                setInSub(false)
              }}
              onClick={() => openGroup(i)}
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
                    setSubCursor(j)
                    setInSub(true)
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
            onMouseEnter={() => {
              if (it.disabled) return
              setCursor(i)
              setOpenSub(null)
              setInSub(false)
            }}
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
