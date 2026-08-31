import type { MessageKey } from '../../../core/i18n'
import type { OpenSessionTask } from '../../../core/types'
import type { ProjectUnderstanding, RecordStatus, WorkRecord } from '../../../core/understanding/types'
import { useI18n } from '../i18n/I18nProvider'
import { RECORD_GLYPH, RECORD_GLYPH_COLOR, StatusGlyph } from './UnderstandingIcons'

const dateOf = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** The same format HistoryBrowser/TerminalView already use — for a task still in progress, what
 *  time it started matters more than what date it is. */
const timeOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** A record whose write-up did not land offers to try again. `ready` has nothing to fix and
 *  `generating` is already running — pressing either would only spend a second round trip. */
const canRetry = (s: RecordStatus): boolean => s === 'failed' || s === 'needs-review'

const sourceLabel = (r: WorkRecord): string =>
  r.source.kind === 'session' ? r.source.label : r.source.jobName

/** Internal codes, not sentences — everything else in a `reason` field is already a free-form
 *  sentence (written by the agent, the validator, or the collector's INTERRUPTED_BY_* wiring) and
 *  belongs on screen unchanged. Shared between a record's row reason and an open task's interrupt
 *  reason — the two code sets never collide, and both want the exact same "translate the known ones,
 *  pass the rest through" rule. */
const REASON_KEY: Record<string, MessageKey> = {
  NO_GENERATOR_ACCOUNT: 'hiw.record.reason.noAccount',
  INTERRUPTED: 'hiw.record.reason.interrupted',
  CHECK_FAILED: 'hiw.record.reason.checkFailed',
  // A Job's own validation is the app's measurement, not something the agent claimed — a separate
  // code so the sentence attributes the check to the right party (pipeline.ts's `fill`).
  CHECK_FAILED_JOB: 'hiw.record.reason.checkFailedJob',
  INTERRUPTED_BY_NEW_TASK: 'hiw.open.reason.newTask',
  INTERRUPTED_BY_SESSION_END: 'hiw.open.reason.sessionEnd',
  INTERRUPTED_BY_APP_RESTART: 'hiw.open.reason.appRestart',
  INTERRUPTED_BY_TRACKING_OFF: 'hiw.open.reason.trackingOff',
  INTERRUPTED_BY_APP_UPGRADE: 'hiw.open.reason.upgrade'
}

const reasonText = (reason: string, t: (key: MessageKey) => string): string =>
  reason in REASON_KEY ? t(REASON_KEY[reason]) : reason

/** How It Works sidebar — what was done, newest first, with the open-task section above it for the
 *  work that has not become a record yet. */
export function UnderstandingView({
  understanding,
  selectedRecordId,
  onOpenRecord,
  onRegenerate,
  openTasks,
  onCompleteTask,
  onCancelTask
}: {
  understanding: ProjectUnderstanding | null
  selectedRecordId: string | null
  onOpenRecord: (recordId: string) => void
  onRegenerate: (recordId: string) => void
  openTasks: OpenSessionTask[]
  onCompleteTask: (id: string) => void
  onCancelTask: (id: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const records = understanding?.records ?? []

  // **The empty state must not win when there are open tasks but no records** — that is exactly the
  // state a person is in the first time they use this feature, and it would be a shame to greet them
  // with "nothing here yet" while their own in-flight task sits one field away, unread.
  if (records.length === 0 && openTasks.length === 0) {
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

  // Spec §11 draws two separate labelled sections rather than one heading that changes meaning —
  // an interrupted row must never read as "in progress". `openTasks` (listOpen, collector.ts) is
  // already newest-first, and filtering by status preserves that relative order, so neither list
  // needs its own sort.
  const active = openTasks.filter((u) => u.status === 'active')
  const interrupted = openTasks.filter((u) => u.status === 'interrupted')

  const openRow = (u: OpenSessionTask): React.JSX.Element => (
    <div key={u.id} className="hiw-row hiw-open-row">
      <span className="hiw-body">
        <span className="hiw-name">{u.objective}</span>
        {u.status === 'active' ? (
          <span className="hiw-meta">{t('hiw.open.startedAt', { time: timeOf(u.startedAt) })}</span>
        ) : (
          // A date the same way a finished record's row has one (dateOf(r.at) below) — spec §11's
          // sketch for this row.
          <span className="hiw-meta">{dateOf(u.endedAt ?? u.startedAt)}</span>
        )}
        {u.status !== 'active' && u.reason && (
          <span className="hiw-summary w">{reasonText(u.reason, t)}</span>
        )}
        <span className="hiw-open-actions">
          <button className="hiw-review" onClick={() => onCompleteTask(u.id)}>
            {t('hiw.open.complete')}
          </button>
          <button className="hiw-review" onClick={() => onCancelTask(u.id)}>
            {t('hiw.open.cancel')}
          </button>
        </span>
      </span>
    </div>
  )

  return (
    <div className="hiw-side">
      <div className="hiw-head">
        <b>{t('hiw.title')}</b>
      </div>
      {openTasks.length > 0 && (
        <div className="hiw-open">
          {active.length > 0 && (
            <>
              <p className="hiw-lab">{t('hiw.open.title')}</p>
              {active.map(openRow)}
            </>
          )}
          {interrupted.length > 0 && (
            <>
              <p className="hiw-lab">{t('hiw.open.interruptedTitle')}</p>
              {interrupted.map(openRow)}
            </>
          )}
        </div>
      )}
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
              {r.reason && <span className="hiw-summary w">{reasonText(r.reason, t)}</span>}
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
