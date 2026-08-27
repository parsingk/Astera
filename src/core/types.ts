import type { RunConfig, RunStatus } from './run/config'
export type { RunConfig, RunStatus } from './run/config'
import type { RunContext } from './run/build'
export type { RunContext } from './run/build'
import type { Jdk } from './run/jdk'
export type { Jdk } from './run/jdk'
import type { PythonInterpreter } from './run/python'
export type { PythonInterpreter } from './run/python'
// This file already has a HistoryEntry for session history, so the local-history one comes in under
// an alias. A deletion snapshot entry (originalPath, deletedAt, size, isDir) merely shares the name
// with that session history entry; the two types are unrelated.
import type { HistoryEntry as LocalHistoryEntry } from './files/localHistory'
export type { HistoryEntry as LocalHistoryEntry } from './files/localHistory'
import type { Lang, LangPreference, Message } from './i18n'
import type { ScheduleRule, ScheduleConfig } from './scheduler/rule'
export type { ScheduleRule, ScheduleConfig } from './scheduler/rule'
import type { RollConfig } from './rolling/types'
export type { RollConfig } from './rolling/types'
import type { GitState } from './git/status'
export type { GitState } from './git/status'
import type { Provider } from './providers/meta'
import type { TerminalFont } from './terminal/font'
import type { ThemeId } from './theme/themes'
// The Jobs sidebar shows a Task's status, so the orchestration domain's own enum comes in here. Only
// orchestration/types.ts is safe to reach for: its single import is a type-only providers/meta.ts,
// already in tsconfig.web.json, so putting it in the renderer's compilation target pulled nothing
// else in with it. state.ts and view.ts never may, for two different reasons — view.ts imports
// isSamePath from files/tree.ts, which imports node:path; state.ts is node-free but is main-side by
// role (the server owns OrchState) and is deliberately out of tsconfig.web.json, so importing it
// here is what would put it back in. Either way the wrong fix is "types": ["node"] — it makes the
// import resolve by handing the renderer typecheck every Node global, which is the guard this note
// stands to protect.
import type { MessageType, Outcome, TaskStatus } from './orchestration/types'
export type { MessageType, TaskStatus } from './orchestration/types'

// providers/meta.ts owns Provider. It is re-exported here so that the files which already imported
// Provider from types can stay as they are.
export type { Provider } from './providers/meta'

export interface Account {
  id: string
  label: string
  configDir: string
  color: string
  createdAt: string // ISO 8601
  // There is no isDefault field. Which account is the default is derived per provider from this list plus
  // the login state (accounts/defaultAccount.ts), so it cannot be decided one account at a time.
  provider?: Provider // which CLI — absent means 'claude' (kept for compatibility with existing accounts.json)
}

export interface DetectCandidate {
  configDir: string
  loggedIn: boolean // the verdict from accounts/loginStatus.ts (claude also checks Keychain on macOS)
  suggestedLabel: string // email, falling back to the folder name; ~/.claude is 'default account'
  provider: Provider // distinguishes the sources when detection results are merged
}

export interface CliStatus {
  ok: boolean
  version?: string
}

export type SessionStatus = 'running' | 'exited'

export interface SessionInfo {
  id: string
  accountId: string
  cwd: string
  status: SessionStatus
  exitCode?: number
  title: string
  resumeSessionId?: string
  rollAccountIds?: string[] // rolling account order; [0] is the initial account. One element waits out the reset instead of switching (every Job worker is one)
  rollPrompt?: string // the carry-on prompt sent when rolling (empty means the default). Only meaningful on the initial spawn
  slackNotify?: boolean // Slack progress notifications — decides hook injection and notifier registration at spawn, and propagates through rolling respawns
  bypassPermissions?: boolean // start without permission prompts — passes --dangerously-skip-permissions at spawn, propagates through rolling and resume
  schedule?: ScheduleConfig // recurring command schedule — only meaningful on the initial spawn; the coordinator owns its lifetime afterwards
}

/** The stored settings the resume modal reads to seed its checkboxes.
 *  A read-only snapshot — what actually gets enabled is settled by the modal and passed down as
 *  spawn opts. */
export interface ResumeDefaults {
  roll: RollConfig | null
  schedule: ScheduleConfig | null
}

/** 워크트리 항목의 상태. **'missing' 은 없다** — 폴더가 사라진 항목은 listWithStatus 가 목록을
 *  만들면서 레지스트리에서 걷으므로(그쪽 주석) 화면까지 오지 않는다. 남는 질문은 "git 이 이 폴더를
 *  아는가" 하나다. */
export type WorktreeStatus = 'ok' | 'orphan-dir'

/** A git worktree record the app created — persisted in worktrees.json */
export interface WorktreeInfo {
  id: string // randomUUID
  repoPath: string // the original repo root (normalised with path.resolve)
  path: string // absolute path of the worktree
  name: string // slug (the directory name)
  branch: string // <username>/<slug>[-N]
  baseRef: string // short form of the base at creation time (e.g. origin/main)
  createdAt: string // ISO 8601
}

export interface WorktreeListItem extends WorktreeInfo {
  status: WorktreeStatus // result of cross-checking `git worktree list` against directory existence
}

/** One branch offered as a worktree base. Declared here rather than in worktrees/git.ts because the
 *  renderer needs the shape and that module imports node:child_process — tsconfig.web.json whitelists
 *  node-free core files, so git.ts can never be one of them. */
export interface BranchRef {
  name: string // short form — 'main' or 'origin/main'
  remote: boolean // came from refs/remotes/
  current: boolean // the local HEAD branch
  updatedAt: string // ISO 8601 committer date, for display
}

export interface WorktreeRemoveResult {
  removed: boolean
  branchDeleted: boolean
  branchPreserved?: { branch: string; head: string } // set when an unmerged branch was preserved
}

export interface HistoryEntry {
  id: string // `${accountId}:${sessionId}`
  accountId: string
  sessionId: string
  projectPath: string
  title: string // the last user message, falling back to the first real user message, then to sessionId
  updatedAt: string // ISO 8601 (the file's mtime)
  filePath: string
  awaitingReply: boolean // true when the last meaningful message was the assistant's — drives the unread-reply marker (green dot)
  rootUuid: string | null // the key that identifies a resume fork (the same conversation)
}

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp?: string
}

export interface TranscriptPreview {
  entryId: string
  messages: TranscriptMessage[]
  truncated: boolean
}

export interface HistoryFilter {
  accountId?: string
  projectPath?: string
}

export interface HistoryPageRequest extends HistoryFilter {
  offset?: number
  limit?: number
}

export interface HistoryPage {
  entries: HistoryEntry[]
  total: number
}

/** One row of the per-project history list (the session list is fetched separately when the row is
 *  expanded via page()).
 *  A lazy model: built cheaply from a folder listing, mtimes, and the cwd of the newest file. Session
 *  counts and unread tallies need transcript parsing, so a collapsed row does not offer them — expand
 *  the row and read them off the session list. */
export interface ProjectSummary {
  accountId: string
  projectPath: string
  name: string // the last path segment of projectPath (for display)
  updatedAt: string // ISO — mtime of that project's newest file
}

/** history.deleteProjects 의 결과. reason 은 SESSION:<제목> / RUN:<이름> / FAILED 중 하나다 —
 *  문장이 아니라 태그로 오는 이유는 worktrees 쪽과 같다(번역은 렌더러의 몫). */
export interface HistoryDeletionResult {
  deleted: string[]
  skipped: { projectPath: string; reason: string }[]
}

export interface HistoryProjectsPageRequest {
  accountId?: string
  offset?: number
  limit?: number
  /** Project paths the renderer is hiding. Optional like accountId — absent filters nothing, so a
   *  caller that does not know about the field keeps the old behaviour. */
  hiddenPaths?: string[]
}

export interface HistoryProjectsPage {
  projects: ProjectSummary[]
  total: number
}

/** One rate-limit window (the 5-hour session window, or the weekly one) — usage % and reset time */
export interface RateLimitWindow {
  usedPercent: number // 0-100 (rounded to an integer)
  resetsAt: string | null // ISO 8601, null when unknown
}

/** The result of asking the account API for its usage directly. Unlike the statusLine snapshot
 *  (SessionUsage) this is fetched independently of session state, so it still answers with the current
 *  figure when a session halted by a limit has left that snapshot frozen at a stale value.
 *  status: 'ok' = at least one window was obtained, 'unavailable' = no credentials, 'error' = the
 *  request or the parse failed. */
export interface RateLimitUsage {
  session: RateLimitWindow | null // the 5-hour window
  weekly: RateLimitWindow | null // the weekly (7-day) window
  /** The highest usage % across every limit bucket (session, weekly_all, weekly_scoped and so on) —
   *  this is the value the limit verdict uses. The two windows alone are not enough; see the comment
   *  on maxPercentOf in core/usage/rateLimit.ts. */
  maxPercent: number | null
  status: 'ok' | 'unavailable' | 'error'
}

/** A usage snapshot for an active session, taken from the Claude Code statusLine payload
 *  (context_window, rate_limits). The values are Claude's own, so no context-window-size (200k/1M)
 *  heuristics and no credentials are needed. */
export interface SessionUsage {
  context: { usedPercent: number; usedTokens: number | null; windowSize: number | null } | null
  session: RateLimitWindow | null // the 5-hour window
  weekly: RateLimitWindow | null // the weekly (7-day) window
}

/** Rolling progress (main to renderer, for the terminal banner) */
export interface RollStateEvent {
  sessionId: string
  // 'nudged' and 'stalled' are momentary events, not lasting states — the renderer leaves them out
  // of the banner and only Slack is told (see TerminalView.rollBannerVisible)
  state: 'switching' | 'trust' | 'waiting' | 'nudged' | 'stalled' | 'none'
  accountLabel?: string // the account being switched to, when state='switching'
  // A re-publish of state='switching' (reattaching the banner to the new sessionId after a respawn).
  // It is not a new switch, so the renderer treats it the same but Slack ignores it to avoid a
  // duplicate notification
  reattach?: boolean
  nextRetryAt?: string // ISO — the retry time, when state='waiting'
  scope?: 'session' | 'weekly' // which limit, when state='waiting' — selects the banner wording and time format
}

/** Schedule progress (main to renderer, for the terminal banner) */
export interface SchedStateEvent {
  sessionId: string
  state: 'active' | 'off' // off covers turning it off, the session ending, and clearing the old id when rolling re-keys it
  nextAt?: string // ISO — the next run time, when state='active'
  rule?: ScheduleRule // for the rule summary shown in the banner
}

/** One project terminal */
export interface TerminalInfo {
  id: string
  projectPath: string
}

/** The recent output replayed into xterm when the panel is re-entered */
export interface TerminalBuffer {
  id: string
  buffer: string
}

/** One Task row of the Jobs sidebar. A projection of the orchestration Task, folded in main —
 *  OrchState itself never crosses the bridge (it carries messages, deliveries and dispatch records
 *  the view has no use for, and it would make the renderer re-derive what main already computed). */
export interface JobTask {
  id: string
  title: string
  status: TaskStatus
  /** The worker session this Task was dispatched to, when this app process still has that session —
   *  so it is present for a worker that has exited as well as a running one, because the tab is still
   *  there either way. Absent means there is no tab to open and the Jobs view draws the row as
   *  unclickable: the Task was never dispatched, or its Dispatch is from a previous app run, or the
   *  worker is mid-launch and its real session id does not exist yet. */
  sessionId?: string
  /** 사람이 이 Task 에 지정해 둔 계정들, 순서대로(Task.accountIds). 상세 창의 `띄우기` 가
   *  스케줄러와 **같은 계정**을 고르려면 이 값이 필요하다 — 없으면 그 버튼이 기본 계정으로 띄워,
   *  같은 Task 가 누가 띄웠는지에 따라 다른 계정에서 돌게 된다. */
  accountIds?: string[]
  /** 가장 이른 열린 Gate. 없으면 이 칸이 없다.
   *
   *  **셋을 한 묶음으로 싣는다.** 한때 질문만 따로 실었는데, 화면에서 답하려면 `gate-resolve` 가
   *  요구하는 **id** 가 있어야 하고 선택지(gate-create --options)도 있어야 한다. 따로 실으면 셋이
   *  같은 Gate 를 가리킨다는 것을 아무것도 강제하지 않아, 그중 하나만 고쳐지는 날 화면이 A 의
   *  질문을 보여 주고 B 를 푼다. 묶어 두면 "열린 Gate 가 있나"도 검사 하나가 된다.
   *
   *  나머지 열린 Gate 는 아래 openGates 가 개수로만 말한다 — 한 번에 하나씩 답하는 자리이고,
   *  답하면 그다음 것이 이 자리로 올라온다. */
  gate?: { id: string; question: string; options?: string[] }
  openGates: number
  /** The provider of the Dispatch that is **running this Task right now**. A Dispatch that has ended
   *  does not count — the sidebar's rows are the running ones, and this is the field that badge draws
   *  from. */
  provider?: Provider
  /** That Dispatch's startedAt. The renderer counts elapsed time from this with formatElapsed. */
  startedAt?: string
  /** 지금 리셋을 기다리는 중이면 그 계정과 리셋 시각. **열린 Dispatch 의 마지막 이력 항목에
   *  `resumedAt` 이 없을 때만 있다** — 끝난 Dispatch 의 열린 항목은 아무도 기다리지 않는 것이다
   *  (앱이 꺼져 outcome_unknown 으로 닫힌 경우가 그 갈래다).
   *
   *  `resetsAt` 이 없는 대기도 있다 — 계정을 바꾸는 정지는 리셋 시각이라는 값 자체가 없고,
   *  `'waiting'` 이어도 provider 가 시각을 주지 않는 경우가 있다. 화면은 시각 없이 "기다리는 중"
   *  만 그린다. */
  waiting?: { accountId: string; resetsAt?: string }
  /** 이 Task 가 몇 번 이어졌는가 — **닫힌** 이력 항목의 수. 0 이면 이 칸이 없다. */
  resumes?: number
}

export type JobEventKind =
  | 'run-created'
  | 'task-created'
  | 'dispatch-started'
  | 'message'
  | 'gate-opened'
  | 'gate-resolved'
  | 'limit-hit'
  | 'resumed'

/** 타임라인 한 줄. 저장된 레코드가 아니라 core/orchestration/timeline.ts 가 파생한 값이다.
 *  Jobs 사이드바의 JobTask 와 같은 자리에 있는 이유도 같다 — 렌더러가 그리는 투영이다. */
export interface JobEvent {
  /** ISO 시각. 정렬 기준이고 화면에 그대로 쓰인다 */
  at: string
  kind: JobEventKind
  /** 이 이벤트를 만든 레코드의 id. **종류 안에서만 유일하다** — 한 Gate 가 열림과 해제 두
   *  이벤트를 만들므로, 렌더러의 key 는 kind 와 함께 써야 한다 */
  sourceId: string
  taskId?: string
  /** Task 제목. 렌더러가 Task 를 다시 찾지 않게 여기서 붙인다 */
  taskTitle?: string
  /** kind === 'message' 일 때만. 배지 문구를 이것으로 고른다 */
  messageType?: MessageType
  /** 한 줄 요약 */
  summary: string
  /** 펼쳤을 때 보이는 본문. 없을 수 있다 */
  body?: string
  outcome?: Outcome
  /** kind === 'dispatch-started' 일 때만 */
  provider?: Provider
  /** 재시도로 뜬 워커인가 (Dispatch.retryOf) */
  retry?: boolean
  /** 검토 Dispatch 인가 (Dispatch.review). 한 Task 에 구현과 검토의 dispatch-started 가 둘 나오므로,
   *  구별하지 않으면 같은 Task 를 두 번 시작한 것처럼 보인다 */
  review?: boolean
  /** 이 앱이 아직 아는 세션이면 그 id — 클릭하면 그 탭으로 간다. view.ts 의 jobTaskOf 와 같은
   *  판정이고 같은 이유로 주입받는다 */
  sessionId?: string
}

/** 상세 창이 한 번에 받는 것. 이벤트만 오던 것을 그래프까지 함께 주도록 넓혔고, 그래서 이름이
 *  timeline 이 아니다 — 창이 열릴 때 한 번 부르므로 두 번 왕복할 이유가 없다. */
export interface RunDetail {
  events: JobEvent[]
  /** 의존 깊이별 Task id (core/orchestration/graph.ts) */
  layers: string[][]
  /** Task id → 이 Run 안의 의존 id. **선을 긋는 것은 이것이고 layers 가 아니다** — 층은 자리만
   *  정하고, 어느 노드가 어느 노드를 기다리는지는 층에서 되살릴 수 없다(층을 건너뛰는 의존이 있고,
   *  같은 층의 모든 노드가 아래 층의 모든 노드를 기다리는 것도 아니다). */
  deps: Record<string, string[]>
  /** 깊이를 정할 수 없는 Task — deps 에 순환이 있다 */
  cyclic: string[]
}

/** Run 이 끝났는지 — Task 상태에서 계산된다. 저장되지 않는다.
 *
 *  여기(web 포함 파일)에 선언하는 이유: JobRun 이 이 타입을 필드로 갖고, 그것을 계산하는
 *  core/orchestration/view.ts 는 node:path 를 끌고 와서 tsconfig.web.json 에 넣을 수 없다.
 *  그래서 타입은 이쪽이 선언하고 view.ts 가 가져간다 — TaskStatus 와 같은 방향이다. */
export type RunOutcome = 'running' | 'completed' | 'failed'
export interface JobRun {
  id: string
  objective: string
  /** 이 Run 의 워커를 띄울 provider — Run(core/orchestration/types.ts)이 들고 있는 값을 그대로
   *  옮긴 것이다. **여기서 계산하거나 기본값을 채우지 않는다** — CLI 가 --provider 없이 만든
   *  Run 에는 이 값이 없을 수 있고(schedule.ts 의 slotsToFill 이 그런 Run 을 건너뛰는 것과 같은
   *  사정), 그것을 감추면 "이 Run 은 무엇으로도 못 띄운다"는 사실이 사라진다. 기본값을 적용하는
   *  것은 이 값을 쓰는 쪽(RunDetail.tsx)의 일이다. */
  provider?: Provider
  /** 이 Run 이 동시에 열어 둘 Dispatch 수 — Run 이 들고 있는 값을 그대로 옮긴 것이다. 없으면
   *  DEFAULT_CONCURRENCY(core/orchestration/types.ts) 인데, 그 기본값도 여기서 채우지 않는다 —
   *  provider 와 같은 이유다. */
  concurrency?: number
  /** 저장된 값이 아니라 Task 에서 계산된다 — core/orchestration/view.ts 의 outcomeOf */
  outcome: RunOutcome
  done: number
  total: number
  /** 이 Run 의 타임라인 이벤트 수(core/orchestration/timeline.ts 의 eventCountFor).
   *
   *  **화면에 그리지 않는다.** 이 값의 일은 sameSnapshot 을 깨우는 것이다 — Task 상태도
   *  openGates 도 움직이지 않는 메시지(질문, 워커의 진행 보고)는 나머지 필드를 하나도 바꾸지
   *  않아서, 이 숫자가 없으면 그 이벤트가 도착해도 푸시가 나가지 않는다. 시각이 아니라 개수인
   *  이유: 한 번의 쓰기가 여러 레코드에 같은 now 를 찍으므로 시각은 바뀌지 않을 수 있다. */
  eventCount: number
  /** 이 Run 의 워커가 프로젝트 폴더에 있고 **다른 Run 의 워커도 거기 있는가.** 사이드바가 그 줄을
   *  경고 톤으로 그리는 근거다.
   *
   *  막지 않고 표시만 한다. 한 폴더의 워커 여럿이 늘 위험한 것은 아니다 — 파일을 안 건드리는
   *  세션이면 충돌할 것이 없고, 앱은 그것을 알 수 없다. 조용히 슬롯을 건너뛰면 "이유 없이 안 도는
   *  Task" 가 되는데, 그것이 이 기능 계열이 없애려는 증상이다.
   *
   *  **왜 이 값이 필요한가**: 상한이 1 이면 배치 규칙이 워커를 프로젝트 폴더에 두는데(2 이상이면
   *  전부 워크트리), 그 안전 논거는 "상한 1 이면 그 폴더에 한 번에 하나"였다. 그 보장이 **Run
   *  별이고 위험은 폴더별**이라, 같은 프로젝트에 상한 1 인 Run 을 둘 만들면 각자 1슬롯씩 받아
   *  워커 둘이 그 폴더에서 동시에 일한다. 그때 커밋 의무도(cwd 가 Run 의 cwd 와 같아 붙지 않는다)
   *  병합 단계도(deps 가 같은 폴더에서 돌아 pendingMerges 가 비었다) 지나지 않아 **앱의 어떤
   *  기계도 알아채지 못한다.** 이 화면 말고는 아무도 그것을 말해 주지 않는다. */
  sharesProjectFolder: boolean
  /** 이 Run 의 Dispatch 가 쓴 워크트리 경로들 — 삭제 모달이 개수를 적고, 감추기 체크박스가 이
   *  경로들을 히스토리 숨김 목록에 넣는다. 비어 있으면 그 Run 은 프로젝트 폴더에서만 일했다
   *  (동시 실행 1 의 배치 규칙). */
  worktrees?: string[]
  /** 사용자가 아직 '실행' 을 누르지 않았다 — Run 이 들고 있는 값을 그대로 옮긴 것이다.
   *  상세 창의 실행 버튼과 사이드바의 표시가 이 값으로 판단한다. */
  pendingStart?: boolean
  /** 사람이 이 예약을 세워 뒀다. 사이드바가 '⏸' 를 '▶' 로 바꾸고 '다음 …' 대신 '일시 중지됨' 을
   *  적는 근거다 — 세우면 무장하지 않으므로(firesDue) 그 줄이 그냥 사라지고, 말이 없으면 세운 예약과
   *  도는 예약이 화면에서 같아 보인다. */
  paused?: boolean
  /** 이 Run 이 예약 템플릿이면 그 규칙 — Run 이 들고 있는 값을 그대로 옮긴 것이다. 있으면 이
   *  줄은 정의이고 스스로 돌지 않는다. 사이드바가 "매일 09:00" 을 적는 근거다. */
  schedule?: ScheduleRule
  /** 다음 발화 시각(epoch ms). 템플릿만 갖는다.
   *
   *  **저장된 값이 아니다** — ticker 가 메모리에 들고 있는 값이라 주입으로 들어온다
   *  (snapshotFor 의 nextFireOf). 렌더러가 스스로 계산할 수 없는 이유는 interval 이다:
   *  "무장 시각 + N분" 이라 그 앵커를 렌더러가 모른다. */
  nextFireAt?: number
  /** 이 템플릿이 지금까지 발화한 횟수 — Run 이 들고 있는 값을 그대로 옮긴 것이다.
   *  **children.length 와 다른 질문이다**: 기록을 지우거나 TTL 이 정리해도 이 값은 줄지 않는다. */
  fireCount?: number
  /** 이 회차가 몇 번째 발화인가. 자식만 갖는다. */
  fireOrdinal?: number
  /** 이 템플릿의 회차들, 최신순. 접힌 회차는 OrchSnapshot.runs 의 최상위에서 빠진다.
   *
   *  **예약이 아닌 Run 에는 이 칸이 아예 없다.** 빈 배열을 달면 sameSnapshot 의 문자열이 이유
   *  없이 길어지고, 화면에서 "회차가 아직 없는 템플릿"과 "템플릿이 아님"이 같아 보인다. */
  children?: JobRun[]
  tasks: JobTask[]
}
export interface OrchSnapshot {
  runs: JobRun[]
  /** 이 프로젝트 폴더에서 지금 일하는 워커가 하나라도 있는가. **새 Run 을 만드는 창이 읽는다.**
   *
   *  위의 Run 별 값으로는 이 질문에 답할 수 없다 — 만들 때 그 Run 은 아직 없고, 기존 Run 하나가
   *  **혼자** 일하고 있으면 그 Run 의 sharesProjectFolder 는 거짓인데 상한 1 짜리를 하나 더 만드는
   *  순간 둘이 얽힌다. 그 경우를 놓치지 않으려고 폴더 사실을 따로 싣는다. */
  projectFolderBusy: boolean
}

export interface CoreEvents {
  'session:data': { sessionId: string; data: string }
  'session:exit': { sessionId: string; exitCode: number }
  // main created a session without the renderer asking — an orchestration worker. The whole
  // SessionInfo is carried so the renderer can build the tab (the same value sessions.spawn returns).
  // It is not emitted on the user path (sessions.spawn) — doing so would place the same session twice.
  'session:created': SessionInfo
  'session:rolled': { oldSessionId: string; info: SessionInfo } // tab swap on rolling
  'session:rollState': RollStateEvent
  'session:busy': { sessionId: string; busy: boolean } // session working/idle — the spinner dot on the tab
  'session:schedState': SchedStateEvent // schedule banner
  'history:updated': { total: number }
  'accounts:changed': { accounts: Account[] }
  // The unregistered history sources were re-scanned (fires after an account is added or removed)
  'accounts:ghostsChanged': { accounts: Account[] }
  'files:changed': { path: string; kind: 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir' } // watcher
  'git:changed': void // index/HEAD changes in the git dir, e.g. a commit from a session terminal — triggers a tree state refresh
  'run:data': { projectPath: string; data: string } // run output
  'run:status': RunStatus // run state change (running/exited)
  'terminal:data': { id: string; data: string } // project terminal output
  'terminal:exit': { id: string; exitCode: number } // shell exited — the renderer removes that tab
  // The Jobs sidebar's whole snapshot, re-sent on every orchestration state change. Small enough to
  // send whole (one project's Runs and Tasks) and it removes any question of the renderer's copy
  // drifting from main's. Which project it is folded for is the last one orch.list asked about, after
  // main's worktree-to-repository resolution (see OrchApi) — that call is the only thing that tells
  // main what the renderer has open.
  'orch:state': OrchSnapshot
}
export type CoreEventChannel = keyof CoreEvents

/** The contract the renderer sees as window.api. The IPC adapter implements it. */
export interface CoreApi {
  accounts: {
    list(): Promise<Account[]>
    create(input: { label: string; color?: string; provider?: Provider }): Promise<Account>
    import(input: { label: string; configDir: string; provider?: Provider }): Promise<Account>
    remove(id: string): Promise<void> // deregisters only — the disk is not touched
    loginStatus(id: string): Promise<boolean> // the verdict from accounts/loginStatus.ts (claude also checks Keychain on macOS)
    detect(): Promise<DetectCandidate[]> // detection candidates, excluding registered and unregistered-by-the-user config dirs
    /** Unregistered config dirs as account-shaped history sources — this one keeps the ones the user
     *  unregistered, since their transcripts should stay visible. Never registry accounts: they cannot
     *  authenticate, so they must not reach session spawning, rolling or the account management UI. */
    ghosts(): Promise<Account[]>
    email(id: string): Promise<string | null> // the login email of a registered account (for the list)
    emailOfDir(configDir: string, provider?: Provider): Promise<string | null> // the email of an unregistered folder (to prefill the import dialog)
    logout(id: string): Promise<{ ok: boolean; message?: Message }> // claude auth logout (removes the credentials)
    syncSettings(id: string): Promise<{ ok: boolean; message?: Message }> // import the default account's settings and MCP servers
  }
  sessions: {
    spawn(opts: {
      accountId: string
      cwd: string
      cols?: number
      rows?: number
      resumeSessionId?: string
      resumeTranscriptPath?: string // resuming under a different account — the source transcript to copy into the target configDir
      rollAccountIds?: string[]
      rollPrompt?: string
      slackNotify?: boolean
      bypassPermissions?: boolean // start without permission prompts
      schedule?: ScheduleConfig // recurring command schedule
    }): Promise<SessionInfo>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    ack(id: string, bytes: number): void // backpressure driven by the xterm write callback
    kill(id: string): Promise<void>
    list(): Promise<SessionInfo[]>
    /** Reads the stored rolling and schedule settings — prefills the resume modal */
    resumeDefaults(sessionId: string): Promise<ResumeDefaults>
  }
  history: {
    page(req?: HistoryPageRequest): Promise<HistoryPage> // a page of sessions within a project
    projectsPage(req?: HistoryProjectsPageRequest): Promise<HistoryProjectsPage> // a page of projects
    preview(entryId: string): Promise<TranscriptPreview>
    refresh(): Promise<void> // manual fallback when the watcher fails
    /** Deletes those projects transcripts (to the bin). Never touches the project folders themselves.
     *  skipped carries a reason tag per path — the renderer turns it into a sentence. */
    deleteProjects(projectPaths: string[]): Promise<HistoryDeletionResult>
  }
  projects: {
    getDefaultAccount(projectPath: string): Promise<string | null>
    setDefaultAccount(projectPath: string, accountId: string | null): Promise<void>
  }
  worktrees: {
    // Splitting a session off into a git worktree.
    list(): Promise<WorktreeListItem[]>
    create(opts: {
      repoPath: string
      name?: string
      baseRef?: string // the branch to fork from, short form. Absent falls back to automatic detection
    }): Promise<{ info: WorktreeInfo; warnings: Message[] }>
    /** Base-branch candidates for the picker, newest commit first. `detected` is what the automatic path
     *  would have chosen, so the select can preselect it and leave behaviour unchanged when untouched. */
    listBranches(repoPath: string): Promise<{ branches: BranchRef[]; detected: string | null }>
    remove(id: string, opts?: { force?: boolean }): Promise<WorktreeRemoveResult>
    isGitRepo(dir: string): Promise<string | null> // returns the repo root, or null
    getRoot(): Promise<string>
    setRoot(root: string | null): Promise<void>
  }
  usage: {
    session(sessionId: string): Promise<SessionUsage | null> // context, 5-hour, and weekly % for an active session (from statusLine)
  }
  localHistory: {
    // Browsing and restoring the snapshot taken just before a deletion. projectPath uses the same
    // allowed roots as files.*.
    list(projectPath: string): Promise<LocalHistoryEntry[]>
    restore(projectPath: string, id: string): Promise<string> // returns the path actually restored to (uniqueName avoids a name collision)
  }
  scheduler: {
    disable(sessionId: string): Promise<void> // turn off the schedule of a running session — the banner button
  }
  slack: {
    // Webhook, plus bot token and channel, plus app token, plus the allowed Member ID.
    // setConfig takes a partial update — fields that are not sent are merged with the stored values by
    // main and preserved (see slack.setConfig in ipc.ts). The settings modal sends all five, but the
    // partial-update contract is kept so that another caller touching one field leaves the rest alive.
    // appToken is for Socket Mode receiving only, so for now it is stored but unused.
    // memberId is the one Slack Member ID whose thread replies are injected into sessions. It is a
    // receiving-side permission, so it plays no part in choosing the transport — and a missing value
    // blocks every reply rather than allowing everyone (core/slack/inbound.ts).
    getConfig(): Promise<{
      webhookUrl: string | null
      botToken: string | null
      channelId: string | null
      appToken: string | null
      memberId: string | null
    }>
    setConfig(cfg: {
      webhookUrl?: string | null
      botToken?: string | null
      channelId?: string | null
      appToken?: string | null
      memberId?: string | null
    }): Promise<void>
  }
  settings: {
    // App language. `stored: null` is System — the OS locale decides, and `resolved` is what it decided.
    getLang(): Promise<LangPreference>
    setLang(lang: Lang | null): Promise<void>
    // The agent orchestration toggle. Turning it on makes the app run a local HTTP server and plant
    // access to the astera CLI in newly created sessions — it does not apply to sessions that are
    // already open (environment variables are fixed at spawn time).
    getOrchestrationEnabled(): Promise<boolean>
    setOrchestrationEnabled(enabled: boolean): Promise<void>
    // The terminal font pair. Either side may be null, meaning "not chosen" — the renderer then uses
    // the app's default chain for that half.
    getTerminalFont(): Promise<TerminalFont>
    setTerminalFont(font: TerminalFont): Promise<void>
    // The chosen theme id. isThemeId is the trust boundary on the main-process side, so whatever comes
    // back here is always one of the six known ids.
    getTheme(): Promise<ThemeId>
    setTheme(id: ThemeId): Promise<void>
  }
  files: {
    // The file explorer. Every files.* IPC call goes through assertAllowedPath, which permits only
    // paths under a session cwd or a history project.
    list(dirPath: string): Promise<{ name: string; path: string; isDir: boolean }[]>
    read(path: string): Promise<{ content: string; truncated: boolean; binary: boolean }>
    /** 마크다운 프리뷰의 이미지. 바이트를 data URL 로 돌려준다 — read 는 바이너리에 빈 문자열을
     *  주므로 이미지에 쓸 수 없다.
     *  read 와 상한이 다르다(1MB vs 5MB): 저 값은 편집기가 열 텍스트의 상한이고 이 값은 이미지의
     *  상한이라 같은 숫자를 쓸 이유가 없다. 확장자가 허용 목록에 없으면 거부한다 — 확장자에서
     *  MIME 을 만들어 내지 않는다. */
    readDataUrl(path: string): Promise<{ dataUrl: string }>
    write(path: string, content: string): Promise<void> // save a file
    watch(root: string): Promise<void> // start or replace the live-update watcher
    unwatch(): Promise<void>
    create(parentDir: string, name: string, isDir: boolean): Promise<string> // returns the created path
    rename(from: string, newName: string): Promise<string> // returns the new path
    move(from: string, destDir: string): Promise<string>
    // Delete. projectRoot is the project root the explorer is showing (useFileOps' root) — it is
    // required so the snapshot's key lines up with that root exactly. Using the matching root that
    // assertAllowedPath finds internally instead would, with nested cwds, differ from the explorer
    // root and the snapshot could then be missing from the restore list. A Local History snapshot is
    // attempted just before deleting — the deletion always completes even when that attempt is
    // skipped or fails. null means the snapshot was taken normally. snapshotId is that snapshot's id —
    // the journal points at it so Ctrl+Z can restore. With no snapshot (too-large or failed) it is
    // null, and since such a deletion cannot be undone it is not journalled
    // (see useFileOps.removeSelection).
    remove(
      path: string,
      projectRoot: string
    ): Promise<{ snapshotSkipped: 'too-large' | 'failed' | null; snapshotId: string | null }>
    copy(from: string, destDir: string): Promise<string> // duplicate — suffixes ' copy' on a collision
    reveal(path: string): Promise<void> // show in the OS file manager
    countEntries(path: string): Promise<number> // child count for the delete confirmation (stops at 9999)
  }
  git: {
    // Inline status in the tree. root is the root the explorer is showing (same casing as files.list) —
    // the keys of the returned map are absolute paths relative to that root, so they compare directly
    // against a file node's path. An empty map means either not a git repo, or a repo with no changes.
    // null means the lookup itself failed or timed out — the renderer then keeps the previous map
    // rather than overwriting it with an empty one.
    status(root: string): Promise<Record<string, GitState> | null>
    watch(root: string): Promise<void> // start or replace watching the git dir's index and HEAD — emits 'git:changed'
    unwatch(): Promise<void>
  }
  run: {
    // Running and stopping a project. start and list go through assertAllowedPath, which permits only
    // registered project paths.
    // isSpringBoot tells the configuration form whether to offer the Spring profile field
    // (optionalFieldsFor in core/run/types.ts, reached through RunConfigManager's isSpringBoot prop).
    // context is the assembly context (wrapper choice, package manager, platform) — the form's preview
    // calls buildCommand(config, context) so it shows exactly what run.start will actually run.
    list(projectPath: string): Promise<{
      configs: RunConfig[]
      active: RunStatus | null
      recent: string
      isSpringBoot: boolean
      // Whether RunTypePicker should show 'python'/'pytest' as detected (pyproject.toml, requirements.txt,
      // or a *.py file at the project root) — there is no seed config for either kind to key that off of.
      isPythonProject: boolean
      // Whether RunTypePicker should show 'dockerfile' as detected (a Dockerfile at the project root) —
      // same "no seed to key off of" situation as isPythonProject. Not part of RunContext like
      // composeFile is, because nothing in buildCommand's 'dockerfile' case reads context.
      hasDockerfile: boolean
      context: RunContext
    }>
    listActive(): Promise<RunStatus[]> // all active runs — for the count badge and the dropdown
    start(projectPath: string, configId: string): Promise<RunStatus>
    stop(projectPath: string): Promise<void>
    write(projectPath: string, data: string): void
    resize(projectPath: string, cols: number, rows: number): void
    // Both return the **stored** list only — never passed through mergeConfigs, so the auto-detected
    // seeds are not in it. A caller that needs the display list has to refetch with run.list (which is
    // what App.tsx does; it discards these return values).
    saveConfig(projectPath: string, config: RunConfig): Promise<RunConfig[]>
    deleteConfig(projectPath: string, configId: string): Promise<RunConfig[]>
    listJdks(): Promise<Jdk[]> // the detected JDKs — no path argument, so not subject to assertAllowedPath
    // The detected Python interpreters for this project (its venv plus whatever is on PATH). Takes a
    // path — unlike listJdks — because venv candidates live inside the project, so it is subject to
    // assertAllowedPath.
    listPythonInterpreters(projectPath: string): Promise<PythonInterpreter[]>
    // The service names found in this project's compose file (empty if none, or if it could not be
    // parsed) — feeds the compose form's services field hint. Subject to assertAllowedPath, same
    // reasoning as listPythonInterpreters: the compose file lives inside the project.
    listComposeServices(projectPath: string): Promise<string[]>
    // The .csproj/.fsproj/.sln files found in this project (empty if none, or if the scan failed),
    // project-relative — feeds the dotnet form's project Select, and a non-empty list is also what
    // RunTypePicker treats as "dotnet detected here". Subject to assertAllowedPath, same reasoning as
    // listComposeServices.
    listDotnetProjects(projectPath: string): Promise<string[]>
  }
  terminal: {
    // An interactive shell at a project path. open and list go through assertAllowedPath, which
    // permits only registered paths.
    open(projectPath: string, cols?: number, rows?: number): Promise<TerminalInfo>
    list(projectPath: string): Promise<TerminalBuffer[]>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    close(id: string): Promise<void>
  }
}

/** Extras on the Electron side (not core — main handles these directly) */
export interface SystemApi {
  // defaultPath is only where the dialog opens, so it changes nothing about security — the result is
  // already validated by run.start and run.saveConfig. Omitting it behaves exactly as the existing
  // caller (NewSessionDialog) does.
  pickFolder(defaultPath?: string): Promise<string | null>
  // Same contract as pickFolder, for a single file — the run configuration file-path fields (node's
  // file, python's file and interpreter, compose's file, dockerfile's path, dotnet's project file)
  // share this instead of each inventing its own.
  pickFile(defaultPath?: string): Promise<string | null>
  pathExists(p: string): Promise<boolean>
  checkCli(): Promise<{ claude: CliStatus; codex: CliStatus }>
  appVersion(): Promise<string>
  /** 프로젝트가 지정되지 않았을 때 아래쪽 패널의 터미널이 열릴 자리 — 셸을 직접 띄웠을 때와 같은 곳 */
  homeDir(): Promise<string>
  /** 기본 브라우저로 링크를 연다. http/https/mailto 만 통과한다 — 렌더러도 같은 검사를 하지만
   *  거기서의 판정은 UI 를 위한 것이고 실제 경계는 메인이다. */
  openExternal(url: string): Promise<void>
}

/** Clipboard reads (for pasting — the Electron clipboard module exposed synchronously from preload) */
export interface ClipboardApi {
  readText(): string
  writeText(text: string): void
}

/** Auto-update progress (main to renderer, for the title bar) */
export interface UpdateStatus {
  state: 'init' | 'checking' | 'available' | 'uptodate' | 'downloading' | 'downloaded' | 'error'
  version?: string
  percent?: number
  message?: string
}

/**
 * An update campaign. A value is present only when this app falls inside the target version range
 * policy.json specifies — null means no campaign.
 *
 * `notify` is a dismissible notice; `block` is a screen that covers the app.
 */
export type UpdateCampaignMode = 'notify' | 'block'

export interface UpdateCampaignInfo {
  id: string
  mode: UpdateCampaignMode
}

export interface UpdateApi {
  onStatus(cb: (s: UpdateStatus) => void): () => void
  /** The campaign verdict comes after a network policy lookup, so it can arrive later than the
   *  renderer mounts — hence the push as well */
  onCampaign(cb: (c: UpdateCampaignInfo) => void): () => void
  /** And it can arrive earlier than the mount, so it is also queried once */
  campaignState(): Promise<UpdateCampaignInfo | null>
  /** The user dismissed the notice — the same campaign is not shown again */
  dismissCampaign(id: string): Promise<void>
  check(): Promise<void>
  /** autoDownload starts the download on its own — this is the manual fallback */
  download(): Promise<void>
  install(): Promise<void>
}

/** A rolling API for development only — packaged builds do not register the handler, so calls are
 *  rejected there (used for manual end-to-end checks) */
export interface RollingApi {
  forceRoll(sessionId?: string): Promise<void>
}

/** Window controls (not core — the renderer/Electron layer, the same layer as system) */
export interface WindowApi {
  minimize(): void
  maximizeToggle(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximizeChange(cb: (isMax: boolean) => void): () => void
}

/**
 * User keybinding overrides. The renderer knows the defaults from core/keys/binding.ts, and only the
 * overridden actions travel through here — so when a default changes, untouched actions follow it.
 */
export interface KeysApi {
  get(): Promise<Record<string, string[]>>
  set(actionId: string, keys: string[]): Promise<void>
  /** With an actionId, resets just that action; without one, resets everything to the defaults */
  reset(actionId?: string): Promise<void>
}

/** App-level control. On win32/macOS win.close only minimises to the tray (on Linux it quits for
 *  real), so a quit path that works everywhere is needed separately */
export interface AppControlApi {
  quit(): void
}

/**
 * The Jobs sidebar. Not core, for the same reason as system and win: nothing in src/main/core.ts
 * knows about orchestration — the store, the server and this fold all live in the ipc wiring.
 *
 * Not read-only anymore: `command` (see its doc below) is the one mutating door — the app reaches the
 * orchestration command surface (`task-create`, `worker-start`, gate-resolve, …) through
 * it exactly the way the CLI does, rather than through a channel of its own. That reversal is
 * knowledge/decisions/ADR-004's subject. It also was never a question of authorization: COORDINATOR_ONLY
 * (server.ts's set of commands a worker session may not call) only blocks *worker* sessions —
 * server.ts checks `isWorker && COORDINATOR_ONLY.has(cmd)`, and the app's caller id has never owned a
 * Dispatch, so isWorker is always false for it and every command is open to it. What used to be
 * missing was the IPC channel itself, not permission through it.
 *
 * list doubles as the subscription: the snapshot is per project and main is not otherwise told what
 * the renderer has open, so the path passed here also settles what 'orch:state' is folded for.
 * unwatch is the way out — the same pair as files.watch/unwatch and git.watch/unwatch, and without it
 * main keeps folding and sending a snapshot after the view is gone.
 *
 * The path is a *location*, not a project identity: main resolves a registered worktree back to the
 * repository it was created from (core/worktrees/repo.ts) and folds for that, so passing the cwd of a
 * worker running in a `--worktree new` tree returns its repository's Runs rather than nothing. Any
 * path that is not a registered worktree is used as given.
 *
 * **The value list resolves to is the initial payload, and the caller must render it.** 'orch:state'
 * carries subsequent changes only: main records what list handed over and drops a push whose fold is
 * identical to it, so a caller that arms the subscription and discards the result never receives that
 * first state — and nothing later heals it, because the next unchanged write is exactly what the
 * comparison suppresses.
 */
export interface OrchApi {
  list(projectPath: string): Promise<OrchSnapshot>
  /** 한 Run 의 이벤트와 의존 그래프. 스냅샷과 달리 **요청할 때만** 온다 — Message.body 에는
   *  검증 출력 꼬리가 실리므로 매 쓰기마다 밀 수 있는 크기가 아니다. */
  runDetail(projectPath: string, runId: string): Promise<RunDetail>
  /** UI 가 오케스트레이션 상태를 바꾸는 유일한 통로 — server.ts 의 명령 표면을 그대로 부른다.
   *  cmd 는 CLI 와 같은 이름이고(`task-create`, `worker-start`, …) args 도 같은 키를 쓴다.
   *
   *  반환 모양은 server.ts 의 `Reply` 와 같지만 그것을 import 하지 않는다 — 그 타입은 export 되지
   *  않고, core 가 main 을 import 하는 것은 층의 방향과 반대다. 둘이 갈라지면 타입체크가 아니라
   *  이 주석이 알려 준다. */
  command(
    projectPath: string,
    cmd: string,
    args: Record<string, unknown>
  ): Promise<{ status: number; body: unknown }>
  unwatch(): Promise<void>
}

export type RendererApi = CoreApi & {
  system: SystemApi
  clipboard: ClipboardApi
  update: UpdateApi
  rolling: RollingApi
  /** For the renderer's platform branching. It's a synchronous value so it's usable on the very first
   *  render — the titlebar's traffic-light margin and the default shortcuts both depend on it, and an
   *  async value would draw the first frame with the wrong layout.
   *
   *  Why the type is string rather than NodeJS.Platform: this file is registered in tsconfig.web.json
   *  and imported by the renderer too, which has no @types/node and so no global NodeJS namespace to
   *  reference. The only value ever compared against is 'darwin', so string is enough.
   *  (core/run/build.ts's RunContext.platform made the same choice for the same reason — this follows that
   *  convention. Do not fix it with `/// <reference types="node" />`: that drags the entire node
   *  global into the web compilation unit.) */
  platform: string
  win: WindowApi
  app: AppControlApi
  keys: KeysApi
  orch: OrchApi
  on<C extends CoreEventChannel>(channel: C, cb: (payload: CoreEvents[C]) => void): () => void
}
