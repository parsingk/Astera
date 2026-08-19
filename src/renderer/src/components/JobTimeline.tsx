import { useState } from 'react'
import type { JobEvent, MessageType } from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'

/** 종류 배지의 문구. message 는 messageType 이 정한다.
 *  heartbeat 과 decision_gate 는 timeline.ts 의 SKIP 이 걸러 지금은 도달하지 않지만, 맵을
 *  온전하게 두면 그 규칙이 바뀌어도 문구가 없는 배지가 나오지 않는다. */
const MSG_LABEL: Record<MessageType, MessageKey> = {
  status: 'jobs.event.status',
  worker_done: 'jobs.event.workerDone',
  question: 'jobs.event.question',
  escalation: 'jobs.event.escalation',
  heartbeat: 'jobs.event.heartbeat',
  decision_gate: 'jobs.event.decisionGate'
}

const KIND_LABEL: Record<Exclude<JobEvent['kind'], 'message'>, MessageKey> = {
  'run-created': 'jobs.event.runCreated',
  'task-created': 'jobs.event.taskCreated',
  'dispatch-started': 'jobs.event.dispatchStarted',
  'gate-opened': 'jobs.event.gateOpened',
  'gate-resolved': 'jobs.event.gateResolved'
}

/** 시각의 표시 형태 — 날짜는 버리고 시:분:초만 남긴다. 한 Run 이 여러 날에 걸치는 경우가 드물고,
 *  좁은 칸에서 날짜는 전부 같은 값이라 자리만 먹는다.
 *
 *  **문자열을 자르지 않는다.** `JobEvent.at` 은 ISO-Z(UTC)이므로 `at.slice(11, 19)` 는 UTC 를
 *  그린다 — KST 사용자에게는 아홉 시간 이른 시각이고, 워커가 방금 한 일이 오늘 아침에 일어난 것처럼
 *  보인다. Date 로 파싱해 지역 시각으로 옮기는 것이 이 값의 유일한 올바른 표시다. 정렬은 core 의
 *  ISO 문자열이 하므로(timeline.ts) 표시를 바꾸는 것이 순서에 영향을 주지 않는다.
 *
 *  형식은 Intl 이 아니라 손으로 맞춘다 — 로케일마다 12시간제와 구분자가 달라지면 한 화면에서 눈으로
 *  순서를 따라가기 어렵고, 이 칸은 tabular-nums 로 자리를 맞춰 둔 고정폭 칸이다. */
const timeOf = (at: string): string => {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 한 Run 의 기록. 읽기 전용이다 — Gate 를 답하는 것은 Slack 제어면의 몫이다.
 *
 *  이 컴포넌트에는 테스트가 없다(렌더러에 jsdom 이 없다). 그래서 판정은 전부
 *  core/orchestration/timeline.ts 에 있고 여기는 건네받은 것을 그리기만 한다. */
export function JobTimeline({
  objective,
  events,
  canOpenSession,
  onOpenSession,
  onClose
}: {
  objective: string
  /** null 은 아직 도착하지 않았다는 뜻 — 빈 상태와 구분한다(JobsView 의 snapshot === null 과 같다) */
  events: JobEvent[] | null
  canOpenSession: (sessionId: string) => boolean
  onOpenSession: (sessionId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState<Set<string>>(new Set())
  const keyOf = (e: JobEvent): string => `${e.kind}:${e.sourceId}`
  const toggle = (key: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal job-timeline" onClick={(e) => e.stopPropagation()}>
        <h2>{t('jobs.timeline.title')}</h2>
        <p className="modal-hint">{objective}</p>
        <div className="timeline-list">
          {events !== null && events.length === 0 && (
            <p className="modal-hint">{t('jobs.timeline.empty')}</p>
          )}
          {(events ?? []).map((e) => {
            const key = keyOf(e)
            const expanded = open.has(key)
            const sessionId = e.sessionId && canOpenSession(e.sessionId) ? e.sessionId : undefined
            return (
              <div key={key} className="timeline-event">
                <div
                  className={`timeline-row${e.body ? ' has-body' : ''}`}
                  onClick={e.body ? () => toggle(key) : undefined}
                >
                  <span className="timeline-at">{timeOf(e.at)}</span>
                  <span className="timeline-kind">
                    {e.kind === 'message'
                      ? t(MSG_LABEL[e.messageType ?? 'status'])
                      : t(KIND_LABEL[e.kind])}
                    {/* 결과가 실린 메시지에만 나오는 표시. **이 줄이 워커가 실패를 보고했다는
                        사실의 유일한 기록이다** — applyWorkerDone 은 두 번째 메시지를 만들지 않고,
                        타임라인에는 Task 상태 변화 이벤트가 없다. 색은 JobsView 의 상태 점이 같은
                        세 뜻에 쓰는 팔레트를 그대로 빌린다. */}
                    {e.outcome && (
                      <span className={`timeline-outcome o-${e.outcome}`}>
                        {t(e.outcome === 'succeeded' ? 'jobs.event.succeeded' : 'jobs.event.outcomeFailed')}
                      </span>
                    )}
                  </span>
                  <span className="timeline-task" title={e.taskTitle}>
                    {e.taskTitle ?? ''}
                  </span>
                  <span className="timeline-summary" title={e.summary}>
                    {e.summary}
                    {e.retry && <span className="timeline-retry">{t('jobs.timeline.retry')}</span>}
                    {e.review && <span className="timeline-review">{t('jobs.event.review')}</span>}
                  </span>
                  {sessionId && (
                    <button
                      className="timeline-jump"
                      title={t('jobs.timeline.openSession')}
                      aria-label={t('jobs.timeline.openSession')}
                      onClick={(ev) => {
                        ev.stopPropagation() // 펼치기와 겹치지 않게 한다
                        onOpenSession(sessionId)
                      }}
                    >
                      ↗
                    </button>
                  )}
                </div>
                {expanded && e.body && <pre className="timeline-body">{e.body}</pre>}
              </div>
            )
          })}
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>{t('jobs.timeline.close')}</button>
        </div>
      </div>
    </div>
  )
}
