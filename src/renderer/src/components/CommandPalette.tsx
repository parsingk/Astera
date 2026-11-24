import { useEffect, useId, useRef, useState } from 'react'
import type { ActionId } from '../../../core/keys/binding'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'
import { backdropProps } from '../lib/backdrop'
import { paletteKey } from '../lib/paletteKey'
import { rankActions } from '../lib/paletteMatch'
import { displayPath, paletteMode } from '../lib/quickOpen'
import { readRecentActions, rememberAction } from '../lib/recentActions'
import { toast } from '../lib/toast'
import { useQuickOpenFiles } from '../hooks/useQuickOpenFiles'

export type PaletteEntry = {
  id: ActionId
  /** The action's wording, the same key Shortcut settings shows. */
  descKey: string
  /** The first chord bound to it, already formatted; absent when it has none. */
  chord?: string
  /** Why it cannot run right now, or null. A blocked row stays in the list and says why. */
  blocked: MessageKey | null
}

/** One row of either list: an action, or a file under the project. */
type Row = {
  key: string
  title: string
  /** A file's folder relative to the project, dimmed after its name. */
  detail?: string
  chord?: string
  blocked: MessageKey | null
  pick: () => void
}

/**
 * The command palette and Quick Open: one box, two lists (knowledge/decisions/ADR-007, spec W2). A leading `>` lists
 * every action the person can take, with its key; anything else lists the files under the explorer's project whose names
 * hold what was typed (lib/quickOpen.ts). Ctrl+Shift+P opens it on actions, Ctrl+P on files. What an action does and
 * whether it can run now belong to the action registry, which the caller reads into `entries`; which files match belongs
 * to main (main/quickOpen.ts).
 *
 * Keyboard only is enough: the box keeps focus, ↑/↓ move, Enter picks, Escape closes (lib/paletteKey.ts). A blocked
 * action is listed with its reason rather than hidden, and Enter on it says the reason instead of doing nothing.
 * Closing gives focus back to where it was (a terminal, usually), unless whatever was picked has taken it.
 */
export function CommandPalette({
  entries,
  onRun,
  onClose,
  initialQuery,
  projectRoot,
  onOpenFile
}: {
  entries: readonly PaletteEntry[]
  onRun: (id: ActionId) => void
  onClose: () => void
  /** `'>'` to open on actions, `''` to open on files. */
  initialQuery: string
  /** The explorer's project, whose files the file list searches; null when none is open. */
  projectRoot: string | null
  onOpenFile: (path: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const listId = useId()
  const [query, setQuery] = useState(initialQuery)
  const [selected, setSelected] = useState(0)
  const known = entries.map((e) => e.id)
  const [recent] = useState(() => readRecentActions(known))
  // Where focus was, read while the first render runs, before the box takes it. Not in the mount effect: under
  // React.StrictMode that effect runs twice in development, and the second run would read the box itself.
  const [restoreTo] = useState(() => document.activeElement as HTMLElement | null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  /** Enter was pressed while the file rows still answered an older query; the newer answer's first row is opened. */
  const pendingEnter = useRef(false)
  const { mode, text } = paletteMode(query)
  const files = useQuickOpenFiles(projectRoot, text, mode === 'files')

  useEffect(() => {
    const box = inputRef.current
    box?.focus()
    // After the `>` an action search opens with, so typing goes on from it
    box?.setSelectionRange(box.value.length, box.value.length)
    return () => {
      // Only when nothing else took focus as the palette closed: an action that opened a dialog keeps its focus.
      const now = document.activeElement
      if ((now === null || now === document.body) && restoreTo?.isConnected) restoreTo.focus()
    }
  }, [restoreTo])

  const rows: Row[] =
    mode === 'actions'
      ? rankActions(
          entries.map((e) => ({ ...e, title: t(e.descKey as MessageKey) })),
          text,
          recent
        ).map((r) => ({
          key: r.id,
          title: r.title,
          chord: r.chord,
          blocked: r.blocked,
          pick: () => {
            rememberAction(r.id, known)
            onRun(r.id)
          }
        }))
      : files.paths.map((p) => {
          const { name, folder } = displayPath(projectRoot ?? '', p)
          return { key: p, title: name, detail: folder, blocked: null, pick: () => onOpenFile(p) }
        })
  const at = rows.length === 0 ? -1 : Math.min(selected, rows.length - 1)
  const optionId = (i: number): string => `${listId}-${i}`
  /** The file rows on screen answer an older query than the one in the box: Enter waits for the newer answer. */
  const stale = mode === 'files' && files.answeredFor !== text

  useEffect(() => {
    if (at < 0) return
    listRef.current?.children[at]?.scrollIntoView({ block: 'nearest' })
  }, [at])

  const choose = (row: Row): void => {
    if (row.blocked) {
      toast.info(t(row.blocked))
      return
    }
    row.pick()
  }

  // An Enter that waited for the rows of what was typed: the first of them, as an Enter on a current list would take.
  useEffect(() => {
    if (!pendingEnter.current || stale) return
    pendingEnter.current = false
    if (rows.length > 0) choose(rows[0])
  })

  // The palette's own keys, taken in the window's capture phase and stopped there. A menu left open behind the palette
  // (the run configuration menu, a tab's context menu) listens on document in the capture phase and would otherwise
  // take the arrows and Enter first, and act on the workbench behind the dialog. The global shortcut listener, also on
  // the window, was registered earlier and stands aside while the palette is open (modalOpenRef).
  const keyState = useRef({ at, rows, choose, onClose, stale })
  keyState.current = { at, rows, choose, onClose, stale }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { at: cur, rows: list, choose: pick, onClose: close, stale: waiting } = keyState.current
      const outcome = paletteKey(e.key, cur, list.length, e.isComposing)
      if (!outcome) return
      e.preventDefault()
      e.stopPropagation()
      // Enter over rows of an older query, or over none yet: wait for what was typed
      if (waiting && e.key === 'Enter') pendingEnter.current = true
      else if (outcome.do === 'close') close()
      else if (outcome.do === 'select') setSelected(outcome.index)
      else if (outcome.do === 'choose') pick(list[outcome.index])
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const title = mode === 'actions' ? t('palette.title') : t('shortcut.file.quickOpen')
  /** Below the rows, or in their place: why there are no file rows, or that more are coming. */
  const fileNote =
    mode !== 'files'
      ? null
      : !projectRoot
        ? t('action.blocked.noProject')
        : files.unavailable
          ? t('quickOpen.unavailable')
          : files.indexing
            ? t('quickOpen.indexing')
            : files.answeredFor !== null && rows.length === 0
              ? t('quickOpen.empty')
              : null
  const note = mode === 'actions' ? (rows.length === 0 ? t('palette.empty') : null) : fileNote

  return (
    <div className="modal-backdrop palette-backdrop" {...backdropProps(onClose)}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label={title}
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
          aria-activedescendant={at >= 0 ? optionId(at) : undefined}
          placeholder={t('quickOpen.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setSelected(0)
            // An Enter that was waiting meant the query in the box then, not the one typed since
            pendingEnter.current = false
          }}
        />
        <ul className="palette-list" role="listbox" id={listId} ref={listRef} aria-label={title}>
          {rows.map((row, i) => (
            <li
              key={row.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              aria-disabled={row.blocked ? true : undefined}
              className={`palette-row${i === at ? ' selected' : ''}${row.blocked ? ' blocked' : ''}${row.detail !== undefined ? ' file' : ''}`}
              onMouseMove={() => i !== at && setSelected(i)}
              onClick={() => choose(row)}
            >
              <span className="palette-title">{row.title}</span>
              {row.detail && <span className="palette-detail">{row.detail}</span>}
              {row.blocked && <span className="palette-reason" title={t(row.blocked)}>{t(row.blocked)}</span>}
              {row.chord && <kbd className="palette-chord">{row.chord}</kbd>}
            </li>
          ))}
        </ul>
        {note && <div className="palette-empty">{note}</div>}
      </div>
    </div>
  )
}
