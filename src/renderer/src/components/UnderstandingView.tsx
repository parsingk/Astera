import type { MessageKey } from '../../../core/i18n'
import type { OpenSessionTask } from '../../../core/types'
import type { ProjectUnderstanding, RecordStatus, WorkRecord } from '../../../core/understanding/types'
import { useI18n } from '../i18n/I18nProvider'
import { RECORD_GLYPH, RECORD_GLYPH_COLOR, StatusGlyph } from './UnderstandingIcons'

const dateOf = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** HistoryBrowser/TerminalView 이 이미 쓰는 같은 형식 — 진행 중인 작업은 날짜보다 몇 시에
 *  시작했는지가 궁금하다. */
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

  // "In progress" only fits while something really is — a section holding only interrupted tasks
  // says so instead.
  const anyActive = openTasks.some((u) => u.status === 'active')

  return (
    <div className="hiw-side">
      <div className="hiw-head">
        <b>{t('hiw.title')}</b>
      </div>
      {openTasks.length > 0 && (
        <div className="hiw-open">
          <p className="hiw-lab">{t(anyActive ? 'hiw.open.title' : 'hiw.open.interruptedTitle')}</p>
          {openTasks.map((u) => (
            <div key={u.id} className="hiw-row hiw-open-row">
              <span className="hiw-body">
                <span className="hiw-name">{u.objective}</span>
                {u.status === 'active' ? (
                  <span className="hiw-meta">{t('hiw.open.startedAt', { time: timeOf(u.startedAt) })}</span>
                ) : (
                  <span className="hiw-summary w">{u.reason ? reasonText(u.reason, t) : ''}</span>
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
          ))}
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
