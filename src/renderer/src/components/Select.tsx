import { useEffect, useRef, useState } from 'react'
import { groupRowsOf, nextCursor, type SelectItem } from '../../../core/ui/select'
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
        <ul className="sel-menu" role="listbox">
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
