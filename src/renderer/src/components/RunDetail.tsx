import { useState } from 'react'
import type {
  JobEvent,
  JobRun,
  JobTask,
  MessageType,
  RunDetail as RunDetailData,
  TaskStatus
} from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import type { GraphBox } from '../../../core/orchestration/graphLayout'
import { edgePath, layoutRows, NODE_H, NODE_W } from '../../../core/orchestration/graphLayout'
import { useI18n } from '../i18n/I18nProvider'
import { RUNNING_STATES, RunIcon, STATE_KEY, STATUS_COLOR, TaskIcon } from './JobIcons'

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

/** 사람을 부르는 메시지. 이 셋만 이벤트 표식으로 blocked 글리프(사람을 기다린다)를 빌린다 —
 *  나머지는 기록 한 줄일 뿐이다. */
const CALLS_FOR_A_PERSON: ReadonlySet<MessageType> = new Set<MessageType>([
  'question',
  'escalation',
  'decision_gate'
])

/** 헤더에서 따로 세는 다섯. 순서는 눈이 가야 하는 차례다 — 사람을 기다리는 것이 먼저다 */
const HEAD_STATES: readonly TaskStatus[] = ['blocked', 'completed', 'failed', 'ready', 'pending']

/** 노드 테두리의 색. 시작 전 둘과 끝난 것은 선을 세우지 않는다 — 안의 글리프가 이미 그 셋을 말하고
 *  있고, 그래프에서 눈이 가야 하는 것은 지금 도는 것과 손이 필요한 것이다. */
const borderOf = (status: TaskStatus): string =>
  status === 'pending' || status === 'ready' || status === 'completed'
    ? 'var(--line-soft)'
    : STATUS_COLOR[status]

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

/** 한 Run 의 상세 창 — 위가 의존 그래프, 아래가 이벤트다. 읽기 전용이다(Gate 를 답하는 것은
 *  Slack 제어면의 몫이다).
 *
 *  **그래프는 장식이 아니라 필터다.** 노드를 누르면 아래가 그 Task 의 이벤트만 남는다 — "왜 저게
 *  안 도나"(위)와 "저기서 무슨 일이 있었나"(아래)가 한 화면에서 이어지고, 이벤트가 수십 줄이 되는
 *  문제도 같이 풀린다(가려진 개수는 맨 아래에 적는다).
 *
 *  두 칸을 옆이 아니라 위아래로 두는 이유는 자라는 방향이다: 그래프는 한 층에 Task 가 늘수록
 *  **가로로** 자라고, 이벤트는 세로로 자란다. 옆에 세우면 그래프가 창의 절반도 못 쓰고 넷만 나란히
 *  서도 잘린다. 스크롤은 둘 다 자기 칸 안에서만 돈다(styles.css 의 min-height: 0).
 *
 *  이 컴포넌트에는 테스트가 없다(렌더러에 jsdom 이 없다). 그래서 판정은 전부 core 에 있고 —
 *  이벤트는 orchestration/timeline.ts, 층은 graph.ts, 노드의 좌표는 graphLayout.ts — 여기는 건네받은
 *  것을 그리기만 한다. */
export function RunDetail({
  run,
  detail,
  canOpenSession,
  onOpenSession,
  onClose
}: {
  /** 스냅샷에 있는 그 Run. 노드의 제목·상태·세션은 전부 여기서 온다(detail 은 id 만 준다).
   *  스냅샷과 detail 은 서로 다른 호출이라 어긋날 수 있으므로, 한쪽에만 있는 Task 는 그리지 않는다. */
  run: JobRun | undefined
  /** null 은 아직 도착하지 않았다는 뜻 — 빈 상태와 구분한다(JobsView 의 snapshot === null 과 같다) */
  detail: RunDetailData | null
  canOpenSession: (sessionId: string) => boolean
  onOpenSession: (sessionId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  /** 고른 노드 = 아래 이벤트의 필터. 같은 노드를 다시 누르면 풀린다 */
  const [selected, setSelected] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const keyOf = (e: JobEvent): string => `${e.kind}:${e.sourceId}`
  const toggle = (key: string): void =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const tasks = run?.tasks ?? []
  // 고른 Task 가 스냅샷에서 사라졌으면 필터도 없다 — 걸러 낸 목록이 영원히 비는 대신 전체를 그린다
  const selectedTask = tasks.find((tk) => tk.id === selected)
  const events = detail?.events ?? null
  const shown = selectedTask
    ? (events ?? []).filter((e) => e.taskId === selectedTask.id)
    : (events ?? [])
  const hidden = (events?.length ?? 0) - shown.length

  const running = tasks.filter((tk) => RUNNING_STATES.includes(tk.status)).length
  const counts = HEAD_STATES.map(
    (status) => [status, tasks.filter((tk) => tk.status === status).length] as const
  ).filter(([, n]) => n > 0)

  /** 이벤트 앞의 표식. **Task 상태의 글리프를 빌려 쓴다** — 사람을 부르는 사건은 사이드바에서
   *  blocked 인 Task 가 쓰는 바로 그 모양이다. 나머지는 중립적인 점이고, 워커가 뜬 것만 열린 고리로
   *  구별한다: 그 줄에서만 세션 탭으로 갈 수 있다. */
  const markOf = (e: JobEvent): React.JSX.Element => {
    const callsForAPerson =
      e.kind === 'gate-opened' ||
      (e.kind === 'message' && CALLS_FOR_A_PERSON.has(e.messageType ?? 'status'))
    if (callsForAPerson) return <TaskIcon status="blocked" label={t(STATE_KEY.blocked)} />
    if (e.kind === 'dispatch-started') return <span className="detail-ring" />
    return <span className="detail-dot" />
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal run-detail" onClick={(e) => e.stopPropagation()}>
        {/* 머리말이 없다 — Run 의 목표가 제목이고, 그 옆의 아이콘과 숫자가 상태를 말한다 */}
        <div className="detail-head">
          <h2 title={run?.objective}>{run?.objective ?? ''}</h2>
          {running > 0 && (
            <span className="jobs-count">
              <RunIcon kind="running" label={t('jobs.run.running')} />
              <span>{running}</span>
            </span>
          )}
          {counts.map(([status, n]) => (
            <span key={status} className="jobs-count">
              <TaskIcon status={status} label={t(STATE_KEY[status])} />
              <span>{n}</span>
            </span>
          ))}
        </div>
        {/* flex: 1; min-height: 0 이 styles.css 에 있다 — 없으면 아래의 두 칸이 줄지 않아 모달 밖으로
            넘치고 닫기 버튼이 밀려난다. 이 저장소가 실제로 그 결함을 냈던 자리다 */}
        <div className="detail-body">
          <div className="detail-graph">
            <Graph
              tasks={tasks}
              layers={detail?.layers ?? []}
              deps={detail?.deps ?? {}}
              cyclic={detail?.cyclic ?? []}
              selected={selectedTask?.id}
              onSelect={(id) => setSelected((prev) => (prev === id ? null : id))}
              canOpenSession={canOpenSession}
              onOpenSession={onOpenSession}
            />
          </div>
          <div className="detail-events">
            {selectedTask && (
              <div className="detail-filter">
                <TaskIcon status={selectedTask.status} label={t(STATE_KEY[selectedTask.status])} />
                <b>{selectedTask.title}</b>
                <button
                  className="detail-clear"
                  title={t('jobs.detail.clearFilter')}
                  aria-label={t('jobs.detail.clearFilter')}
                  onClick={() => setSelected(null)}
                >
                  ✕
                </button>
              </div>
            )}
            <div className="detail-list">
              {events !== null && shown.length === 0 && (
                <p className="modal-hint">{t('jobs.timeline.empty')}</p>
              )}
              {shown.map((e) => {
                const key = keyOf(e)
                const expanded = open.has(key)
                const sessionId = e.sessionId && canOpenSession(e.sessionId) ? e.sessionId : undefined
                // dispatch-started 의 요약은 provider 이름 그대로다(timeline.ts) — 배지가 이미 그것을
                // 적고 있으므로 아래 줄을 비운다
                const summary = e.kind === 'dispatch-started' ? '' : e.summary
                return (
                  <div key={key} className="detail-event">
                    <div
                      className={`detail-ev${e.body ? ' has-body' : ''}`}
                      onClick={e.body ? () => toggle(key) : undefined}
                    >
                      <span className="detail-at">{timeOf(e.at)}</span>
                      <span className="detail-mark">{markOf(e)}</span>
                      <div className="detail-ev-main">
                        <div className="detail-eh">
                          <b>
                            {e.kind === 'message'
                              ? t(MSG_LABEL[e.messageType ?? 'status'])
                              : t(KIND_LABEL[e.kind])}
                          </b>
                          {e.provider && <span className="detail-chip provider">{e.provider}</span>}
                          {e.retry && (
                            <span className="detail-chip retry">{t('jobs.timeline.retry')}</span>
                          )}
                          {e.review && (
                            <span className="detail-chip review">{t('jobs.event.review')}</span>
                          )}
                          {/* 결과가 실린 메시지에만 나온다. **이 줄이 워커가 실패를 보고했다는 사실의
                              유일한 기록이다** — applyWorkerDone 은 두 번째 메시지를 만들지 않고,
                              타임라인에는 Task 상태 변화 이벤트가 없다 */}
                          {e.outcome && (
                            <span className={`detail-outcome o-${e.outcome}`}>
                              {t(
                                e.outcome === 'succeeded'
                                  ? 'jobs.event.succeeded'
                                  : 'jobs.event.outcomeFailed'
                              )}
                            </span>
                          )}
                          {/* 어느 Task 의 일인가. 걸러 놓은 동안에는 위의 필터 줄이 이미 같은 말을
                              하고 있어서 적지 않는다 */}
                          {!selectedTask && e.taskTitle && (
                            <span className="detail-ev-task" title={e.taskTitle}>
                              {e.taskTitle}
                            </span>
                          )}
                          {sessionId && (
                            <button
                              className="detail-jump"
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
                        {summary && (
                          <div className="detail-summary" title={summary}>
                            {summary}
                          </div>
                        )}
                      </div>
                    </div>
                    {expanded && e.body && <pre className="detail-ev-body">{e.body}</pre>}
                  </div>
                )
              })}
            </div>
            {/* 가려진 개수. 이것이 없으면 걸러 놓은 화면과 이벤트가 원래 적은 Run 이 같아 보인다 */}
            {selectedTask && hidden > 0 && (
              <p className="detail-hidden">{t('jobs.detail.hidden', { count: hidden })}</p>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>{t('jobs.timeline.close')}</button>
        </div>
      </div>
    </div>
  )
}

/** 의존 그래프. 층 하나가 줄 하나이고, 같은 층은 나란히 선다.
 *
 *  **선의 색이 대기의 이유다** — 의존이 이미 `completed` 면 회색(풀린 의존), 아니면 청록(지금
 *  기다리는 중인 의존)이다. 그래서 "청록 선 둘이 한 노드로 모인다"가 곧 "저것은 둘을 기다린다"이다.
 *
 *  선은 `layers` 가 아니라 `deps` 로 긋는다 — 층은 자리만 정한다. 층 사이를 전부 이으면 있지도 않은
 *  의존이 청록으로 그려지고(같은 층의 노드들은 서로 무관하다), 그러면 위 문장이 거짓이 된다. */
function Graph({
  tasks,
  layers,
  deps,
  cyclic,
  selected,
  onSelect,
  canOpenSession,
  onOpenSession
}: {
  tasks: JobTask[]
  layers: string[][]
  deps: Record<string, string[]>
  cyclic: string[]
  selected: string | undefined
  onSelect: (taskId: string) => void
  canOpenSession: (sessionId: string) => boolean
  onOpenSession: (sessionId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const byId = new Map(tasks.map((tk) => [tk.id, tk]))
  // 스냅샷에 없는 id 는 버린다 — detail 과 스냅샷은 서로 다른 호출이라 한쪽이 한 박자 낡을 수 있고,
  // 그때 제목도 상태도 없는 빈 상자를 그리게 된다
  const pick = (ids: string[]): JobTask[] =>
    ids.map((id) => byId.get(id)).filter((tk): tk is JobTask => tk !== undefined)
  const rows = layers.map(pick).filter((r) => r.length > 0)
  const cycle = pick(cyclic)
  const layout = layoutRows(rows.map((r) => r.length))
  // 그려진 노드의 자리. 선은 이 표에 양쪽 끝이 다 있을 때만 그어진다 — 순환에 든 Task 를 가리키는
  // 의존은 끝점이 없고(그 묶음에는 자리가 없다), 그래서 저절로 빠진다
  const posOf = new Map<string, GraphBox>(
    rows.flatMap((row, i) => row.map((task, j) => [task.id, layout.rows[i][j]] as const))
  )

  const node = (task: JobTask, pos?: GraphBox): React.JSX.Element => {
    const sessionId = task.sessionId && canOpenSession(task.sessionId) ? task.sessionId : undefined
    return (
      <div
        key={task.id}
        className={`detail-node detail-node--${task.status}${selected === task.id ? ' on' : ''}`}
        style={{
          width: NODE_W,
          height: NODE_H,
          borderColor: borderOf(task.status),
          ...(pos ? { left: pos.x, top: pos.y } : {})
        }}
        onClick={() => onSelect(task.id)}
        title={task.title}
      >
        <TaskIcon status={task.status} label={t(STATE_KEY[task.status])} />
        <span className="detail-node-title">{task.title}</span>
        {/* 세션이 없으면 그리지 않는다 — 눌러도 아무 일이 없는 자리를 만들지 않기 위해서다.
            stopPropagation 이 필수다: 이 버튼은 필터를 여는 노드 위에 얹혀 있다 */}
        {sessionId && (
          <button
            className="detail-node-jump"
            title={t('jobs.timeline.openSession')}
            aria-label={t('jobs.timeline.openSession')}
            onClick={(ev) => {
              ev.stopPropagation()
              onOpenSession(sessionId)
            }}
          >
            ↗
          </button>
        )}
      </div>
    )
  }

  return (
    <>
      <div className="detail-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg className="detail-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {rows.flat().map((task) =>
            (deps[task.id] ?? []).map((depId) => {
              const from = posOf.get(depId)
              const to = posOf.get(task.id)
              if (!from || !to) return null
              return (
                <path
                  key={`${depId}:${task.id}`}
                  d={edgePath(from, to)}
                  fill="none"
                  strokeWidth="1.5"
                  stroke={
                    byId.get(depId)?.status === 'completed' ? 'var(--line-soft)' : 'var(--accent)'
                  }
                />
              )
            })
          )}
        </svg>
        {rows.map((row, i) => row.map((task, j) => node(task, layout.rows[i][j])))}
      </div>
      {/* 선이 하나도 없는 그래프에는 설명할 색도 없다 */}
      {rows.flat().some((task) => (deps[task.id] ?? []).some((d) => posOf.has(d))) && (
        <div className="detail-legend">
          <span>
            <i className="detail-line" style={{ borderTopColor: 'var(--accent)' }} />
            {t('jobs.detail.edgeWaiting')}
          </span>
          <span>
            <i className="detail-line" style={{ borderTopColor: 'var(--line-soft)' }} />
            {t('jobs.detail.edgeResolved')}
          </span>
        </div>
      )}
      {/* 순환. **서로 간 선을 긋지 않는다** — 그을 순서가 없다는 것이 바로 이 묶음이 여기 있는
          이유다. 명령으로는 만들 수 없고(createTask 가 없는 dep 을 거절하고 deps 를 바꾸는 명령이
          없다) 저장 파일이 손으로 고쳐졌을 때만 생기는데, 그래서 더더욱 이 화면 말고는 아무도
          말해 주지 않는다. 조용히 숨기지 않는 이유다 */}
      {cycle.length > 0 && (
        <div className="detail-cycle">
          <p className="detail-cycle-note">{t('jobs.detail.cycle')}</p>
          <div className="detail-cycle-nodes">{cycle.map((task) => node(task))}</div>
        </div>
      )}
    </>
  )
}
