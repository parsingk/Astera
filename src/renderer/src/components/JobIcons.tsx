import type { TaskStatus } from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'

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
  label
}: {
  status: TaskStatus
  size?: number
  label?: string
}): React.JSX.Element {
  return (
    <Glyph color={STATUS_COLOR[status]} size={size} label={label}>
      {shapeOf(status)}
    </Glyph>
  )
}

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

function shapeOf(status: TaskStatus): React.JSX.Element {
  switch (status) {
    // 도는 셋. 회색 테두리 위를 4분의 1 호가 돈다 — 호만 있으면 작은 크기에서 무엇이 도는지
    // 읽히지 않아서, 도는 자리를 테두리가 먼저 그려 준다
    case 'dispatched':
    case 'validating':
    case 'reviewing':
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke="var(--line-soft)" strokeWidth="2" />
          <path
            className="job-arc"
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
