// One file's diff as `git diff` printed it on the machine the Run lives on (remote runtime design Phase 10): numbered
// rows, added and removed lines coloured, a cut diff and a binary file said in words. Text only: nothing here opens or
// resolves a path.
import { useMemo, useState } from 'react'
import { DIFF_ROWS_STEP, diffLines } from '../lib/diffLines'
import { useI18n } from '../i18n/I18nProvider'

export function DiffView({ diff, truncated, binary }: { diff: string; truncated: boolean; binary: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const rows = useMemo(() => diffLines(diff), [diff])
  const [shown, setShown] = useState(DIFF_ROWS_STEP)
  return (
    <div className="diff-view">
      {binary && <p className="modal-hint">{t('jobs.changes.binaryDiff')}</p>}
      {truncated && <p className="modal-hint">{t('jobs.changes.truncated')}</p>}
      <table className="diff-table">
        <tbody>
          {rows.slice(0, shown).map((r, i) => (
            <tr key={i} className={`diff-row diff-${r.kind}`}>
              <td className="diff-no">{r.oldNo ?? ''}</td>
              <td className="diff-no">{r.newNo ?? ''}</td>
              <td className="diff-text">{r.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown && (
        <button type="button" className="detail-completion-head diff-more" onClick={() => setShown((n) => n + DIFF_ROWS_STEP)}>
          {t('jobs.changes.moreRows', { count: Math.min(DIFF_ROWS_STEP, rows.length - shown), left: rows.length - shown })}
        </button>
      )}
    </div>
  )
}
