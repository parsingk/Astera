import { useEffect, useState } from 'react'
import type { JobRun, JobTask, OrchSnapshot, Provider, TaskStatus } from '../../../core/types'
import type { MessageKey, MessageParams } from '../../../core/i18n'
import { formatElapsed, formatRemaining } from '../../../core/orchestration/elapsed'
import { isStoppedWorker, runningCount } from '../../../core/orchestration/running'
import { schedRuleSummary } from '../../../core/scheduler/summary'
import { useI18n } from '../i18n/I18nProvider'
import { PauseIcon, PlayIcon, RunIcon, STATE_KEY, STATUS_COLOR, TaskGlyph, TaskIcon, TrashIcon } from './JobIcons'
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

/** 띠 한 칸의 색. **STATUS_COLOR 를 따르지 않는 셋**이 있다 — 띠는 "얼마나 갔나"를 말하는 자리라,
 *  아직 안 간 칸이 배경으로 남아야 채워진 칸이 읽힌다. 시작하지 않은 둘을 서로 구별하는 일은 아래
 *  한 줄의 글리프(빈 원과 점선 원)가 한다.
 *
 *  **멈춰 세워진 워커의 칸도 채우지 않는다.** 상태는 `dispatched` 로 남지만(멈추는 것이 Task 를
 *  건드리지 않는다) 그 색은 accent 이고, 그러면 예약을 세운 뒤에도 회차의 띠가 파랗게 남아 도는
 *  것처럼 읽힌다 — 실제로 그렇게 보고됐다. 이 띠가 묻는 것은 "이 일이 도착했는가" 이고 멈춘 일은
 *  도착하지 않았다. 글리프는 여전히 자기 색과 모양을 지킨다(TaskIcon 의 still 주석): 그쪽이 묻는
 *  것은 "지금 어떤 상태인가" 라는 다른 질문이다. */
const segColor = (task: JobTask): string =>
  task.status === 'pending' || task.status === 'ready' || isStoppedWorker(task)
    ? 'var(--line-soft)'
    : STATUS_COLOR[task.status]

/** provider 배지의 두 글자. 21px 칸에 이름은 들어가지 않고, 바로 아래 줄이 이미 전체 이름을 적는다 */
const PROVIDER_ABBR: Record<Provider, string> = { claude: 'CL', codex: 'CX' }

/** 아래 한 줄이 세는 상태와 그 순서. 도는 셋은 줄로 서 있고 blocked 는 Gate 줄이 펼쳐져 있으므로
 *  여기서 다시 세지 않는다 — 같은 Task 를 두 자리에 적으면 세로도 낭비하고 합도 맞지 않는다. */
const FOOT_STATES: readonly TaskStatus[] = ['completed', 'failed', 'ready', 'pending']

/** 도는 줄의 최대 개수. 워커 여섯이 동시에 돌면 한 Run 이 사이드바의 세로를 다 먹는다 —
 *  넷째부터는 개수로 접는다. */
const MAX_ROWS = 3

/** 한 번에 그리는 회차 개수. 2분마다 도는 예약은 하루에 720 회차를 만들고, 그것을 다 그리면 한
 *  템플릿이 사이드바를 통째로 먹는다 — 도는 줄이 MAX_ROWS 로 접는 것과 같은 이유다.
 *
 *  '더 보기' 는 이 수만큼씩 늘린다. 한 번에 전부 펼치지 않는 이유: 회차가 수백 개면 "전부" 는
 *  접기 전과 같은 상태이고, 사람이 찾는 것은 대개 최근 몇 개다(목록은 최신순이다). */
const ROUNDS_PAGE = 5

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

/** provider 뒤에 오는 문구. **리셋을 기다리는 중이면 경과 대신 이것을 적는다** — `startedAt` 이
 *  있어도 그 경과는 지금 벌어지는 일(한도에 걸려 멈춰 있다)을 말해 주지 않는다. `waiting`·`resumes`
 *  는 서로 다른 이력 항목에서 오므로(view.ts 의 jobTaskOf) 함께 올 수 있다 — 두 번 이어진 뒤에 다시
 *  대기 중일 수 있고, 그때는 재개 횟수를 뒤에 이어 붙인다.
 *
 *  **계정을 바꾸는 정지는 일부러 그리지 않는다.** `waiting` 은 그쪽에서도 채워지지만
 *  (JobTask.waiting 의 주석) 그것은 기다리는 것이 아니고 리셋 시각도 없어서, 사유를 보지 않으면 이
 *  줄이 "리셋 대기" 로 읽힌다 — 보통 1초도 안 되는 전환에. 그 대신 아무 말도 하지 않는다: 줄은 이미
 *  provider 와 경과 시간을 적고 있고, 전환에 걸려 멈춘 것을 알리는 것은 **새로운 표시 상태**여서
 *  이 물결에서 정할 일이 아니다(전환이 실패해 그 항목이 끝내 닫히지 않는 갈래가 실제로 있다 —
 *  SPEC §21 의 알려진 한계).
 *
 *  **리셋 시각이 있어도 이미 지났으면 시각 없는 문구로 떨어진다** — formatRemaining 이 그 경계를
 *  undefined 로 답한다(elapsed.ts). 지난 시각을 "앞으로 남았다"로 그리는 것이 시각을 안 그리는
 *  것보다 나쁘다는 판단은 재개 브리핑과 같다. */
function taskMeta(
  task: RunningTask,
  nowMs: number,
  t: (key: MessageKey, params?: MessageParams) => string
): string {
  const wait = task.waiting?.reason === 'waiting' ? task.waiting : undefined
  const left = wait?.resetsAt !== undefined ? formatRemaining(wait.resetsAt, nowMs) : undefined
  const base = wait
    ? left !== undefined
      ? t('jobs.task.waitingReset', { left })
      : t('jobs.task.waitingNoTime')
    : formatElapsed(task.startedAt, nowMs)
  return task.resumes ? `${base} · ${t('jobs.task.resumedCount', { n: task.resumes })}` : base
}

/** Run 하나의 카드 — 머리말·띠·도는 줄·Gate 줄·아래 한 줄. **JobsView 에서 뽑아낸 것이고 그리는
 *  것이 달라지지 않았다.** 뽑은 이유는 예약 템플릿의 회차를 같은 모양으로 그려야 해서다: 한 벌을
 *  두 자리에서 쓰지 않으면 두 벌이 갈라진다. */
function RunCard({
  run,
  open,
  onToggle,
  ordinal,
  nowMs,
  canOpenSession,
  onOpenSession,
  onOpenRun,
  onDeleteRun
}: {
  run: JobRun
  open: boolean
  onToggle: () => void
  /** 예약 회차라면 그 번호. 평범한 Run 에는 없다 */
  ordinal?: number
  nowMs: number
  canOpenSession: (sessionId: string) => boolean
  onOpenSession: (sessionId: string) => void
  onOpenRun: (runId: string) => void
  onDeleteRun: (runId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
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
      <div className="jobs-run-head" onClick={() => onToggle()}>
        <span className="jobs-caret">{open ? '▾' : '▸'}</span>
        {/* 예약 회차의 번호. 한 템플릿의 회차들은 목표가 같아서(spawnScheduledRun 이 복사한다)
            제목만으로는 서로 구별되지 않는다 — 이 칩이 그것을 구별하는 유일한 표시다.
            평범한 Run 은 이 프롭을 받지 않으므로 그대로다. */}
        {ordinal !== undefined && (
          <span className="jobs-ordinal">{t('jobs.run.scheduleOrdinal', { n: ordinal })}</span>
        )}
        <span className={`jobs-objective${kind === 'done' ? ' done' : ''}`} title={run.objective}>
          {run.objective}
        </span>
        {/* 이 Run 의 워커가 프로젝트 폴더를 다른 Run 과 나눠 쓰고 있다. **막힌 것이 아니라
            얽힌 것**이라 Gate 글리프(주황 `!`)를 빌리지 않는다 — 그것은 사람을 기다리는
            자리의 모양이고, 여기서는 기다리는 것이 없다. 경고 톤의 테두리(styles.css)와 이
            글자 하나로 말하고, 무엇이 위험한지는 툴팁이 적는다. */}
        {/* 아직 실행을 누르지 않은 Run. **이 표시가 없으면 조용히 안 도는 Run 이 된다** — 상세
            창을 닫고 실행을 잊으면 목록에서는 갓 만든 Run 과 구별되지 않고, "이유 없이 안 도는
            Task" 가 이 화면이 없애려는 바로 그 증상이다. 경고가 아니라 상태이므로 톤은 중립이다
            (.jobs-ordinal 과 같은 칩). */}
        {run.pendingStart && (
          <span className="jobs-ordinal" title={t('jobs.run.notStartedHint')}>
            {t('jobs.run.notStarted')}
          </span>
        )}
        {/* 세워 둔 회차. **이 표시가 없으면 멈춘 회차가 도는 회차처럼 읽힌다** — 상태는 dispatched 로
            남고(멈추는 것이 Task 를 건드리지 않는다) 글리프도 그 색을 지키므로, 말로 적어 주는 자리가
            여기뿐이다. 재개는 이 회차를 이어받지 않는다: 다음 예약 시각의 새 회차가 돈다. */}
        {run.paused && (
          <span className="jobs-ordinal" title={t('jobs.run.roundStoppedHint')}>
            {t('jobs.run.roundStopped')}
          </span>
        )}
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
            style={{ background: segColor(task) }}
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
                  <span className="jobs-task-meta" title={`${task.provider} · ${taskMeta(task, nowMs, t)}`}>
                    {task.provider} · {taskMeta(task, nowMs, t)}
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
          {/* 물러나게 하기. **자동 정리가 손대지 못하는 것을 위해 있다** — store.ts 의 TTL 은
              모든 Task 가 끝난 Run 만, 그것도 30일 뒤에 버리므로 중단한 작업이나 워커가 죽어
              dispatched 에 멈춘 Task 를 가진 Run 은 영원히 남는다.
              **제목 줄이 아니라 이 줄에 있다.** 되돌릴 수 없는 동작을 상세 창으로 가는 `›`
              바로 옆에 두면 둘 다 작은 표적이라 오클릭이 값비싸진다. 그리고 이 줄은 펼쳤을
              때만 보이므로 그 Run 을 열어 본 사람만 지우게 된다 — Gate 줄이 접혀도 남는 규칙과
              어긋나지 않는다: 그것은 알림이고 이것은 알림이 아니다.
              누르면 App 이 확인 창을 먼저 띄운다(onDeleteRun). 도는 워커가 있으면 명령이
              409 로 거절하고 그것을 토스트로 말한다 — 버튼을 감추지 않는 것은 왜 못 지우는지가
              화면에 남아야 하기 때문이다. */}
          <button
            className="jobs-delete"
            title={t('jobs.run.delete')}
            aria-label={t('jobs.run.delete')}
            onClick={() => onDeleteRun(run.id)}
          >
            <TrashIcon />
          </button>
        </div>
      )}
    </div>
  )
}

/** 다음 발화 시각. TerminalView 의 fmtDateTime 과 같은 형식이다 — 주는 값이 epoch ms 라
 *  (JobRun.nextFireAt) 그쪽처럼 ISO 를 받지 않는다. */
const fmtNext = (ms: number): string =>
  new Date(ms).toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })

/** 예약 템플릿의 카드 — 규칙과 다음 시각, 그리고 펼치면 회차 목록.
 *
 *  **RunCard 를 쓰지 않는다.** 템플릿은 돌지 않으므로 띠와 도는 줄과 진행률이 말할 것이 없고,
 *  무엇보다 outcome 을 빌릴 수 없다: outcomeOf 는 배치되지 않는 Task 를 terminal 로 보지 않아
 *  템플릿에 늘 'running' 을 준다 — 그것을 그리면 안 도는 것에 도는 점이 붙는다. 회차는 평범한
 *  Run 이므로 그 안에서 RunCard 를 그대로 쓴다. */
function ScheduleCard({
  run,
  open,
  onToggle,
  collapsed,
  onToggleChild,
  nowMs,
  canOpenSession,
  onOpenSession,
  onOpenRun,
  onPauseRun,
  onResumeRun,
  onDeleteRun
}: {
  run: JobRun
  open: boolean
  onToggle: () => void
  collapsed: Set<string>
  onToggleChild: (runId: string) => void
  nowMs: number
  canOpenSession: (sessionId: string) => boolean
  onOpenSession: (sessionId: string) => void
  onOpenRun: (runId: string) => void
  onPauseRun: (runId: string) => void
  onResumeRun: (runId: string) => void
  onDeleteRun: (runId: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const children = run.children ?? []
  /** 지금까지 펼친 회차 수. **접었다 펴도 유지된다** — 이 컴포넌트는 접힘에 언마운트되지 않으므로,
   *  더 보기를 누른 사람이 접기 한 번에 그 자리를 잃지 않는다. */
  const [shown, setShown] = useState(ROUNDS_PAGE)
  const rest = children.length - shown
  return (
    <div className={`jobs-run jobs-tmpl${open ? '' : ' collapsed'}`}>
      <div className="jobs-run-head" onClick={onToggle}>
        <span className="jobs-caret">{open ? '▾' : '▸'}</span>
        <span className="jobs-objective" title={run.objective}>
          {run.objective}
        </span>
        <span className="jobs-tmpl-badge" title={t('jobs.new.scheduleHint')}>
          {t('jobs.run.scheduled')}
        </span>
        {/* **멈추고 싶어지는 순간은 이 줄에서 온다** — 회차가 쌓이는 것도, 워커가 계정 한도를 먹는
            것도 여기서 보인다. 상세 창을 열어야 멈출 수 있다면 정확히 급한 순간에 마찰이 생긴다.
            휴지통이 이미 이 줄에 있으므로(그보다 파괴적이다) 밀도의 문제는 아니고, 오클릭은 확인
            창이 받는다. 회차 줄에는 두지 않는다: 회차는 읽기 전용 기록이고, 거기 두면 "이 회차만
            멈추나, 예약 전체가 멈추나" 가 모호해진다.
            stopPropagation: 이 줄 자체가 접기·펴기다 */}
        <button
          className="jobs-more"
          title={run.paused ? t('jobs.run.resumeHint') : t('jobs.run.pauseHint')}
          aria-label={run.paused ? t('jobs.run.resume') : t('jobs.run.pause')}
          onClick={(e) => {
            e.stopPropagation()
            if (run.paused) onResumeRun(run.id)
            else onPauseRun(run.id)
          }}
        >
          {run.paused ? <PlayIcon /> : <PauseIcon />}
        </button>
        {/* 상세 창으로 가는 입구 — 템플릿에서는 **Task 를 짜는 자리**다. 정의를 고치는 곳이
            여기뿐이라(회차는 읽기 전용 기록) 이 버튼이 회차보다 더 중요하다.
            stopPropagation: 이 줄 자체가 접기·펴기라서, 없으면 창을 열면서 동시에 접는다 */}
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
      <div className="jobs-tmpl-meta">
        <span>{schedRuleSummary(t, run.schedule)}</span>
        {/* **멈춘 것이 보여야 한다.** 일시 중지하면 무장하지 않으므로(firesDue) '다음 …' 줄이 그냥
            사라진다 — 그러면 멈춘 예약과 도는 예약이 화면에서 거의 같아 보이고, 멈춘 것을 잊은
            사람이 "왜 안 도는지" 를 찾게 된다. 한 번도 돌리지 않은 것도 같은 자리에 선다: 둘 다
            버튼을 눌러야 도는 상태이고, 아래 회차 목록의 문구가 그 둘을 이미 구별해 준다. */}
        {run.paused ? (
          <span className="jobs-tmpl-paused">{t('jobs.run.paused')}</span>
        ) : (
          run.nextFireAt !== undefined && (
            <span>{t('jobs.run.scheduleNext', { time: fmtNext(run.nextFireAt) })}</span>
          )
        )}
        {/* **children.length 가 아니라 fireCount 다.** 회차 기록은 사람이 지우고 30일 TTL 도
            지우므로, 개수로 적으면 이 숫자가 뒤로 간다 — 실제로 그렇게 보고됐다. 아래 회차 목록의
            길이는 "보관된 기록"이고 이 숫자는 "지금까지 몇 번 돌았나"로, 서로 다른 질문이다.
            fireCount 가 없는 것은 이 필드가 생기기 전의 템플릿이다 — 아직 한 번도 안 돈 것과 같이
            0 으로 읽는다(그 둘을 구별할 근거가 상태에 없다). */}
        <span>{t('jobs.run.scheduleRuns', { count: run.fireCount ?? 0 })}</span>
      </div>
      {open &&
        (children.length === 0 ? (
          <p className="jobs-tmpl-empty">
            {/* **아직 실행하지 않은 것과 시각을 기다리는 것을 가른다.** 둘 다 회차가 없지만 사람이
                할 일이 다르다 — 앞의 것은 버튼을 눌러야 하고, 뒤의 것은 기다리면 된다. 한 문구로
                덮으면 예약을 걸어 뒀다고 믿은 사람이 영원히 기다린다. */}
            {t(run.pendingStart ? 'jobs.run.schedulePending' : 'jobs.run.scheduleEmpty')}
          </p>
        ) : (
          <div className="jobs-tmpl-kids">
            {children.slice(0, shown).map((kid) => (
              <RunCard
                key={kid.id}
                run={kid}
                open={!collapsed.has(kid.id)}
                onToggle={() => onToggleChild(kid.id)}
                ordinal={kid.fireOrdinal}
                nowMs={nowMs}
                canOpenSession={canOpenSession}
                onOpenSession={onOpenSession}
                onOpenRun={onOpenRun}
                onDeleteRun={onDeleteRun}
              />
            ))}
            {/* **누르면 늘어나는 수를 그대로 적는다.** "+12개 더" 라고 쓰고 5개만 늘리면 그 줄이
                거짓말을 한다 — 남은 것이 5보다 적으면 그 수가 곧 늘어날 수다.
                stopPropagation: 이 줄은 템플릿 카드 안이고 그 카드는 클릭이 접기·펴기다 */}
            {rest > 0 && (
              <div
                className="jobs-tmpl-more"
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation()
                  setShown((n) => n + ROUNDS_PAGE)
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return
                  e.stopPropagation()
                  setShown((n) => n + ROUNDS_PAGE)
                }}
              >
                + {t('jobs.run.scheduleMore', { count: Math.min(ROUNDS_PAGE, rest) })}
              </div>
            )}
          </div>
        ))}
      {open && (
        <div className="jobs-foot">
          {/* 예약을 물러나게 하는 **유일한 문이다.** schedule 을 나중에 고치는 UI 는 없으므로
              (`run-update` 계열 명령이 없다) 바꾸려면 템플릿을 지우고 다시 만든다 — 그 "지우고"
              가 여기다. 그리고 TTL 정리는 템플릿을 절대 건드리지 않으므로(store.ts 의 조건이
              Task 가 하나도 없는 Run 과 안 끝난 Run 을 둘 다 남긴다) 이 버튼이 없으면 예약은
              지울 방법이 아예 없다.
              **회차도 함께 지워진다** — `run-delete` 가 템플릿 id 와 그 회차를 한 집합으로
              지운다(server.ts). App 의 확인 창이 그 숫자를 합해서 보여 준다.
              자리와 모양은 RunCard 의 그것과 같고 이유도 같다: 되돌릴 수 없는 동작을 상세 창으로
              가는 `›` 옆에 두면 둘 다 작은 표적이라 오클릭이 값비싸고, 펼쳤을 때만 보이므로 그
              예약을 열어 본 사람만 지우게 된다. */}
          <button
            className="jobs-delete"
            title={t('jobs.run.delete')}
            aria-label={t('jobs.run.delete')}
            onClick={() => onDeleteRun(run.id)}
          >
            <TrashIcon />
          </button>
        </div>
      )}
    </div>
  )
}

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
  onPauseRun,
  onResumeRun,
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
  /** 예약을 세운다·다시 돌린다. **App 이 들고 있다** — 상세 창의 같은 아이콘과 확인 문구·409 의
   *  갈래를 공유해야 하므로 이 뷰가 자기 사본을 갖지 않는다(onDeleteRun 과 같은 갈래다). */
  onPauseRun: (runId: string) => void
  onResumeRun: (runId: string) => void
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
  // waiting 도 센다 — 지금은 열린 Dispatch 만 대기 중이 되므로 늘 startedAt 과 함께 오지만
  // (view.ts 의 jobTaskOf), 카운트다운이 그 우연에 기대면 안 된다: startedAt 없이 waiting 만
  // 오는 날 이 조건이 그대로면 시계가 멈춘 채 남은 시간이 굳는다.
  const anyRunning =
    snapshot?.runs.some(
      (r) =>
        r.tasks.some((tk) => tk.startedAt || tk.waiting) ||
        (r.children ?? []).some((kid) => kid.tasks.some((tk) => tk.startedAt || tk.waiting))
    ) ?? false
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
      {snapshot.runs.map((run) =>
        run.schedule ? (
          <ScheduleCard
            key={run.id}
            run={run}
            open={!collapsed.has(run.id)}
            onToggle={() => toggle(run.id)}
            collapsed={collapsed}
            onToggleChild={toggle}
            nowMs={nowMs}
            canOpenSession={canOpenSession}
            onOpenSession={onOpenSession}
            onOpenRun={onOpenRun}
            onPauseRun={onPauseRun}
            onResumeRun={onResumeRun}
            onDeleteRun={onDeleteRun}
          />
        ) : (
          <RunCard
            key={run.id}
            run={run}
            open={!collapsed.has(run.id)}
            onToggle={() => toggle(run.id)}
            nowMs={nowMs}
            canOpenSession={canOpenSession}
            onOpenSession={onOpenSession}
            onOpenRun={onOpenRun}
            onDeleteRun={onDeleteRun}
          />
        )
      )}
    </section>
  )
}
