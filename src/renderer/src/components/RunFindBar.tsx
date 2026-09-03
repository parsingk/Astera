import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

/** The find bar drawn inside a run's console (top-right, over the output). Plain text,
 *  case-insensitive — no regex or case toggles in this slice. Enter → next, Shift+Enter → previous,
 *  Esc → close. RunPanel owns the query and the results; this only draws them. */
export function RunFindBar({
  query,
  results,
  onQueryChange,
  onNext,
  onPrev,
  onClose
}: {
  query: string
  /** null until a search has run; total 0 means nothing matched */
  results: { index: number; total: number } | null
  onQueryChange: (q: string) => void
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const inputRef = useRef<HTMLInputElement>(null)
  // Opening the bar is a request to type — take the focus from the terminal
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])
  return (
    <div className="run-find" role="search">
      <Search size={13} className="run-find-icon" />
      <input
        ref={inputRef}
        className="run-find-input"
        type="text"
        value={query}
        placeholder={t('run.find.placeholder')}
        aria-label={t('run.find.placeholder')}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (e.shiftKey) onPrev()
            else onNext()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className={`run-find-count${results && results.total === 0 ? ' none' : ''}`}>
        {results === null
          ? ''
          : results.total === 0
            ? t('run.find.noResults')
            : t('run.find.count', { n: results.index, total: results.total })}
      </span>
      <button
        type="button"
        className="run-find-btn"
        title={t('run.find.prev')}
        aria-label={t('run.find.prev')}
        onClick={onPrev}
      >
        <ChevronUp size={12} />
      </button>
      <button
        type="button"
        className="run-find-btn"
        title={t('run.find.next')}
        aria-label={t('run.find.next')}
        onClick={onNext}
      >
        <ChevronDown size={12} />
      </button>
      <button
        type="button"
        className="run-find-btn"
        title={t('run.find.close')}
        aria-label={t('run.find.close')}
        onClick={onClose}
      >
        <X size={12} />
      </button>
    </div>
  )
}
