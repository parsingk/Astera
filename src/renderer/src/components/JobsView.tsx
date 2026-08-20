import { useEffect, useState } from 'react'
import type { JobRun, JobTask, OrchSnapshot, Provider, TaskStatus } from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import { formatElapsed } from '../../../core/orchestration/elapsed'
import { runningCount } from '../../../core/orchestration/running'
import { useI18n } from '../i18n/I18nProvider'
import { RunIcon, STATE_KEY, STATUS_COLOR, TaskGlyph, TaskIcon } from './JobIcons'
import type { RunIconKind } from './JobIcons'

/** Run 헤더 글리프의 툴팁. 끝난·실패·막힘은 줄의 글리프와 같은 모양이고 같은 뜻이라 같은 문구를 쓴다.
 *
 *  **도는 중만 다르다.** 헤더의 채워진 점은 링이 아니고, 뜻도 "워커가 일하는 중"이 아니라 "이 Run 에
 *  도는 일이 있다"이다 — 그 안에서 도는 것은 워커일 수도, 검증일 수도, 검토일 수도 있다. 어느
 *  하나의 문구를 빌려 오면 검증만 도는 Run 이 "워커가 일하는 중"이라고 말한다. */
const RUN_KIND_KEY: Record<RunIconKind, MessageKey> = {
  running: 'jobs.run.running',
  blocked: 'jobs.state.blocked',
  done: 'jobs.state.completed',
  failed: 'jobs.state.failed'
}

/** 띠 한 칸의 색. 시작하지 않은 둘만 STATUS_COLOR 를 따르지 않는다 — 띠는 "얼마나 갔나"를 말하는
 *  자리라, 아직 안 간 칸이 배경으로 남아야 채워진 칸이 읽힌다. 그 둘을 서로 구별하는 일은 아래
 *  한 줄의 글리프(빈 원과 점선 원)가 한다. */
const segColor = (status: TaskStatus): string =>
  status === 'pending' || status === 'ready' ? 'var(--line-soft)' : STATUS_COLOR[status]

/** provider 배지의 두 글자. 21px 칸에 이름은 들어가지 않고, 바로 아래 줄이 이미 전체 이름을 적는다 */
const PROVIDER_ABBR: Record<Provider, string> = { claude: 'CL', codex: 'CX' }

/** 아래 한 줄이 세는 상태와 그 순서. 도는 셋은 줄로 서 있고 blocked 는 Gate 줄이 펼쳐져 있으므로
 *  여기서 다시 세지 않는다 — 같은 Task 를 두 자리에 적으면 세로도 낭비하고 합도 맞지 않는다. */
const FOOT_STATES: readonly TaskStatus[] = ['completed', 'failed', 'ready', 'pending']

/** 도는 줄의 최대 개수. 워커 여섯이 동시에 돌면 한 Run 이 사이드바의 세로를 다 먹는다 —
 *  넷째부터는 개수로 접는다. */
const MAX_ROWS = 3

/** Run 헤더의 한 글리프가 말하는 것.
 *
 *  blocked 가 가장 세다: 사람을 부르는 것이고, 그것을 놓치면 Run 이 거기서 선다. 그 아래는 Run 자신의
 *  outcome 이 정한다 — outcomeOf(view.ts)가 이미 "failed 가 completed 를 이긴다"와 "끝나지 않은
 *  Task 가 하나라도 있으면 running" 을 답해 두었다.
 *
 *  "도는 Task 가 있으면 running" 을 startedAt 으로 여기서 다시 계산하지 않는 이유: 아직 아무것도
 *  뜨지 않은 Run(모든 Task 가 pending)에는 도는 것도 실패한 것도 없어서 done 으로 떨어지고, 시작도
 *  하지 않은 Run 에 체크 표시가 붙는다. */
function runKind(run: JobRun): RunIconKind {
  if (run.tasks.some((t) => t.status === 'blocked')) return 'blocked'
  if (run.outcome === 'running') return 'running'
  return run.outcome === 'failed' ? 'failed' : 'done'
}

/** 지금 도는 Task — 열린 Dispatch 가 있는 것들(view.ts 의 jobTaskOf 가 그때만 이 둘을 넣는다).
 *  술어로 좁히는 이유는 타입이다: 둘은 항상 함께 오지만 JobTask 는 각각을 optional 로 적고 있어서,
 *  filter 만으로는 아래에서 startedAt 과 provider 를 다시 검사해야 한다. */
type RunningTask = JobTask & { provider: Provider; startedAt: string }
const isRunning = (t: JobTask): t is RunningTask =>
  t.provider !== undefined && t.startedAt !== undefined

/** Read-only Jobs sidebar — the orchestration Runs and Tasks of the open project.
 *
 *  상태를 말로 적지 않는다: **움직임이 "일하는 중"을, 색이 "어떤 일"을** 말한다(JobIcons.tsx).
 *  Run 하나는 띠 하나로 다 말하고, 줄로 서는 것은 지금 도는 Task 뿐이다 — 끝난 것과 시작 전인 것은
 *  아래 한 줄의 아이콘·숫자로 접힌다. Gate 만 예외로 펼친다: 사람을 부르는 것이라 접으면 놓친다.
 *
 *  snapshot is the already-folded OrchSnapshot from window.api.orch.list / the 'orch:state' push
 *  (src/main/ipc.ts, src/core/orchestration/view.ts). Every judgement — which Runs belong to this
 *  project, task ordering, whether a sessionId still names a session this app process knows about,
 *  which open Gate's question to show — was made there. This component only draws what it is handed;
 *  it has no test of its own because the renderer has no jsdom (vitest runs environment: 'node'). */
export function JobsView({
  snapshot,
  hasProject,
  canOpenSession,
  onOpenSession,
  onOpenRun,
  onNewRun,
  onDeleteRun
}: {
  snapshot: OrchSnapshot | null
  /** Whether the caller currently has a project open. snapshot alone cannot answer that — with no
   *  project App.tsx deliberately still hands this component `{ runs: [] }` rather than null (its
   *  own comment: null would leave an unexplained blank sidebar for as long as the view stays open,
   *  where the empty state at least says something). That means the no-project case and a real
   *  project with zero Runs render the exact same snapshot shape, so the empty state's "+ 새 작업"
   *  button needs a signal snapshot cannot carry — this prop, from the one caller that knows
   *  (App's currentProject). Without it the button opens NewRunModal's flag with no project to hand
   *  it (App.tsx gates the modal itself on currentProject), and that leftover flag joins
   *  modalOpenRef and kills every global shortcut with no visible modal to explain why. */
  hasProject: boolean
  /** Whether this window still has a tab for that session — the second half of "is this row
   *  clickable", and the half main cannot answer. JobTask.sessionId means main's SessionManager still
   *  has the session record, which is deliberately not the same set as the open tabs (see App). A row
   *  that fails this draws exactly like a Task that was never dispatched. */
  canOpenSession: (sessionId: string) => boolean
  /** Focus the tab that owns this session. The Jobs view creates no surface of its own — the worker
   *  sessions already arrive as tabs and Dispatch carries the id that ties a Task to one. */
  onOpenSession: (sessionId: string) => void
  /** Open the Run detail window. Its graph and events are fetched on demand (orch.runDetail), so this
   *  view only names the Run — App owns both the request and the window. */
  onOpenRun: (runId: string) => void
  /** Opens NewRunModal. This view creates no Run itself — App owns the modal and the project path it
   *  needs, the same split as onOpenRun/onOpenSession above. */
  onNewRun: () => void
  /** 이 Run 을 물러나게 한다(`run-delete`). **되돌릴 수 없다** — 확인은 이 뷰가 받고(지워지는 것을
   *  세어 보여 준다) 명령은 App 이 보낸다, onOpenRun 과 같은 갈래다. */
  onDeleteRun: (runId: string) => void
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

  // 도는 것이 없으면 타이머도 없다 — 아무것도 안 변하는 화면을 1초마다 다시 그릴 이유가 없다.
  // 조건을 스냅샷에서 뽑는 덕분에 마지막 워커가 끝나면 다음 푸시에서 저절로 꺼진다.
  const anyRunning = snapshot?.runs.some((r) => r.tasks.some((tk) => tk.startedAt)) ?? false
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!anyRunning) return
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [anyRunning])

  // Before the first orch.list response — nothing is known yet, so nothing is drawn (not even the
  // empty state, which would otherwise flash "no jobs" for a frame on every project switch).
  if (snapshot === null) return <></>

  if (snapshot.runs.length === 0) {
    // **프로젝트가 없을 때와 있을 때가 다른 화면이다.** 이 빈 상태는 둘 다에서 그려진다(App.tsx 가
    // 프로젝트 없을 때 일부러 `{ runs: [] }` 를 넣는다 — 빈 사이드바보다 낫다는 판단). 그런데
    // '+ 새 작업' 버튼은 프로젝트가 없으면 그릴 수 없다(아래 가드): 그때 두 문구를 그대로 두면
    // "여기서 바로 만들 수 있습니다" 가 버튼 없이 남아 **화면이 거짓말을 한다.** 그래서 문구도
    // 함께 갈라, 무엇을 하면 되는지 그 자리에서 말한다.
    return (
      <div className="jobs-empty">
        <p>{hasProject ? t('jobs.empty') : t('jobs.noProject')}</p>
        <p className="jobs-empty-hint">
          {hasProject ? t('jobs.empty.hint') : t('jobs.noProject.hint')}
        </p>
        {/* 아무것도 없을 때가 만들고 싶을 때다 — 목록이 생긴 뒤의 자리(아래)와 같은 버튼.
            hasProject 로 가드하는 이유는 위 hasProject 의 주석대로다: 그때 이 버튼을 누르면
            만들 자리도 없는 newRunOpen 이 true 로 남아 전역 단축키를 죽인다. */}
        {hasProject && (
          <button className="jobs-new" onClick={onNewRun}>
            + {t('jobs.new.open')}
          </button>
        )}
      </div>
    )
  }

  return (
    <section className="jobs-view">
      {/* 목록 위, 첫 자식 — 아이콘을 새로 만들지 않는다: '+' 글자로 충분하다 */}
      <button className="jobs-new" onClick={onNewRun}>
        + {t('jobs.new.open')}
      </button>
      {snapshot.runs.map((run) => {
        const open = !collapsed.has(run.id)
        const kind = runKind(run)
        // 줄은 열린 Dispatch 기반이다 — 줄에는 provider 배지와 경과 시간이 있고 둘 다 열린
        // Dispatch 에서만 온다. 숫자는 그것과 다른 질문이라 core 의 runningCount 가 답한다
        // (running.ts — 상태와 열린 Dispatch 중 어느 하나로도 답이 안 되는 이유가 거기 있다).
        const rows = run.tasks.filter(isRunning).slice(0, MAX_ROWS)
        const running = runningCount(run.tasks)
        // 줄을 세우지 못한 것도 여기 접힌다 — 넷째부터 넘친 것뿐 아니라, validating 처럼 애초에 줄로
        // 세울 수 없는 것도 folded 로만 나타난다.
        const folded = running - rows.length
        const gates = run.tasks.filter((tk) => tk.status === 'blocked' && tk.gate)
        const counts = FOOT_STATES.map(
          (status) => [status, run.tasks.filter((tk) => tk.status === status).length] as const
        ).filter(([, n]) => n > 0)
        return (
          <div
            key={run.id}
            className={`jobs-run${open ? '' : ' collapsed'}${run.sharesProjectFolder ? ' shared-folder' : ''}`}
          >
            <div className="jobs-run-head" onClick={() => toggle(run.id)}>
              <span className="jobs-caret">{open ? '▾' : '▸'}</span>
              <span className={`jobs-objective${kind === 'done' ? ' done' : ''}`} title={run.objective}>
                {run.objective}
              </span>
              {/* 이 Run 의 워커가 프로젝트 폴더를 다른 Run 과 나눠 쓰고 있다. **막힌 것이 아니라
                  얽힌 것**이라 Gate 글리프(주황 `!`)를 빌리지 않는다 — 그것은 사람을 기다리는
                  자리의 모양이고, 여기서는 기다리는 것이 없다. 경고 톤의 테두리(styles.css)와 이
                  글자 하나로 말하고, 무엇이 위험한지는 툴팁이 적는다. */}
              {run.sharesProjectFolder && (
                <span className="jobs-shared" title={t('jobs.run.sharedFolderHint')}>
                  {t('jobs.run.sharedFolder')}
                </span>
              )}
              <span className="jobs-count">
                <RunIcon kind={kind} label={t(RUN_KIND_KEY[kind])} />
                {kind === 'running' && running > 0 ? <span>{running}</span> : null}
              </span>
              {/* 상세 창으로 가는 입구. **제목 줄에 있는 이유는 접기 때문이다** — 아래 한 줄은
                  접으면 사라지는데, 접기는 세로를 아끼는 장치이지 유일한 문을 잠그는 장치가 아니다
                  (같은 판단을 Gate 줄이 이미 하고 있다). 그리고 Run 이 쌓여 접어 두게 될 때가
                  상세 창이 가장 필요한 때다.
                  stopPropagation: 이 줄 자체가 접기·펴기라서, 없으면 창을 열면서 동시에 접는다 */}
              {/* 물러나게 하기. **자동 정리가 손대지 못하는 것을 위해 있다** — store.ts 의 TTL 은
                  모든 Task 가 끝난 Run 만, 그것도 30일 뒤에 버리므로 중단한 작업이나 워커가 죽어
                  dispatched 에 멈춘 Task 를 가진 Run 은 영원히 남는다.
                  `›` 옆인 이유: 이 줄이 그 Run 에 대해 할 수 있는 일이 모이는 자리다. 도는 워커가
                  있으면 명령이 409 로 거절하고(server.ts) App 이 그것을 토스트로 보여 준다 —
                  버튼을 지우지 않는 것은 왜 못 지우는지를 화면이 말해야 하기 때문이다.
                  stopPropagation: 이 줄 자체가 접기·펴기다 */}
              <button
                className="jobs-more jobs-delete"
                title={t('jobs.run.delete')}
                aria-label={t('jobs.run.delete')}
                onClick={(e) => {
                  e.stopPropagation()
                  onDeleteRun(run.id)
                }}
              >
                ✕
              </button>
              <button
                className="jobs-more"
                title={t('jobs.detail.open')}
                aria-label={t('jobs.detail.open')}
                onClick={(e) => {
                  e.stopPropagation()
                  onOpenRun(run.id)
                }}
              >
                ›
              </button>
            </div>
            {/* 띠 — Task 하나가 칸 하나다. **클릭 대상이 아니다**: 6px 은 정확히 누를 수 없고,
                누를 수 있어 보이면 누르고 아무 일도 없는 자리가 된다.
                **툴팁은 제목뿐이다.** 한때 상태 문구를 붙여 `제목 — 끝났다` 처럼 적었는데, 그
                문구들은 글리프를 처음 보는 사람에게 아이콘을 가르치려고 문장으로 쓴 것이라
                (`jobs.state.*`) 제목 뒤에 이어 붙으면 길고 어색하다. 이 칸이 답해야 하는 질문은
                "이게 어느 Task 인가" 하나이고, 어떤 일인지는 칸의 색이 말한다 — 이 화면의 규칙
                그대로다. 상태를 말로 읽어야 하는 자리에는 글리프가 자기 툴팁을 갖고 있다 */}
            <div className="jobs-bar">
              {run.tasks.map((task) => (
                <span
                  key={task.id}
                  className="jobs-seg"
                  style={{ background: segColor(task.status) }}
                  title={task.title}
                />
              ))}
            </div>
            {open && (rows.length > 0 || folded > 0) && (
              <div className="jobs-rows">
                {rows.map((task) => {
                  // Both conditions or neither — the row's appearance and its click have to be
                  // decided by the same value, or it looks clickable and silently does nothing.
                  const sessionId =
                    task.sessionId && canOpenSession(task.sessionId) ? task.sessionId : undefined
                  return (
                    <div
                      key={task.id}
                      className={`jobs-task jobs-task--${task.status}${sessionId ? '' : ' no-session'}`}
                      onClick={sessionId ? () => onOpenSession(sessionId) : undefined}
                    >
                      <span className="jobs-av">{PROVIDER_ABBR[task.provider]}</span>
                      <span className="jobs-task-body">
                        <span className="jobs-task-title" title={task.title}>
                          {task.title}
                        </span>
                        <span className="jobs-task-meta">
                          {task.provider} · {formatElapsed(task.startedAt, nowMs)}
                        </span>
                      </span>
                      <TaskGlyph task={task} />
                      {sessionId ? (
                        <span className="jobs-jump" aria-hidden="true">
                          ↗
                        </span>
                      ) : null}
                    </div>
                  )
                })}
                {/* 접힌 줄 — 넷째부터 넘친 것과, validating 처럼 열린 Dispatch 가 없어 애초에 줄을
                    세울 수 없는 것이 함께 접힌다. 글리프가 회전이 아니라 채워진 점인 이유는 Run
                    헤더와 같다 — 이 한 줄은 Task 여럿을 가리키고, 묶음은 돌지 않는다 */}
                {folded > 0 && (
                  <div className="jobs-task jobs-fold">
                    <RunIcon kind="running" />
                    <span>+{folded}</span>
                  </div>
                )}
              </div>
            )}
            {/* Gate 는 접힌 Run 에서도 남는다 — 사람을 기다리는 줄이고, 접혀서 안 보이면 그 Run 은
                아무도 모르는 채로 선다. 접기는 세로를 아끼는 장치이지 알림을 끄는 장치가 아니다 */}
            {gates.map((task) => (
              <div key={task.id} className="jobs-gate">
                <TaskIcon status="blocked" label={t(STATE_KEY.blocked)} />
                <span>
                  {task.gate?.question}
                  {task.openGates > 1
                    ? ` ${t('jobs.gates.more', { count: task.openGates - 1 })}`
                    : ''}
                </span>
              </div>
            ))}
            {open && (
              <div className="jobs-foot">
                {counts.map(([status, n]) => (
                  <span key={status} className="jobs-count">
                    <TaskIcon status={status} label={t(STATE_KEY[status])} />
                    <span>{n}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}
