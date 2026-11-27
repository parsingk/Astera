// One file's diff as `git diff` printed it on the machine the Run lives on (remote runtime design Phase 10): numbered
// rows, added and removed lines coloured, a cut diff and a binary file said in words. Text only: nothing here opens or
// resolves a path.
//
// With the agent-aware review (Phase 3 Part 4): each review finding under the line it was made on, the ones found on
// another revision and the ones about the file above the rows, each with its state, its history and a fix button. Where
// each goes is the command's call (core/review/diffFindings.ts).
import { Fragment, useMemo, useState } from 'react'
import type { DiffFinding } from '../../../core/review/types'
import { DIFF_ROWS_STEP, diffLines } from '../lib/diffLines'
import { findingsByLine, shortSha } from '../lib/agentReview'
import { chipKeyOf, findingStateKey, findingWhoKey } from '../lib/findingStates'
import { useI18n } from '../i18n/I18nProvider'
import { localTime } from './findingsText'

/** One finding: its severity and words, its state, its history on demand, and a fix button while it is still open to one. */
function FindingItem({ f, label, onFix }: { f: DiffFinding; label?: string; onFix?: (f: DiffFinding) => void }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const chip = chipKeyOf(f.state, f.history)
  return (
    <div className={`diff-finding is-${f.state}`}>
      {label !== undefined && <span className="diff-finding-where">{label}</span>}
      <span className={`diff-finding-severity is-${f.severity}`}>{f.severity}</span>
      <span className="diff-finding-title">{f.title}</span>
      {chip !== null && <span className="diff-finding-state">{t(chip)}</span>}
      {f.history.length > 0 && (
        <button type="button" className="diff-finding-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t('agentReview.finding.history')}
        </button>
      )}
      {onFix !== undefined && f.state !== 'dismissed' && f.state !== 'verified' && (
        <button type="button" className="diff-finding-fix" onClick={() => onFix(f)}>
          {t('agentReview.finding.fix')}
        </button>
      )}
      {open && (
        <ul className="diff-finding-history">
          {[...f.history].reverse().map((c, i) => (
            <li key={i}>
              {t('problems.finding.change', {
                when: localTime(c.at),
                who: t(findingWhoKey(c.by)),
                from: c.from !== null ? t(findingStateKey(c.from)) : t('problems.finding.new'),
                to: t(findingStateKey(c.to))
              })}
              {c.revision !== undefined && <span className="diff-finding-revision">{t('agentReview.finding.revision', { sha: shortSha(c.revision) })}</span>}
              {c.note !== undefined && <span className="diff-finding-note">{c.note}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DiffView({
  diff,
  truncated,
  binary,
  onDraftRepair,
  findings,
  onFixFinding
}: {
  diff: string
  truncated: boolean
  binary: boolean
  /** A hunk header row's draft button (spec W4): a repair Job drafted from the hunk at that row. Absent: no buttons. */
  onDraftRepair?: (rowIndex: number) => void
  /** The file's review findings, placed (Phase 3 Part 4). Absent: none shown. */
  findings?: DiffFinding[]
  /** A finding's fix button: Part 1's repair request on its Task. Absent: no buttons. */
  onFixFinding?: (f: DiffFinding) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const rows = useMemo(() => diffLines(diff), [diff])
  const grouped = useMemo(() => findingsByLine(findings ?? []), [findings])
  const [shown, setShown] = useState(DIFF_ROWS_STEP)
  /** Findings under rows not shown yet (final review M10). */
  const below = rows.slice(shown).reduce((n, r) => n + (r.kind !== 'del' && r.newNo !== undefined ? (grouped.inline.get(r.newNo)?.length ?? 0) : 0), 0)
  return (
    <div className="diff-view">
      {binary && <p className="modal-hint">{t('jobs.changes.binaryDiff')}</p>}
      {truncated && <p className="modal-hint">{t('jobs.changes.truncated')}</p>}
      {(grouped.otherRevision.length > 0 || grouped.file.length > 0) && (
        <div className="diff-findings-above">
          {grouped.otherRevision.map((f) => (
            <FindingItem key={f.ref} f={f} label={t('agentReview.finding.otherRevision', { head: shortSha(f.head ?? null) })} onFix={onFixFinding} />
          ))}
          {grouped.file.map((f) => (
            <FindingItem key={f.ref} f={f} label={t('agentReview.finding.file')} onFix={onFixFinding} />
          ))}
        </div>
      )}
      <table className="diff-table">
        <tbody>
          {rows.slice(0, shown).map((r, i) => {
            const here = r.kind !== 'del' && r.newNo !== undefined ? grouped.inline.get(r.newNo) : undefined
            return (
              <Fragment key={i}>
                <tr className={`diff-row diff-${r.kind}`}>
                  <td className="diff-no">{r.oldNo ?? ''}</td>
                  <td className="diff-no">{r.newNo ?? ''}</td>
                  <td className="diff-text">
                    {r.text}
                    {r.kind === 'hunk' && onDraftRepair && (
                      <button type="button" className="diff-draft" onClick={() => onDraftRepair(i)}>
                        {t('context.diff.draft')}
                      </button>
                    )}
                  </td>
                </tr>
                {here !== undefined && (
                  <tr className="diff-finding-row">
                    <td colSpan={3}>
                      {here.map((f) => (
                        <FindingItem key={f.ref} f={f} onFix={onFixFinding} />
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
      {below > 0 && <p className="modal-hint">{t('agentReview.finding.below', { count: below })}</p>}
      {rows.length > shown && (
        <button type="button" className="detail-completion-head diff-more" onClick={() => setShown((n) => n + DIFF_ROWS_STEP)}>
          {t('jobs.changes.moreRows', { count: Math.min(DIFF_ROWS_STEP, rows.length - shown), left: rows.length - shown })}
        </button>
      )}
    </div>
  )
}
