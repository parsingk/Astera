import { useState } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, CircleSlash, CircleX, OctagonX } from 'lucide-react'
import type { MessageKey } from '../../../core/i18n'
import type { TestRunResult, TestStatus } from '../../../core/tests/model'
import { useI18n } from '../i18n/I18nProvider'
import { caseLocation, testTree, type TreeNode } from '../lib/testTree'
import { localTime } from './findingsText'

const ICON: Record<TestStatus, React.ReactNode> = {
  passed: <CircleCheck size={13} className="test-icon passed" />,
  failed: <CircleX size={13} className="test-icon failed" />,
  errored: <OctagonX size={13} className="test-icon failed" />,
  skipped: <CircleSlash size={13} className="test-icon skipped" />
}

/** Why a result could not be read, in the words the tab says (core/tests/read.ts ReportReason). */
const REASON_KEY: Record<string, MessageKey> = {
  missing: 'tests.reason.missing',
  unreadable: 'tests.reason.unreadable',
  malformed: 'tests.reason.malformed',
  'too-large': 'tests.reason.too-large',
  outside: 'tests.reason.outside',
  empty: 'tests.reason.empty'
}

const duration = (ms: number): string => (ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)

/**
 * The Tests tab (Phase 3 Part 2): the last result of each of the project's configurations that names a test report,
 * newest first, each with its counts, how long it took and when, and its tree of files, suites and cases. A case shows
 * its failure and opens at its place. Rerun runs the configuration again; rerun failures is offered while the result has
 * failures, and the app says when it could narrow less. A stale, stopped or unread result says so, and never reads as
 * passed.
 */
export function TestsPanel({
  results,
  onOpen,
  onRerun
}: {
  /** The project's results; undefined while they are asked for. */
  results: TestRunResult[] | undefined
  onOpen: (path: string, line?: number) => void
  onRerun: (configId: string, failuresOnly: boolean) => void
}): React.JSX.Element {
  const { t } = useI18n()
  /** The configurations whose tree is open, and the cases whose failure is open. */
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set())
  const toggle = (key: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  if (results === undefined) return <div className="tests-panel"><p className="problems-note">{t('tests.loading')}</p></div>
  if (results.length === 0) return <div className="tests-panel"><p className="problems-note">{t('tests.empty')}</p></div>

  const node = (r: TestRunResult, n: TreeNode, depth: number): React.ReactNode => {
    if (n.kind === 'case' && n.case) {
      const at = caseLocation(r, n.case)
      const shown = open.has(`${r.configId}|${n.key}`)
      return (
        <li key={n.key} className="tests-case" style={{ paddingLeft: depth * 14 }}>
          <div className="tests-row">
            {ICON[n.case.status]}
            {n.case.failure ? (
              <button type="button" className="tests-name link" aria-expanded={shown} onClick={() => toggle(`${r.configId}|${n.key}`)}>
                {n.label}
              </button>
            ) : (
              <span className="tests-name">{n.label}</span>
            )}
            {n.case.durationMs !== undefined && <span className="tests-time">{duration(n.case.durationMs)}</span>}
            {at !== null && (
              <button type="button" className="run-panel-btn tests-open" onClick={() => onOpen(at.path, at.line)}>
                {t('tests.open')}
              </button>
            )}
          </div>
          {shown && n.case.failure && <pre className="tests-failure">{n.case.failure.message || t('tests.noMessage')}</pre>}
        </li>
      )
    }
    return (
      <li key={n.key} className={`tests-group ${n.kind}`} style={{ paddingLeft: depth * 14 }}>
        <div className="tests-row">
          {ICON[n.counts.failed + n.counts.errored > 0 ? 'failed' : n.counts.passed > 0 ? 'passed' : 'skipped']}
          <span className="tests-name">{n.label}</span>
          <span className="tests-time">{t('tests.counts', { passed: n.counts.passed, failed: n.counts.failed + n.counts.errored, skipped: n.counts.skipped })}</span>
        </div>
        <ul className="tests-tree">{n.children?.map((c) => node(r, c, depth + 1))}</ul>
      </li>
    )
  }

  return (
    <div className="tests-panel">
      <ul className="tests-list">
        {results.map((r) => {
          const expanded = open.has(r.configId)
          // How long the run took (final review M9): its cases' own times add up to more when workers run in parallel
          const took = Date.parse(r.endedAt) - Date.parse(r.startedAt)
          return (
            <li key={r.configId} className="tests-config">
              <div className="tests-config-head">
                <button type="button" className="tests-config-toggle" aria-expanded={expanded} onClick={() => toggle(r.configId)}>
                  {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  {r.configName}
                </button>
                <span className="tests-counts">{t('tests.counts', { passed: r.counts.passed, failed: r.counts.failed + r.counts.errored, skipped: r.counts.skipped })}</span>
                {took > 0 && <span className="tests-time">{duration(took)}</span>}
                <span className="tests-time">{localTime(r.endedAt)}</span>
                <button type="button" className="problems-action" onClick={() => onRerun(r.configId, false)}>
                  {t('tests.rerun')}
                </button>
                {/* Only this run's own failures: a report an earlier run left, or one not read, offers none */}
                {!r.stale && r.outcome === 'failed' && r.counts.failed + r.counts.errored > 0 && (
                  <button type="button" className="problems-action" onClick={() => onRerun(r.configId, true)}>
                    {t('tests.rerunFailures')}
                  </button>
                )}
              </div>
              {r.stale && <p className="tests-note warn">{t('tests.stale')}</p>}
              {r.outcome === 'stopped' && <p className="tests-note warn">{t('tests.outcome.stopped')}</p>}
              {r.outcome === 'unknown' && !r.stale && (
                <p className="tests-note warn">{t('tests.outcome.unknown', { reason: t(REASON_KEY[r.reason ?? ''] ?? 'tests.reason.malformed') })}</p>
              )}
              {r.truncated && <p className="tests-note">{t('tests.truncated')}</p>}
              {expanded && <ul className="tests-tree">{testTree(r).map((n) => node(r, n, 0))}</ul>}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
