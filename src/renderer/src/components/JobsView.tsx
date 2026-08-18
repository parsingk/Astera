import { useState } from 'react'
import type { OrchSnapshot, TaskStatus } from '../../../core/types'
import { useI18n } from '../i18n/I18nProvider'

/** One dot colour per Task status. pending/ready reuse the muted text tones, dispatched is the app's
 *  one accent colour (the active marker everywhere else — the rail's .on state, focus rings), and the
 *  three outcomes reuse the git-status palette (ok/attention/danger) rather than inventing new colours
 *  for the same three meanings. */
const STATUS_DOT: Record<TaskStatus, string> = {
  pending: 'var(--text-faint)',
  ready: 'var(--text-dim)',
  dispatched: 'var(--accent)',
  // 검증 중 — 도는 중(accent)과도, 끝난 셋과도 달라야 한다. git 의 '수정됨' 톤을 빌린다:
  // 이 앱에서 이미 "아직 정해지지 않았다"를 뜻하는 색이다.
  validating: 'var(--git-modified)',
  completed: 'var(--ok)',
  failed: 'var(--git-deleted)',
  blocked: 'var(--git-conflict)'
}

/** Read-only Jobs sidebar — the orchestration Runs and Tasks of the open project.
 *
 *  snapshot is the already-folded OrchSnapshot from window.api.orch.list / the 'orch:state' push
 *  (src/main/ipc.ts, src/core/orchestration/view.ts). Every judgement — which Runs belong to this
 *  project, task ordering, whether a sessionId still names a session this app process knows about,
 *  which open Gate's question to show — was made there. This component only draws what it is handed;
 *  it has no test of its own because the renderer has no jsdom (vitest runs environment: 'node'). */
export function JobsView({
  snapshot,
  canOpenSession,
  onOpenSession,
  onOpenTimeline
}: {
  snapshot: OrchSnapshot | null
  /** Whether this window still has a tab for that session — the second half of "is this row
   *  clickable", and the half main cannot answer. JobTask.sessionId means main's SessionManager still
   *  has the session record, which is deliberately not the same set as the open tabs (see App). A row
   *  that fails this draws exactly like a Task that was never dispatched. */
  canOpenSession: (sessionId: string) => boolean
  /** Focus the tab that owns this session. The Jobs view creates no surface of its own — the worker
   *  sessions already arrive as tabs and Dispatch carries the id that ties a Task to one. */
  onOpenSession: (sessionId: string) => void
  /** Open the history modal for that Run. The Run's events are fetched on demand (orch.timeline), so
   *  this view only names the Run — App owns both the request and the modal. */
  onOpenTimeline: (runId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  // Runs the user collapsed. Absence means expanded — a Run that just appeared, or one from before this
  // component ever rendered, opens by default rather than needing to be found and expanded by hand.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (runId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(runId)) next.delete(runId)
      else next.add(runId)
      return next
    })
  }

  // Before the first orch.list response — nothing is known yet, so nothing is drawn (not even the
  // empty state, which would otherwise flash "no jobs" for a frame on every project switch).
  if (snapshot === null) return <></>

  if (snapshot.runs.length === 0) {
    return (
      <div className="jobs-empty">
        <p>{t('jobs.empty')}</p>
        <p className="jobs-empty-hint">{t('jobs.empty.hint')}</p>
      </div>
    )
  }

  return (
    <section className="jobs-view">
      {snapshot.runs.map((run) => {
        const open = !collapsed.has(run.id)
        return (
          <div key={run.id} className="jobs-run">
            <div className="jobs-row jobs-run-header" onClick={() => toggle(run.id)}>
              <span className="jobs-caret">{open ? '▾' : '▸'}</span>
              <span className="jobs-objective" title={run.objective}>
                {run.objective}
              </span>
              <span className="jobs-progress">
                {t('jobs.progress', { done: run.done, total: run.total })}
                {run.outcome === 'completed' ? ` ${t('jobs.completed')}` : ''}
                {run.outcome === 'failed' ? ` ${t('jobs.failed')}` : ''}
              </span>
              <button
                className="jobs-timeline-btn"
                title={t('jobs.timeline.open')}
                aria-label={t('jobs.timeline.open')}
                onClick={(e) => {
                  // The header's own click collapses the Run. Without this the button would do both,
                  // so opening the history would fold the Run shut behind the modal — the same reason
                  // .bottom-tab-close stops the event before its tab strip sees it.
                  e.stopPropagation()
                  onOpenTimeline(run.id)
                }}
              >
                {/* 기록 — 시계. 앱의 SVG 관례대로 16 viewBox 에 currentColor 하나 */}
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                     strokeWidth="1.4" strokeLinecap="round">
                  <circle cx="8" cy="8" r="5.6" />
                  <path d="M8 4.8V8l2.2 1.6" />
                </svg>
              </button>
            </div>
            {open && (
              <div className="jobs-tasks">
                {run.tasks.map((task) => {
                  // Both conditions or neither — the row's appearance and its click have to be
                  // decided by the same value, or it looks clickable and silently does nothing.
                  const sessionId =
                    task.sessionId && canOpenSession(task.sessionId) ? task.sessionId : undefined
                  return (
                    <div key={task.id}>
                      <div
                        className={`jobs-row jobs-task${sessionId ? '' : ' no-session'}`}
                        onClick={sessionId ? () => onOpenSession(sessionId) : undefined}
                      >
                        <span
                          className="jobs-status-dot"
                          style={{ background: STATUS_DOT[task.status] }}
                        />
                        <span className="jobs-task-title" title={task.title}>
                          {task.title}
                        </span>
                      </div>
                      {task.status === 'blocked' && task.gateQuestion && (
                        <div className="jobs-gate">
                          {task.gateQuestion}
                          {task.openGates > 1
                            ? ` ${t('jobs.gates.more', { count: task.openGates - 1 })}`
                            : ''}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
