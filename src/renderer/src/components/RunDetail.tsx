import { useEffect, useState } from 'react'
import type {
  Account,
  JobEvent,
  JobRun,
  JobTask,
  MessageType,
  Provider,
  RunDetail as RunDetailData,
  TaskStatus
} from '../../../core/types'
import type { MessageKey } from '../../../core/i18n'
import { accountToDispatchOn } from '../../../core/accounts/dispatchAccount'
import { providerOf } from '../../../core/providers/meta'
import type { GraphBox } from '../../../core/orchestration/graphLayout'
import { edgePath, layoutRows, NODE_H, NODE_W } from '../../../core/orchestration/graphLayout'
import { DEFAULT_CONCURRENCY, type Dispatch } from '../../../core/orchestration/types'
import { runningCount } from '../../../core/orchestration/running'
import { useI18n } from '../i18n/I18nProvider'
import { confirmModal } from '../lib/confirm'
import { toast } from '../lib/toast'
import {
  LockIcon,
  RunIcon,
  STATE_KEY,
  STATUS_COLOR,
  TaskGlyph,
  TaskIcon,
  UnlockIcon
} from './JobIcons'
import { NewTaskModal } from './NewTaskModal'

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

/** 한 Run 의 상세 창 — 위가 의존 그래프, 아래가 이벤트다. **더 이상 읽기 전용이 아니다** — Task 8 이
 *  여기서 Task 를 짓게 했고(`task-create`), Task 9 가 노드에서 `띄우기`·`멈추기`·`물어보기`·
 *  `다시 띄우기`(`worker-start`·`worker-stop`·`gate-create`·`task-update`)를 열었다. 이 계획이
 *  초안될 때는 이 파일이 쓰는 쪽이 될 줄 몰랐고, 그 반전은 `knowledge/decisions/ADR-004`에 있다.
 *  **Gate 에 답하는 것도 이제 여기다**(`답하기` → `gate-resolve`). 한때 이 주석은 그것이 "아직
 *  Slack 제어면의 몫"이라고 적었는데, 그 절반이 참인 동안 앱은 Gate 를 **열고 보여 주기만 하고
 *  푸는 곳이 아무 데도 없었다** — 로드맵 5번이 그래서 "Slack 에 제어면을 만든다"에서 "Gate 를
 *  앱에서 푼다"로 좁아졌다. 사람이 앱에서 일을 만들게 해 놓고 그 일이 던지는 질문은 다른 데서
 *  답하라는 것은 앞뒤가 맞지 않고, `물어보기` 로 연 Gate 는 애초에 사람이 스스로 쓴 질문이다.
 *  Slack 은 알림으로 남는다.
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
/** busy 가 담는 값은 노드 동작의 대상 Task id 인데, 실행 버튼에는 대상 Task 가 없다. Task id 와
 *  겹칠 수 없는 값을 하나 둔다 — id 는 `tsk_` 로 시작하므로(core/orchestration/types.ts 의 newId)
 *  이 문자열과 같아질 수 없다. UI_CALLER 가 세션 id 와 겹치지 않게 하는 것과 같은 방식이다. */
const RUN_START = 'run:start'

/** 병합 버튼의 busy 센티넬. RUN_START 와 같은 이유로 Task id 와 겹칠 수 없는 값이다 */
const RUN_MERGE = 'run:merge'

export function RunDetail({
  run,
  detail,
  projectPath,
  runId,
  canOpenSession,
  onOpenSession,
  onClose
}: {
  /** 스냅샷에 있는 그 Run. 노드의 제목·상태·세션은 전부 여기서 온다(detail 은 id 만 준다).
   *  스냅샷과 detail 은 서로 다른 호출이라 어긋날 수 있으므로, 한쪽에만 있는 Task 는 그리지 않는다. */
  run: JobRun | undefined
  /** null 은 아직 도착하지 않았다는 뜻 — 빈 상태와 구분한다(JobsView 의 snapshot === null 과 같다) */
  detail: RunDetailData | null
  /** Task 짓기(task-create)와 그 검증 구성 조회(run.list)가 쓴다. App.tsx 의 openRun 이 이미 이
   *  짝을 들고 있으므로 그대로 받는다 — run?.id 로 대신하면 run 이 undefined 인 순간(스냅샷이 아직
   *  없거나 Run 이 막 사라졌을 때)에는 Task 를 지을 수 없어야 할 이유가 없는데도 지을 수 없게 된다. */
  projectPath: string
  runId: string
  canOpenSession: (sessionId: string) => boolean
  onOpenSession: (sessionId: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  /** 고른 노드 = 아래 이벤트의 필터. 같은 노드를 다시 누르면 풀린다 */
  const [selected, setSelected] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  /** Task 를 짓는 중인가. **한때 string[] | null 이었다** — 그래프 노드를 눌러 의존을 골랐으므로
   *  이 상태가 "폼이 열렸다"와 "무엇을 골랐다"를 겸했다. 의존이 폼의 셀렉트로 가면서 고른 값은
   *  NewTaskModal 이 소유하고, 여기 남는 것은 열렸는가 하나다.
   *
   *  **필터(selected)는 건드리지 않는다.** 짓는 동안에도 그대로 남아 있다가 끝나면(성공이든 취소든)
   *  그대로 돌아온다 — 지우거나 감추면, 이미 한 Task 로 걸러서 그 사정을 보던 사람이 + Task 를
   *  누른 순간 그 맥락을 잃는다. 짓는 동안 아래 칸(.detail-events)이 폼으로 바뀌어 그 필터 줄
   *  자체는 잠깐 보이지 않지만, 상태는 그대로 있으므로 폼을 닫으면 원래 걸러 보던 화면이 다시
   *  나온다. */
  const [authoring, setAuthoring] = useState(false)
  /** Task 짓기 폼의 검증 구성 목록. null 은 아직 안 온 것 — NewTaskModal 의 prop 문서와 같은 뜻이다.
   *
   *  **run.list 로 받는다. orch.command(..., 'run-configs', ...) 가 아니다.** run-configs 명령은
   *  latestOrdinaryRun(s) — 템플릿도 예약 회차도 아닌 것 중 가장 최근 Run — 을 위해 답하고 어느 Run
   *  을 위한 것인지 받는 인자가 아예 없다(server.ts 의 'run-configs' case). 이 창은 프로젝트마다
   *  열릴 수 있고 그 Run 이 이 창의 프로젝트에 속한다는 보장이 없으므로, 그 명령을 쓰면 다른
   *  프로젝트의 실행 구성 목록이 뜰 수 있다. **예약이 생긴 뒤로는 더 그렇다** — 발화가 Run 을
   *  만들므로 그 "가장 최근"이 사람의 동작 없이도 움직인다. run.list(projectPath) 는 프로젝트로 직접 물어보고
   *  (assertAllowedPath 를 거친다) 오케스트레이션 상태를 바꾸지 않는 프로젝트 설정 조회이므로 "UI 는
   *  orch.command 만 부른다" 규칙과 부딪히지 않는다 — 그 규칙은 오케스트레이션 상태를 바꾸는
   *  통로에 대한 것이다. listRunConfigs(ipc.ts, run-configs 가 쓰는 것)와 run.list 핸들러는 똑같이
   *  loadRunConfigs({projectPath, stored, assertAllowedPath})를 부르므로 id 가 갈라지지 않는다 —
   *  여기서 고른 id 가 곧 validateConfigId 로 저장되고 TaskValidator 가 나중에 그 id 로 찾아낼 그
   *  설정이다. */
  const [runConfigs, setRunConfigs] = useState<{ id: string; name: string }[] | null>(null)
  /** 계정 목록. **두 곳이 쓴다** — Task 짓기 폼의 계정 칸(그 Run 의 provider 것만 걸러 넘긴다)과
   *  아래 필터 줄이 지정된 계정의 **이름**을 적는 자리다. 그래서 폼이 열릴 때만이 아니라 창이 열려
   *  있는 동안 들고 있고, 폼을 열 때마다 다시 받는다(그 사이 계정이 늘거나 지워졌을 수 있다).
   *
   *  **로그인 여부는 묻지 않는다**: 이 목록은 "고를 수 있는 것"이고, 고른 계정을 정말 쓸 수 있는지는
   *  띄우는 순간 accountToDispatchOn 이 본다 — 지금 로그아웃돼 있어도 나중에 로그인하면 되는
   *  것이라, 여기서 숨기면 고를 수 없는 이유가 화면에 남지 않는다. */
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  // 계정 목록은 창이 열려 있는 동안 들고 있고 폼을 열 때 다시 받는다(authoring 이 의존성에 있는
  // 이유). 실행 구성과 **따로 둔 이유**: 그쪽은 폼이 닫히면 비우고 이쪽은 비우지 않는다 — 두
  // 수명을 한 effect 에 넣으면 정리 함수가 갈래마다 생겨 읽을 수 없게 된다.
  useEffect(() => {
    let cancelled = false
    // 거부 팔을 둔다 — 실패해도 폼은 쓸 수 있어야 하므로 빈 목록으로 접는다. 그러면 계정 칸이
    // 그려지지 않고(고를 것이 둘 미만) 지정 없이 Task 를 만드는 길이 남는다.
    void window.api.accounts.list().then(
      (list) => {
        if (!cancelled) setAccounts(list)
      },
      () => {
        if (!cancelled) setAccounts([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [authoring])
  useEffect(() => {
    if (!authoring) {
      setRunConfigs(null) // 다음에 지을 때 다시 받도록 비운다 — 그 사이 설정이 바뀌었을 수 있다
      return
    }
    let cancelled = false
    // 거부 팔을 반드시 둔다 — main 이 프로젝트를 읽다 던질 수 있고, 그러면 DevTools 에
    // Uncaught (in promise) 가 뜬다. 실패해도 폼은 그대로 쓸 수 있어야 하므로(검증 없이 Task 를
    // 만드는 것도 유효한 선택이다) 빈 목록으로 접는다 — "검증 없음" 하나만 남는다.
    void window.api.run.list(projectPath).then(
      (r) => {
        if (!cancelled) setRunConfigs(r.configs.map((c) => ({ id: c.id, name: c.name })))
      },
      () => {
        if (!cancelled) setRunConfigs([])
      }
    )
    return () => {
      cancelled = true
    }
  }, [authoring, projectPath])
  /** 물어보기(Gate)의 질문을 쓰는 중인 Task id. null 이면 안 쓰는 중이다 — authoring 과 같은 자리에
   *  서는 세 번째 모습이다(그래프는 그대로, .detail-events 만 바뀐다). authoring 처럼 selected(필터)는
   *  건드리지 않는다. */
  const [asking, setAsking] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  /** Gate 에 답을 쓰는 중인 Task id. asking 의 짝이다 — 저쪽은 질문을 만들고 이쪽은 그 질문을 푼다.
   *  **둘은 동시에 열리지 않는다**(아래 formOpen 이 둘 다 잠근다) 그래서 gateError 를 함께 쓴다. */
  const [answering, setAnswering] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  /** 지금 도는 노드 동작(띄우기·멈추기·물어보기·다시 띄우기)의 대상 Task id, 없으면 null.
   *
   *  **하나뿐이고 Task 별로 나누지 않는다** — 그래서 무언가 도는 동안에는 그래프의 모든 노드
   *  버튼이 함께 숨는다. 이 창은 한 번에 하나만 다루는 것이 보통의 쓰임이고, Task 마다 따로 두면
   *  "다른 Task 의 명령이 도는 동안 이 버튼은 눌러도 되는가"를 버튼마다 다시 정해야 한다.
   *
   *  authoring·asking 과 따로 두는 이유: 그 둘은 "폼이 열려 있다"를 말하지만 띄우기·멈추기·다시
   *  띄우기에는 폼이 없다 — 버튼 하나가 곧 명령이라, 명령이 오가는 동안을 표시할 값이 그 셋에는
   *  따로 필요하다(물어보기는 asking 이 그 구간도 이미 덮는다 — 성공했을 때만 asking 을 null 로
   *  돌리므로). */
  const [busy, setBusy] = useState<string | null>(null)
  /** 물어보기(gate-create) 제출이 실패했을 때의 안내 — 이 폼(asking)과 함께 살고 죽는다.
   *  NewTaskModal 이 자기 에러를 자기 폼 안에 두는 것과 같은 자리다. **띄우기·멈추기·다시
   *  띄우기는 이 값을 쓰지 않는다** — 그 셋에는 폼이 없어서 실패를 인라인으로 보여 줄 자리가
   *  없고, 이 앱은 그런 폼 없는 단발 액션의 실패를 이미 toast.error 로 보낸다(App.tsx 의
   *  run.start.failed·files.save.failed 등과 같은 관례). 하나의 배너에 넷을 몰아넣는 것은 "폼이
   *  있으면 인라인, 없으면 토스트"라는 이 저장소의 규칙 옆에 같은 일을 하는 두 번째 장치를
   *  세우는 것이라 고르지 않았다. */
  const [gateError, setGateError] = useState<string | null>(null)
  /** 그래프의 노드 버튼이 무언가를 조용히 버릴 수 있는 동안 — Task 짓기 폼이 열려 있거나, 질문을
   *  쓰는 중이거나, 명령이 도는 중이다. 이 동안은 노드 버튼(↗ 포함)을 전부 숨기고 배경 클릭으로
   *  창을 닫지도 않는다: 다른 버튼을 누르면 지금 쓰던 것을 잃고, 배경을 눌러 창을 닫으면 도는
   *  명령의 결과를 아무도 보지 못한다(이 창을 새로 열지 않는 한 다시 알 길이 없다). */
  const formOpen = authoring || asking !== null || answering !== null || busy !== null
  /** 띄우기 버튼을 보일 조건 — **셋 다** 참이어야 한다. 한 자리에 모아 두는 것은 하나만
   *  보고 고치면 나머지 조건을 깨뜨리기 쉬워서다.
   *
   *  1) 이 Run 의 동시 실행 한도(없으면 DEFAULT_CONCURRENCY, JobRun 의 주석과 같다)가 1 이하다.
   *     한도가 2 이상인 Run 은 모든 워커가 각자의 워크트리에서 돌고, 사람이 여기서 하나를 띄우면
   *     그것은 Run 워크트리로 간다(worker-start 의 기본값) — 통합 Task 가 도는 바로 그 폴더다.
   *     "병렬인데 한 폴더"라는 금지된 조합이 되고(coordinator/runScheduler 주석), 그 워커가 합칠
   *     자리에 커밋 안 된 변경을 남기면 나머지 워크트리를 합칠 자리가 없어진다. 렌더러는 Task
   *     워크트리의 이름을 지어 줄 수도 없다 — nameForTask(core/worktrees/naming.ts)가 node:path 를
   *     끌고 와 tsconfig.web.json 에 못 들어간다. 그래서 한도 2 이상인 Run 에서는 버튼 자체를 없앤다
   *     (스케줄러가 거기서 띄우는 것을 대신 맡는다). DEFAULT_CONCURRENCY 가 3 이므로 사이드바가
   *     기본값으로 만든 Run 에는 이 버튼이 나오지 않는다 — 대안(프로젝트 폴더로라도 억지로
   *     띄우기)을 만들지 않기로 한 결정이다.
   *
   *  2) 이 Run 에 provider 가 있다. 없으면 이 버튼은 눌려도 결코 되지 않는다 — worker-start 가
   *     --agent 로 지목할 provider 가 없어 `--agent must be claude|codex` 로 거절한다(server.ts).
   *     **schedule.ts 의 slotsToFill 이 이미 같은 판단을 내려 두었다** — `const provider =
   *     run.provider; if (!provider) continue` 로 provider 없는 Run 을 건너뛴다는 그 주석과 같은
   *     사정이다(그런 Run 은 명령으로는 만들 수 없지만 orchestration.json 은 프로세스보다 오래
   *     살고 손으로 고쳐질 수 있다). 스케줄러가 이미 내린 판단을 UI 가 다르게 낼 이유가 없다.
   *     버튼을 그대로 두고 실패했을 때 안내로 대신하는 것도 틀렸다 — "로그인된 계정이 없다"는
   *     이 경우 거짓이다(계정은 있을 수 있고, 없는 것은 이 Run 의 provider 다). 원인을 잘못
   *     말하는 오류 문구는 문구가 없는 것보다 나쁘다.
   *
   *  3) 이 Run 이 **예약 템플릿이 아니다.** 템플릿은 자신의 Task 를 돌리지 않는다 — 발화가 만든
   *     회차가 돈다. `worker-start` 가 이 조합을 거절하므로(server.ts) 버튼을 두면 서버가 반드시
   *     거절할 동작을 권하는 것이 되고, 무엇보다 그 거절이 없던 동안에는 눌리는 대로 템플릿의
   *     Task 가 terminal 이 되어 TTL 정리가 예약과 모든 회차를 30일 뒤에 지우는 경로가 열려
   *     있었다(store.ts). 이 창은 템플릿에서 **Task 를 짜는 자리**이고 돌리는 자리가 아니다.
   *     회차에서는 그대로 보인다 — 회차는 templateId 를 갖고 schedule 은 갖지 않는다.
   *
   *  4) 이 Run 이 **이미 시작했다** (`pendingStart` 가 없다). '실행' 버튼이 지키는 게이트가
   *     정확히 이것이다 — 사람이 Task 를 다 짜고 누르기 전까지는 아무것도 돌지 않아야 한다.
   *     pendingStart 인 Run 은 아직 워크트리도 없다(runScheduler 가 첫 슬롯을 채울 때 게으르게
   *     만든다) — 이 자리에서 버튼이 살아 있으면 `worker-start` 가 `--worktree` 없이 불려
   *     app-managed Run 을 워크트리 없이 세운 채 거절당하거나(server.ts 의 새 거절), 그 거절이
   *     없다면 프로젝트 폴더에서 돌았을 것이다 — 두 경우 다 '실행' 을 누르기 전에는 아무 노드
   *     버튼도 없어야 한다는 이 게이트의 존재 이유를 어긴다. */
  const canManualStart =
    (run?.concurrency ?? DEFAULT_CONCURRENCY) <= 1 &&
    run?.provider !== undefined &&
    run.schedule === undefined &&
    run.pendingStart !== true
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

  const running = runningCount(tasks)
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

  /** 그래프 노드 클릭은 필터 하나만 뜻한다 — 같은 노드를 다시 누르면 풀린다.
   *
   *  **예전에는 뜻이 둘이었다**: 짓는 중이면 의존을 고르고, 아니면 필터였다. 의존이 폼의 셀렉트로
   *  가면서 그 분기가 없어졌고, 함께 없어진 것이 하나 더 있다 — 같은 노드가 "걸러 놓은 것"과
   *  "고른 의존" 두 표시를 동시에 달 수 있던 상태다(청록 링과 체크 글리프). 뜻이 하나면 표시도
   *  하나다.
   *
   *  **폼이 열려 있는 동안에는 클릭을 통째로 무시한다.** 노드 버튼들이 이 동안 전부 숨는 것
   *  (node() 의 `!formOpen &&`)과 같은 규칙이다 — 버튼만 숨기고 노드 자신의 onClick 을 그대로
   *  두면, 폼을 쓰는 중에 다른 노드를 눌러 필터 링을 조용히 옮길 수 있는 구멍이 남는다. 이 판단을
   *  Graph 안에 두지 않고 여기 두는 것은 Graph 는 그리기만 한다는 파일 머리말의 규칙이다. */
  const onNodeClick = (id: string): void => {
    if (formOpen) return
    setSelected((prev) => (prev === id ? null : id))
  }

  /** 계정을 고른다 — 스케줄러(src/main/ipc.ts 의 runScheduler)와 같은 방법이다: 계정 목록과
   *  로그인 여부를 병렬로 확인한 뒤 defaultAccountIdOf(그 규칙을 정하는 단 하나의 함수)에게
   *  넘긴다. 로그인 조회를 계정마다 차례로 기다리면 계정 수만큼 느려지므로 Promise.all 로 편다. */
  const accountFor = async (provider: Provider, assigned?: string): Promise<string | null> => {
    const list = await window.api.accounts.list()
    const loggedIn = new Set(
      (
        await Promise.all(
          list.map(async (a) => ((await window.api.accounts.loginStatus(a.id)) ? a.id : null))
        )
      ).filter((id): id is string => id !== null)
    )
    const picked = accountToDispatchOn({
      ...(assigned !== undefined ? { assigned } : {}),
      provider,
      accounts: list,
      loggedInIds: loggedIn
    })
    return picked.ok ? picked.accountId : null
  }

  /** 실행. **사이드바로 만든 Run 은 사람이 이것을 누를 때까지 돌지 않는다** — 예전에는 Task 를
   *  하나 만드는 순간 돌기 시작해서, 나머지를 짜는 동안 첫 Task 의 워커가 이미 일하고 있었다.
   *  게이트는 Run.pendingStart 이고 이 명령이 그것을 걷는다(server.ts 의 run-start).
   *
   *  **버튼은 pendingStart 일 때만 있다** — 코디네이터가 돌리는 Run 에는 그 칸이 없으므로 나타나지
   *  않는다. 앱이 그쪽 Run 을 함께 돌리면 같은 ready Task 를 두고 경합한다(Run.autoDispatch 주석).
   *
   *  실패는 toast 다 — 폼이 없는 단발 액션의 관례(startTask 와 같다). */
  const startRunNow = async (): Promise<void> => {
    setBusy(RUN_START)
    try {
      const reply = await window.api.orch.command(projectPath, 'run-start', { run: runId })
      if (reply.status >= 400) toast.error(t('jobs.run.startFailed'))
    } catch {
      toast.error(t('jobs.run.startFailed'))
    } finally {
      setBusy(null)
    }
  }

  /** 워커들이 워크트리에 남긴 일을 프로젝트 폴더로 합친다.
   *
   *  **자동으로 하지 않는 것이 이 버튼의 존재 이유다.** 병합은 사용자가 체크아웃해 둔 브랜치의
   *  작업 트리를 바꾸고, 사용자가 그 폴더에서 일하는 중일 수도 있다 — 충돌하면 그 트리가 반쯤
   *  병합된 상태로 남는다. 그래서 그 순간을 사람이 고른다.
   *
   *  성공해도 워크트리를 지우지 않는다(명령 쪽 주석). 폴더 정리는 삭제 모달의 체크박스다.
   *
   *  **`merged` 가 비면 다른 문구를 보인다.** 이 버튼은 `run.worktrees`(발행 cwd 를 센 값, 폴더가
   *  없어져도 줄지 않는다)로 나타나므로, 예약 회차가 걷혔거나 삭제 때 폴더가 이미 지워진 뒤에도
   *  눌릴 수 있다 — 그때 명령은 200 을 내지만 `merged: []` 다(server.ts 의 run-merge). 아무것도
   *  합치지 않았는데 "합쳤습니다" 토스트를 보이면 그 자체가 결함이다. */
  const mergeRunNow = async (): Promise<void> => {
    // **묻고 나서 합친다.** 이것은 사용자가 체크아웃해 둔 브랜치의 작업 트리를 바꾸는 유일한 버튼이고,
    // 되돌리려면 git 을 직접 써야 한다 — 버튼 하나 거리에 두기에는 너무 먼 결과다. 무엇이 일어나는지
    // (워크트리 몇 개가, 어느 자리로, 푸시는 하지 않는다는 것)를 그 자리에서 말한다.
    const count = (run?.worktrees ?? []).length
    if (
      !(await confirmModal({
        title: t('jobs.run.mergeConfirmTitle'),
        body: t('jobs.run.mergeConfirmBody', { count }),
        confirmLabel: t('jobs.run.merge')
      }))
    )
      return
    setBusy(RUN_MERGE)
    try {
      const reply = await window.api.orch.command(projectPath, 'run-merge', { run: runId })
      if (reply.status >= 400) {
        const reason =
          typeof reply.body === 'object' && reply.body !== null && 'error' in reply.body
            ? String((reply.body as { error: unknown }).error)
            : String(reply.status)
        toast.error(t('jobs.run.mergeFailed', { reason }))
        return
      }
      const merged =
        typeof reply.body === 'object' && reply.body !== null && 'merged' in reply.body
          ? (reply.body as { merged: unknown }).merged
          : undefined
      // **몇 개를 합쳤는지 말한다.** 병합은 화면에 아무 변화를 남기지 않는다(워크트리도 Run 도 그대로
      // 다) — "합쳤습니다" 만으로는 눌린 것인지 확인할 수 없어 사람이 같은 버튼을 여러 번 누른다.
      // 실제로 그랬다. 수는 명령이 돌려준 것이다(사라진 폴더를 건너뛴 뒤의 수), 넘긴 수가 아니다.
      const mergedCount = Array.isArray(merged) ? merged.length : count
      toast.success(
        mergedCount === 0
          ? t('jobs.run.mergeNothing')
          : t('jobs.run.merged', { count: mergedCount })
      )
      // **커밋되지 않은 변경은 합쳐지지 않았다.** git 은 커밋만 옮긴다 — 워커가 파일을 고쳐 놓고
      // 커밋하지 않았으면 그 일은 워크트리에만 있고, 병합을 성공으로 읽은 사람이 폴더를 지우는
      // 순간 사라진다. 앱은 워커에게 커밋을 지시하지만 지켰는지 확인하지 않으므로, 이 자리가 그
      // 사실이 사람에게 닿는 유일한 곳이다.
      //
      // 성공 토스트와 **따로** 띄운다. toast 는 error 만 스스로 사라지지 않으므로(lib/toast) 놓쳐서는
      // 안 되는 쪽을 그것으로 보낸다 — 문구가 실패가 아니라 남은 것을 말한다.
      const uncommitted =
        typeof reply.body === 'object' && reply.body !== null && 'uncommitted' in reply.body
          ? (reply.body as { uncommitted: unknown }).uncommitted
          : 0
      if (typeof uncommitted === 'number' && uncommitted > 0)
        toast.error(t('jobs.run.mergeUncommitted', { count: uncommitted }))
    } catch {
      toast.error(t('jobs.run.mergeFailed', { reason: '' }))
    } finally {
      setBusy(null)
    }
  }

  /** 띄우기. ready·pending 에서만 보이고(Graph.node), canManualStart 가 아니면 버튼 자체가 없다.
   *  **worktree 를 보내지 않는다** — 이 버튼은 워커가 어디서 도는지를 정하지 않는다. 그 결정은
   *  Run 의 것이고 worker-start 안에 산다(server.ts 의 기본값: 이 Run 의 워크트리). */
  const startTask = async (taskId: string): Promise<void> => {
    setBusy(taskId)
    try {
      const provider = run?.provider
      // provider 가 없는 Run 은 canManualStart 가 이미 버튼을 지워 이 자리에 닿지 못한다 — 이
      // 확인은 그 상태가 정말로 불가능함을 다시 강제하는 것이 아니라, 페인트와 클릭 사이에
      // 스냅샷이 바뀌는 좁은 창에 대한 방어일 뿐이다(canManualStart 의 주석).
      // **이 Task 에 지정된 계정을 지킨다.** 스케줄러와 같은 판정을 쓴다(accountToDispatchOn) —
      // 두 경로가 다른 계정을 고르면 같은 Task 가 누가 띄웠는지에 따라 다른 계정에서 돌게 된다.
      const assigned = tasks.find((tk) => tk.id === taskId)?.accountId
      const accountId = provider
        ? await accountFor(provider, assigned ?? undefined)
        : null
      if (!provider || !accountId) {
        // 폼이 없는 단발 액션의 실패라 toast 로 보낸다(gateError 의 주석과 같은 규칙) —
        // 계정을 못 찾은 경우도 같은 안내다(worker-start 를 부를 수 없다는 결과가 같다).
        toast.error(t('session.resume.noLoggedInAccounts'))
        return
      }
      const reply = await window.api.orch.command(projectPath, 'worker-start', {
        taskId,
        agent: provider,
        account: accountId
      })
      if (reply.status >= 400) toast.error(t('jobs.node.failed'))
    } catch {
      toast.error(t('jobs.node.failed'))
    } finally {
      setBusy(null)
    }
  }

  /** 멈추기. **worker-stop 은 Task id 가 아니라 Dispatch id 를 요구한다**(server.ts 의
   *  `str(args.dispatch)`) — 그래서 dispatch-show 로 이 Task 의 열린 Dispatch 를 먼저 찾는다.
   *  dispatch-show 는 읽기만 하는 명령이지만 "UI 는 orch.command 만 부른다" 규칙과 부딪히지
   *  않는다 — 그 규칙은 오케스트레이션 상태를 바꾸는 통로에 대한 것이고, 이 조회는 CLI 도 쓰는
   *  같은 명령 표면을 그대로 쓸 뿐 새 통로를 열지 않는다. */
  const stopTask = async (taskId: string): Promise<void> => {
    setBusy(taskId)
    try {
      const shown = await window.api.orch.command(projectPath, 'dispatch-show', { task: taskId })
      if (shown.status >= 400) {
        toast.error(t('jobs.node.failed'))
        return
      }
      const open = (shown.body as Dispatch[]).find((d) => !d.outcome && !d.endedAt)
      // 멈추기 버튼은 열린 Dispatch 가 있을 때만 보이므로(provider 의 유무로 안다) 보통은
      // 반드시 찾는다 — 그 사이 워커가 스스로 끝났을 수는 있으니 방어적으로만 확인한다.
      if (!open) {
        toast.error(t('jobs.node.failed'))
        return
      }
      const reply = await window.api.orch.command(projectPath, 'worker-stop', { dispatch: open.id })
      if (reply.status >= 400) toast.error(t('jobs.node.failed'))
    } catch {
      toast.error(t('jobs.node.failed'))
    } finally {
      setBusy(null)
    }
  }

  /** 다시 띄우기. task-update 로 상태를 ready 로 되돌린다 — 전이표(dispatched 에는 dispatched 가
   *  없다)를 일부러 우회하는 사람의 손보기 명령이다. **대가:** consecutiveFailures 도 함께 0 으로
   *  돌아간다 — task-update 가 회로 차단을 여는 유일한 길이라 그렇게 만들어져 있다. 실패 횟수를
   *  건드리지 않고 상태만 되돌리려면 명령 표면을 나눠야 하고, 이 슬라이스는 그것을 하지 않는다. */
  const restartTask = async (taskId: string): Promise<void> => {
    setBusy(taskId)
    try {
      const reply = await window.api.orch.command(projectPath, 'task-update', {
        id: taskId,
        status: 'ready'
      })
      if (reply.status >= 400) toast.error(t('jobs.node.failed'))
    } catch {
      toast.error(t('jobs.node.failed'))
    } finally {
      setBusy(null)
    }
  }

  /** 물어보기의 제출. asking 이 성공했을 때만 null 로 돌아간다 — NewTaskModal.onCreated 와 같은
   *  관례로, 실패하면 폼(과 이미 쓴 질문)이 그대로 남아야 사람이 다시 쓰지 않아도 된다. 이
   *  실패만 인라인(gateError)이다 — 이 액션에는 폼이 있고, 나머지 셋에는 없다. */
  const askQuestion = async (): Promise<void> => {
    const taskId = asking
    const trimmed = question.trim()
    if (taskId === null || !trimmed) return
    setBusy(taskId)
    setGateError(null)
    try {
      const reply = await window.api.orch.command(projectPath, 'gate-create', {
        task: taskId,
        question: trimmed
      })
      if (reply.status >= 400) {
        setGateError(t('jobs.node.failed'))
        return
      }
      setAsking(null)
      setQuestion('')
    } catch {
      setGateError(t('jobs.node.failed'))
    } finally {
      setBusy(null)
    }
  }

  /** 물어보기 폼을 닫는다(취소든 배경 클릭이든) — busy 인 동안은 막는다. NewTaskModal.tsx 의
   *  `!busy && onClose()` 와 같은 관례다: 제출이 도는 동안 닫으면 그 요청이 끝났을 때 아무도
   *  결과를 보지 못한다. */
  const cancelAsk = (): void => {
    if (busy !== null) return
    setAsking(null)
    setQuestion('')
  }

  /** Gate 에 답한다. **선택지 버튼도 이것을 부른다** — 그 버튼의 라벨을 그대로 resolution 으로
   *  보낸다(gate-resolve 는 자유 텍스트를 받으므로 새 규약이 필요 없다).
   *
   *  풀린 뒤 Task 를 어디로 보낼지는 core 가 이미 정해 두었다(resolveGate) — blocked 에서 곧바로
   *  ready 로 올리지 않고 pending 으로 내린 뒤 recomputeReady 가 판단한다. 여기서 그 판단을
   *  다시 하지 않는다.
   *
   *  askQuestion 과 같은 관례: 성공했을 때만 폼을 닫는다. 실패하면 쓴 답이 남아야 다시 쓰지 않는다. */
  const resolveGate = async (gateId: string, resolution: string): Promise<void> => {
    const taskId = answering
    const trimmed = resolution.trim()
    if (taskId === null || !trimmed) return
    setBusy(taskId)
    setGateError(null)
    try {
      const reply = await window.api.orch.command(projectPath, 'gate-resolve', {
        id: gateId,
        resolution: trimmed
      })
      if (reply.status >= 400) {
        setGateError(t('jobs.node.failed'))
        return
      }
      setAnswering(null)
      setAnswer('')
    } catch {
      setGateError(t('jobs.node.failed'))
    } finally {
      setBusy(null)
    }
  }

  const cancelAnswer = (): void => {
    if (busy !== null) return
    setAnswering(null)
    setAnswer('')
  }

  return (
    <div className="modal-backdrop" onClick={() => !formOpen && onClose()}>
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
          {/* 창을 닫는다. **폼이 열려 있는 동안은 숨는다** — 노드 버튼들과 같은 규칙이고(node() 의
              `!formOpen &&`) 이유가 하나 더 있다: 폼 자신도 오른쪽 위에 ✕ 를 갖고 있어서
              (NewTaskModal 의 .detail-clear) 둘이 함께 보이면 어느 ✕ 가 무엇을 닫는지 알 수 없다.
              폼이 열린 동안 나가는 길은 그 폼의 취소 하나다.
              한때 이 자리가 왼쪽 아래의 `닫기` 버튼이었고 formOpen 이면 disabled 였다. 죽은 버튼이
              폼의 취소·추가 옆에 서서 세 버튼처럼 읽혔고, 무엇에 쓰는 것이냐는 질문을 받았다 —
              같은 가드를 이 파일이 세 자리에서 이미 "숨긴다"로 쓰고 있었는데 이 자리만 달랐다. */}
          {!formOpen && (
            <button
              className="detail-x"
              title={t('jobs.timeline.close')}
              aria-label={t('jobs.timeline.close')}
              onClick={onClose}
            >
              ✕
            </button>
          )}
        </div>
        {/* flex: 1; min-height: 0 이 styles.css 에 있다 — 없으면 아래의 두 칸이 줄지 않아 모달 밖으로
            넘치고 닫기 버튼이 밀려난다. 이 저장소가 실제로 그 결함을 냈던 자리다 */}
        <div className="detail-body">
          <div className="detail-graph">
            {/* 짓는 동안(또는 질문을 쓰는 동안)에는 치운다 — 질문을 쓰는 중에 누르면 아래 칸이
                통째로 NewTaskModal 로 바뀌어 아직 안 보낸 질문을 잃고, Task 를 짓는 중에 누르면
                폼이 다시 그려져 채워 둔 것을 잃는다. 이 버튼이 여는 것은 새 창이 아니라 아래 칸
                (.detail-events)의 두 번째 모습이다: 그래프는 그대로 보이고 아래만 바뀐다. */}
            {!formOpen && (
              <div className="detail-graph-head">
                <button className="jobs-new" onClick={() => setAuthoring(true)}>
                  + {t('jobs.task.new')}
                </button>
                {/* Task 를 다 짜고 누르는 버튼. **Task 가 없으면 잠근다** — 빈 Run 을 시작하면
                    pendingStart 만 걷히고 아무 일도 일어나지 않아, 눌렀는데 아무 반응이 없는
                    자리가 된다. 누르면 게이트가 걷히고 이 버튼도 사라진다(run.pendingStart 가
                    조건이다). */}
                {run?.pendingStart && (
                  <button
                    className="jobs-new primary"
                    disabled={busy === RUN_START || tasks.length === 0}
                    title={t('jobs.run.startHint')}
                    onClick={() => void startRunNow()}
                  >
                    {t('jobs.run.start')}
                  </button>
                )}
                {/* **예약에서는 아이콘 토글 하나가 그 자리를 대신한다.** 시작과 재생이 같은 동작이라
                    (둘 다 pendingStart 를 걷는다) 한 번도 돌리지 않은 템플릿에도 ▶ 가 맞다. 둘을
                    따로 두면 "시작" 과 "재생" 이 다른 일처럼 보이고, 실제로는 같은 명령이다. */}
                {/* 워커의 일을 프로젝트 폴더로 가져오는 자리. **예약 템플릿에는 없다** — 템플릿은
                    돌지 않으므로 합칠 것이 없다(회차의 워크트리는 완료되면 앱이 걷는다). 워크트리를
                    쓰지 않은 Run 에도 없다 — 삭제 모달의 병합 체크박스와 같은 근거를 쓴다. */}
                {run !== undefined &&
                  run.schedule === undefined &&
                  (run.worktrees ?? []).length > 0 && (
                    <button
                      className="jobs-new"
                      disabled={busy === RUN_MERGE}
                      title={t('jobs.run.mergeHint', { count: (run.worktrees ?? []).length })}
                      onClick={() => void mergeRunNow()}
                    >
                      {t('jobs.run.merge')}
                    </button>
                  )}
              </div>
            )}
            <Graph
              tasks={tasks}
              layers={detail?.layers ?? []}
              deps={detail?.deps ?? {}}
              cyclic={detail?.cyclic ?? []}
              selected={selectedTask?.id}
              onSelect={onNodeClick}
              canOpenSession={canOpenSession}
              onOpenSession={onOpenSession}
              canManualStart={canManualStart}
              formOpen={formOpen}
              onStart={(taskId) => void startTask(taskId)}
              onStop={(taskId) => void stopTask(taskId)}
              onGate={(taskId) => {
                setAsking(taskId)
                setQuestion('')
                setGateError(null)
              }}
              onAnswer={(taskId) => {
                setAnswering(taskId)
                setAnswer('')
                setGateError(null)
              }}
              onRestart={(taskId) => void restartTask(taskId)}
            />
          </div>
          <div className="detail-events">
            {authoring ? (
              <NewTaskModal
                projectPath={projectPath}
                runId={runId}
                tasks={tasks}
                accounts={
                  accounts === null
                    ? null
                    : accounts.filter((a) => providerOf(a) === run?.provider)
                }
                runConfigs={runConfigs}
                onClose={() => setAuthoring(false)}
                onCreated={() => setAuthoring(false)}
              />
            ) : answering !== null ? (
              (() => {
                // 답할 Gate 는 스냅숏에서 다시 찾는다 — 폼을 연 뒤에 그 Gate 가 풀렸을 수 있고
                // (코디네이터나 CLI 가 답할 수 있다), 그때 열어 둔 id 로 보내면 이미 끝난 것을
                // 다시 푼다. 사라졌으면 폼을 그리지 않고 원래 화면으로 돌아간다.
                const gate = tasks.find((tk) => tk.id === answering)?.gate
                if (!gate) return <></>
                return (
                  <>
                    <div className="detail-filter">
                      <b>{t('jobs.node.answer')}</b>
                      <button
                        className="detail-clear"
                        title={t('common.cancel')}
                        aria-label={t('common.cancel')}
                        onClick={cancelAnswer}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="detail-task-fields">
                      {/* 질문을 그대로 보여 준다 — 답하는 사람이 그래프의 Gate 줄을 기억하고 있을
                          이유가 없다. 읽는 글이라 modal-hint 가 아니라 본문 톤이다 */}
                      <p className="detail-gate-question">{gate.question}</p>
                      {/* 코디네이터가 고를 것을 줬으면 그것이 답이다 — 자유 입력으로 그 낱말을 다시
                          치게 하지 않는다. 버튼의 라벨을 그대로 resolution 으로 보낸다 */}
                      {gate.options && gate.options.length > 0 && (
                        <div className="detail-gate-options">
                          {gate.options.map((opt) => (
                            <button
                              key={opt}
                              disabled={busy !== null}
                              onClick={() => void resolveGate(gate.id, opt)}
                            >
                              {opt}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="field">
                        <label>{t('jobs.node.answerLabel')}</label>
                        <textarea
                          rows={3}
                          value={answer}
                          onChange={(e) => setAnswer(e.target.value)}
                          autoFocus
                        />
                      </div>
                      {gateError && <p className="warn">{gateError}</p>}
                    </div>
                    <div className="row right">
                      <button onClick={cancelAnswer} disabled={busy !== null}>
                        {t('common.cancel')}
                      </button>
                      <button
                        className="primary"
                        disabled={busy !== null || !answer.trim()}
                        onClick={() => void resolveGate(gate.id, answer)}
                      >
                        {t('jobs.node.answer')}
                      </button>
                    </div>
                  </>
                )
              })()
            ) : asking !== null ? (
              <>
                {/* .detail-filter/.detail-clear 를 NewTaskModal 과 같이 빌린다 — 무엇을 하고 있는지
                    보여 주던 자리를 그대로 쓴다 */}
                <div className="detail-filter">
                  <b>{t('jobs.node.gate')}</b>
                  <button
                    className="detail-clear"
                    title={t('common.cancel')}
                    aria-label={t('common.cancel')}
                    onClick={cancelAsk}
                  >
                    ✕
                  </button>
                </div>
                <div className="detail-task-fields">
                  <div className="field">
                    <label>{t('jobs.node.gateQuestion')}</label>
                    <textarea
                      rows={4}
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      autoFocus
                    />
                  </div>
                  {/* NewTaskModal 과 같은 자리 — 이 폼에만 있는 실패는 이 폼 안에서 죽는다 */}
                  {gateError && <p className="warn">{gateError}</p>}
                </div>
                <div className="row right">
                  <button onClick={cancelAsk} disabled={busy !== null}>
                    {t('common.cancel')}
                  </button>
                  <button
                    className="primary"
                    disabled={busy !== null || !question.trim()}
                    onClick={() => void askQuestion()}
                  >
                    {t('jobs.node.gate')}
                  </button>
                </div>
              </>
            ) : (
              <>
                {selectedTask && (
                  <div className="detail-filter">
                    <TaskGlyph task={selectedTask} />
                    <b>{selectedTask.title}</b>
                    {/* 지정된 계정. **지정이 있을 때만 그린다** — 없는 것이 보통이라 "기본 계정"을
                        늘 적으면 이 줄이 그 낱말로 채워지고, 정작 지정된 Task 가 눈에 안 띈다.
                        그래서 이 칩이 있다는 것 자체가 "이 Task 는 계정이 못박혀 있다"는 뜻이다.
                        이름을 못 찾으면 id 를 적는다 — 지워진 계정을 가리키는 지정이고, 그것을
                        감추면 왜 이 Task 가 Gate 로 가는지 화면에 남지 않는다. */}
                    {selectedTask.accountId !== undefined && (
                      <span
                        className="detail-chip"
                        title={t('jobs.task.accountHint')}
                      >
                        {accounts?.find((a) => a.id === selectedTask.accountId)?.label ??
                          selectedTask.accountId}
                      </span>
                    )}
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
                    const sessionId =
                      e.sessionId && canOpenSession(e.sessionId) ? e.sessionId : undefined
                    // dispatch-started 의 요약은 provider 이름 그대로다(timeline.ts) — 배지가 이미
                    // 그것을 적고 있으므로 아래 줄을 비운다
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
                              {e.provider && (
                                <span className="detail-chip provider">{e.provider}</span>
                              )}
                              {e.retry && (
                                <span className="detail-chip retry">{t('jobs.timeline.retry')}</span>
                              )}
                              {e.review && (
                                <span className="detail-chip review">{t('jobs.event.review')}</span>
                              )}
                              {/* 결과가 실린 메시지에만 나온다. **이 줄이 워커가 실패를 보고했다는
                                  사실의 유일한 기록이다** — applyWorkerDone 은 두 번째 메시지를
                                  만들지 않고, 타임라인에는 Task 상태 변화 이벤트가 없다 */}
                              {e.outcome && (
                                <span className={`detail-outcome o-${e.outcome}`}>
                                  {t(
                                    e.outcome === 'succeeded'
                                      ? 'jobs.event.succeeded'
                                      : 'jobs.event.outcomeFailed'
                                  )}
                                </span>
                              )}
                              {/* 어느 Task 의 일인가. 걸러 놓은 동안에는 위의 필터 줄이 이미 같은
                                  말을 하고 있어서 적지 않는다 */}
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
                {/* 가려진 개수. 이것이 없으면 걸러 놓은 화면과 이벤트가 원래 적은 Run 이 같아
                    보인다 */}
                {selectedTask && hidden > 0 && (
                  <p className="detail-hidden">{t('jobs.detail.hidden', { count: hidden })}</p>
                )}
              </>
            )}
          </div>
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
  onOpenSession,
  canManualStart,
  formOpen,
  onStart,
  onStop,
  onGate,
  onAnswer,
  onRestart
}: {
  tasks: JobTask[]
  layers: string[][]
  deps: Record<string, string[]>
  cyclic: string[]
  selected: string | undefined
  /** null 이면 평소(필터 모드) — 배열이면 그 배열에 든 것이 지금 고른 의존이다. onSelect 뒤에서
   *  RunDetail 이 이미 모드를 갈랐으므로(onNodeClick) 여기서는 어느 쪽 뜻인지 몰라도 그리기만 하면
   *  된다: 이 컴포넌트는 판단하지 않는다는 파일 머리말의 규칙과 같다. */
  onSelect: (taskId: string) => void
  canOpenSession: (sessionId: string) => boolean
  onOpenSession: (sessionId: string) => void
  /** 띄우기 버튼을 보일지 — 이 Run 의 동시 실행 한도가 1 이하이고 **그리고** provider 가 있을
   *  때만이다(RunDetail.canManualStart 의 주석에 둘 다, 각각 왜인지 적혀 있다). 판단은
   *  RunDetail 이 하고 여기는 결과만 받는다 — 이 컴포넌트는 판단하지 않는다는 파일 머리말의
   *  규칙과 같다. */
  canManualStart: boolean
  /** Task 짓기 폼이 열려 있거나, 질문을 쓰는 중이거나, 명령이 도는 중이다(RunDetail.formOpen).
   *  참이면 노드의 버튼(↗ 포함)을 전부 숨긴다 — 다른 버튼을 눌러 지금 하는 일을 조용히 버리지
   *  못하게 한다. */
  formOpen: boolean
  onStart: (taskId: string) => void
  onStop: (taskId: string) => void
  /** 물어보기 버튼을 누른 결과 — 명령을 바로 보내지 않고 질문을 쓸 폼을 연다(RunDetail 이 asking
   *  을 세운다) */
  onGate: (taskId: string) => void
  /** 답하기 버튼을 누른 결과 — onGate 와 같은 관례로 명령을 보내지 않고 답을 쓸 폼을 연다 */
  onAnswer: (taskId: string) => void
  onRestart: (taskId: string) => void
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
    // 열린 Dispatch 가 있는지는 provider(그리고 startedAt)의 유무로만 안다 — 스냅샷에 Dispatch
    // 배열 자체가 없으므로 이것이 유일한 신호다(view.ts 의 jobTaskOf 주석과 brief 의 Step 2).
    const dispatchOpen = task.provider !== undefined
    const showStart = canManualStart && (task.status === 'ready' || task.status === 'pending')
    const showGate = task.status === 'ready' || task.status === 'pending'
    const showStop = task.status === 'dispatched' && dispatchOpen
    const showRestart = task.status === 'failed' || (task.status === 'dispatched' && !dispatchOpen)
    // 열린 Gate 가 있어야 답할 것이 있다. blocked 인데 gate 가 없는 조합은 만들어지지 않지만
    // (blocked 로 가는 길이 createGate 뿐이다) 판정이 그 사실에 기대지 않는다 — 기대면 그
    // 불변식이 깨지는 날 답할 것 없는 버튼이 뜬다
    const showAnswer = task.status === 'blocked' && task.gate !== undefined
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
        <TaskGlyph task={task} />
        <span className="detail-node-title">{task.title}</span>
        {/* 세션 열기·띄우기·멈추기·물어보기·다시 띄우기 — 노드 안의 버튼들. formOpen 인 동안은
            전부 숨긴다: Task 짓기·질문 쓰기 폼이 열려 있거나 다른 명령이 도는 동안 이 버튼 중
            하나를 누르면 그 폼이나 그 명령의 결과를 조용히 버리게 된다(RunDetail.formOpen 의
            주석). 세션 열기(↗)는 원래 있던 버튼이지만 이 규칙은 새로 더한 네 버튼과 똑같이
            적용한다 — 노드 버튼이 하나든 다섯이든 "폼이 열려 있는 동안 무엇을 하는가"의 답은
            하나여야 한다.
            각 버튼은 onClick 에서 stopPropagation 을 부른다 — 노드 자신의 onClick(필터)으로
            새지 않게 한다. */}
        {!formOpen && (
          <>
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
            {showStart && (
              <button
                className="detail-node-btn"
                title={t('jobs.node.start')}
                aria-label={t('jobs.node.start')}
                onClick={(ev) => {
                  ev.stopPropagation()
                  onStart(task.id)
                }}
              >
                ▶
              </button>
            )}
            {showGate && (
              <button
                className="detail-node-btn"
                title={t('jobs.node.gate')}
                aria-label={t('jobs.node.gate')}
                onClick={(ev) => {
                  ev.stopPropagation()
                  onGate(task.id)
                }}
              >
                <LockIcon />
              </button>
            )}
            {/* 답하기 — Gate 가 열려 있는 blocked 노드에만. 이 버튼이 이 슬라이스의 전부다: 앱은
                Gate 를 열고(위 `?`) 보여 주기만 하고 푸는 곳이 아무 데도 없었다. */}
            {showAnswer && (
              <button
                className="detail-node-btn"
                title={t('jobs.node.answer')}
                aria-label={t('jobs.node.answer')}
                onClick={(ev) => {
                  ev.stopPropagation()
                  onAnswer(task.id)
                }}
              >
                <UnlockIcon />
              </button>
            )}
            {showStop && (
              <button
                className="detail-node-btn"
                title={t('jobs.node.stop')}
                aria-label={t('jobs.node.stop')}
                onClick={(ev) => {
                  ev.stopPropagation()
                  onStop(task.id)
                }}
              >
                ⏹
              </button>
            )}
            {showRestart && (
              <button
                className="detail-node-btn"
                title={t('jobs.node.restart')}
                aria-label={t('jobs.node.restart')}
                onClick={(ev) => {
                  ev.stopPropagation()
                  onRestart(task.id)
                }}
              >
                ▶
              </button>
            )}
          </>
        )}
      </div>
    )
  }

  return (
    <>
      {/* 스크롤은 **이 안에서만** 돈다 — 범례는 이 밖에 있어 무엇을 스크롤하든 칸의 왼쪽 아래에
          그대로 붙어 있다. 선의 색을 설명하는 글이 스크롤에 밀려 사라지면, 색을 물어볼 자리가
          화면에서 없어진다(선에는 툴팁을 달 곳이 없다). */}
      <div className="detail-scroll">
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
    </>
  )
}
