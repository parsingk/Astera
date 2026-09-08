import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery
} from '@codemirror/search'
import {
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Regex,
  Replace,
  ReplaceAll,
  Search,
  TextSelect,
  WholeWord,
  X
} from 'lucide-react'
import { useI18n } from '../i18n/I18nProvider'
import { countMatches } from './fileFind'

/** How long the count waits after the last change before walking the document. Long enough that a
 *  burst of typing costs one walk, short enough that pressing Enter does not feel like it lagged. */
const COUNT_DELAY = 90

/** The find and replace bar drawn over the file editor, top right. It replaces @codemirror/search's
 *  own panel, which is unstyled default CodeMirror and looks like nothing else in the app.
 *
 *  **The search state still belongs to CodeMirror.** This component owns nothing but the text in its
 *  own two fields: every change is pushed into the editor as a `setSearchQuery`, and every action is
 *  one of CodeMirror's own commands. That is what keeps the query attached to the file — the query
 *  lives in the EditorState, which FileEditor caches per file and moves between panes, so switching
 *  tabs brings each file's own search back with it.
 *
 *  **A hidden panel is deliberately left open.** Match highlighting is gated on the panel being open:
 *  @codemirror/search's `searchHighlighter` paints nothing while `searchState.panel` is null. So
 *  FileEditor configures `search()` with a `createPanel` that returns an empty div, this component
 *  opens and closes it alongside itself, and styles.css hides `.cm-panels` outright. Without that the
 *  bar would work and nothing in the document would light up. */
export function FileFindBar({
  view,
  stateEpoch,
  readOnly,
  nonce,
  wantReplace,
  tick,
  onClose
}: {
  view: EditorView
  /** Rises whenever FileEditor hands the view a different EditorState — a file switch, or a reload
   *  from disk. Not drawn: it is the signal to reread the query, and FileEditor bumps it *after* the
   *  swap precisely because this component's own effects run before its parent's. */
  stateEpoch: number
  /** A read-only file has no replace row at all, the same rule CodeMirror's own panel follows */
  readOnly: boolean
  /** Bumped on every Ctrl+F and Ctrl+H. Reseeds from the selection and takes the focus, so pressing
   *  the shortcut again with a word selected searches for that word. */
  nonce: number
  /** The shortcut was Ctrl+H — show the replace row. Never hides it: Ctrl+F after Ctrl+H leaves the
   *  replace row where the user put it. */
  wantReplace: boolean
  /** Bumped by FileEditor when the document or the selection moved, which is when the count and the
   *  current position go stale. Nothing is read from it beyond the change itself. */
  tick: number
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  const [initial] = useState(() => getSearchQuery(view.state))
  const [search, setSearch] = useState(initial.search)
  const [replace, setReplace] = useState(initial.replace)
  const [caseSensitive, setCaseSensitive] = useState(initial.caseSensitive)
  const [wholeWord, setWholeWord] = useState(initial.wholeWord)
  const [regexp, setRegexp] = useState(initial.regexp)
  const [showReplace, setShowReplace] = useState(wantReplace)
  const [results, setResults] = useState<{ index: number | null; total: number } | null>(null)

  // Open the hidden panel for as long as the bar is on screen — see the note on the component
  useEffect(() => {
    openSearchPanel(view)
    return () => {
      closeSearchPanel(view)
    }
  }, [view])

  // A file switch replaces the whole EditorState, so both the panel and the fields have to be put
  // back for the file now on screen. Reading the fields from the state (rather than keeping them
  // here) is what makes each file remember its own search.
  useEffect(() => {
    openSearchPanel(view)
    const q = getSearchQuery(view.state)
    setSearch(q.search)
    setReplace(q.replace)
    setCaseSensitive(q.caseSensitive)
    setWholeWord(q.wholeWord)
    setRegexp(q.regexp)
  }, [view, stateEpoch])

  // Ctrl+F with a word selected searches for that word. The rule is CodeMirror's own (defaultQuery):
  // a non-empty selection on one line, up to 100 characters. Runs on the first open too, which is
  // where the focus comes from.
  useEffect(() => {
    const sel = view.state.selection.main
    const picked = sel.empty || sel.to > sel.from + 100 ? '' : view.state.sliceDoc(sel.from, sel.to)
    if (picked && !picked.includes('\n')) setSearch(picked)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [view, nonce])

  useEffect(() => {
    if (wantReplace) setShowReplace(true)
  }, [wantReplace, nonce])

  const query = useMemo(
    () => new SearchQuery({ search, replace, caseSensitive, wholeWord, regexp }),
    [search, replace, caseSensitive, wholeWord, regexp]
  )

  // Hand the query to CodeMirror. The equality check matters: the fields are also set from the state
  // above, and dispatching the query that is already there would be a transaction per keystroke.
  useEffect(() => {
    if (!query.eq(getSearchQuery(view.state))) view.dispatch({ effects: setSearchQuery.of(query) })
  }, [view, query])

  // `valid` is false for an empty query and for a regular expression that does not compile. Both mean
  // there is nothing to count, and countMatches would throw on the second one.
  useEffect(() => {
    if (!query.valid) {
      setResults(null)
      return
    }
    const id = window.setTimeout(() => setResults(countMatches(view.state, query)), COUNT_DELAY)
    return () => window.clearTimeout(id)
  }, [view, query, tick])

  const close = (): void => {
    onClose()
    view.focus()
  }

  // Keeps the caret in the field the user is typing in. Without it every button press moves the focus
  // out of the input, and the next keystroke goes to the document.
  const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

  const badPattern = search !== '' && !query.valid
  const countText = badPattern
    ? t('explorer.find.badRegexp')
    : results === null
      ? ''
      : results.total === 0
        ? t('explorer.find.noResults')
        : results.index === null
          ? t('explorer.find.countMany', { total: results.total })
          : t('explorer.find.count', { n: results.index, total: results.total })
  const countBad = badPattern || results?.total === 0

  const toggle = (
    on: boolean,
    label: string,
    Icon: typeof CaseSensitive,
    flip: () => void
  ): React.JSX.Element => (
    <button
      type="button"
      className={`fe-find-toggle${on ? ' on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={on}
      onMouseDown={keepFocus}
      onClick={flip}
    >
      <Icon size={12} />
    </button>
  )

  const action = (
    label: string,
    Icon: typeof CaseSensitive,
    run: () => void
  ): React.JSX.Element => (
    <button
      type="button"
      className="fe-find-btn"
      title={label}
      aria-label={label}
      onMouseDown={keepFocus}
      onClick={run}
    >
      <Icon size={12} />
    </button>
  )

  const expandLabel = t(showReplace ? 'explorer.find.hideReplace' : 'explorer.find.showReplace')
  return (
    <div className="fe-find" role="search">
      {!readOnly && (
        <button
          type="button"
          className="fe-find-expand"
          title={expandLabel}
          aria-label={expandLabel}
          aria-expanded={showReplace}
          onMouseDown={keepFocus}
          onClick={() => setShowReplace((v) => !v)}
        >
          {showReplace ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      )}
      <div className="fe-find-rows">
        <div className="fe-find-row">
          <div className="fe-find-field">
            <Search className="fe-find-field-icon" size={12} />
            <input
              ref={inputRef}
              type="text"
              value={search}
              placeholder={t('explorer.find.placeholder')}
              aria-label={t('explorer.find.placeholder')}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  if (e.shiftKey) findPrevious(view)
                  else findNext(view)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  close()
                }
              }}
            />
            <span className="fe-find-toggles">
              {toggle(caseSensitive, t('explorer.find.caseSensitive'), CaseSensitive, () =>
                setCaseSensitive((v) => !v)
              )}
              {toggle(wholeWord, t('explorer.find.wholeWord'), WholeWord, () =>
                setWholeWord((v) => !v)
              )}
              {toggle(regexp, t('explorer.find.regexp'), Regex, () => setRegexp((v) => !v))}
            </span>
          </div>
          <span className={`fe-find-count${countBad ? ' bad' : ''}`}>{countText}</span>
          <span className="fe-find-sep" />
          {action(t('explorer.find.prev'), ChevronUp, () => findPrevious(view))}
          {action(t('explorer.find.next'), ChevronDown, () => findNext(view))}
          {action(t('explorer.find.selectAll'), TextSelect, () => {
            selectMatches(view)
            view.focus()
          })}
          <span className="fe-find-sep" />
          {action(t('explorer.find.close'), X, close)}
        </div>
        {showReplace && !readOnly && (
          <div className="fe-find-row">
            <div className="fe-find-field">
              <Replace className="fe-find-field-icon" size={12} />
              <input
                type="text"
                value={replace}
                placeholder={t('explorer.find.replacePlaceholder')}
                aria-label={t('explorer.find.replacePlaceholder')}
                onChange={(e) => setReplace(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    if (e.shiftKey) replaceAll(view)
                    else replaceNext(view)
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    close()
                  }
                }}
              />
            </div>
            {action(t('explorer.find.replace'), Replace, () => replaceNext(view))}
            {action(t('explorer.find.replaceAll'), ReplaceAll, () => replaceAll(view))}
          </div>
        )}
      </div>
    </div>
  )
}
