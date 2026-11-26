import { Fragment, useMemo, useState } from 'react'
import { AlertTriangle, CircleX, EyeOff, Info, RefreshCw, Send, Wrench } from 'lucide-react'
import {
  filterDiagnostics,
  problemCounts,
  sortDiagnostics,
  type Diagnostic,
  type DiagnosticSeverity
} from '../../../core/problems/diagnostic'
import { relativeTo } from '../../../core/context/contextRef'
import { useI18n } from '../i18n/I18nProvider'
import { dismissGroups, findingChipKey, findingStateKey, findingWhoKey } from '../lib/findingStates'
import { localTime } from './findingsText'
import { Select } from './Select'

/** Each severity's toggle wording, written out so every key stays findable in the source. */
const SEVERITY_KEY = {
  error: 'problems.severity.error',
  warning: 'problems.severity.warning',
  info: 'problems.severity.info'
} as const

/** What was not checked and why (Phase 3 Part 3), written out so every key stays findable in the source. */
const UNCHECKED_KEY = {
  'not-installed': 'problems.unchecked.not-installed',
  room: 'problems.unchecked.room',
  crashed: 'problems.unchecked.crashed',
  refused: 'problems.unchecked.refused',
  'too-large': 'problems.unchecked.too-large'
} as const

const ICON: Record<DiagnosticSeverity, React.ReactNode> = {
  error: <CircleX size={13} className="problem-icon error" />,
  warning: <AlertTriangle size={13} className="problem-icon warning" />,
  info: <Info size={13} className="problem-icon info" />
}

/**
 * The Problems tab (spec W5): every problem the project's producers found (main/problems.ts; today what its Jobs'
 * completion checks and reviews found on this computer), filtered by severity and by the text a row shows, sorted as
 * asked, each row opening its file at its line, by click or by keyboard. A problem whose file changed since it was found
 * is marked; one whose file is gone, or whose name was not looked at (outside its folder, another machine), opens
 * nothing.
 *
 * With the Agent Context Bridge on (Phase 3 Part 1), rows are chosen with a checkbox and the bar sends them to an agent
 * session or has an agent fix them (`actions`, App.tsx); off, neither the checkboxes nor the buttons are there.
 */
export function ProblemsPanel({
  projectRoot,
  problems,
  onOpen,
  onRefresh,
  actions
}: {
  /** The explorer's project, or null with none open. */
  projectRoot: string | null
  /** The project's problems; null when they could not be read, undefined while they are not known yet. */
  problems: Diagnostic[] | null | undefined
  onOpen: (path: string, line?: number, column?: number) => void
  onRefresh: () => void
  /** What the bar does with the chosen rows; absent with the bridge off. */
  actions?: {
    send: (rows: Diagnostic[]) => void
    fix: (rows: Diagnostic[]) => void
    dismiss: (rows: Diagnostic[]) => void
    undismiss: (rows: Diagnostic[]) => void
  }
}): React.JSX.Element {
  const { t } = useI18n()
  const [severities, setSeverities] = useState<ReadonlySet<DiagnosticSeverity>>(() => new Set(['error', 'warning', 'info']))
  const [text, setText] = useState('')
  const [sort, setSort] = useState<'severity' | 'file' | 'source'>('severity')
  /** The chosen rows' ids; a row no longer listed falls out of `chosen` by itself. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  /** The rows whose finding history is open under them (Phase 3 Part 1b). */
  const [history, setHistory] = useState<ReadonlySet<string>>(() => new Set())
  const toggleHistory = (id: string): void =>
    setHistory((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const counts = problemCounts(problems ?? [])
  /** Who found it, in the words the row shows. */
  const sourceOf = (d: Diagnostic): string => (d.source.kind === 'review' ? t('problems.source.review') : d.source.label)
  /** Where it is, as the row shows it: relative to the project, or the name as written when it was not looked at. */
  const placeOf = (d: Diagnostic): string | null =>
    d.path !== undefined && projectRoot ? `${relativeTo(projectRoot, d.path)}${d.line !== undefined ? `:${d.line}` : ''}` : null
  /** A root as a note names it: relative to the project, or the project's own folder name. */
  const folderOf = (root: string | undefined): string =>
    (root !== undefined && projectRoot ? relativeTo(projectRoot, root) : '') || (projectRoot ?? '').split(/[\\/]/).filter(Boolean).at(-1) || ''
  /** What the row says. */
  const messageOf = (d: Diagnostic): string =>
    d.unchecked !== undefined
      ? t(UNCHECKED_KEY[d.unchecked], { server: d.source.label, folder: folderOf(d.root) })
      : d.unlisted !== undefined
        ? t('problems.unlisted', { count: d.unlisted })
        : d.message !== ''
          ? d.message
          : t('problems.checkFailed')
  const shown = (d: Diagnostic): string[] => [messageOf(d), placeOf(d) ?? d.unresolved ?? '', sourceOf(d)]
  const rows = useMemo(
    () => sortDiagnostics(filterDiagnostics(problems ?? [], { severities, text, shown }), sort, sourceOf),
    // shown and sourceOf read t and projectRoot, which these cover
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [problems, severities, text, sort, projectRoot, t]
  )

  const chosen = rows.filter((d) => selected.has(d.id))
  /** Every chosen row is dismissed: the button takes the dismissal back instead. */
  const allDismissed = chosen.length > 0 && chosen.every((d) => d.finding?.state === 'dismissed')
  const choose = (id: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  /** Hands the chosen rows on and clears the choice. */
  const act = (run: (rows: Diagnostic[]) => void): void => {
    run(chosen)
    setSelected(new Set())
  }

  const toggle = (s: DiagnosticSeverity): void =>
    setSeverities((prev) => {
      const next = new Set(prev)
      if (next.has(s)) next.delete(s)
      else next.add(s)
      return next
    })

  if (!projectRoot) return <div className="problems-panel"><p className="problems-note">{t('problems.noProject')}</p></div>

  const note =
    problems === undefined
      ? t('problems.loading')
      : problems === null
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
          ariaLabel={t('problems.sort')}
        />
        {actions !== undefined && (
          <>
            <button type="button" className="problems-action" disabled={chosen.length === 0} onClick={() => act(actions.send)}>
              <Send size={12} />
              {t('problems.send')}
            </button>
            <button type="button" className="problems-action" disabled={chosen.length === 0} onClick={() => act(actions.fix)}>
              <Wrench size={12} />
              {t('problems.fix')}
            </button>
            {/* Only a Task's findings are kept, so the button waits for rows that all are */}
            <button type="button" className="problems-action" disabled={dismissGroups(chosen) === null} onClick={() => act(allDismissed ? actions.undismiss : actions.dismiss)}>
              <EyeOff size={12} />
              {t(allDismissed ? 'problems.undismiss' : 'problems.dismiss')}
            </button>
          </>
        )}
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
            const where = placeOf(d)
            const chip = findingChipKey(d)
            return (
              <Fragment key={d.id}>
              <li
                className={`problem-row${openable ? ' openable' : ''}${d.stale !== undefined ? ' stale' : ''}${d.finding?.state === 'dismissed' ? ' dismissed' : ''}`}
                role={openable ? 'button' : undefined}
                tabIndex={openable ? 0 : undefined}
                onClick={openable ? () => onOpen(d.path as string, d.line, d.column) : undefined}
                onKeyDown={
                  openable
                    ? (e) => {
                        if (e.key !== 'Enter' && e.key !== ' ') return
                        e.preventDefault()
                        onOpen(d.path as string, d.line, d.column)
                      }
                    : undefined
                }
                title={d.origin ? d.origin.task : undefined}
              >
                {/* A note that something was not checked is not a finding to send or fix */}
                {actions !== undefined && d.unchecked === undefined && (
                  <input
                    type="checkbox"
                    className="problem-choose"
                    aria-label={t('problems.choose')}
                    checked={selected.has(d.id)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                    onChange={() => choose(d.id)}
                  />
                )}
                {ICON[d.severity]}
                <span className="problem-message">{messageOf(d)}</span>
                {where !== null && <span className="problem-where">{where}</span>}
                {d.unresolved !== undefined && (
                  <span className="problem-where unresolved" title={t('problems.unresolvedHint')}>
                    {d.unresolved}
                  </span>
                )}
                <span className="problem-source">{sourceOf(d)}</span>
                {d.stale !== undefined && (
                  <span className="problem-stale" title={t(d.stale === 'changed' ? 'problems.stale.changedHint' : 'problems.stale.missingHint')}>
                    {t(d.stale === 'changed' ? 'problems.stale.changed' : 'problems.stale.missing')}
                  </span>
                )}
                {/* Where a finding a person acted on stands (Phase 3 Part 1b); it opens the changes, not the file */}
                {chip !== null && d.finding !== undefined && (
                  <button
                    type="button"
                    className={`problem-finding ${d.finding.state}`}
                    aria-expanded={history.has(d.id)}
                    title={t('problems.finding.historyHint')}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleHistory(d.id)
                    }}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    {t(chip)}
                  </button>
                )}
              </li>
              {history.has(d.id) && d.finding !== undefined && (
                <li className="problem-history-row">
                  <ul className="problem-history">
                    {[...d.finding.history].reverse().map((c, i) => (
                      <li key={i}>
                        {t('problems.finding.change', {
                          when: localTime(c.at),
                          who: t(findingWhoKey(c.by)),
                          from: c.from !== null ? t(findingStateKey(c.from)) : t('problems.finding.new'),
                          to: t(findingStateKey(c.to))
                        })}
                        {c.note !== undefined && <span className="problem-history-note">{c.note}</span>}
                      </li>
                    ))}
                  </ul>
                </li>
              )}
              </Fragment>
            )
          })}
        </ul>
      )}
    </div>
  )
}
