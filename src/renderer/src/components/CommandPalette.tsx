import { useEffect, useId, useRef, useState } from 'react'
import type { MessageKey } from '../../../core/i18n'
import type { RegistryId } from '../lib/actionRegistry'
import { useI18n } from '../i18n/I18nProvider'
import { backdropProps } from '../lib/backdrop'
import { giveFocus } from '../lib/focusHold'
import { paletteKey } from '../lib/paletteKey'
import { rankActions } from '../lib/paletteMatch'
import { displayPath, enterAction, markSegments, paletteMode, rowsWaiting, settleEnter } from '../lib/quickOpen'
import { readRecentActions, rememberAction } from '../lib/recentActions'
import { toast } from '../lib/toast'
import { useQuickOpenFiles } from '../hooks/useQuickOpenFiles'
import { useTextSearch } from '../hooks/useTextSearch'
import { TEXT_SEARCH_LINES_PER_FILE, TEXT_SEARCH_MAX_QUERY } from '../../../core/files/textMatch'

export type PaletteEntry = {
  id: RegistryId
  /** The action's wording: a core action's text in the person's language (the key Shortcut settings shows), a plugin
   *  command's title as its manifest wrote it. */
  title: string
  /** Whose command it is, drawn dimmed after the title: a plugin's name. Absent for a core action. */
  source?: string
  /** The first chord bound to it, already formatted; absent when it has none. */
  chord?: string
  /** Why it cannot run right now, or null. A blocked row stays in the list and says why. */
  blocked: MessageKey | null
}

/** One row of any list: an action, a file under the project, or a line in one. */
type Row = {
  key: string
  title: string
  /** Where the matches fall in `title`, for a line of text: drawn marked. */
  marks?: Array<[number, number]>
  /** A file's folder relative to the project, or a line's file and line number, dimmed after the title. */
  detail?: string
  /** A plugin command's plugin, dimmed after the title. */
  source?: string
  chord?: string
  blocked: MessageKey | null
  pick: () => void
}

/**
 * The command palette, Quick Open and text search: one box, three lists (knowledge/decisions/ADR-007, spec W2). A leading
 * `>` lists every action the person can take, with its key; a leading `%` lists the lines of the explorer's project's
 * files that hold what was typed; anything else lists the files whose names hold it (lib/quickOpen.ts). Ctrl+Shift+P
 * opens it on actions, Ctrl+Shift+F on text, Ctrl+P on files. What an action does and whether it can run now belong to
 * the action registry, which the caller reads into `entries`; which files and lines match belongs to main
 * (main/quickOpen.ts, main/textSearch.ts).
 *
 * Keyboard only is enough: the box keeps focus, ↑/↓ move, Enter picks, Escape closes (lib/paletteKey.ts). A blocked
 * action is listed with its reason rather than hidden, and Enter on it says the reason instead of doing nothing; an
 * action whose feature is turned off in Settings is not among the entries at all.
 * Closing gives focus back to where it was (a terminal, usually), unless whatever was picked has taken it.
 */
export function CommandPalette({
  entries,
  onRun,
  onClose,
  initialQuery,
  projectRoot,
  onOpenFile,
  onOpenAt,
  restoreTo,
  actionIds
}: {
  entries: readonly PaletteEntry[]
  /** Every action this version knows, shown or not: the recent list is kept against it, so an action hidden while its
   *  feature is turned off keeps its place for when it is back. */
  actionIds: readonly RegistryId[]
  onRun: (id: RegistryId) => void
  onClose: () => void
  /** `'>'` to open on actions, `''` on files, `'%'` on text in files. */
  initialQuery: string
  /** The explorer's project, whose files the file and text lists search; null when none is open. */
  projectRoot: string | null
  onOpenFile: (path: string) => void
  /** A line chosen from the text list: its file in the editor, at the match. */
  onOpenAt: (path: string, at: { line: number; col: number }) => void
  /** Where focus was before the palette opened, read by the caller as it opened (an event handler, not this box's
   *  render or effects: React.StrictMode runs those twice, and a box remounted on the other list would read the old
   *  box's input). Closing gives focus back to it. */
  restoreTo: HTMLElement | null
}): React.JSX.Element {
  const { t } = useI18n()
  const listId = useId()
  const [query, setQuery] = useState(initialQuery)
  const [selected, setSelected] = useState(0)
  const known = actionIds
  const [recent] = useState(() => readRecentActions(known))
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  /** Enter was pressed while the file or text rows were not yet those of what is typed; the first current row is
   *  opened. */
  const pendingEnter = useRef(false)
  const { mode, text } = paletteMode(query)
  const files = useQuickOpenFiles(projectRoot, text, mode === 'files')
  const found = useTextSearch(projectRoot, text, mode === 'text')
  const projectName = projectRoot ? projectRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || projectRoot : ''

  useEffect(() => {
    const box = inputRef.current
    box?.focus()
    // After the `>` an action search opens with, so typing goes on from it
    box?.setSelectionRange(box.value.length, box.value.length)
    return () => {
      // Only when nothing else took focus as the palette closed: an action that opened a dialog keeps its focus. A
      // microtask later, after the effects of what was picked, so a tab it activated has taken the focus by then: giving
      // it back to a plugin panel first made Electron hand that panel the focus again a moment later, over the tab's
      // (review of the A1 fix). Given as the app's, so a panel taking it does not read as the person moving there.
      queueMicrotask(() => {
        const now = document.activeElement
        if ((now === null || now === document.body) && restoreTo?.isConnected) giveFocus(restoreTo)
      })
    }
  }, [restoreTo])

  const rows: Row[] =
    mode === 'actions'
      ? rankActions(entries, text, recent).map((r) => ({
          key: r.id,
          title: r.title,
          source: r.source,
          chord: r.chord,
          blocked: r.blocked,
          pick: () => {
            rememberAction(r.id, known)
            onRun(r.id)
          }
        }))
      : mode === 'files'
        ? files.paths.map((p) => {
            const { name, folder } = displayPath(projectRoot ?? '', p)
            return { key: p, title: name, detail: folder, blocked: null, pick: () => onOpenFile(p) }
          })
        : found.matches.map((m) => {
            const { name, folder } = displayPath(projectRoot ?? '', m.path)
            return {
              key: `${m.path}\n${m.line}`,
              title: m.preview,
              marks: m.ranges,
              detail: `${folder ? `${folder}/` : ''}${name}:${m.line}`,
              blocked: null,
              pick: () => onOpenAt(m.path, { line: m.line, col: m.col })
            }
          })
  const at = rows.length === 0 ? -1 : Math.min(selected, rows.length - 1)
  const optionId = (i: number): string => `${listId}-${i}`
  /** Whether the rows on screen answer what is typed, and whether the work behind them (a first walk, or files still
   *  being read for text) is under way. */
  const list = mode === 'text' ? { current: found.current, busy: found.searching } : { current: files.current, busy: files.indexing }
  /** Enter waits: the rows on screen answer an older query or project, or the work behind them has found nothing yet. */
  const waiting = rowsWaiting({ mode, current: list.current, busy: list.busy, rows: rows.length })

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
    if (!pendingEnter.current) return
    const next = settleEnter(waiting, rows.length)
    if (next === 'hold') return
    pendingEnter.current = false
    if (next === 'first') choose(rows[0])
  })

  // The palette's own keys, taken in the window's capture phase and stopped there. A menu left open behind the palette
  // (the run configuration menu, a tab's context menu) listens on document in the capture phase and would otherwise
  // take the arrows and Enter first, and act on the workbench behind the dialog. The global shortcut listener, also on
  // the window, was registered earlier and stands aside while the palette is open (modalOpenRef).
  const keyState = useRef({ at, rows, choose, onClose, waiting })
  keyState.current = { at, rows, choose, onClose, waiting }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { at: cur, rows: list, choose: pick, onClose: close, waiting } = keyState.current
      const outcome = paletteKey(e.key, cur, list.length, e.isComposing)
      if (!outcome) return
      e.preventDefault()
      e.stopPropagation()
      if (outcome.do === 'close') close()
      else if (outcome.do === 'select') setSelected(outcome.index)
      else if (e.key === 'Enter') {
        // Over rows of an older query or project, or over none yet during a first walk: wait for what was typed
        const act = enterAction(waiting, cur)
        if (act.do === 'wait') pendingEnter.current = true
        else if (act.do === 'choose') pick(list[act.index])
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const title = mode === 'actions' ? t('palette.title') : mode === 'text' ? t('shortcut.search.text') : t('shortcut.file.quickOpen')
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
            : files.current && rows.length === 0
              ? t('quickOpen.empty')
              : null
  /** The same for lines of text. Until the rows answer what is typed (the debounce, the first answer), it is searching. */
  const textNote =
    mode !== 'text'
      ? null
      : !projectRoot
        ? t('action.blocked.noProject')
        : text === ''
          ? t('textSearch.hint')
          : text.length > TEXT_SEARCH_MAX_QUERY
            ? t('textSearch.tooLong', { max: TEXT_SEARCH_MAX_QUERY })
            : found.unavailable
              ? t('quickOpen.unavailable')
              : !found.current || found.searching
                ? t('textSearch.searching')
                : rows.length === 0
                  ? t('textSearch.empty')
                  : null
  const note = mode === 'actions' ? (rows.length === 0 ? t('palette.empty') : null) : mode === 'text' ? textNote : fileNote
  /** Text search's scope line: what was cut first, since the line ends in an ellipsis when it runs long, then which
   *  project is searched and what is never read. The whole line is its tooltip. */
  const textScope = [
    found.truncated ? t('textSearch.truncated', { count: rows.length }) : null,
    found.fileCut ? t('textSearch.fileCut', { count: TEXT_SEARCH_LINES_PER_FILE }) : null,
    found.partial ? t('quickOpen.truncated') : null,
    t('textSearch.scope', { name: projectName })
  ]
    .filter((part) => part !== null)
    .join(' · ')

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
        {mode === 'files' && projectRoot && (
          // Spec W2's search scope: which project is searched, and whether a large one is searched only in part
          <div className="palette-scope">
            {t('quickOpen.scope', { name: projectName })}
            {files.truncated && ` · ${t('quickOpen.truncated')}`}
          </div>
        )}
        {mode === 'text' && projectRoot && (
          // The same for text: whether the rows or the files were cut, which project, and what is never read
          <div className="palette-scope" title={textScope}>
            {textScope}
          </div>
        )}
        <ul className="palette-list" role="listbox" id={listId} ref={listRef} aria-label={title}>
          {rows.map((row, i) => (
            <li
              key={row.key}
              id={optionId(i)}
              role="option"
              aria-selected={i === at}
              aria-disabled={row.blocked ? true : undefined}
              className={`palette-row${i === at ? ' selected' : ''}${row.blocked ? ' blocked' : ''}${row.marks ? ' text' : row.detail !== undefined ? ' file' : ''}`}
              onMouseMove={() => i !== at && setSelected(i)}
              onClick={() => choose(row)}
            >
              <span className="palette-title">
                {row.marks
                  ? markSegments(row.title, row.marks).map((part, j) =>
                      part.mark ? (
                        <mark key={j} className="palette-mark">
                          {part.text}
                        </mark>
                      ) : (
                        part.text
                      )
                    )
                  : row.title}
              </span>
              {row.source && <span className="palette-source">{row.source}</span>}
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
