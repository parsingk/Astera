import { useEffect, useRef, useState } from 'react'
import type { Account } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'
import { ProviderBadge } from './ProviderBadge'

interface Item {
  id: string
  label: string
  account: Account | null // null = a pseudo-item with no badge, such as 'All accounts'
}

/** The badge cell — the 'All accounts' row has no account but has to take up the same width, otherwise the labels do not line up vertically. */
function BadgeCell({ account }: { account: Account | null }): React.JSX.Element {
  if (!account) return <span className="provider-badge-spacer" aria-hidden="true" />
  return <ProviderBadge provider={account.provider} />
}

/** Account picker dropdown. A native select's option renders text only, so a ProviderBadge (SVG) cannot go
 *  in it and this is built custom instead. Every UI that picks an account uses this. */
export function AccountSelect({
  accounts,
  value,
  onChange,
  allLabel,
  suffixOf,
  className
}: {
  accounts: Account[]
  value: string
  onChange: (id: string) => void
  /** When given, puts an 'All accounts' item with the value '' at the very front (the history account filter) */
  allLabel?: string
  /** Secondary text after the label (e.g. resume's ' (original account)') */
  suffixOf?: (a: Account) => string | null
  className?: string
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  // Keyboard navigation highlight. It starts on the currently selected item when the dropdown opens.
  const [cursor, setCursor] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)

  const items: Item[] = [
    ...(allLabel === undefined ? [] : [{ id: '', label: allLabel, account: null }]),
    ...accounts.map((a) => ({ id: a.id, label: a.label + (suffixOf?.(a) ?? ''), account: a }))
  ]
  const selected = items.find((it) => it.id === value) ?? null

  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocDown)
    return () => document.removeEventListener('mousedown', onDocDown)
  }, [open])

  const openList = (): void => {
    setCursor(Math.max(0, items.findIndex((it) => it.id === value)))
    setOpen(true)
  }

  const commit = (it: Item): void => {
    onChange(it.id)
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
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => (items.length === 0 ? 0 : (c + 1) % items.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => (items.length === 0 ? 0 : (c - 1 + items.length) % items.length))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      const it = items[cursor]
      if (it) commit(it)
    }
  }

  return (
    <div className={className ? `account-select ${className}` : 'account-select'} ref={rootRef}>
      <button
        type="button"
        className="account-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        {selected ? (
          <>
            <BadgeCell account={selected.account} />
            <span className="account-select-label">{selected.label}</span>
          </>
        ) : (
          <span className="account-select-label empty">{t('account.select.none')}</span>
        )}
        <span className="account-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul className="account-select-list" role="listbox">
          {items.map((it, i) => (
            <li
              key={it.id || '__all__'}
              role="option"
              aria-selected={it.id === value}
              className={`account-select-option${i === cursor ? ' cursor' : ''}${it.id === value ? ' selected' : ''}`}
              onMouseEnter={() => setCursor(i)}
              onClick={() => commit(it)}
            >
              <BadgeCell account={it.account} />
              <span className="account-select-label">{it.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
