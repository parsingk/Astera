import type { JobTask, TaskStatus } from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import { isStoppedWorker } from '../../../core/orchestration/running'
import { useI18n } from '../i18n/I18nProvider'

/** 여덟 상태의 툴팁 키. 글리프와 **같은 파일에** 있는 이유는 글리프가 여기 있는 이유와 같다 —
 *  아이콘이 말로 풀리는 자리(툴팁, 접근성 이름)가 화면마다 다른 낱말을 쓰면 같은 모양이 두 뜻을
 *  갖게 된다. 사이드바와 상세 창이 이 한 표를 가져다 쓴다.
 *
 *  `jobs.state.${status}` 로 조립하지 않는다 — 조립한 키는 grep 에 걸리지 않아서, 카탈로그에서
 *  지워져도 아무도 모르고 화면에서만 사라진다. */
export const STATE_KEY: Record<TaskStatus, MessageKey> = {
  pending: 'jobs.state.pending',
  ready: 'jobs.state.ready',
  dispatched: 'jobs.state.dispatched',
  validating: 'jobs.state.validating',
  reviewing: 'jobs.state.reviewing',
  completed: 'jobs.state.completed',
  failed: 'jobs.state.failed',
  blocked: 'jobs.state.blocked'
}

/** Task 한 상태의 색. 글리프도 띠도 그래프도 여기서 가져간다.
 *
 *  pending/ready 는 쉬는 글자 톤을 그대로 쓰고(아직 아무 일도 일어나지 않았다), 끝난 셋은 git 상태
 *  팔레트(ok/deleted/conflict)를 빌린다 — 같은 세 뜻에 새 색을 만들 이유가 없다. */
export const STATUS_COLOR: Record<TaskStatus, string> = {
  // 의존이 아직 풀리지 않은 것. 파일 트리에서 '봐도 되지만 볼 필요는 없는' 것에 쓰는 톤을 빌린다
  pending: 'var(--fi-mute)',
  ready: 'var(--text-dim)',
  dispatched: 'var(--accent)',
  // 검증 중 — 도는 중(accent)과도, 끝난 셋과도 달라야 한다. git 의 '수정됨' 톤을 빌린다:
  // 이 앱에서 이미 "아직 정해지지 않았다"를 뜻하는 색이다.
  validating: 'var(--git-modified)',
  // 검토 중 — 검증(--git-modified)과도, 도는 중(accent)과도, 끝난 셋과도 달라야 한다.
  // 다른 에이전트가 읽고 있는 상태이므로 상태 팔레트에 없던 색을 하나 빌린다.
  reviewing: 'var(--fi-purple)',
  completed: 'var(--ok)',
  failed: 'var(--git-deleted)',
  blocked: 'var(--git-conflict)'
}

/** Task 상태의 여덟 글리프. 사이드바와 상세 창이 **같은 파일에서** 가져다 쓴다 — 같은 뜻이 화면마다
 *  다르게 생기면 "아이콘으로 읽는다"는 규칙 자체가 무너진다.
 *
 *  **움직임은 작업 하나에만 붙는다.** dispatched·validating·reviewing 셋은 같은 회전(.job-arc,
 *  styles.css)을 공유하고 색만 다르다: "무언가 돌고 있다"가 하나의 신호로 읽히고, 무엇이 도는지는
 *  색이 말한다. 여럿을 묶은 자리에서는 이 글리프가 아니라 RunIcon 을 쓴다.
 *
 *  색은 svg 의 color 로 한 번만 주고 안쪽은 currentColor 로 받는다 — 여덟 곱하기 두세 군데의 색을
 *  글리프마다 적으면, 한 상태의 색을 바꿀 때 고칠 자리가 흩어진다.
 *
 *  label 은 툴팁이자 접근성 이름이다. 없으면 aria-hidden — 옆에 글자가 이미 같은 말을 하는 자리
 *  (줄의 제목, 아래 한 줄의 숫자)에서 읽는 사람이 같은 것을 두 번 듣지 않게 한다. */
export function TaskIcon({
  status,
  size = 13,
  label,
  still = false
}: {
  status: TaskStatus
  size?: number
  label?: string
  /** 도는 셋의 회전을 멈춘다. **모양과 색은 그대로다** — 상태가 바뀐 것이 아니라 그 상태에서
   *  움직이는 것이 없을 뿐이다. 지금 쓰는 곳은 워커가 멈춰 세워진 dispatched 하나다(glyphOf). */
  still?: boolean
}): React.JSX.Element {
  return (
    <Glyph color={STATUS_COLOR[status]} size={size} label={label}>
      {shapeOf(status, still)}
    </Glyph>
  )
}

/** 한 Task 의 글리프가 쓸 문구와 회전 여부. **둘을 함께 돌려주는 이유는 둘이 같은 사실을 말하기
 *  때문이다** — 문구만 고치고 회전을 두면 항상 보이는 쪽이 계속 거짓말한다(툴팁은 올려 봐야 보인다).
 *
 *  워커가 멈춰 세워진 Task 가 그 자리다(isStoppedWorker, core/orchestration/running.ts):
 *  `dispatched` 인데 열린 Dispatch 가 없다. 상태 문구는 그것을 "워커가 일하는 중"이라고 적고
 *  회전은 "지금 무언가 돌고 있다"를 말하는데(styles.css 의 job-spin 주석), 둘 다 거짓이다.
 *
 *  판정 자체는 core 에 있다 — 렌더러에 두면 이 질문의 답이 화면마다 한 벌씩 생기고, 도는 개수가
 *  정확히 그렇게 두 화면에 복사되어 똑같이 틀렸다. */
const glyphOf = (task: JobTask): { key: MessageKey; still: boolean } =>
  isStoppedWorker(task)
    ? { key: 'jobs.state.dispatchedStopped', still: true }
    : { key: STATE_KEY[task.status], still: false }

/** 한 Task 의 상태 글리프. **Task 를 그리는 자리는 전부 이것을 쓴다** — 사이드바의 줄, 상세 창의
 *  그래프 노드, 그 아래 칸의 필터 표시. 문구를 여기서 직접 풀기 때문에 호출부가 문구와 회전 중
 *  하나만 넘기고 다른 하나를 잊는 일이 생기지 않는다: 도는 개수가 그렇게 두 화면에 복사되어 똑같이
 *  틀려 있었다.
 *
 *  상태만 있고 Task 가 없는 자리(머리말의 개수 묶음, 이벤트 앞의 표식)는 TaskIcon 을 그대로 쓴다 —
 *  그 자리들은 어느 한 Task 를 가리키지 않으므로 "그 워커가 멈췄는가"라는 질문 자체가 없다. */
export function TaskGlyph({ task, size }: { task: JobTask; size?: number }): React.JSX.Element {
  const { t } = useI18n()
  const g = glyphOf(task)
  return <TaskIcon status={task.status} label={t(g.key)} still={g.still} size={size} />
}

/** 자물쇠 둘 — Gate 를 걸고 푸는 노드 버튼이 쓴다.
 *
 *  **왜 그림인가**: 이 버튼들의 이웃(`▶ ⏹ ↗ ↻`)은 전부 단색 텍스트 글리프인데 자물쇠에는 널리
 *  쓰이는 단색 문자가 없다 — `🔒`/`🔓` 는 컬러 이모지라 그 줄에서 혼자 튄다.
 *
 *  **왜 자물쇠인가**: 이 짝은 한때 `물어보기`/`답하기` 였는데 대화처럼 읽혔다. 실제로 하는 일은
 *  잠금이다 — Gate 는 Task 를 `blocked` 로 내려 **시작을 막고**, 푸는 것이 그것을 되돌린다.
 *  `createGate` 가 열린 Dispatch 가 있는 Task 를 거절하는 것이 그 증거다(묻는 장치라면 상대가 있을
 *  때 막을 이유가 없다). 가이드도 "a decision block … for deciding the task DAG" 라 적는다.
 *
 *  Glyph 를 쓰지 않는다 — 그것은 색을 스스로 정하는데, 이 둘은 버튼의 색(--text-faint → hover
 *  accent)을 물려받아야 한다. Select.tsx 의 Chevron 과 같은 모양이다. */
export const LockIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.8 7V5.2a2.2 2.2 0 0 1 4.4 0V7" />
  </svg>
)

/** 풀린 자물쇠 — 고리가 한쪽만 걸려 있다. 잠긴 것과 **몸통이 같고 고리만 다르다**: 두 상태가 한
 *  물건의 두 모습으로 읽혀야 하고, 모양을 통째로 바꾸면 서로 다른 두 아이콘이 된다. */
export const UnlockIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" />
    <path d="M5.8 7V5.2a2.2 2.2 0 0 1 4.3-.7" />
  </svg>
)

/** 휴지통 — Run 을 물러나게 하는 버튼이 쓴다. 자물쇠 둘과 같은 관례다(단색, currentColor 를
 *  물려받아 버튼의 색과 hover 를 따라간다). `✕` 로 하지 않는 이유: 이 사이드바에서 `✕` 는 이미
 *  "닫는다·취소한다"의 모양이고(상세 창의 필터 지우기, 폼 취소), 지우는 것은 되돌릴 수 없어 같은
 *  모양을 빌려 쓸 자리가 아니다. */
export const TrashIcon = (): React.JSX.Element => (
  <svg
    viewBox="0 0 16 16"
    width="12"
    height="12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3 4.5h10" />
    <path d="M6.5 4.5V3.2h3v1.3" />
    <path d="M4.4 4.5l.6 8a.9.9 0 0 0 .9.8h4.2a.9.9 0 0 0 .9-.8l.6-8" />
    <path d="M6.8 7v4M9.2 7v4" />
  </svg>
)

export type RunIconKind = 'running' | 'blocked' | 'done' | 'failed'

/** 여럿을 묶은 자리(Run 헤더, 접힌 줄)의 글리프. **도는 것은 채워진 점으로 적는다** — 묶음까지
 *  돌면 화면에 스피너가 여럿 생기고, 그러면 움직임이 신호이기를 그만둔다. 개수는 옆에 숫자로 선다.
 *
 *  나머지 셋은 Task 글리프를 그대로 쓴다: 그 셋은 이미 정지해 있어서 하나를 가리키든 여럿을
 *  가리키든 같은 것을 말한다. 새 모양을 만들면 뜻이 같은 글리프가 둘이 된다. */
export function RunIcon({
  kind,
  size = 13,
  label
}: {
  kind: RunIconKind
  size?: number
  label?: string
}): React.JSX.Element {
  if (kind !== 'running') {
    return (
      <TaskIcon
        status={kind === 'blocked' ? 'blocked' : kind === 'failed' ? 'failed' : 'completed'}
        size={size}
        label={label}
      />
    )
  }
  return (
    <Glyph color={STATUS_COLOR.dispatched} size={size} label={label}>
      <circle cx="8" cy="8" r="4.2" fill="currentColor" />
    </Glyph>
  )
}

/** 앱의 SVG 관례대로 16 viewBox 하나. 툴팁은 title 속성이 아니라 <title> 자식이다 — SVG 에서는
 *  브라우저가 그쪽을 읽는다. */
function Glyph({
  color,
  size,
  label,
  children
}: {
  color: string
  size: number
  label?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <svg
      className="job-ic"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      style={{ color }}
      role={label ? 'img' : undefined}
      aria-hidden={label ? undefined : true}
    >
      {label ? <title>{label}</title> : null}
      {children}
    </svg>
  )
}

function shapeOf(status: TaskStatus, still: boolean): React.JSX.Element {
  switch (status) {
    // 도는 셋. 회색 테두리 위를 4분의 1 호가 돈다 — 호만 있으면 작은 크기에서 무엇이 도는지
    // 읽히지 않아서, 도는 자리를 테두리가 먼저 그려 준다.
    // still 이면 같은 그림이 멈춘다. 클래스를 떼는 것만으로 되는 이유는 회전이 CSS 에 있기
    // 때문이고(.job-arc), 그래서 reduced-motion 인 사람이 이미 보고 있던 그림과 같아진다 —
    // 움직임으로 말하는 신호는 애초에 그쪽에 닿지 않는다
    case 'dispatched':
    case 'validating':
    case 'reviewing':
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--line-soft)" strokeWidth="2" />
          <path
            className={still ? undefined : 'job-arc'}
            d="M8 2a6 6 0 0 1 6 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </>
      )
    // 끝난 셋은 채워진 점에 표식을 파낸다. 파내는 색이 --bg 인 것은 이 글리프가 --panel 위에도
    // --elevated 위에도 서기 때문이다 — 표면색을 따라가게 하면 자리마다 다른 글리프가 된다
    case 'completed':
      return (
        <>
          <circle cx="8" cy="8" r="6.5" fill="currentColor" />
          <path
            d="M5 8.2l2 2 4-4.2"
            fill="none"
            stroke="var(--bg)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )
    case 'failed':
      return (
        <>
          <circle cx="8" cy="8" r="6.5" fill="currentColor" />
          <path
            d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"
            fill="none"
            stroke="var(--bg)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </>
      )
    case 'blocked':
      return (
        <>
          <circle cx="8" cy="8" r="6.5" fill="currentColor" />
          <path d="M8 4.6v4.2" fill="none" stroke="var(--bg)" strokeWidth="1.9" strokeLinecap="round" />
          <circle cx="8" cy="11.3" r="1.05" fill="var(--bg)" />
        </>
      )
    // 시작 전 둘은 비어 있다 — 채우지 않는 것이 "아직 아무 일도 없었다"를 말한다. 점선은 그중에서도
    // 자기 힘으로 시작할 수 없는 쪽(의존이 막고 있다)
    case 'ready':
      return <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />
    case 'pending':
      return (
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeDasharray="2.6 2.6"
        />
      )
  }
}
