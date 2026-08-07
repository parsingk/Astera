import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuItem =
  | { label: string; onSelect: () => void; danger?: boolean; disabled?: boolean }
  | 'separator'

/** General-purpose right-click menu. It follows AccountSelect's dropdown conventions (close on outside
 *  click and Escape, ↑↓ and Enter, roles assigned). It opens at the cursor coordinates, flipping to the
 *  opposite side when it would cross a screen edge.
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
  const [cursor, setCursor] = useState(-1)
  const actionable = items
    .map((it, i) => ({ it, i }))
    .filter((e): e is { it: Exclude<MenuItem, 'separator'>; i: number } => e.it !== 'separator' && !e.it.disabled)

  // Refs for reading the latest values from inside effects
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  const itemsRef = useRef(items)
  itemsRef.current = items
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const actionableRef = useRef(actionable)
  actionableRef.current = actionable

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

  // Register the listeners once, on mount/unmount — the latest values come through refs
  useEffect(() => {
    const onDocDown = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (actionableRef.current.length === 0) return
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setCursor((c) => {
          const idx = actionableRef.current.findIndex((a) => a.i === c)
          // No cursor (-1): ↓ goes to the first, ↑ to the last
          if (idx < 0) return (delta === 1 ? actionableRef.current[0] : actionableRef.current[actionableRef.current.length - 1]).i
          return actionableRef.current[(idx + delta + actionableRef.current.length) % actionableRef.current.length].i
        })
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cur = itemsRef.current[cursorRef.current]
        if (cur && cur !== 'separator' && !cur.disabled) {
          onCloseRef.current()
          cur.onSelect()
        }
      }
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
      {items.map((it, i) =>
        it === 'separator' ? (
          <div key={`sep-${i}`} className="context-menu-sep" />
        ) : (
          <div
            key={`item-${i}`}
            role="menuitem"
            aria-disabled={it.disabled}
            className={`context-menu-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}${i === cursor ? ' cursor' : ''}`}
            onMouseEnter={() => !it.disabled && setCursor(i)}
            onClick={() => {
              if (it.disabled) return
              onClose()
              it.onSelect()
            }}
          >
            {it.label}
          </div>
        )
      )}
    </div>
  )
}
