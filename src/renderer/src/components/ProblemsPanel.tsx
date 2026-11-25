import { useMemo, useState } from 'react'
import { AlertTriangle, CircleX, Info, RefreshCw } from 'lucide-react'
import {
  filterDiagnostics,
  problemCounts,
  sortDiagnostics,
  type Diagnostic,
  type DiagnosticSeverity
} from '../../../core/problems/diagnostic'
import { relativeTo } from '../../../core/context/contextRef'
import { useI18n } from '../i18n/I18nProvider'
import { Select } from './Select'

/** Each severity's toggle wording, written out so every key stays findable in the source. */
const SEVERITY_KEY = {
  error: 'problems.severity.error',
  warning: 'problems.severity.warning',
  info: 'problems.severity.info'
} as const

const ICON: Record<DiagnosticSeverity, React.ReactNode> = {
  error: <CircleX size={13} className="problem-icon error" />,
  warning: <AlertTriangle size={13} className="problem-icon warning" />,
  info: <Info size={13} className="problem-icon info" />
}

/**
 * The Problems tab (spec W5): every problem the project's producers found (main/problems.ts; today what its Jobs'
 * completion checks and reviews found), filtered by severity and text, sorted as asked, each row opening its file at its
 * line. A problem whose file changed since it was found is marked, and one whose file is gone opens nothing.
 */
export function ProblemsPanel({
  projectRoot,
  problems,
  onOpen,
  onRefresh
}: {
  /** The explorer's project, or null with none open. */
  projectRoot: string | null
  /** The project's problems; null when they could not be read. */
  problems: Diagnostic[] | null
  onOpen: (path: string, line?: number) => void
  onRefresh: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [severities, setSeverities] = useState<ReadonlySet<DiagnosticSeverity>>(() => new Set(['error', 'warning', 'info']))
  const [text, setText] = useState('')
  const [sort, setSort] = useState<'severity' | 'file' | 'source'>('severity')
  const counts = problemCounts(problems ?? [])
  const rows = useMemo(() => sortDiagnostics(filterDiagnostics(problems ?? [], { severities, text }), sort), [problems, severities, text, sort])

  const toggle = (s: DiagnosticSeverity): void =>
    setSeverities((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })

  if (!projectRoot) return <div className="problems-panel"><p className="problems-note">{t('problems.noProject')}</p></div>

  const note =
    problems === null
      ? t('problems.unavailable')
      : problems.length === 0
        ? t('problems.empty')
        : rows.length === 0
          ? t('problems.filteredEmpty')
          : null

  return (
    <div className="problems-panel">
      <div className="problems-bar">
        {(['error', 'warning', 'info'] as const).map((s) => (
          <button
            key={s}
            type="button"
            className={`problems-toggle${severities.has(s) ? ' on' : ''}`}
            aria-pressed={severities.has(s)}
            onClick={() => toggle(s)}
          >
            {ICON[s]}
            {t(SEVERITY_KEY[s], { count: counts[s] })}
          </button>
        ))}
        <input
          type="text"
          className="problems-filter"
          placeholder={t('problems.filter')}
          aria-label={t('problems.filter')}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Select
          className="problems-sort"
          items={[
            { value: 'severity', label: t('problems.sort.severity') },
            { value: 'file', label: t('problems.sort.file') },
            { value: 'source', label: t('problems.sort.source') }
          ]}
          value={sort}
          onChange={(v) => setSort(v as typeof sort)}
          ariaLabel={t('problems.sort.severity')}
        />
        <button type="button" className="run-panel-btn" title={t('problems.refresh')} aria-label={t('problems.refresh')} onClick={onRefresh}>
          <RefreshCw size={12} />
        </button>
      </div>
      <p className="problems-scope">{t('problems.scope')}</p>
      {note !== null ? (
        <p className="problems-note">{note}</p>
      ) : (
        <ul className="problems-list">
          {rows.map((d) => {
            const openable = d.path !== undefined && d.stale !== 'missing'
            const where = d.path !== undefined ? `${relativeTo(projectRoot, d.path)}${d.line !== undefined ? `:${d.line}` : ''}` : null
            return (
              <li
                key={d.id}
                className={`problem-row${openable ? ' openable' : ''}${d.stale !== undefined ? ' stale' : ''}`}
                onClick={openable ? () => onOpen(d.path as string, d.line) : undefined}
                title={d.origin ? d.origin.task : undefined}
              >
                {ICON[d.severity]}
                <span className="problem-message">{d.message}</span>
                {where !== null && <span className="problem-where">{where}</span>}
                <span className="problem-source">{d.source.kind === 'review' ? t('problems.source.review') : d.source.label}</span>
                {d.stale !== undefined && (
                  <span className="problem-stale" title={t(d.stale === 'changed' ? 'problems.stale.changedHint' : 'problems.stale.missingHint')}>
                    {t(d.stale === 'changed' ? 'problems.stale.changed' : 'problems.stale.missing')}
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
