import type { ProjectUnderstanding, RecordStatus, WorkRecord } from '../../../core/understanding/types'
import { useI18n } from '../i18n/I18nProvider'
import { RECORD_GLYPH, RECORD_GLYPH_COLOR, StatusGlyph } from './UnderstandingIcons'

const dateOf = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** A record whose write-up did not land offers to try again. `ready` has nothing to fix and
 *  `generating` is already running — pressing either would only spend a second round trip. */
const canRetry = (s: RecordStatus): boolean => s === 'failed' || s === 'needs-review'

const sourceLabel = (r: WorkRecord): string =>
  r.source.kind === 'session' ? r.source.label : r.source.jobName

/** How It Works sidebar — what was done, newest first. */
export function UnderstandingView({
  understanding,
  selectedRecordId,
  onOpenRecord,
  onRegenerate
}: {
  understanding: ProjectUnderstanding | null
  selectedRecordId: string | null
  onOpenRecord: (recordId: string) => void
  onRegenerate: (recordId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const records = understanding?.records ?? []

  if (records.length === 0) {
    return (
      <div className="hiw-side">
        <div className="hiw-head">
          <b>{t('hiw.title')}</b>
        </div>
        <div className="hiw-empty">
          <p>{t('hiw.empty.body')}</p>
          <p className="hiw-fine">{t('hiw.empty.readOnly')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="hiw-side">
      <div className="hiw-head">
        <b>{t('hiw.title')}</b>
      </div>
      <div className="hiw-list">
        {records.map((r) => (
          <div
            key={r.id}
            className={`hiw-row${r.id === selectedRecordId ? ' on' : ''}`}
            onClick={() => onOpenRecord(r.id)}
          >
            <span className="hiw-g" style={{ color: RECORD_GLYPH_COLOR[r.status] }} aria-hidden="true">
              <StatusGlyph glyph={RECORD_GLYPH[r.status]} spinning={r.status === 'generating'} />
            </span>
            <span className="hiw-body">
              <span className="hiw-name">{r.request}</span>
              <span className="hiw-meta">
                {dateOf(r.at)} · {sourceLabel(r)}
              </span>
              {/* The reason is the answer to "why would I press that button" — it belongs beside it */}
              {r.reason && <span className="hiw-summary w">{r.reason}</span>}
              {canRetry(r.status) && (
                <button
                  className="hiw-review"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRegenerate(r.id)
                  }}
                >
                  {t('hiw.record.regenerate')}
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
