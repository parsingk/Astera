import { useEffect, useId, useRef, useState } from 'react'
import type { ActionId } from '../../../core/keys/binding'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'
import { backdropProps } from '../lib/backdrop'
import { paletteKey } from '../lib/paletteKey'
import { rankActions } from '../lib/paletteMatch'
import { readRecentActions, rememberAction } from '../lib/recentActions'
import { toast } from '../lib/toast'

export type PaletteEntry = {
  id: ActionId
  /** The action's wording, the same key Shortcut settings shows. */
  descKey: string
  /** The first chord bound to it, already formatted; absent when it has none. */
  chord?: string
  /** Why it cannot run right now, or null. A blocked row stays in the list and says why. */
  blocked: MessageKey | null
}

/**
 * The command palette: every action the person can take, with its key, searchable from one box
 * (knowledge/decisions/ADR-007). It lists and runs; what an action does and whether it can run now belong to the
 * action registry, which the caller reads into `entries`.
 *
 * Keyboard only is enough: the box keeps focus, ↑/↓ move, Enter runs, Escape closes (lib/paletteKey.ts). A blocked
 * action is listed with its reason rather than hidden, and Enter on it says the reason instead of doing nothing.
 * Closing gives focus back to where it was (a terminal, usually), unless whatever the action opened has taken it.
 */
export function CommandPalette({
  entries,
  onRun,
  onClose
}: {
  entries: readonly PaletteEntry[]
  onRun: (id: ActionId) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const listId = useId()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const known = entries.map((e) => e.id)
  const [recent] = useState(() => readRecentActions(known))
  // Where focus was, read while the first render runs, before the box takes it. Not in the mount effect: under
  // React.StrictMode that effect runs twice in development, and the second run would read the box itself.
  const [restoreTo] = useState(() => document.activeElement as HTMLElement | null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    return () => {
      // Only when nothing else took focus as the palette closed: an action that opened a dialog keeps its focus.
      const now = document.activeElement
      if ((now === null || now === document.body) && restoreTo?.isConnected) restoreTo.focus()
    }
  }, [restoreTo])

  const rows = rankActions(
    entries.map((e) => ({ ...e, title: t(e.descKey as MessageKey) })),
    query,
    recent
  )
  const at = rows.length === 0 ? -1 : Math.min(selected, rows.length - 1)
  const optionId = (id: ActionId): string => `${listId}-${id.replace(/\W/g, '-')}`

  useEffect(() => {
    if (at < 0) return
    listRef.current?.children[at]?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const choose = (row: (typeof rows)[number]): void => {
    if (row.blocked) {
      toast.info(t(row.blocked))
      return
    }
    rememberAction(row.id, known)
    onRun(row.id)
  }

  // The palette's own keys, taken in the window's capture phase and stopped there. A menu left open behind the palette
  // (the run configuration menu, a tab's context menu) listens on document in the capture phase and would otherwise
  // take the arrows and Enter first, and act on the workbench behind the dialog. The global shortcut listener, also on
  // the window, was registered earlier and stands aside while the palette is open (modalOpenRef).
  const keyState = useRef({ at, rows, choose, onClose })
  keyState.current = { at, rows, choose, onClose }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { at: cur, rows: list, choose: pick, onClose: close } = keyState.current
      const outcome = paletteKey(e.key, cur, list.length, e.isComposing)
      if (!outcome) return
      e.preventDefault()
      e.stopPropagation()
      if (outcome.do === 'close') close()
      else if (outcome.do === 'select') setSelected(outcome.index)
      else if (outcome.do === 'choose') pick(list[outcome.index])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return (
    <div className="modal-backdrop palette-backdrop" {...backdropProps(onClose)}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.title')}
        onMouseDown={(e) => {
          if (e.target !== inputRef.current) e.preventDefault() // a press anywhere else keeps focus in the box
        }}
      >
        <input
          ref={inputRef}
          type="text"
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={at >= 0 ? optionId(rows[at].id) : undefined}
          placeholder={t('palette.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
          }}
        />
        <ul className="palette-list" role="listbox" id={listId} ref={listRef} aria-label={t('palette.title')}>
          {rows.map((row, i) => (
            <li
              key={row.id}
              id={optionId(row.id)}
              role="option"
              aria-selected={i === at}
              aria-disabled={row.blocked ? true : undefined}
              className={`palette-row${i === at ? ' selected' : ''}${row.blocked ? ' blocked' : ''}`}
              onMouseMove={() => i !== at && setSelected(i)}
              onClick={() => choose(row)}
            >
              <span className="palette-title">{row.title}</span>
              {row.blocked && <span className="palette-reason" title={t(row.blocked)}>{t(row.blocked)}</span>}
              {row.chord && <kbd className="palette-chord">{row.chord}</kbd>}
            </li>
          ))}
        </ul>
        {rows.length === 0 && <div className="palette-empty">{t('palette.empty')}</div>}
      </div>
    </div>
  )
}
