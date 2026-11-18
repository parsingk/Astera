import { toSideBySide } from '../../lib/sideBySide'
import type { ResourceDiff } from '../../../../core/kube/types'
import { useI18n } from '../../i18n/I18nProvider'

/** The two columns of one resource: the cluster now, and what the operation leaves. */
export function SideBySideDiff({
  rows,
  afterLabel
}: {
  rows: ResourceDiff['rows']
  afterLabel: string
}): React.JSX.Element {
  const { t } = useI18n()
  if ('tooLarge' in rows) {
    return <div className="kube-diff-large">{t('kube.confirm.tooLarge', { added: rows.added, removed: rows.removed })}</div>
  }
  const side = toSideBySide(rows)
  return (
    <div className="kube-diff">
      <div className="kube-diff-head">
        <span>{t('kube.confirm.columnBefore')}</span>
        <span>{afterLabel}</span>
      </div>
      <div className="kube-diff-body">
        {side.map((r, i) => (
          <div className="kube-diff-row" key={i}>
            <span className={`kube-diff-cell ${r.left.kind}`}>
              <span className="kube-diff-no">{r.left.kind === 'empty' ? '' : r.left.no}</span>
              <span className="kube-diff-text">{r.left.text}</span>
            </span>
            <span className={`kube-diff-cell ${r.right.kind}`}>
              <span className="kube-diff-no">{r.right.kind === 'empty' ? '' : r.right.no}</span>
              <span className="kube-diff-text">{r.right.text}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
