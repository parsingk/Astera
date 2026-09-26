// The orchestration command layer — every `cmd` the CLI and the app can ask for, and what each one
// does to OrchState.
//
// handleCommand was always kept separate from HTTP because routing, authorization and argument
// validation are the logic worth testing, and HTTP was a thin shell on top of it. **This file is that
// separation being spent** (host control plane design §5): it lives in core so the Host can import it
// without importing Electron, and the Host's `orch-call` handler is now the only shell that calls it
// — the app's loopback HTTP server was removed once nothing reached it any more (§7). Nothing here
// knows whether a dependency is answered locally or across a socket, which is what lets the same
// command layer run in both places.
import { randomBytes } from 'node:crypto'
import {
  ackDelivery,
  applyReply,
  applyReviewResult,
  applyWorkerDone,
  blockForReview,
  closeDispatch,
  createGate,
  createQuestion,
  createJob,
  createTask,
  emptyState,
  latestRun,
  nextDelivery,
  openDispatch,
  resolveGate,
  deleteRuns,
  deleteJobs,
  startJobRun,
  releaseJob,
  jobOf,
  jobOfRunId,
  runIdOf,
  attachCoordinator,
  detachCoordinator,
  pauseSchedule,
  resumeSchedule,
  resumeRun,
  setRunWorktree,
  placedByApp,
  coordinatorStarting,
  type OrchState,
  type RepairTarget,
  type Res
} from './state'
import { CLI_PROTOCOL } from './cliOutput'
import type { SwitchedCommand } from './cliAgentContext'
import { findProject, findProjectByPath } from './projects'
import { workerDoneFieldError } from './sendArgs'
import type { SessionState } from '../hooks/sessionState'
import {
  CHAT_TURNS_DEFAULT,
  CHAT_TURNS_MAX,
  type ChatAnswerResult,
  type ChatPending,
  type ChatPromptList,
  type ChatTurn
} from '../sessions/chatRead'
import {
  DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  FAILURE_LIMIT,
  canTransition,
  isPlaceholderSessionId,
  recomputeReady,
  type ConvergencePolicy,
  type Dispatch,
  type Job,
  type JobRun,
  type MessageType,
  type Task,
  type TaskStatus
} from './types'
import { runWorktrees } from './integrate'
import { buildHandoverPrompt } from './handover'
import { parseReviewFile, type ReviewIssueInput } from './review'
import { nameForRun } from '../worktrees/naming'
import type { Provider } from '../providers/meta'
import { isValidRule, type ScheduleRule } from '../scheduler/rule'
import { parseCheckFlag } from '../workUnit/verification'
import { isTerminal as taskFinished, outcomeOf, progressOf } from './view'
import { runningRunCount } from './running'
import { appDriven } from './schedule'
import type { RunOutcome } from '../types'
import type { SessionCheck } from '../workUnit/types'
import { PTY_LOST_SIGHT_EXIT_CODE } from '../sessions/pty'
import { parseHandoffBody } from '../handoff/parse'
import type { HandoffBody } from '../handoff/types'
import type { Lang } from '../i18n'
import { isOverrideCompletion, policyOf } from './convergence'
import { leftNothingBehind } from '../host/orchProtocol'
import { APP_CALLER, HOST_CALLER } from '../host/driver'

/** One row of `listAccounts`. Named only because the declaration below is a union and repeating the
 *  shape on both sides invites the two halves to drift. */
export interface OrchAccount {
  id: string
  label: string
  provider: Provider
}

/** One run configuration as this layer sees it: what `--validate` takes and what `run-configs`
 *  lists. The rest of a configuration (its command, env, cwd) stays with the app. */
export interface OrchRunConfig {
  id: string
  name: string
  type: string
}

/** One agent session the Host holds — a row of `sessions list` (CLI phase C).
 *
 *  **`id` is the app's id for the session**, not the Host's id for its pty: the app mints a pty id of
 *  its own at spawn (main/host/ptyFactory.ts) and carries the session id in the note. The session id
 *  is the one a person or an agent already has — `ASTERA_SESSION` inside the session, a Dispatch's
 *  `sessionId` — so it is the one every command here takes. The other three fields come out of that
 *  note, which the app writes and nothing checks, so each is `null` when it is not a string. */
export interface HostSession {
  id: string
  /** `terminal` is an agent CLI in a pty; `chat` is a chat session's line process. */
  kind: 'terminal' | 'chat'
  title: string | null
  accountId: string | null
  cwd: string | null
  alive: boolean
  /** Whether a turn is running (`working`) or the session is waiting on a person (`waiting`), read
   *  off the hook event file the capture script appends for it (core/hooks/sessionState.ts);
   *  `unknown` when there is no signal to read — a Codex or chat session, an ended one, no event yet,
   *  or input typed after the last event. */
  state: SessionState
}

/** What `sessions read` shows: a terminal session's scrollback replayed into a terminal at the size
 *  the tab has (host/sessions.ts). `screen` is the visible rows, top first, with the blank rows under
 *  the last painted one dropped; `scrollback` is up to `--lines` rows just above it, oldest first.
 *  Each row is the text in its cells, trailing spaces trimmed. */
export interface SessionScreen {
  cols: number
  rows: number
  screen: string[]
  scrollback: string[]
}

/** What a turn sent to a chat session came to. The app refuses one while the session holds a card
 *  open (an approval or a question): answering it is the person's, in the app, and a turn typed at
 *  it would be read as the answer by nobody and queued behind it by the CLI. */
export type ChatSendResult =
  | { sent: true }
  | { sent: false; pending: ChatPending }
  /** The app is attached but does not hold the session yet (it is taking the Host's sessions back
   *  after a start), or could not say whether a card is open. Nothing was sent; try again. */
  | { sent: false; reason: 'not-held' }

export interface OrchServerDeps {
  getState(): OrchState
  /** `rollsBack`: this commit undoes an earlier commit of **the same command**, and the command left
   *  nothing else behind either (Host S3 follow-up A36). Only worker-start's failure rollback says
   *  so, after its own `openDispatch`, and only when `startWorker`'s error says the start left
   *  nothing (`leftNothingBehind`: refused before acting, or undone before failing). The Host's receipts then count the two commits as none. Every
   *  other wiring may ignore it: it changes nothing about what is written. */
  setState(next: OrchState, how?: { rollsBack: true }): Promise<void>
  /** Filled in by the wiring that wraps the coordinator (OrchCoordinator.startWorker). worker-start
   *  has already created the dispatchId (after committing openDispatch) and passes it in — this
   *  function only creates the session process, the worktree and the spec file, and never touches
   *  OrchState at all: the server owns the state. retryOf is not here — openDispatch has already
   *  validated it. */
  startWorker(a: {
    dispatchId: string
    taskId: string
    title: string
    spec: string
    /** The finished spec file, when the caller assembled it itself — passed straight through to
     *  OrchCoordinator.startWorker, where the reason it exists is documented. worker-start never sets
     *  it (task.spec is a body and the implementer's template is the right wrapper for it); the
     *  wiring's review path does. */
    specFileContent?: string
    provider: Provider
    accountId: string
    runCwd: string
    worktree: string
    name?: string
    terminal?: string
    terminalCwd?: string
    terminalProvider?: Provider
    terminalAccountId?: string
    /** Set only by recovery (main/recovery/execute.ts) — this wrapper forwards it straight through
     *  to OrchCoordinator.startWorker, where the reason it exists is documented. Nothing else in this
     *  file reads it. */
    resume?: { nativeSessionId?: string; briefing?: string }
    /** Forwarded straight through to OrchCoordinator.startWorker, where the reason it exists is
     *  documented. Type-only pass-through here — this file adds no behaviour for it. */
    launchPhrase?: string
  }): Promise<{ sessionId: string; cwd: string; specPath: string }>
  releaseWorker(a: { dispatchId: string }): Promise<void>
  /** 그 세션의 롤링 체인을 버린다 — **세션은 죽이지 않는다**(releaseWorker 와 그 점이 다르다).
   *
   *  **Dispatch 가 닫혔는데 세션이 살아 있는 자리에서만 부른다.** 워커는 보고한 뒤에도 일부러 살아
   *  있고(가이드 8절), 롤링 체인은 세션이 죽을 때만 버려졌다. 그 사이의 창에서 롤링은 이미 끝난 일의
   *  세션에 재개 프롬프트를 타이핑하거나(claude 의 idle nudge) 그 세션을 죽이고 다시 띄운다(codex 의
   *  maxed+silent 폴백) — 아무도 요청하지 않은 작업이고, 워크트리 워커라면 커밋 의무까지 딸린다.
   *
   *  **세션을 죽이는 경로에서는 부르지 않는다**(worker-stop, run-delete, run-pause, 그리고
   *  handleExit). 그쪽은 세션 종료가 알아서 체인을 버린다.
   *
   *  주입되지 않으면 아무것도 하지 않는다 — probeLimit?/startValidation? 과 같은 "주입되지 않으면
   *  그 기능이 없다" 관례다. 모르는 sessionId 도 무해하다(코디네이터 쪽 계약). */
  unregisterRolling?(sessionId: string): void
  /** Copies the current `orchestration.json` to `.bak` right before a destructive operation. The
   *  wiring passes OrchestrationStore.backup. Optional for the same reason as now? and log? — if it
   *  is not injected the backup is skipped (existing tests that do not use the store). */
  backup?(): Promise<void>
  /** 이 Run 의 워크트리 브랜치들을 프로젝트 폴더에 합친다 — `run-merge`(사람이 상세 창에서 누른다)
   *  와 `run-delete --merge` 가 부른다. 실패하면 사람이 읽을 이유를 돌려주고, 그때 삭제는 일어나지
   *  않는다(그 case 의 주석). 둘 다 **합친 워크트리를 걷지 않는다** — 폴더 정리는 삭제 모달의
   *  체크박스가 따로 하는 일이다(배선의 reap 옵션, src/core/orchestration/exec/integrateGit.ts 의
   *  worktreeDeps).
   *  주입인 이유: 실제 병합은 git 을 돌리고 Gate 문구까지 만드는 배선의 일이라
   *  src/core/orchestration/exec/integrateGit.ts 에 있고(앱은 src/main/ipc.ts 에서, Host 는
   *  src/host/worktrees.ts 에서 그것을 부른다), 이 파일은 그것을 호출만 한다 — now?/backup? 과 같은
   *  관례로 optional 이다(주입되지 않으면
   *  병합을 요청받아도 할 수 없으므로 거절한다).
   *  `merged` 는 넘긴 `paths` 중 폴더가 아직 남아 있던 것들의 부분집합이다(이미 사라진 폴더는
   *  배선이 조용히 걸러 낸다) — 호출자는 이 값을 그대로 사람에게 보여야 한다, 넘긴 목록을 그대로
   *  돌려주면 아무것도 합치지 못했을 때도 성공을 알리게 된다. */
  mergeWorktrees?(
    runCwd: string,
    paths: string[]
  ): Promise<{ ok: true; merged: string[]; uncommitted: number } | { ok: false; reason: string }>
  /** 이 경로들의 워크트리를 폴더째 지운다 — `run-delete --remove-worktrees` 가 부른다. 그 안에서
   *  도는 세션을 닫는 일까지 배선이 한다(removeWorktree 의 isPathInUse 가 그러지 않으면 거절한다).
   *  실패한 경로는 돌려준다 — 삭제를 막지는 않지만 응답에 실어 사람이 알 수 있게 한다. */
  removeWorktrees?(paths: string[]): Promise<{ failed: string[] }>
  /** Risk-6's orphan cleanup: best-effort removal of a Run worktree `run-start` just made with
   *  `makeRunWorktree`, once starting the coordinator then failed. **Never decides that command's
   *  status** — a refused or failed cleanup is logged wherever it is wired (the Host's own version,
   *  `hostOrchDeps`, never calls the app-required flag for it) and left as an orphan on disk; the
   *  command keeps its own 400 and its own reason (Host S3 fix round 1, I1). `inUse` says which kind
   *  of "not removed" it was — still busy, or an outright failure — so the 400's own note can say
   *  which (fix round 2, R2). Optional: without it, the cleanup falls back to `removeWorktrees` alone
   *  if that is wired — see the `run-start` case. **That fallback is new in 88f2700 (Host S3 Task 7),
   *  not something this file always did**: before it, a coordinator that failed to start left `bad(…)`
   *  with no cleanup at all, and the fresh Run worktree was simply orphaned (final review m4). */
  discardRunWorktree?(path: string): Promise<{ removed: boolean; inUse: boolean }>
  /** 이 Run 을 관리할 코디네이터 세션을 띄운다. **`startWorker` 와 같은 꼴이다** — 배선이 채우고,
   *  세션 프로세스만 만들고 OrchState 는 건드리지 않는다(서버가 상태를 소유한다). 첫 입력으로
   *  인수 프롬프트를 받는다(core/orchestration/handover.ts).
   *
   *  주입되지 않으면 코디네이터를 띄우지 않는다 — `probeLimit`·`removeWorktrees` 와 같은 관례이고,
   *  그때 Run 은 앱이 돌린다(옛 동작). */
  startCoordinator?(a: {
    runId: string
    cwd: string
    accountId: string
    /** 인계 브리핑의 **본문**. 배선이 이것을 파일로 쓰고, 세션에는 그 파일을 가리키는 한 줄만
     *  넣는다(handover.ts 의 coordinatorLaunchPrompt) — 여러 줄은 argv 를 지나갈 수 없다. */
    brief: string
  }): Promise<{ sessionId: string }>
  /** Stops a coordinator session `startCoordinator` opened, when the hand-over finds another one
   *  already in the Run's slot (Task 1 fix round 1, I2). Optional: without it that session is left
   *  running and the command says so in the log. */
  stopCoordinator?(sessionId: string): Promise<void>
  /** Records a `check --wait` long-poll entering, for this Run and caller session; the returned
   *  function records its exit (final round 2, I-A; checkWaits.ts). Optional: the Host's command server,
   *  where every CLI call is served, wires it; the app serves no session's `check` and does not. */
  enterCheckWait?(runId: string, sessionId: string): () => void
  /** Whether a Run's coordinator is parked: `true` only while that session has a `check --wait` for that
   *  Run in flight in the process that serves it (I-A). `false` or `null` (cannot tell) otherwise. Absent
   *  means `null`. A fire replaces an idle-only Run, and `run-coordinator-stop` stops an unfinished one,
   *  only on `true`: nothing else tells "parked in check --wait" from "thinking". **May be a Promise**
   *  (final round 3): the app, when it drives, asks the Host, which serves the waits (`coordinator-idle`). */
  coordinatorIdle?(runId: string, sessionId: string): boolean | null | Promise<boolean | null>
  /** 이 Run 이 일할 워크트리를 하나 만들고 그 경로를 낸다. **`startCoordinator` 와 같은 꼴** —
   *  배선이 채우고, 디스크만 만들고 OrchState 는 건드리지 않는다(기록은 setRunWorktree 가 한다).
   *
   *  **왜 인계 시점에 필요한가.** 평소에는 앱의 스케줄러가 첫 슬롯을 채우기 직전에 게으르게 만든다.
   *  그런데 Run 을 코디네이터에게 넘기면 앱은 그 Run 의 슬롯을 더 채우지 않으므로, 만들어 줄 사람이
   *  없어진다 — 한도 1 인 Run 의 코디네이터는 "`--worktree` 를 생략하라"는 배치 규칙을 따를 자리가
   *  아예 없게 된다(handover.ts 가 그렇게 지시한다).
   *
   *  주입되지 않으면 만들지 않는다 — 그때는 worker-start 가 `--worktree` 없는 호출을 소리 내어
   *  거절하므로(아래) 코디네이터가 `--worktree new` 로 갈 수 있다. */
  makeRunWorktree?(a: { repoPath: string; name: string }): Promise<string>
  /** **Either an array or a promise of one, and the three call sites `await` it.**
   *
   *  It is answered locally in the app and across a socket in the Host, and the command layer must
   *  not care which — that is the whole point of the split (host control plane design §5). The union
   *  rather than `Promise<…>` outright: `await` on a plain array is already correct, so the app's
   *  wiring and every test double that returns one stay exactly as they are. */
  listAccounts(provider?: Provider): OrchAccount[] | Promise<OrchAccount[]>
  readWorker(a: { dispatchId: string; limit?: number }): Promise<string>
  /** Whether work-unit tracking is on — the toggle the three session-task-* commands answer to.
   *  **Orchestration itself has no such toggle**: it is a thing Astera has, like sessions, so the
   *  commands below it are never refused for being switched off. Optional so the existing test
   *  harnesses (and any wiring that predates work-unit tracking) keep compiling; the session-task-*
   *  commands treat a missing implementation the same as `false`.
   *
   *  **A value or a promise of one, and its one call site awaits it — the same union as
   *  `listAccounts` and `repairTargetFor`** (host control plane design §5). Inside the app it is the
   *  settings read it always was; inside the Host it crosses a socket to the app, and this layer must
   *  not be able to tell which. `await` on a plain boolean is already correct, so every existing
   *  wiring and test double stays exactly as it is. */
  trackingEnabled?(): boolean | Promise<boolean>
  /** The agent browser toggle — what `browser-js` answers to. Optional for the same reason as
   *  trackingEnabled, and a value or a promise of one for the same reason. */
  browserEnabled?(): boolean | Promise<boolean>
  /** Runs one script in the calling session's agent browser (main/agentBrowser/runs.ts). Optional:
   *  not injected, `browser-js` answers "agent browser is off". */
  browserRun?(sessionId: string, script: string): Promise<
    | { ok: true; result: { log: string[]; error?: { message: string; at: string } } }
    | { ok: false; status: 404 | 409; error: string }
  >
  /** The Smart Resume setting — what the `handoff` command answers to. The memo only ever feeds a
   *  Smart Resume briefing, so there is no separate switch (spec §11). Optional for the same reason
   *  as trackingEnabled; absent reads as off, and a value or a promise of one for the same reason. */
  handoffEnabled?(): boolean | Promise<boolean>
  /** Stores a validated memo for the calling session. The server hands over only what it checked
   *  (the body); ipc.ts fills in the facts only the app can vouch for — cwd, provider, git, the
   *  clock — before writing. 409 is "unknown session" (the app has not caught up to a tab that just
   *  opened); 500 is a write that failed. */
  handoffs?: {
    save(
      sessionId: string,
      body: HandoffBody
    ): Promise<{ ok: true; savedAt: string } | { ok: false; status: 409 | 500; error: string }>
  }
  /** The handle the three session-task-* commands call through, shaped so `ipc.ts` can pass
   *  `WorkUnitCollector.startTask/completeTask/cancelTask` straight in. Optional for the same reason
   *  as `trackingEnabled` — when it is not injected, the commands answer `work unit tracking is
   *  off` rather than throwing. */
  sessionTasks?: {
    start(
      sessionId: string,
      objective: string
    ): Promise<{ ok: true; id: string; interruptedId?: string } | { ok: false; reason: string }>
    complete(
      sessionId: string,
      input: { source: 'agent'; checks?: SessionCheck[]; summary?: string }
    ): Promise<{ ok: true; id: string } | { ok: false; reason: string }>
    cancel(
      sessionId: string,
      reason?: string
    ): Promise<{ ok: true; id: string } | { ok: false; reason: string }>
  }
  now?(): string
  /**
   * Decides whether an ended worker session hit a quota limit and returns the reset time (epoch ms).
   * null when it was not a limit or when it could not be decided — the two are not distinguished.
   * If it is not injected, no limit detection happens at all.
   */
  probeLimit?: (d: Dispatch) => Promise<number | null>
  /**
   * 임의 경로를 그것이 속한 프로젝트 루트로 되돌린다. run-create 가 --cwd 를 저장하기 전에
   * 통과시킨다.
   *
   * 소유 판정(core/orchestration/view.ts 의 runsForProject)이 '동일 경로'라, 하위 디렉터리에서
   * 만들어진 Run 은 어떤 프로젝트 목록에도 나타나지 않는다. 질의를 넓히는 대신 저장 값을
   * 여기서 바로잡는다.
   *
   * 주입되지 않으면 정규화하지 않는다 — now?/log?/backup?/probeLimit? 와 같은 관례다.
   */
  resolveProjectRoot?(cwd: string): Promise<string>
  /** Run 의 프로젝트에 저장된 실행 구성 목록. 주입되지 않으면 빈 목록이다 —
   *  now?/log?/backup?/probeLimit? 와 같은 관례다. */
  listRunConfigs?(projectPath: string): Promise<OrchRunConfig[]>
  /** 지금 도는 세션 수. **상태에 없는 값이라 주입된다** — 세션은 SessionManager 의 것이고
   *  (core.sessions) 이 층은 OrchState 만 본다. `status` 하나가 쓴다. */
  runningSessions?(): number
  /** 앱의 버전. 주입되지 않으면 `version` 이 그 칸을 비워 답한다 — CLI 는 자기 버전을 빌드에서
   *  받으므로, 앱 쪽 값이 없다고 명령이 실패할 이유는 없다. */
  appVersion?(): string
  /** 검증을 시작한다. **동기다** — 검증은 몇 분이 걸리므로 기다리면 worker_done 응답이 그만큼
   *  늦어지고, 워커 세션이 그 자리에서 멈춘다. 결과는 배선이 나중에 setState 로 커밋한다.
   *  주입되지 않으면 검증이 없는 것으로 동작한다 — validateConfigId 가 걸린 Task 도 worker_done
   *  성공에 곧바로 completed 로 간다(applyWorkerDone 의 canValidate 인자로 전달된다).
   *  validating 으로 보내지 않는 이유는 그 상태에서 꺼내 줄 것이 아무것도 없기 때문이다 —
   *  now?/log?/backup?/probeLimit? 와 같은 "주입되지 않으면 그 기능이 없다" 관례다. */
  startValidation?(a: { taskId: string; cwd: string }): void
  /** 검토를 시작한다. **동기다** — startValidation 과 같은 이유이고, 검토는 세션을 하나 띄우므로
   *  더 오래 걸린다. 배선이 provider·계정을 고르고, 검토 Dispatch 를 열고, 세션을 띄운다.
   *  주입되지 않으면 검토가 없는 것으로 동작한다(applyWorkerDone/applyValidationResult 의
   *  canReview 인자로 전달된다) — reviewing 으로 보내면 그 상태에서 꺼내 줄 것이 없다.
   *
   *  **cwd 를 넘기지 않는다.** 배선은 provider 를 고르려고 구현 Dispatch 를 어차피 찾아야 하고,
   *  그 Dispatch 가 cwd 를 들고 있다. 여기서 넘기면 두 호출자(이 서버와 검증 통과 경로)가 같은 값을
   *  서로 다른 방법으로 구하게 되고, 그 둘은 갈라진다. */
  startReview?(a: { taskId: string }): void
  /** `<specPath>.review.json` 의 본문 — **완성된 경로를 받는다.** suffix(`.review.json`)는 이 파일의
   *  호출부(아래 send worker_done 의 검토 분기)가 붙인다, 한 곳에서만. 여기서 또 붙이면
   *  `….md.review.json.review.json` 을 찾다가 조용히 못 찾아, 구조화된 판정 기능 자체가 죽은 채로
   *  아무 신호도 내지 않는다.
   *  없으면 null(outcome 으로 해석). 읽기 실패는 **던진다** — 서버가 잡아 'malformed' 로 다룬다
   *  (조용히 삼키면 "이슈 없음" 으로 읽혀 깨진 판정이 통과가 된다, 설계 §8.2). convergence 가 없는
   *  Run 에서는 이 함수가 있어도 부르지 않는다 — 그 경로는 오늘과 바이트 단위로 같아야 한다. */
  readReviewFile?(path: string): Promise<string | null>
  /** 판정 직전의 repair 대상(repair.ts 의 repairTargetFor 를 배선이 감싼다) — 마지막 구현·수리
   *  세션이 살아 있으면 그 세션, 아니면 새 워커(설계 D3). applyValidationResult/applyReviewResult 의
   *  `repair` 로 그대로 넘긴다; 주입되지 않으면 넘기지 않고, convergence Run 에서 repair 를 열어야
   *  하는 판정은 그 순수 층이 Gate 로 보낸다(routeFailure, jobs.convergence.gate.repairFailed) —
   *  오늘의 배선은 항상 넘기므로 닿지 않지만, 닿았을 때도 Task 가 validating 에 갇히지 않는다.
   *
   *  **값이거나 그 약속이다 — `listAccounts` 와 같은 이유다**(host control plane 설계 §5). 앱
   *  안에서는 그 자리에서 답하고 Host 에서는 소켓을 건너 답하며, 명령 층은 어느 쪽인지 몰라야
   *  한다. 부르는 자리는 하나뿐이고 거기서 await 한다. */
  repairTargetFor?(taskId: string): RepairTarget | null | Promise<RepairTarget | null>
  /** 판정이 새로 연 repair Dispatch 의 부수 효과(repair.ts 의 performRepair) — spec 파일을 쓰고
   *  살아 있는 세션에 넣거나 새 워커를 띄운다. **커밋 뒤에만 부른다** — 이 파일의 다른 모든 부수
   *  효과와 같은 순서(Dispatch 먼저, 세션은 그다음)다.
   *
   *  **Host 가 앱 없이 이 명령을 받아도 안전한 이유는 이 칸이 아니라 `repairTargetFor` 다**
   *  (ruling F58). 둘 다 host/orchDeps.ts 의 HOST_DRIVES 에 있고, 호출마다 같은 술어
   *  `drive.owns()` 를 동기로 묻는다(S4+S5 R8). Host 가 몰면 둘 다 Host 가 답한다: 대상은 Host 의
   *  레지스트리로 판정하고, 이 훅은 Host 가 직접 spec 을 쓰고 세션을 띄운다. 몰지 않으면 둘 다 S5
   *  이전의 길로 간다: 이 훅은 앱으로 전달되거나, 앱이 없으면 로그만 남기고 삼켜지며,
   *  `repairTargetFor` 는 앱에 묻고 물을 수 없으면 `null` 을 답해 판정이 repair Dispatch 를 열지
   *  않고 `repairFailed` Gate 를 연다. **그러니 삼켜지는 갈래에는 가리킬 Dispatch 가 없다.** 앱이
   *  대상을 답한 뒤 이 훅 전에 떠나면, 운전이 그 사이 Host 로 넘어와 Host 가 띄운다. **두 칸을
   *  다른 묶음이나 다른 술어로 나누는 날 이 문장은 거짓이 된다.** */
  startRepair?(a: { dispatchId: string }): void
  /** 소진 Gate(kind: 'convergence-exhausted')의 retry-once 답(repair.ts 의 repairOnce) — 예산 밖의
   *  repair 를 정확히 하나 연다. gate-resolve 가 그 kind 의 Gate 를 이 답으로 풀 때만 부른다.
   *  **비동기다 — gate-resolve 가 그 반환을 기다린다.** repairOnce 자신은 Dispatch 를 열어 커밋한
   *  뒤에야 resolve 하고 실제 부수 효과(spec 파일 쓰기, 세션 띄우기)는 백그라운드로 넘긴다 — 그래서
   *  이것을 기다리는 것은 "그 Dispatch 가 이미 커밋됐다" 까지만 기다리는 것이다. 기다리지 않으면
   *  gate-resolve 응답이 먼저 나가고, 그 사이 Task 는 ready 에 Dispatch 없이 있어
   *  worker-release·worker-start 가 그 창으로 same-session repair 가 노리는 세션에 슬쩍 들어올 수
   *  있다.
   *
   *  **결과를 돌려준다(전체 브랜치 리뷰, Finding 5).** 사람의 "한 번 더" 가 실제로 아무것도 열지
   *  못했을 때(예: 이 Task 를 막는 다른 Gate 가 이미 열려 있다) gate-resolve 의 200 응답이 그 사실을
   *  담을 수 있게 한다 — repairOnce 자신은 실패를 이미 로그하므로(그 함수의 주석) 이 반환값은 응답에
   *  싣는 용도이지, 여기서 또 로그할 것이 있어서가 아니다. */
  repairOnce?(a: { taskId: string }): Promise<{ ok: true } | { ok: false; error: string }>
  /** Gate 문구의 언어. 배선이 앱 언어를 넘긴다(applyValidationResult/applyReviewResult 의 `lang`
   *  으로 그대로 간다); 주입되지 않으면 영어다.
   *
   *  **값이거나 그 약속이다 — `listAccounts`·`repairTargetFor` 와 같은 이유다**(host control plane
   *  설계 §5). 부르는 자리는 하나뿐이고, 거기서 `repairTargetFor` 바로 옆에서 await 한다. */
  lang?(): Lang | Promise<Lang>
  /** Audit log left behind when task-update bypasses the transition table (canTransition) — the same
   *  shape as log(message: string) in coordinator.ts. The wiring decides where it goes. If it is not
   *  injected (existing tests and the like) logging is skipped — optional for the same reason as
   *  now?. */
  log?(message: string): void
  /** Job Continuity: a worker Dispatch just closed without an outcome, so its Task is stranded.
   *  The app's wiring always injects it and decides inside whether there is anything to do — the
   *  Job Continuity toggle is read there, not here. Optional so tests can leave it out. */
  onDispatchLost?(a: { dispatchId: string }): void
  /** The agent sessions the Host holds, live and ended (`sessions list`). **Only the Host injects
   *  the three below**, from its own registries (host/sessions.ts): it is the process that holds the
   *  ptys, so it answers with or without an app. Absent, the three commands answer 409. */
  listSessions?(): Promise<HostSession[]>
  /** A terminal session's screen, rendered, by the app's session id, with up to `lines` rows of
   *  scrollback — empty once it has ended, because the scrollback goes with it. */
  readSession?(id: string, lines: number): Promise<SessionScreen>
  /** Types into a terminal session by the app's session id, then presses Enter 150ms later when
   *  `enter` (ptyDriver's convention), one delivery at a time per session. A write to one that has
   *  ended is dropped by the registry, as every write is. */
  sendSession?(id: string, text: string, enter: boolean): Promise<void>
  /** A chat session's last `turns` turns, oldest first, from the transcript or rollout file its agent
   *  CLI writes (core/sessions/chatRead.ts). Host-injected, beside the three above. */
  readChat?(id: string, turns: number): Promise<ChatTurn[]>
  /** The card a chat session holds open, or `null` for none. **Only the app can say**: the card is
   *  in its adapter's protocol state. The app injects it (`core.chat.state(id).request`); the Host
   *  forwards it, and answers `undefined` when the app cannot be asked, which means "not known" and
   *  leaves `pending` out of the reply rather than claiming there is no card. The app answers
   *  `undefined` too for a session it does not hold (yet): it cannot know that session's card. */
  chatPending?(id: string): Promise<ChatPending | null | undefined>
  /** One turn into a chat session. With the app attached the app delivers it through its session
   *  driver (the scheduler's and Slack's), so its turn state stays its own, and refuses while a card
   *  is open. With no app the Host writes the adapter's own bytes to the process itself
   *  (host/orchDeps.ts `chatSend`). Either way one at a time per session. */
  chatSend?(id: string, text: string): Promise<ChatSendResult>
  /** The open prompts, from the process that is each session's writer (chat takeover §3.5). The Host
   *  answers its own writer sessions and asks an attached app for the rest; `complete` is false when the
   *  app could not be asked. The app answers every session it holds, complete. */
  chatPrompts?(sessionId?: string): Promise<ChatPromptList>
  /** Allow or deny one open approval, by the session's writer. Never throws for a closed prompt: that is
   *  `{ answered: false, reason: 'not-open' }`. */
  chatAnswer?(sessionId: string, requestId: string, decision: 'allow' | 'deny'): Promise<ChatAnswerResult>
}

type Reply = { status: number; body: unknown }
const okBody = (body: unknown): Reply => ({ status: 200, body })
const bad = (msg: string): Reply => ({ status: 400, body: { error: msg } })
/** 지목한 것이 없다. **400 과 가르는 이유는 CLI 다** — 스크립트가 "인자를 잘못 줬다"(exit 2)와
 *  "그런 id 가 없다"(exit 4)를 구별할 수 있어야 한다(공개 CLI 설계 §8). 그 전에는 둘 다 400 이라
 *  부르는 쪽이 문구를 읽어야 알 수 있었다. */
const notFound = (msg: string): Reply => ({ status: 404, body: { error: msg } })
/** A pure-layer refusal handed straight to the caller: 404 when it is marked `missing` (the id the
 *  caller named is not there — state.ts marks it where it refuses), 400 otherwise. For the cases that
 *  do not go through `commit()`; the same fact must not exit 4 from one command and 2 from another. */
const refused = (r: { error: string; missing?: true }): Reply =>
  r.missing ? notFound(r.error) : bad(r.error)
const denied = (msg: string): Reply => ({ status: 403, body: { error: msg } })
const conflict = (msg: string): Reply => ({ status: 409, body: { error: msg } })
/** How long after its `startedAt` a `pending:` Dispatch still counts as a start in flight (Host S2
 *  fix round 2, N1). A start waits at most a spawn deadline (SPAWN_DEADLINE_MS, 20 s) plus the
 *  coordinator's idle wait before its prompt (30 s), plus trust and account reads; two minutes covers
 *  that with room to spare, and a test pins that it stays above the sum. Past it, the placeholder is
 *  a start that died: an app that quit inside worker-start leaves one, and nothing else ever closes
 *  it, so the stop goes ahead. */
export const PENDING_START_WINDOW_MS = 2 * 60_000

/** The refusal of every command that stops workers, for a Dispatch whose worker-start has not
 *  answered yet (Host S2 fix round, I1). Its session id is still the `pending:` placeholder, so there
 *  is nothing to kill, and the spawn may still complete and write the real id onto the Dispatch.
 *  Recording it stopped would leave a live agent on a closed Dispatch, and the next `--retry-of`
 *  would put a second one in the same worktree. So the command writes nothing and says to try again.
 *
 *  **Only inside the start window** (`PENDING_START_WINDOW_MS`, fix round 2). An older placeholder
 *  is a start that died, and refusing it forever would leave a Dispatch nothing can close short of
 *  `worker-abandon` or a Host restart. Such a one goes ahead, with no release (`releases`).
 *  Null when no Dispatch among `open` is still starting. */
const stillStarting = (open: readonly Dispatch[], now: string): Reply | null => {
  const d = open.find(
    (x) => isPlaceholderSessionId(x.sessionId) && Date.parse(now) - Date.parse(x.startedAt) < PENDING_START_WINDOW_MS
  )
  return d ? conflict(`the worker is still starting; try again in a moment (dispatch ${d.id})`) : null
}
/** Whether stopping this Dispatch has a session to kill. A placeholder that got past `stillStarting`
 *  is a start that died: no pty was ever opened for it, so there is nothing to release. */
const releases = (d: Dispatch): boolean => !isPlaceholderSessionId(d.sessionId)

/**
 * 계획과 회차에 붙는 파생값 — 공개 읽기 표면이 상태를 말하는 방식(공개 CLI 설계 §6).
 *
 * **저장된 칸이 아니다.** Job 에도 JobRun 에도 상태 칸은 없고, 상태는 그것이 거느린 Task 에 있다.
 * 화면이 쓰는 함수를 그대로 쓴다(view.ts 의 outcomeOf·progressOf) — 같은 Job 을 앱에서 보는 것과
 * 셸에서 보는 것이 다르면 둘 중 하나는 거짓이다.
 *
 * `questionsOpen` 을 따로 세는 이유는 status 명령과 같다: 그것만이 **사람을 기다리는** 수이고,
 * 나머지 상태와 달리 사람이 답해야 움직인다.
 */
const derivedFor = (
  s: OrchState,
  ownerId: string,
  runIds: readonly string[]
): { outcome: RunOutcome; progress: { done: number; total: number }; questionsOpen: number } => ({
  outcome: outcomeOf(s, ownerId),
  progress: progressOf(s, ownerId),
  questionsOpen: s.gates.filter((g) => g.status === 'open' && runIds.includes(g.runId)).length
})

/** 그 계획의 마지막 회차. 번호로 고른다 — 배열의 순서가 곧 시간순이 아니다(앞 회차를 지워도
 *  남은 번호는 그대로다). */
const latestRunOf = (s: OrchState, job: Job): JobRun | undefined =>
  s.runs.filter((r) => r.jobId === job.id).sort((a, b) => a.ordinal - b.ordinal).at(-1)

/** The Job's latest Run **while it still runs**, else undefined. `jobs run` refuses on it, and a fire
 *  skips on it (`run-spawn --unless-running`; the user's ruling of 2026-09-25 on U1): the same test in
 *  both, so a schedule never starts a second Run of a Job beside one `jobs run` would count as running. */
const runningRunOf = (s: OrchState, job: Job, now: string): JobRun | undefined => {
  const latest = latestRunOf(s, job)
  return latest && runMoves(s, job, latest, now) ? latest : undefined
}

/**
 * **Whether something can still move this Run** (Task 1 fix round 1, C1). "Its outcome is `running`"
 * was the test, and it is true of a Run nothing will ever move: one with no Tasks (`outcomeOf` reads
 * that as running, so a just-made Run is not `completed`), one whose coordinator failed to start, or
 * died before it made a Task, or died leaving `ready` Tasks no loop places. Each of those stopped every
 * later fire of its schedule, and every later `jobs run` of its Job, for good.
 *
 * Not running: a finished Run (every Task done), and a paused one (a person resumes it; unchanged from
 * before). Otherwise it runs when any of these holds:
 * - its coordinator's start is in flight (`coordinatorStarting`, I1);
 * - a worker is at work on it (an open Dispatch), a check is (a Task `validating` or `reviewing`),
 *   or it waits on a person (an open Gate);
 * - it is `limited`: its agents resume by themselves at the reset (Task 1 review Minor 3);
 * - its driver, a live coordinator or the app's loop (`placedByApp`), can still start one of its
 *   Tasks (`startable`).
 *
 * **The last clause asks about the Tasks, not only the driver** (final review I1, and the user's U4 of
 * 2026-09-25). An app-placed Run with a Task that failed once, or a `pending` Task behind a dependency
 * that failed for good, has an unfinished Task that nothing will ever start, and it counted as running
 * for ever. A live coordinator on a Run with no Task it can start did the same: a Run made from an
 * objective alone has no Task, and its coordinator is told not to make any (handover.ts).
 *
 * **Such a Run is "idle only", and one rule covers both callers.** `jobs run` does not count it as
 * running and makes the next Run beside it, leaving its coordinator alone (a person may be reading
 * that tab). A fire of a scheduled Job replaces it (`run-spawn --unless-running`, `retireCoordinator`):
 * it stops that coordinator, ends the Run, and makes the next one. So a Run the fire would replace is
 * never one `jobs run` refuses on, and a Run `jobs run` refuses on is never replaced.
 */
const runMoves = (s: OrchState, job: Job, run: JobRun, now: string): boolean => {
  const tasks = s.tasks.filter((t) => t.runId === run.id)
  if (tasks.length > 0 && tasks.every(taskFinished)) return false
  if (run.paused === true || job.paused === true) return false
  if (coordinatorStarting(run, Date.parse(now))) return true
  const ids = new Set(tasks.map((t) => t.id))
  if (s.dispatches.some((d) => ids.has(d.taskId) && !d.outcome && !d.endedAt)) return true
  if (tasks.some((t) => t.status === 'validating' || t.status === 'reviewing')) return true
  if (s.gates.some((g) => g.status === 'open' && g.runId === run.id)) return true
  if (limitedUntil(s, run.id, now) !== null) return true
  const coordinated = run.coordinatorSessionId !== undefined
  if (!coordinated && !placedByApp(job, run)) return false
  return startable(tasks, coordinated).size > 0
}

/**
 * The Tasks of one Run its driver can still start, by id (final review I1). The driver is a live
 * coordinator when `coordinated`, else the app's loop.
 * - `ready` under the circuit break: the loop places it (slotsToFill), or opens a Gate on it when it
 *   has no account (tasksMissingAccounts); a coordinator starts it.
 * - `failed` under the circuit break, and `dispatched` with its Dispatch closed: **only a coordinator**
 *   starts them again (`worker-start --retry-of`). Nothing in the app does: slotsToFill takes `ready`
 *   only, and recovery acts on open Dispatches alone.
 * - `pending`: when each of its dependencies can still complete (`canComplete`), since recomputeReady
 *   frees it only once they are all `completed`.
 */
const startable = (tasks: readonly Task[], coordinated: boolean): Set<string> => {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const memo = new Map<string, boolean>()
  /** Whether this Task can still reach `completed`. A Task under way or with a person (`validating`,
   *  `reviewing`, `blocked`) can. A cycle, or a dependency outside this Run, cannot. */
  const canComplete = (id: string): boolean => {
    const known = memo.get(id)
    if (known !== undefined) return known
    memo.set(id, false)
    const t = byId.get(id)
    const answer =
      t !== undefined &&
      (t.status === 'completed' ||
        t.status === 'validating' ||
        t.status === 'reviewing' ||
        t.status === 'blocked' ||
        canStart(t))
    memo.set(id, answer)
    return answer
  }
  const canStart = (t: Task): boolean => {
    switch (t.status) {
      case 'ready':
        return t.consecutiveFailures < FAILURE_LIMIT
      case 'failed':
      case 'dispatched':
        return coordinated && t.consecutiveFailures < FAILURE_LIMIT
      case 'pending':
        return t.deps.every(canComplete)
      default:
        return false
    }
  }
  return new Set(tasks.filter(canStart).map((t) => t.id))
}

/** 회차가 없으면 계획의 정의 Task 를 센다 — tasksOwnedBy 가 두 id 를 다 받는다(view.ts). */
const jobView = (s: OrchState, job: Job, run: JobRun | undefined): Record<string, unknown> => ({
  ...job,
  ...derivedFor(s, run?.id ?? job.id, run ? [run.id] : [])
})

/**
 * `wait` 가 끝나는 자리. **아직 아니면 null 이고, 그때만 계속 기다린다.**
 *
 * 네 가지로 끝난다. 둘은 일이 끝난 것이고(completed·failed), 둘은 **사람이 손대야 움직이는
 * 것**이다(waiting·paused). 뒤의 둘을 끝으로 치는 이유는 그렇게 안 하면 CI 가 한 시간을 조용히
 * 매달리기 때문이다 — 아무도 안 보는 대기는 실패보다 나쁜 소식이다.
 *
 * 질문을 먼저 본다. 열린 질문이 있는 회차는 Task 가 전부 terminal 이어도 아직 사람을 기다리는
 * 중이고, 그쪽이 스크립트가 먼저 알아야 하는 사실이다.
 */
const waitEndingFor = (s: OrchState, runId: string, now: string): Record<string, unknown> | null => {
  const run = s.runs.find((r) => r.id === runId)
  if (!run) return null
  const job = s.jobs.find((j) => j.id === run.jobId)
  const base = { runId, jobId: run.jobId, progress: progressOf(s, runId) }
  const open = s.gates.find((g) => g.status === 'open' && g.runId === runId)
  if (open) return { ...base, state: 'waiting', questionId: open.id, taskId: open.taskId }
  if (run.paused === true || job?.paused === true) return { ...base, state: 'paused' }
  // Q3 (S6): every worker of this Run waits for a usage limit to reset, so nothing moves before then.
  // The worker resumes by itself at the reset; this only lets a script stop holding on. No Gate (A58).
  // The coordinator's own wait counts as well (S6 limits D2, limitedUntil).
  const limited = limitedUntil(s, runId, now)
  if (limited) return { ...base, state: 'limited', resetsAt: limited }
  const outcome = outcomeOf(s, runId)
  return outcome === 'running' ? null : { ...base, state: outcome }
}

/** How long past its reset a coordinator's stop still counts (S6 limits D2). A stop that should have
 *  been cleared by now (a clear that never came: a lost 'none', a tap that went away mid-episode) must
 *  not end every `runs wait` at once, forever. Ten minutes is past any reset the chain waits out and
 *  resumes after (the resume lands within a minute of the reset). */
const STALE_COORDINATOR_STOP_MS = 10 * 60_000

/** The reset the Run's coordinator is stopped for, or null when it is not stopped, its stop knows no
 *  reset (a switch to another account), or that reset is stale (STALE_COORDINATOR_STOP_MS). */
const coordinatorResetOf = (run: JobRun, now: string): string | null => {
  const at = run.coordinatorSessionId !== undefined ? run.coordinatorStop?.resetsAt : undefined
  if (at === undefined) return null
  const t = Date.parse(at)
  if (!Number.isFinite(t) || t < Date.parse(now) - STALE_COORDINATOR_STOP_MS) return null
  return at
}

/** The earliest reset every agent of the Run is waiting for, or null when any of them is not, or when
 *  the Run is no longer running (its outcome is completed or failed).
 *
 *  **`limited` means "nothing moves on its own before the reset"**, not "nothing can move". A person can
 *  still start a ready Task by hand (RunDetail's start button, or `worker-start`), the same way a person
 *  answers a `waiting` Run's question or resumes a `paused` one. Like those, it ends the wait because
 *  holding on would change nothing by itself.
 *
 *  Workers: every open Dispatch waits on a known reset. Null when any open one does not, a check is
 *  running, a Task is ready to start (the loop may still dispatch it), or nothing is open.
 *
 *  **The coordinator counts too** (S6 limits D2). Stopped with a known reset (coordinatorResetOf), it
 *  makes the Run limited when every open Dispatch is also limited or none is open, and the earliest
 *  reset of them all is the answer. A `ready` Task does not hold that off when the Run is not
 *  app-driven (`appDriven`, schedule.ts): then no loop dispatches it (`slotsToFill` only fills app-driven
 *  Runs) and only the coordinator starts it, which is stopped. */
const limitedUntil = (s: OrchState, runId: string, now: string): string | null => {
  // **Only a Run still running can be limited** (final review I1). A finished Run keeps its
  // coordinatorSessionId (the isRunCoordinator note in handleCommand), so a coordinator that hits a limit
  // after writing its closing summary would otherwise turn `completed` into `limited`, and `jobs run`
  // would refuse the Job until the reset. The Run is over; its real outcome is the answer.
  if (outcomeOf(s, runId) !== 'running') return null
  const run = s.runs.find((r) => r.id === runId)
  const coordinator = run ? coordinatorResetOf(run, now) : null
  const readyHolds = coordinator === null || (run !== undefined && appDriven(s, run))
  const tasks = new Set(s.tasks.filter((t) => t.runId === runId).map((t) => t.id))
  if (
    s.tasks.some(
      (t) =>
        tasks.has(t.id) &&
        (t.status === 'validating' || t.status === 'reviewing' || (t.status === 'ready' && readyHolds))
    )
  )
    return null
  const open = s.dispatches.filter((d) => tasks.has(d.taskId) && !d.endedAt && !d.outcome)
  if (open.length === 0) return coordinator
  let earliest: string | null = coordinator
  for (const d of open) {
    const last = d.resumes?.[d.resumes.length - 1]
    if (!last || last.resumedAt !== undefined || last.resetsAt === undefined) return null
    if (earliest === null || Date.parse(last.resetsAt) < Date.parse(earliest)) earliest = last.resetsAt
  }
  return earliest
}

const runView = (s: OrchState, run: JobRun): Record<string, unknown> => ({
  ...run,
  ...derivedFor(s, run.id, [run.id])
})

/** Commands only the orchestrator may call. Workers do not need check (the worker preamble uses only
 *  send and ask) — and on top of that the single unacknowledged Delivery is shared per Run with the
 *  coordinator, so a worker calling check --ack would acknowledge, on the coordinator's behalf, a
 *  batch the coordinator has not seen yet.
 *
 *  **inbox is blocked too**: ask --resume has an ownership guard so a worker cannot peek at another
 *  worker's answer (the ask branch below), but inbox returns all of s.messages.slice(-limit)
 *  unfiltered and so bypasses that guard — a single `inbox --limit 200` lets a worker read another
 *  worker's question, the body of the coordinator's reply (applyReply puts the answer straight into
 *  the body of a status message), and the spec and results of other Tasks. The remaining read
 *  commands (worker-show, worker-read, tasks-list, questions-list, accounts, jobs-list, jobs-get,
 *  dispatch-show) do not carry another worker's private conversation, so they are not blocked. */
const COORDINATOR_ONLY = new Set([
  'run-create',
  'run-use',
  'run-delete',
  'run-spawn',
  'run-coordinator-stop',
  'run-start-marks-clear',
  'run-start',
  'run-worktree-set',
  'run-pause',
  'run-resume',
  'run-merge',
  'task-create',
  'task-update',
  'worker-start',
  'worker-release',
  'worker-retain',
  'worker-stop',
  'worker-abandon',
  'gate-create',
  'gate-resolve',
  'reply',
  'reset',
  'check',
  'inbox'
])

/** Session-task commands answer to the work-unit tracking toggle, not the orchestration one. They
 *  are the only commands that do: everything else here drives Jobs, which is what "orchestration"
 *  names. */
const SESSION_TASK_CMDS = new Set(['session-task-start', 'session-task-complete', 'session-task-cancel'])

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)

/** 1 이상의 정수만 통과. CLI 는 숫자를 문자열로 넘길 수도 있으므로 둘 다 받는다. */
const posInt = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isInteger(n) && n >= 1 ? n : null
}

// TaskStatus 유니온에서 파생되지 않는 손수 쓴 목록이다 — 빠뜨려도 컴파일은 통과한다.
// 유일한 증상은 `task-update --status <빠진 상태>` 가 "must be one of ..." 로 거절되는 것이다:
// isTaskStatus 를 쓰는 자리는 그 명령 하나뿐이고(아래 task-update), task-list 는 --status 를
// 검증하지 않는다(모르는 값이면 조용히 빈 목록이 된다). 이 주석은 예전에 task-list 를 가리키고
// 있었는데, 그 문장을 믿고 쓴 테스트는 아무것도 검증하지 못한다.
const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'ready',
  'dispatched',
  'validating',
  'reviewing',
  'completed',
  'failed',
  'blocked'
]
const isTaskStatus = (v: string): v is TaskStatus => (TASK_STATUSES as string[]).includes(v)

const POLL_MS = 50

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Polls until the condition becomes true or the deadline passes. Returns the value once it is true.
 *  deps.setState is an injected function, so it cannot be intercepted to implement "wake up when a
 *  write happens" — 50ms polling stands in for that. The scheduler already sets a precedent with its
 *  15s polling, and at this app's scale the accuracy is good enough. */
async function pollUntil<T>(
  probe: () => T | null,
  timeoutMs: number
): Promise<{ value: T } | { timedOut: true }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = probe()
    if (v !== null) return { value: v }
    if (Date.now() >= deadline) return { timedOut: true }
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())))
  }
}

/** 쉼표로 온 계정 목록을 읽고 거절할 이유를 낸다. `null` 이면 통과다.
 *
 *  **두 자리가 같은 규칙을 쓴다** — Task 의 `--account`(그 Task 의 워커)와 Run 의
 *  `--coordinator-account`(그 Run 의 관리자). 층은 다르지만 규칙은 같다: 실재하는 계정이어야
 *  하고, 한 목록 안에서 provider 가 섞이면 안 되고(첫 계정이 provider 를 정하고 나머지는 갈아탈
 *  순서다), 빈 칸과 중복은 손이 미끄러진 것이다. 규칙을 두 번 적으면 한쪽만 고쳐지는 날이 온다. */
function parseAccountList(
  raw: string,
  known: { id: string; provider: Provider }[],
  flag: string
): { ok: true; ids: string[] } | { ok: false; reason: string; missing?: true } {
  const parts = raw.split(',').map((x) => x.trim())
  if (parts.some((x) => x === '')) return { ok: false, reason: `${flag} must not contain an empty entry` }
  const dup = parts.find((x, i) => parts.indexOf(x) !== i)
  if (dup !== undefined) return { ok: false, reason: `${flag} lists ${dup} twice` }
  const unknown = parts.find((x) => !known.some((k) => k.id === x))
  // `missing` is the one refusal here that is about an id the caller named not existing — the
  // caller answers it 404, the rest 400. Carried as a field so nobody has to read it off the words.
  if (unknown !== undefined) return { ok: false, reason: `unknown account: ${unknown}`, missing: true }
  const providerOfId = (id: string): Provider => known.find((k) => k.id === id)!.provider
  const head = providerOfId(parts[0])
  const odd = parts.find((x) => providerOfId(x) !== head)
  if (odd !== undefined)
    return {
      ok: false,
      reason: `${flag} must not mix providers: ${parts[0]} is ${head}, ${odd} is ${providerOfId(odd)}`
    }
  return { ok: true, ids: parts }
}

export async function handleCommand(
  deps: OrchServerDeps,
  caller: { sessionId: string },
  cmd: string,
  args: Record<string, unknown>
): Promise<Reply> {
  if (cmd === 'browser-js') {
    // The browser has its own toggle and needs none of the orchestration state below.
    // **이 await 는 상태를 읽기 전이다.** 이 분기는 handleCommand 의 첫 문장이고, 위에는 읽은
    // 상태도 쓴 상태도 없다 — 여기서 멈춰도 뒤집힐 것이 없다(repairTargetFor 가 겪은 그 자리와
    // 대조적으로).
    if (!(await deps.browserEnabled?.()) || !deps.browserRun) return conflict('agent browser is off')
    const script = args.script
    if (typeof script !== 'string' || script.trim() === '') return bad('script is required')
    const outcome = await deps.browserRun(caller.sessionId, script)
    return outcome.ok ? okBody(outcome.result) : { status: outcome.status, body: { error: outcome.error } }
  }
  if (cmd === 'handoff') {
    // Its own toggle and none of the orchestration state below — the same footing as browser-js
    // and the session-task-* commands: a plain tab session that has never seen a Job must be able
    // to leave a memo, because that is the session Smart Resume is for.
    // browser-js 와 같다 — 이 await 앞에 읽은 상태도 쓴 상태도 없다.
    if (!(await deps.handoffEnabled?.()) || !deps.handoffs) return conflict('smart resume is off')
    const memo = args.memo
    if (typeof memo !== 'string' || memo.trim() === '')
      return bad('--memo is required: the JSON document, or - to read it from stdin')
    const parsed = parseHandoffBody(memo)
    if (!parsed.ok) return bad(parsed.error)
    const r = await deps.handoffs.save(caller.sessionId, parsed.value)
    return r.ok ? okBody({ savedAt: r.savedAt }) : { status: r.status, body: { error: r.error } }
  }
  if (SESSION_TASK_CMDS.has(cmd)) {
    // **이 await 도 상태 앞이다.** 바로 아래 `deps.getState()` 가 이 명령이 상태를 처음 읽는
    // 자리이고, 그 위에 커밋은 없다 — 여기서 멈춰도 읽고-쓰는 창이 열리지 않는다.
    if (!(await deps.trackingEnabled?.())) return conflict('work unit tracking is off')
  }
  const now = deps.now?.() ?? new Date().toISOString()
  const s = deps.getState()

  // Role authorization (the third layer) — three things are kept distinct.
  // myDispatch: the dispatch that is open right now. Used only as the default when dispatchId was
  // omitted — that is the one case where the server has no way to guess which dispatch was meant.
  // myDispatchIds: every dispatch this session owns, regardless of state. Used for the ownership
  // question "is this my dispatch?". Whether it is still open or already terminal is a validity
  // question for the pure layer (applyWorkerDone, createQuestion) to decide — if the server narrowed
  // this to "only open ones are mine", then re-sending worker_done for one's own dispatch (a network
  // retry, say) would be blocked with a 403 before ever reaching applyWorkerDone, breaking the
  // guaranteed idempotent alreadyReported response (200). That was a regression from an earlier round.
  // isWorker: has this session ever held a dispatch — a permanent verdict. Deciding it by "is there
  // an open dispatch" would flip isWorker to false the moment applyWorkerDone sets outcome and
  // endedAt together (the session process itself stays alive), letting a worker that just finished
  // its own task go on to call run-create, task-create, worker-start, gate-create and reset from the
  // same session — the block on nested orchestration would collapse on every completion.
  const myDispatch = s.dispatches.find((d) => d.sessionId === caller.sessionId && !d.endedAt)
  const myDispatchIds = new Set(
    s.dispatches.filter((d) => d.sessionId === caller.sessionId).map((d) => d.id)
  )
  const isWorker = myDispatchIds.size > 0
  if (isWorker && COORDINATOR_ONLY.has(cmd)) return denied(`worker sessions cannot call ${cmd}`)
  // **The driving loop's own calls are not an agent's** (final review M3). `run-coordinator-stop --gone`
  // empties a slot with nothing stopped, and a coordinator sending it with its own id would orphan
  // itself; `run-start-marks-clear` is the loop's sweep. Refused from inside any agent session, as
  // `chats answer` is: taken from the app (APP_CALLER), the Host (HOST_CALLER) and a shell (no session).
  if (
    (cmd === 'run-start-marks-clear' || (cmd === 'run-coordinator-stop' && args.gone !== undefined)) &&
    caller.sessionId !== '' &&
    caller.sessionId !== APP_CALLER &&
    caller.sessionId !== HOST_CALLER
  )
    return denied(`${cmd === 'run-start-marks-clear' ? cmd : 'run-coordinator-stop --gone'} is sent by the app or the Host, not from inside an agent session`)
  // isRunCoordinator: this session is coordinating a Run that is **still running**. Kept separate
  // from isWorker rather than folded into one flag — they answer different questions (dispatch
  // ownership vs. Run coordination) for different reasons elsewhere in this file (isWorker also
  // feeds COORDINATOR_ONLY above), and are combined only at the session-task-* cases below, which
  // are the one place both answer the same question: is this session's work already going to be
  // recorded by a Run, at some level, when that Run finishes?
  //
  // **`outcomeOf` is what makes this narrow enough to be right.** `coordinatorSessionId` is cleared
  // only when the coordinator session itself disappears (detachCoordinator's one caller) — never
  // when its Run finishes, pauses or merges. Asking only whether the field points at this session
  // therefore denied a session its own /astera-task for as long as it lived, once it had coordinated
  // a single Run: shipped in v1.3.10 and fixed here. A Run with no tasks yet reads as 'running',
  // which is the answer we want while one is being set up.
  const isRunCoordinator = s.runs.some(
    (r) => r.coordinatorSessionId === caller.sessionId && outcomeOf(s, r.id) === 'running'
  )

  const commit = async <T>(r: Res<T>): Promise<Reply> => {
    // **404 is what state.ts marked `missing`, nothing else** (R4). This used to read the words: any
    // refusal starting `unknown ` was a 404. That made the status depend on how a message was phrased,
    // and it answered 404 to a refusal whose id was there all along (applyReply's "not a question").
    // Now the refusal says it (`gone` in state.ts), the same way `refused` reads every other one.
    if (!r.ok) return refused(r)
    await deps.setState(r.state)
    return okBody(r.value)
  }

  /**
   * Hands `target` to a coordinator started on `accountId` (U1): the Run worktree first, then the
   * session, then **one** commit of `base` with the worktree recorded, the Job's `autoDispatch` dropped
   * and the slot attached.
   *
   * **The one way a Run gets its coordinator.** `run-start` calls it for the sidebar's '실행' and for
   * the ▶ on a Run row; `run-spawn` calls it for a fire and a later `jobs run`. A fire used to start no
   * coordinator at all (F65) because that path had a copy of none of this; one body keeps the next
   * path from being the one that forgets.
   *
   * **A failure commits nothing of `base`**, removes the worktree it just made, and answers 400. What
   * `base` holds is the caller's: `run-start` passes its uncommitted release so a failure leaves
   * `pendingStart` in place; `run-spawn` passes the state its Run is already committed in.
   *
   * **`rebase` puts the hand-over on the state as it is once the coordinator is up**, not on `base`.
   * The start is a long await (a spawn deadline, the idle wait before the prompt), and the rest of the
   * state keeps moving under it: the loop places other Runs, workers report. Committing `base` then
   * would erase all of that. A caller whose `base` holds nothing uncommitted passes it: `run-spawn`,
   * which a fire calls every time a schedule is due, and the ▶ on a Run row, and a Job-id `run-start`
   * that has nothing to release. One that releases a gate or makes the first Run cannot, since those
   * exist only in `base`, and keeps committing `base` as before.
   *
   * **A rebased hand-over claims the start first** (fix round 1, I1): it commits the Run's
   * `coordinatorStartingAt` on the current state before it starts anything, unless the Run already
   * has a coordinator or a start in flight, which it then answers 200 and leaves alone. That mark is
   * what stops a ▶ in the app from starting a second coordinator beside a fire's in the Host: the two
   * run in two processes, and the state is the one thing both read. `marked` says the caller already
   * committed the mark (a fire does, in the commit that makes the Run). A failure drops the mark; the
   * attach drops it (attachCoordinator).
   *
   * Routing the app's ▶ to the driving process instead was considered and is not enough on its own:
   * within one process a fire's start and a ▶ still interleave across the start's awaits, so the mark
   * is needed there too, and with it the routing adds nothing.
   */
  const handToCoordinator = async (
    base: OrchState,
    job: Job,
    target: JobRun,
    accountId: string,
    rebase = false,
    marked = false
  ): Promise<Reply> => {
    if (!rebase) return startAndAttach(base, job, target, accountId, false)
    if (!marked) {
      const current = deps.getState()
      const run = current.runs.find((r) => r.id === target.id)
      if (!run) return notFound(`unknown run: ${target.id}`)
      if (run.coordinatorSessionId !== undefined || coordinatorStarting(run, Date.parse(now))) return okBody(run)
      await deps.setState({
        ...current,
        runs: current.runs.map((r) => (r.id === target.id ? { ...r, coordinatorStartingAt: now } : r))
      })
    }
    const reply = await startAndAttach(deps.getState(), job, target, accountId, true)
    if (reply.status < 200 || reply.status >= 300) await dropStartMark(target.id, now)
    return reply
  }

  /** Drops a Run's `coordinatorStartingAt`, on the state as it is now (I1), **only when it is the
   *  mark this call wrote** (`stamp`, this command's `now`). A start that outlived the window may find
   *  a later ▶'s mark there, and erasing it would let a third start through beside that one. */
  const dropStartMark = async (runId: string, stamp: string): Promise<void> => {
    const current = deps.getState()
    const run = current.runs.find((r) => r.id === runId)
    if (!run || run.coordinatorStartingAt !== stamp) return
    const { coordinatorStartingAt: _mark, ...rest } = run
    await deps.setState({ ...current, runs: current.runs.map((r) => (r.id === runId ? rest : r)) })
  }

  /** Drops a Run's `coordinatorStopPending`, on the state as it is now (L1): its Run moves again, so the
   *  stop it held is no longer one to retry. Nothing is written when there is no mark. */
  const dropStopPending = async (runId: string, why = 'moves again'): Promise<void> => {
    const current = deps.getState()
    const run = current.runs.find((r) => r.id === runId)
    if (!run || run.coordinatorStopPending === undefined) return
    const { coordinatorStopPending: _mark, ...rest } = run
    await deps.setState({ ...current, runs: current.runs.map((r) => (r.id === runId ? rest : r)) })
    deps.log?.(`run ${runId} ${why}; the stop pending for its coordinator ${run.coordinatorSessionId ?? '(none)'} was dropped`)
  }

  /**
   * **Stops a Run's coordinator that has nothing left to do** (the user's U4 of 2026-09-25). Two
   * callers: `run-coordinator-stop`, which the driving process's loop sends once a scheduled Job's Run
   * has finished (and again for a stop still pending), and a fire that replaces an idle-only Run
   * (`run-spawn --unless-running`), which also passes `pause` to end that unfinished Run the way
   * `runs stop` does.
   *
   * **The slot is kept, marked `coordinatorStopPending`, until the session is gone** (limits pass L1).
   * A stop is confirmed only by the exit release (`coordinatorReleaseOf`), which empties the slot and
   * drops the mark (`detachCoordinator`). Emptying it here, after a stop that failed or went nowhere,
   * left a live coordinator looping on `check --wait` with nothing pointing at it, and nothing asked
   * again. The mark is what the driving loop finds to send the stop again after a backoff
   * (dispatchLoop.ts). **It never throws out of the command** (R3): a stop that throws is logged and
   * still marked, since it is exactly the stop that needs the retry.
   *
   * The Run is written on the state as it is after the stop (a long await). The mark is written only
   * when the slot still names the session this call stopped: a ▶ may have started another coordinator on
   * the Run meanwhile, and then nothing is written. When the exit release already emptied the slot
   * during the stop, there is nothing to mark. **`pause` holds either way** (final round 2, Minor 3): the
   * replaced Run must still end paused.
   *
   * `still` is asked on that fresh state before anything is written (Minor 4, `run-coordinator-stop`):
   * when it answers false, nothing is written and the answer is `'moved'`. A stop that did land ends the
   * session, and its exit release empties the slot the ordinary way; one that did not leaves a
   * coordinator whose Run has work again, which is not a stop to retry.
   */
  const retireCoordinator = async (
    runId: string,
    sessionId: string,
    why: string,
    pause: boolean,
    still: (current: OrchState) => boolean = () => true
  ): Promise<'retired' | 'moved' | 'gone'> => {
    try {
      if (deps.stopCoordinator) await deps.stopCoordinator(sessionId)
      else deps.log?.(`coordinator ${sessionId} of run ${runId} could not be stopped: nothing here can stop a session`)
    } catch (e) {
      deps.log?.(`coordinator ${sessionId} of run ${runId} could not be stopped: ${String(e)}`)
    }
    const current = deps.getState()
    const run = current.runs.find((r) => r.id === runId)
    if (!run) return 'gone'
    if (run.coordinatorSessionId !== undefined && run.coordinatorSessionId !== sessionId) return 'gone'
    if (!still(current)) {
      deps.log?.(`coordinator ${sessionId} of run ${runId} was asked to stop, but the run gained work meanwhile; its slot is left as it is`)
      return 'moved'
    }
    const pending = run.coordinatorSessionId === sessionId && run.coordinatorStopPending === undefined
    if (pending || (pause && run.paused !== true)) {
      await deps.setState({
        ...current,
        runs: current.runs.map((r) =>
          r.id === runId
            ? { ...r, ...(pending ? { coordinatorStopPending: now } : {}), ...(pause ? { paused: true } : {}) }
            : r
        )
      })
    }
    deps.log?.(
      run.coordinatorSessionId === sessionId
        ? `coordinator ${sessionId} of run ${runId} asked to stop: ${why}; its slot is kept until the session is gone`
        : `coordinator ${sessionId} of run ${runId} stopped: ${why}`
    )
    return 'retired'
  }

  /** The body of `handToCoordinator`: the worktree, the session, the attach. */
  const startAndAttach = async (
    base: OrchState,
    job: Job,
    target: JobRun,
    accountId: string,
    rebase: boolean
  ): Promise<Reply> => {
    // Both callers ask first and take their own no-coordinator path; this is for the compiler.
    if (!deps.startCoordinator) return bad('starting a coordinator is not available in this build')
    // **워크트리를 먼저 만든다.** 코디네이터를 띄운 뒤에 만들면 그 세션이 첫 명령을 부르는 사이에
    // 워크트리 없는 Run 을 보게 된다. 실패하면 아래 spawn 실패와 같은 처리다 — 아무것도 바꾸지
    // 않고 거절한다(run-start 라면 `pendingStart` 가 남는다).
    let withWorktree = base
    // **고아가 되지 않는다.** 아래에서 코디네이터가 못 뜨면 상태는 하나도 안 바뀌므로(주석대로),
    // 방금 여기서 만든 폴더만 실제로 남는다 — 그 회차는 그 폴더를 다시 볼 길이 없다. 그래서 기억해
    // 두었다가 코디네이터 실패에서 지운다(Host S3, risk 6).
    let freshWorktree: string | null = null
    if (!target.worktree && deps.makeRunWorktree) {
      try {
        const created = await deps.makeRunWorktree({
          repoPath: job.cwd,
          name: nameForRun({ id: job.id, objective: job.objective })
        })
        const recorded = setRunWorktree(withWorktree, target.id, created)
        if (!recorded.ok) return bad(recorded.error)
        withWorktree = recorded.state
        freshWorktree = created
      } catch (e) {
        return bad(`could not create the run worktree: ${String(e)}`)
      }
    }
    let sessionId: string
    try {
      const spawned = await deps.startCoordinator({
        runId: target.id,
        cwd: job.cwd,
        accountId,
        brief: buildHandoverPrompt({
          runId: target.id,
          objective: job.objective,
          concurrency: job.concurrency ?? DEFAULT_CONCURRENCY,
          // 같은 이유로 `s` 가 아니다 — '실행' 이 방금 베껴 넣은 Task 들이 그 스냅샷에는 없다.
          taskCount: base.tasks.filter((t) => t.runId === target.id).length,
          // policyOf 로 판정한다, target.convergence !== undefined 가 아니다 — 손으로 고친
          // "convergence": null 은 !== undefined 로는 정책이 있다고 잘못 읽혀 코디네이터 브리핑이
          // "수렴 중인 Task 는 건드리지 말라"는 문단을 얻는데, 다른 모든 관문(reconciler.ts,
          // core/orchestration/exec/validation.ts 의 startValidation)은 이미 이 실수를 policyOf 로 고쳐 두었다 — 여기만 남아
          // 있었다(전체 브랜치 리뷰, Finding 2).
          // **`s` 가 아니라 방금 만든 회차가 들어 있는 상태로 묻는다.** `s` 는 명령 진입 시점의
          // 스냅샷이라 이 회차가 없고, 그러면 policyOf 가 회차를 찾지 못해 정책이 걸린 Job 도
          // "정책 없음" 으로 읽힌다 — 코디네이터가 수렴 절 없는 브리핑을 받는다.
          convergence: policyOf(base, { runId: target.id }) !== null
        })
      })
      sessionId = spawned.sessionId
    } catch (e) {
      // **`pendingStart` 를 그대로 둔다.** 걷어 버리면 실행 버튼이 사라져 사람이 다시 누를 수
      // 없고, 운전자도 없는 Run 이 남는다 — 아무것도 돌지 않는데 화면은 시작한 것처럼 보인다.
      // 그래서 이 실패는 상태를 하나도 바꾸지 않는다.
      //
      // **방금 만든 워크트리는 예외다 — 상태가 아니라 디스크에 남는다.** 상태를 안 바꾸므로 이
      // 회차는 그 경로를 다시 보지 못하고, 그러면 `run-delete removeWorktrees` 도 결코 이 폴더를
      // 겨누지 않는다: 아무도 지우지 않는 고아 워크트리다.
      //
      // **지우는 것 자체가 거절되거나 실패해도 이 400 은 절대 바뀌지 않는다**(fix round 1, I1).
      // `deps.discardRunWorktree` 가 있으면 그것만 쓴다 — Host 쪽 배선은 그 실패를 결코
      // `onAppRequired` 로 표시하지 않아, "코디네이터를 못 띄웠다"는 이 실패가 "앱이 필요하다"는
      // 409 로 둔갑하지 않는다. 없으면(예: 앱이 직접 도는 옛 배선) `removeWorktrees` 로 대신한다 —
      // 그쪽에는 그런 표시가 없으니 안전하다. 어느 쪽이든 실패는 로그만 남기고, 고아가 남았다는
      // 말은 이 400 자신의 문구에 싣는다 — 사람이 볼 자연스러운 자리가 그것뿐이다.
      let orphanNote = ''
      if (freshWorktree) {
        const orphan = freshWorktree
        if (deps.discardRunWorktree) {
          const { removed, inUse } = await deps.discardRunWorktree(orphan)
          if (!removed)
            orphanNote = inUse
              ? ` — its fresh run worktree ${orphan} is still in use and was left behind`
              : ` — its fresh run worktree ${orphan} could not be removed and was left behind`
        } else if (deps.removeWorktrees) {
          try {
            const { failed } = await deps.removeWorktrees([orphan])
            if (failed.length > 0) {
              deps.log?.(`orphaned run worktree ${orphan} is still in use — left in place`)
              orphanNote = ` — its fresh run worktree ${orphan} is still in use and was left behind`
            }
          } catch (removeErr) {
            deps.log?.(`orphaned run worktree ${orphan} could not be removed: ${String(removeErr)}`)
            orphanNote = ` — its fresh run worktree ${orphan} could not be removed and was left behind`
          }
        }
      }
      return bad(`could not start the coordinator: ${String(e)}${orphanNote}`)
    }
    // autoDispatch 는 **지운다** — false 로 두면 JSON 비교에서 "없음" 과 다른 값이 되고, 이
    // 코드베이스는 해당 없는 칸을 두지 않는다(startRun 이 pendingStart 를 지우는 것과 같다). 계획의
    // 칸이므로 Job 에서 지운다. 예약 Job 에는 처음부터 없다(run-create 가 주지 않는다).
    let onto = withWorktree
    if (rebase) {
      onto = deps.getState()
      // **Another coordinator got the slot meanwhile** (fix round 1, I2): only a start that outlived its
      // mark's window, or a hand-edited file, gets here. The slot stays as it is, and the session this
      // call started is stopped, so the Run does not end up with two agents driving it.
      const current = onto.runs.find((r) => r.id === target.id)
      if (current?.coordinatorSessionId !== undefined && current.coordinatorSessionId !== sessionId) {
        deps.log?.(
          `run ${target.id} already has coordinator ${current.coordinatorSessionId}; ` +
            `stopping the one this start opened (${sessionId})`
        )
        try {
          if (deps.stopCoordinator) await deps.stopCoordinator(sessionId)
          else deps.log?.(`coordinator ${sessionId} could not be stopped: nothing here can stop a session`)
        } catch (e) {
          deps.log?.(`coordinator ${sessionId} could not be stopped: ${String(e)}`)
        }
        if (freshWorktree && current.worktree !== freshWorktree && deps.discardRunWorktree)
          await deps.discardRunWorktree(freshWorktree)
        await dropStartMark(target.id, now)
        return okBody(deps.getState().runs.find((r) => r.id === target.id) ?? current)
      }
      if (freshWorktree) {
        const recorded = setRunWorktree(onto, target.id, freshWorktree)
        if (recorded.ok) onto = recorded.state
        else deps.log?.(`run ${target.id}: its fresh run worktree ${freshWorktree} was not recorded: ${recorded.error}`)
      }
    }
    const handed = onto.jobs.map((j) => {
      if (j.id !== job.id) return j
      const { autoDispatch: _drop, ...rest } = j
      return rest
    })
    return commit(attachCoordinator({ ...onto, jobs: handed }, { runId: target.id, sessionId }))
  }

  // **이 캐스트가 아래 표를 `astera agent-context` 의 명령 목록에 못 박는다**(cliAgentContext.ts).
  // `cmd` 는 여전히 아무 문자열이나 될 수 있고 — 모르는 명령은 아래 `default` 가 501 로 답한다 —
  // 좁힌 이름으로 가르는 것은 **이 switch 가 무엇을 다루기로 했는가** 쪽이다. 그래서 두 방향이 다
  // 컴파일 오류가 된다: 스키마에 없는 `case` 는 "not comparable to SwitchedCommand" 이고, 스키마에만
  // 있고 `case` 가 없는 이름은 `default` 의 `never` 를 깨뜨린다. 명령을 하나 더할 때 스키마를
  // 잊는 것이 이 파일에서 가장 하기 쉬운 실수였고, 이제 그것이 빌드를 멈춘다.
  const routed = cmd as SwitchedCommand
  switch (routed) {
    case 'run-create': {
      const objective = str(args.objective)
      // .trim() here (unlike the plain str() presence check elsewhere) because resolveProjectRoot
      // below is a real async call now — a whitespace-only objective must not reach it.
      if (!objective?.trim()) return bad('--objective is required')
      // **provider 는 이제 Run 의 것이 아니다** — Task 의 계정이 정한다(Task.accountIds). 조용히
      // 무시하지 않고 거절하는 이유: 이 플래그를 보내는 호출자는 "이 Run 은 이 CLI 로 돈다"고
      // 믿고 있고, 무시하면 그 믿음이 틀렸다는 것을 알 방법이 없다. 한 Run 에 두 provider 의
      // Task 가 섞일 수 있게 된 것이 이 변경의 목적이므로 옮길 자리도 없다.
      if (args.provider !== undefined)
        return bad('--provider is no longer accepted — the provider comes from task-create --account')
      const concurrency = args.concurrency === undefined ? null : posInt(args.concurrency)
      if (args.concurrency !== undefined && concurrency === null)
        return bad('--concurrency must be an integer >= 1')
      // 완료 수렴(설계 D12). --convergence 만 주면 빈 정책(기본값). 숫자 셋은 --convergence 없이는
      // 거절한다 — 조용히 받으면 "정책을 줬는데 꺼져 있다" 가 된다.
      let convergence: ConvergencePolicy | undefined
      const wantsConvergence = args.convergence === true
      const hasKnob =
        args.maxFixAttempts !== undefined ||
        args.maxReviewRounds !== undefined ||
        args.blockingSeverity !== undefined ||
        args.maxTotalMinutes !== undefined
      if (hasKnob && !wantsConvergence)
        return bad(
          '--max-fix-attempts, --max-review-rounds, --max-total-minutes and --blocking-severity require --convergence'
        )
      if (wantsConvergence) {
        convergence = {}
        if (args.maxFixAttempts !== undefined) {
          const n = posInt(args.maxFixAttempts)
          if (n === null) return bad('--max-fix-attempts must be an integer >= 1')
          convergence.maxFixAttempts = n
        }
        if (args.maxReviewRounds !== undefined) {
          const n = posInt(args.maxReviewRounds)
          if (n === null) return bad('--max-review-rounds must be an integer >= 1')
          convergence.maxReviewRounds = n
        }
        if (args.blockingSeverity !== undefined) {
          if (args.blockingSeverity !== 'high' && args.blockingSeverity !== 'medium')
            return bad('--blocking-severity must be high|medium')
          convergence.blockingSeverity = args.blockingSeverity
        }
        // 시간 예산(명세 §40). 나머지 셋과 같은 모양으로 받는다 — 이 칸만 명령으로 줄 길이 없으면
        // 정책에 있어도 손으로 orchestration.json 을 고치는 것 말고는 켤 방법이 없다.
        if (args.maxTotalMinutes !== undefined) {
          const n = posInt(args.maxTotalMinutes)
          if (n === null) return bad('--max-total-minutes must be an integer >= 1')
          convergence.maxTotalMinutes = n
        }
      }
      // 이 Run 을 관리할 코디네이터 세션의 계정. **하나다** — 목록이 아닌 이유는 Run.coordinatorAccountId
      // 의 주석에 있다(갈아타는 대신 같은 세션에서 기다린다). 없으면 코디네이터를 띄우지 않고 앱이
      // 돌린다(옛 동작). 사이드바는 그 상태를 만들지 않지만 CLI 와 옛 Run 이 그 갈래다.
      const coordArg = str(args.coordinatorAccount)
      let coordinatorAccountId: string | undefined
      if (coordArg !== null) {
        // 쉼표를 **거절한다.** 조용히 첫 칸만 쓰면 사람이 적은 것과 도는 것이 달라지고, 그 사실을
        // 알 방법이 화면에 없다 — `--account` 가 빈 칸을 거절하는 것과 같은 이유다.
        if (coordArg.includes(','))
          return bad('--coordinator-account takes one account, not a list')
        // Awaited: the account list may be answered across a socket now (listAccounts' own note).
        // Nothing is committed from the entry snapshot on this path — the state this command writes
        // is built from the `deps.getState()` re-read further down, which the `resolveProjectRoot`
        // await below already made necessary.
        if (!(await deps.listAccounts()).some((k) => k.id === coordArg))
          return notFound(`unknown account: ${coordArg}`)
        coordinatorAccountId = coordArg
      }
      // 예약. **규칙만 받는다**(command 없는 반쪽) — Job 에는 타이핑할 명령이 없다(Run.schedule).
      // 지역 변수로 좁히는 이유는 타입이다: `if (a && !guard) return` 은 블록 밖에서 좁혀지지 않는다.
      let schedule: ScheduleRule | undefined
      if (args.schedule !== undefined) {
        if (!isValidRule(args.schedule)) return bad('--schedule must be a valid schedule rule')
        schedule = args.schedule
      }
      // process.cwd() is evaluated in the Electron main process — a different process from the CLI
      // (src/cli/run.ts), so this fallback has nothing to do with the CLI's actual working directory.
      // The CLI already fills in its own process.cwd() in buildRequest when --cwd is omitted, so in
      // practice this server-side fallback is unreachable unless a caller bypasses the CLI — it is
      // kept defensively anyway.
      const given = str(args.cwd) ?? process.cwd()
      // Normalised to the owning project root before it is stored, so that the sidebar's
      // exact-match ownership test (runsForProject) can stay exact. Skipped when the dependency is
      // not injected — the same optional-dependency convention as now?/log?/backup?.
      //
      // A rejection falls back to the path as given, for the same reason handleExit wraps
      // deps.probeLimit: the wiring reads files (knownProjectPaths walks every configured account)
      // and shells out to git (ipc.ts), and none of that may stop a Run from being created. The
      // normalisation only decides which project list the Run shows up in; failing it closed would
      // trade the whole feature for a display improvement.
      let cwd = given
      if (deps.resolveProjectRoot) {
        try {
          cwd = await deps.resolveProjectRoot(given)
        } catch (err) {
          deps.log?.(`project root resolution failed cwd=${given}: ${String(err)}`)
        }
      }
      // getState is read again here, not the snapshot s taken on entry — resolveProjectRoot above
      // is a real await (it reads files and shells out to git), so by the time this runs, s is
      // stale. createRun(s, ...) would commit against that stale snapshot and silently overwrite
      // whatever landed during the await — a Dispatch opened in that window would disappear from
      // the committed state while its session keeps running, orphaning the worker. Every other
      // command with an await between its entry read and its commit already re-reads (worker-start
      // below after deps.startWorker, handleExit after deps.probeLimit, send after deps.probeLimit,
      // reset's wipe() after deps.backup) — this is the same fix, just late: run-create used to be
      // the one place in this switch that awaited and then committed against the entry snapshot
      // anyway, because before this branch a second Run mid-await was rare enough not to matter.
      // The scheduler added in this branch runs after every setState, and the sidebar's "+ 새 작업"
      // button makes a person creating a second Run while workers are running ordinary, not rare —
      // so the window this await always had is now one this app hits in normal use.
      const latest = deps.getState()
      // **등록되어 있으면 그 프로젝트에 매단다.** 등록은 여기서 하지 않는다 — 프로젝트 목록을
      // 채우는 것은 사람이 프로젝트를 여는 일이고(ipc.ts 의 orch.list), 이 명령은 CLI 로도
      // 불린다: 코디네이터가 워크트리 안에서 부른 run-create 가 그 워크트리를 프로젝트로
      // 등록해 버리면 목록이 작업 폴더로 오염된다. 위에서 cwd 는 이미 프로젝트 루트로
      // 정규화됐으므로(resolveProjectRoot), 앱이 아는 저장소라면 여기서 맞는다.
      // 못 맞으면 칸이 비고, 그 Run 은 옛 Run 과 같은 경로 유도로 목록에 든다.
      const project = findProjectByPath(latest, cwd)
      const created = createJob(
        latest,
          {
            objective,
            cwd,
            ...(project ? { projectId: project.id } : {}),
            ...(concurrency !== null ? { concurrency } : {}),
            ...(coordinatorAccountId ? { coordinatorAccountId } : {}),
            // `--auto` 는 값이 없는 플래그다(task-create --review 와 같은 모양). **예약이면 켜지
            // 않는다** — 템플릿 자신은 돌지 않기 때문이다.
            //
            // **그래도 발화가 만든 회차는 돈다**(U1, F65). 누가 그 회차를 모는지는 여기가 아니라
            // 회차를 만드는 순간에 정한다: 코디네이터 계정이 있으면 run-spawn 이 그 회차의 코디네이터를
            // 띄우고, 없으면 startJobRun 이 그 회차에 `autoDispatch` 를 찍는다(JobRun.autoDispatch). 이
            // 칸을 계획에 주지 않는 것은 그대로다. 디스크에 있는 예약 Job 들에는 이 칸이 없으므로,
            // 계획의 칸에 기대는 규칙은 옮겨 적기 없이는 그 Job 들에 듣지 않는다(R2).
            ...(args.auto === true && schedule === undefined ? { autoDispatch: true } : {}),
            ...(schedule !== undefined ? { schedule } : {}),
            // `--auto` 는 "앱이 돌린다" 이고, 그 시작 시점은 사람이 정한다 — Task 를 하나 만드는
            // 순간 돌기 시작하던 것을 '실행' 버튼 뒤로 미룬다(Run.pendingStart).
            //
            // **예약도 이 게이트를 쓴다.** 템플릿 자신은 돌지 않지만 발화는 시작이고, Task 를 다 짜기
            // 전에 첫 회차가 도는 것은 보통 Run 에서 없앤 바로 그 문제다. 게이트가 걷히는 순간부터
            // 무장하므로(firesDue), '실행' 을 누른 뒤의 첫 예약 시각이 첫 회차가 된다.
            ...(args.auto === true ? { pendingStart: true } : {}),
            ...(convergence ? { convergence } : {})
          },
        now
      )
      if (!created.ok) return commit(created)
      // **코디네이터에게는 곧바로 회차를 준다.** 계획만 만들고 끝내면 `--run` 에 넣을 id 가 없고,
      // 코디네이터는 Task 를 만들어 가며 일하므로 붙일 자리가 그 자리에 있어야 한다.
      //
      // 회차를 만들지 않는 두 경우는 **아직 돌 때가 아닌 계획**이다. 사람이 화면에서 만든 Job 은
      // '실행' 을 누를 때까지 기다리고(`--auto` + pendingStart), 예약 Job 의 회차는 발화가 만든다 —
      // 여기서 하나 만들면 예약 시각이 되기도 전에 1회차가 도는 일이 된다.
      if (args.auto === true || schedule !== undefined) return commit(created)
      return commit(startJobRun(created.state, created.value.id, now))
    }
    // **등록된 저장소들.** 만들지 않는다 — 프로젝트는 사람이 폴더를 여는 순간 등록되고
    // (ipc.ts 의 orch.list), CLI 가 그것을 흉내 내면 워커의 워크트리가 목록에 섞인다.
    case 'projects-list':
      return okBody(s.projects)
    case 'projects-get': {
      const id = str(args.id)
      if (!id) return bad('--id is required')
      const project = findProject(s, id)
      return project ? okBody(project) : notFound(`unknown project: ${id}`)
    }
    // **경로로 찾는다.** 셸에서 치는 쪽은 id 를 모르고 자기가 선 폴더를 안다. 비교는 isSamePath 다
    // — win32 은 대소문자를 가리지 않고 같은 저장소가 여러 철자로 들어온다.
    case 'projects-find': {
      const p = str(args.path)
      if (!p) return bad('--path is required')
      const project = findProjectByPath(s, p)
      return project ? okBody(project) : notFound(`no project registered for: ${p}`)
    }
    // **회차를 낸다, 계획이 아니라.** `--job` 은 한 계획의 회차만 추린다. 번호순으로 내보내는
    // 것은 배열에 들어간 순서가 곧 시간순이 아니기 때문이다 — 예약은 발화마다 뒤에 붙지만
    // 사람이 앞 회차를 지우면 그 자리가 메워지지 않는다.
    case 'runs-list': {
      const job = str(args.job)
      // Given with no value (`--job ""`, or a bare `--job`), it is not "no filter": a script whose id
      // came back empty would read every run as that Job's (review M1). The same 400 as tasks-add.
      if (args.job !== undefined && job === null) return bad('--job needs a value: the Job id')
      // A named Job that is not there is a 404, not an empty list, for the reason tasks-list gives
      // for its `--run`: the list would read as "that Job has no runs" (conformance audit #101).
      if (job && !s.jobs.some((j) => j.id === job)) return notFound(`unknown job: ${job}`)
      const runs = job ? s.runs.filter((r) => r.jobId === job) : s.runs
      return okBody([...runs].sort((a, b) => a.ordinal - b.ordinal).map((r) => runView(s, r)))
    }
    /**
     * 끝날 때까지 기다린다 — CI 가 부르는 자리(공개 CLI 설계 §5·§8).
     *
     * **언제나 200 으로 답하고, 무엇으로 끝났는지를 본문이 말한다.** 종료 코드로 바꾸는 것은
     * CLI 의 일이다(cliOutput 의 waitEnd) — "실패로 끝났다" 는 HTTP 상태로 말할 수 없고,
     * 억지로 골라 쓰면 4나 6 이 뜻하는 것이 명령마다 달라진다.
     *
     * `jobs wait` 은 **매 번 최신 회차를 다시 고른다.** 그래야 `jobs run` 으로 돌리고 이어서
     * 기다리는 것과, 예약이 발화해 만든 회차를 잡는 것이 둘 다 된다.
     */
    /**
     * 이 계획을 지금 돌린다 (공개 CLI 설계 §5 Phase B).
     *
     * **새 이름이지 새 동작이 아니다.** 사이드바의 '실행' 과 다시 돌리기가 하던 일 둘을
     * 한 명령으로 묶는다: 아직 무장하지 않았거나 회차가 하나도 없으면 `run-start`, 이미 돌았던
     * 계획이면 `run-spawn`. 셸에서 치는 사람은 그 둘을 가를 이유가 없다 — 둘 다 "돌려라" 다.
     *
     * **돌고 있는 것을 또 돌리지 않는다.** 그러면 한 계획에 동시에 두 회차가 도는데, 그것을
     * 원했다면 `--again` 같은 말을 츠을 것이다. 지금은 거절하고 무엇이 도는지 말해 준다.
     */
    case 'jobs-run': {
      const id = str(args.id)
      if (!id) return bad('--id is required')
      const job = s.jobs.find((j) => j.id === id)
      if (!job) return notFound(`unknown job: ${id}`)
      const latest = latestRunOf(s, job)
      // Reading `limited` as "not running" let a cron `jobs run` during a usage wait start a second Run
      // of the same Job beside the first, the thing this refusal exists to prevent (runningRunOf).
      const running = runningRunOf(s, job, now)
      if (running)
        return conflict(`job ${id} is already running (run ${running.id}) — wait for it or stop it first`)
      // **예약은 무장을 건드리지 않는다.** "지금 돌려라" 는 한 회차를 지금 만들라는 말이지
      // "이 예약을 켜라" 가 아니다 — 켜는 것은 발화 시각마다 도는 것을 뜻하고, 사람이 그것까지
      // 원했다면 사이드바의 '실행' 이 그 버튼이다.
      const first = job.schedule === undefined && (job.pendingStart === true || latest === undefined)
      const reply = await handleCommand(deps, caller, first ? 'run-start' : 'run-spawn', { run: id })
      // **carry 4 (R18, 사용자의 Q2), 그리고 U1: 뒤 회차도 앞 회차와 같이 코디네이터를 띄운다.** 그
      // 일은 이제 `run-spawn` 자신이 한다(handToCoordinator) — 발화가 같은 명령을 부르므로, 예약의
      // 회차와 `jobs run` 의 회차가 같은 몸통으로 시작한다. 예전에는 이 자리가 `run-spawn` 뒤에
      // `run-start` 를 한 번 더 불렀고, 예약 Job 은 거기서 빠졌다.
      //
      // **N7 — 뒤 회차의 실패는 첫 회차의 실패가 아니다.** `run-spawn` 이 이미 그 회차를 커밋한
      // 뒤이므로, 코디네이터를 못 띄워도(세션이 거절되거나 워크트리를 못 만들어도) 그 회차는
      // 코디네이터 없이 그대로 남는다 — `run-start` 자신의 실패가 아무것도 커밋하지 않는 것과
      // 다르다. 그 답은 회차를 `runId` 로 싣고(run-spawn), 여기서 실패 문구에 재시도할 명령을 직접
      // 박아 둔다: CLI 의 `nextSteps` 표는 명령이 아니라 종료 코드로 갈라(cliOutput.ts) 이 명령만의
      // 다음 걸음을 싣지 못한다. 재시도는 **회차 id** 를 겨눈다 — `run-start` 가 회차 id 를 그 회차의
      // 관리자로 받고(▶ 와 같은 길), 예약 Job 의 id 로는 게이트만 걷어 이 회차에 닿지 않는다.
      if (reply.status < 200 || reply.status >= 300) {
        const failed = reply.body as { error?: string; runId?: unknown }
        if (first || typeof failed?.runId !== 'string') return reply
        const runId = failed.runId
        return {
          status: reply.status,
          body: {
            ...failed,
            error:
              // One instruction (final review M6): a refusal from a retiring Host also says "start
              // it again", and the CLI's own step for such a refusal is the same command. Here the
              // same command does not help: the new run has no coordinator slot and no start mark, so
              // nothing moves it (runMoves), and a second `jobs run` is not refused but makes a third
              // run beside it (final review I3). The message names the one that works.
              `${failed.error ?? ''}. The new run ${runId} has no coordinator. Running \`jobs run\` ` +
              `again would start another run beside this one; start this one with: astera run-start --run ${runId}`,
            jobId: id,
            runId
          }
        }
      }
      // **돌려주는 것은 언제나 회차다.** 이 명령이 있는 이유가 받은 id 를 `runs wait` 에 넘기는
      // 것인데, run-start 는 계획을 돌려준다(사이드바의 '실행' 이 그것을 쓴다). 실제로 그 id 를
      // `task-create --run` 에 넘겨 봤더니 Task 가 회차가 아니라 계획에 붙어 이번 회차에서는
      // 아무 일도 하지 않았다.
      const after = deps.getState()
      const jobAfter = after.jobs.find((j) => j.id === id)
      const started = jobAfter && latestRunOf(after, jobAfter)
      return started ? okBody(runView(after, started)) : reply
    }
    /**
     * 계획을 만든다 — 공개 이름(phase C). **언제나 계획부터다**: 사이드바의 '새 작업' 이 보내는 것과
     * 같이 `auto` 를 붙여 run-create 로 간다(NewRunModal). auto 없는 run-create 는 Task 가 하나도
     * 없는 회차를 곧바로 돌리는데, 셸에서 치는 사람이 원하는 일이 아니다. 회차는 `jobs run` 이 만든다.
     *
     * 돌려주는 것은 계획이고 `jobs get` 과 같은 파생값을 싣는다 — 회차가 없으므로 정의 Task 를 센다.
     *
     * **COORDINATOR_ONLY 에 따로 적지 않는다.** 같은 caller 로 run-create 를 부르므로 워커는 거기서
     * 403 을 받는다 — `jobs run` 이 run-start 로 가며 받는 것과 같은 경계다. tasks-add 도 같다.
     */
    case 'jobs-create': {
      const reply = await handleCommand(deps, caller, 'run-create', { ...args, auto: true })
      if (reply.status < 200 || reply.status >= 300) return reply
      const after = deps.getState()
      const created = after.jobs.find((j) => j.id === (reply.body as { id?: unknown }).id)
      return created ? okBody(jobView(after, created, undefined)) : reply
    }
    /**
     * Task 를 더한다 — task-create 의 공개 이름(phase C).
     *
     * **`--job` 과 `--run` 중 정확히 하나다.** task-create 의 기본값("가장 최근 회차")은 셸에서
     * 치는 사람에게 남의 회차일 수 있어서 내주지 않는다. 그리고 **플래그가 종류를 정한다** —
     * task-create 의 `--run` 은 Job id 를 받으면 조용히 정의 Task 를 만들지만, 여기서는 `--job` 에 준
     * 회차 id 도 `--run` 에 준 계획 id 도 그 종류로는 없는 것이므로 404 다.
     *
     * `--run-id` 는 task-create 가 `--run` 보다 먼저 읽는 옛 철자라, 받으면 이 규칙을 넘어선다 —
     * 거절한다.
     *
     * **`--validate` 는 그 계획의 구성 id 로 확인한다**(phase D). task-create 는 id 를 확인하지 않고
     * 싣는다 — 코디네이터는 run-configs 에서 막 읽은 id 를 넣기 때문이다. 셸에서 치는 사람은 오타를
     * 내고, 확인 없이 실린 id 는 워커가 일을 다 마친 뒤 검증 자리에서야 실패한다. 없는 id 는 404 이고
     * 답에 계획 id 를 싣는다: CLI 가 `run-configs list --job <jobId>` 를 채워 권한다(cliOutput).
     */
    case 'tasks-add': {
      if (args.runId !== undefined) return bad('tasks add takes --run, not --run-id')
      // **친 플래그로 센다, 값으로가 아니라.** `--job --run r1` 은 `job: true` 로 온다 — 값으로 세면
      // `--run` 하나만 준 것이 되어, 부른 사람이 적은 `--job` 이 조용히 사라진다.
      if ((args.job === undefined) === (args.run === undefined))
        return bad('exactly one of --job or --run is required')
      const job = str(args.job)
      const run = str(args.run)
      if (args.job !== undefined && job === null) return bad('--job needs a value: the Job id')
      if (args.run !== undefined && run === null) return bad('--run needs a value: the run id')
      if (job !== null && !s.jobs.some((j) => j.id === job)) return notFound(`unknown job: ${job}`)
      if (run !== null && !s.runs.some((r) => r.id === run)) return notFound(`unknown run: ${run}`)
      if (args.validate !== undefined) {
        const validate = str(args.validate)
        if (validate === null) return bad('--validate needs a value: run configuration ids')
        const ids = validate.split(',').map((x) => x.trim())
        if (ids.some((x) => x === '')) return bad('--validate must not contain an empty entry')
        const owner = job !== null ? s.jobs.find((j) => j.id === job) : jobOf(s, s.runs.find((r) => r.id === run)!)
        if (!owner) return notFound(`unknown job for run: ${String(run)}`)
        if (!deps.listRunConfigs) return conflict('run configurations cannot be listed here')
        const known = new Set((await deps.listRunConfigs(owner.cwd)).map((c) => c.id))
        const unknown = ids.filter((x) => !known.has(x))
        if (unknown.length > 0)
          return {
            status: 404,
            body: { error: `unknown run configuration: ${unknown.join(', ')} (not one of job ${owner.id}'s)`, jobId: owner.id }
          }
      }
      const { job: _job, ...rest } = args
      return handleCommand(deps, caller, 'task-create', { ...rest, run: job ?? run })
    }
    case 'jobs-wait':
    case 'runs-wait': {
      const id = str(args.id)
      if (!id) return bad('--id is required')
      const byJob = cmd === 'jobs-wait'
      if (byJob) {
        if (!s.jobs.some((j) => j.id === id)) return notFound(`unknown job: ${id}`)
      } else if (!s.runs.some((r) => r.id === id)) {
        return notFound(`unknown run: ${id}`)
      }
      const probe = (): Record<string, unknown> | null => {
        const cur = deps.getState()
        const now = deps.now?.() ?? new Date().toISOString()
        if (!byJob) return waitEndingFor(cur, id, now)
        const job = cur.jobs.find((j) => j.id === id)
        const run = job && latestRunOf(cur, job)
        return run ? waitEndingFor(cur, run.id, now) : null
      }
      const timeoutMs =
        typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_WAIT_TIMEOUT_MS
      const waited = await pollUntil(probe, timeoutMs)
      if ('value' in waited) return okBody(waited.value)
      // 마감에 닿았을 때도 지금 어디까지 왔는지를 싣는다 — "안 끝났다" 만 들고 돌아가면
      // 사람이 그 다음에 무엇을 볼지 모른다.
      const cur = deps.getState()
      const run = byJob
        ? (() => {
            const job = cur.jobs.find((j) => j.id === id)
            return job && latestRunOf(cur, job)
          })()
        : cur.runs.find((r) => r.id === id)
      return okBody({
        state: 'timeout',
        jobId: byJob ? id : run?.jobId,
        runId: run?.id ?? null,
        progress: run ? progressOf(cur, run.id) : { done: 0, total: 0 }
      })
    }
    /**
     * 이 회차를 멈춘다 (공개 CLI 설계 §5·§15).
     *
     * **`cancel` 이 아니라 `stop` 인 이유.** 이 모델에는 "취소된 회차" 가 없고, 여기서 하는 일은
     * 되돌릴 수 있다 — 워커를 닫고 회차를 세우며, `run-resume` 이 푸는 것과 같은 상태다.
     * 되돌릴 수 있는 것을 취소라고 부르면 사람이 되돌릴 수 없다고 읽는다.
     *
     * **붙잡아 둔 세션은 죽이지 않는다.** worker-retain 은 사람이 "이 세션을 살려 두어라" 고 말한
     * 것이다. worker-stop·run-pause·run-delete 가 같은 이유로 같은 거절을 하고, 푸는 법도
     * 같다(worker-release).
     *
     * **세우는 것까지 해야 멈춘다.** Dispatch 만 닫으면 빈 자리에 그 회차의 다음 ready Task 가
     * 곧바로 뜨고(JobRun.paused 의 주석), 멈췄다고 말해 놓고 계속 도는 것이 된다.
     */
    case 'runs-stop': {
      const id = str(args.id)
      if (!id) return bad('--id is required')
      const run = s.runs.find((r) => r.id === id)
      if (!run) return notFound(`unknown run: ${id}`)
      const mine = new Set(s.tasks.filter((t) => t.runId === id).map((t) => t.id))
      const open = s.dispatches.filter((d) => !d.outcome && !d.endedAt && mine.has(d.taskId))
      const retained = open.filter((d) => d.retained)
      if (retained.length > 0)
        return conflict(
          `refusing to stop while ${retained.length} dispatch(es) are held by worker-retain — release them first`
        )
      const starting = stillStarting(open, now)
      if (starting) return starting
      for (const d of open.filter(releases)) await deps.releaseWorker({ dispatchId: d.id })
      const stopped = new Set(open.map((d) => d.id))
      const latest = deps.getState()
      await deps.setState({
        ...latest,
        dispatches: latest.dispatches.map((d) =>
          stopped.has(d.id)
            ? { ...d, workerState: 'stopped' as const, endedAt: now, closedBy: 'stop' as const }
            : d
        ),
        runs: latest.runs.map((r) => (r.id === id ? { ...r, paused: true } : r))
      })
      return okBody({ runId: id, stopped: open.length, paused: true })
    }
    /** 세워 둔 회차를 다시 돌게 한다. **`runs stop` 이 만든 상태를 푸는 유일한 길이다** —
     *  기존 `run-resume` 은 예약(계획)의 것만 걷고 예약이 아닌 Job 을 거절한다. 되돌릴 수 있다는
     *  것이 `stop` 이라는 이름의 근거이므로, 푸는 길이 없으면 그 이름이 거짓이 된다. */
    case 'runs-resume': {
      const id = str(args.id)
      if (!id) return bad('--id is required')
      return commit(resumeRun(s, id))
    }
    case 'runs-get': {
      const id = str(args.id)
      if (!id) return bad('--id is required')
      const run = s.runs.find((r) => r.id === id)
      return run ? okBody(runView(s, run)) : notFound(`unknown run: ${id}`)
    }
    // **계획을 낸다, 회차가 아니라.** 공개 표면의 `jobs list` 가 뜻하는 것이 계획이고, 회차는
    // `runs list` 의 것이다(공개 CLI 설계 §5). 옛 `run-list` 는 한 배열밖에 없어서 둘을 함께 냈다.
    case 'jobs-list':
      return okBody(s.jobs.map((j) => jobView(s, j, latestRunOf(s, j))))
    // 코디네이터가 --validate 에 넣을 id 를 알아야 한다. 상태를 바꾸지 않으므로 COORDINATOR_ONLY
    // 가 아니다 — 워커도 자기가 무엇으로 검증될지 볼 수 있어야 한다.
    case 'run-configs': {
      if (!deps.listRunConfigs) return okBody([])
      const run = latestRun(s)
      const job = run && jobOf(s, run)
      if (!job) return bad(`no run exists`)
      return okBody(await deps.listRunConfigs(job.cwd))
    }
    // **공개 이름은 계획을 지목한다**(phase D). 위의 `run-configs` 는 "가장 최근 회차" 의 것이라, 셸에서
    // 치는 사람에게는 남의 계획의 목록일 수 있다 — task-create 의 기본값을 tasks add 가 내주지 않은
    // 것과 같은 이유다. 회차 id 는 받지 않는다(tasks add --job 과 같은 규칙).
    case 'run-configs-list': {
      if (args.job === undefined) return bad('--job is required')
      const id = str(args.job)
      if (id === null) return bad('--job needs a value: the Job id')
      const job = s.jobs.find((j) => j.id === id)
      if (!job) return notFound(`unknown job: ${id}`)
      if (!deps.listRunConfigs) return okBody([])
      return okBody(await deps.listRunConfigs(job.cwd))
    }
    // **id 는 계획일 수도 회차일 수도 있다.** 사람은 목록에서 본 Job 의 id 를 주고, 코디네이터는
    // 자기가 받은 회차의 id 를 준다. 어느 쪽이든 돌려주는 것은 계획이다 — 코디네이터가 여기서
    // 읽는 것(동시 실행 한도, 수렴 정책)이 전부 계획의 칸이기 때문이다(가이드 4·8절).
    //
    // 회차를 지목했으면 그 회차를, 아니면 가장 최근 회차를 `run` 에 접어 싣는다. 두 단계를 평소에는
    // 안 보이게 한다는 설계 §5 의 접기가 이 자리다.
    case 'jobs-get': {
      const id = str(args.id)
      const named = s.runs.find((r) => r.id === id)
      const job = s.jobs.find((j) => j.id === id) ?? (named && jobOf(s, named))
      if (!job) return notFound(`unknown job or run: ${String(id)}`)
      const run = named ?? latestRunOf(s, job)
      // **파생값은 접어 실은 그 회차의 것이다.** 회차를 지목해 물었는데 계획의 숫자가 다른
      // 회차를 말하면 한 응답 안에서 두 가지를 말하는 셈이 된다.
      return okBody({ ...jobView(s, job, run), ...(run ? { run: runView(s, run) } : {}) })
    }
    // 사람이 사이드바에서 Run 을 물러나게 한다. **되돌릴 수 없다.**
    //
    // 자동 정리는 이미 있지만(store.ts 의 TTL: 모든 Task 가 terminal 인 Run 이 30일 지나면 버린다)
    // 그것이 손대지 못하는 것이 있다 — **끝나지 않은 Run 은 영원히 남는다.** 중단한 작업, 실패한
    // 실험, 워커가 죽어 dispatched 에 멈춘 Task 가 그렇다. 이 명령이 메우는 자리가 정확히 그것이다.
    //
    // 지우는 방법은 deleteRuns(core/orchestration/state.ts)가 안다 — TTL prune 과 **같은 함수**다.
    //
    // 워크트리와 브랜치는 건드리지 않는다: 그것은 사용자의 git 저장소이고 지우는 자리가 이미 있다
    // (파일 탐색기의 워크트리 패널). 앱이 Run 기록을 지우는 것과 사용자의 저장소를 지우는 것은
    // 다른 무게다.
    case 'run-delete': {
      const id = str(args.id)
      if (!id) return bad('--id is required')
      // **id 는 Job 일 수도 회차일 수도 있다.** 사이드바의 Job 줄은 Job 의 id 를 보내고(계획째
      // 지운다), 펼쳐진 회차 줄은 그 회차의 id 를 보낸다(기록 하나를 버린다). 정의는 Job 에 있으므로
      // 회차 하나를 지워도 다음 회차가 베낄 것이 남는다.
      const job = s.jobs.find((j) => j.id === id)
      const run = s.runs.find((r) => r.id === id)
      if (!job && !run) return notFound(`unknown job or run: ${String(id)}`)
      const doomed = job
        ? new Set(s.runs.filter((r) => r.jobId === job.id).map((r) => r.id))
        : new Set([id])
      // 도는 워커가 있으면 거절한다 — reset 이 같은 판정을 한다. 삭제는 되돌릴 수 없으므로 도는
      // 상태에서 다룰 것을 하나 더 만들지 않는다. 세션을 죽이는 일까지 이 명령이 하게 하면, 커밋
      // 안 된 작업을 워크트리에 남긴 워커가 조용히 사라진다.
      const open = s.dispatches.filter((d) => {
        if (d.outcome || d.endedAt) return false
        const runId = s.tasks.find((t) => t.id === d.taskId)?.runId
        return runId !== undefined && doomed.has(runId)
      })
      if (open.length > 0) {
        // **예약 템플릿만 스스로 정리한다.** 평범한 Run 에서는 "먼저 워커를 멈춰라"가 지킬 수 있는
        // 요구다 — 멈추면 다시 뜨지 않는다. 템플릿에서는 그것이 **충족될 수 없는 요구**다: 멈춘
        // 자리에 다음 발화가 또 워커를 띄우므로, 사람은 예약을 영원히 지울 수 없다(실제로 그렇게
        // 보고됐다). 그 고리를 끊는 자리가 여기다. 비대칭에는 이 이유가 있고, 그래서 자식 회차를
        // 직접 지울 때는 아래 옛 거절이 그대로 남는다.
        // 예약 Job 만 스스로 정리한다(아래 주석). 회차 하나를 지우는 것은 옛 거절이 그대로다.
        if (!job?.schedule)
          return conflict(
            `refusing to delete while ${open.length} dispatch(es) are open — stop them first`
          )
        // **붙잡아 둔 세션은 죽이지 않는다.** worker-retain 은 사람이 "이 세션을 살려 둬라"고 말한
        // 것이고, coordinator.releaseWorker 는 그것을 건너뛴다 — 그러면 기록만 지워져 그 세션이
        // 고아가 된다(worker-stop 이 같은 이유로 409 를 낸다). 이 거절은 풀 수 있다: worker-release
        // 로 붙잡음을 놓으면 된다.
        const retained = open.filter((d) => d.retained)
        if (retained.length > 0)
          return conflict(
            `refusing to delete while ${retained.length} dispatch(es) are held by worker-retain — release them first`
          )
        const starting = stillStarting(open, now)
        if (starting) return starting
        // 순차로 닫는다. releaseWorker 는 세션을 죽이는 부수 효과이고 상태를 쓰지 않는다 — 상태에서
        // 사라지는 것은 아래 deleteRuns 가 한꺼번에 한다.
        for (const d of open.filter(releases)) await deps.releaseWorker({ dispatchId: d.id })
      }
      // **병합이 먼저다.** 사람이 병합을 골랐는데 실패한 뒤 지우면 워커의 일이 워크트리 브랜치에
      // 갇힌 채 그 브랜치까지 사라진다 — 그래서 실패하면 아무것도 지우지 않고 이유를 돌려준다.
      // 순서도 이래야 한다: 폴더를 먼저 지우면 합칠 대상이 없어진다.
      //
      // **doomed 전체를 본다, id 하나가 아니라.** 예약 템플릿을 지우면 회차까지 함께 사라지고
      // (doomed), 워크트리를 쓴 것은 **회차들**이다 — 템플릿 자신은 한 번도 돌지 않으므로 폴더가
      // 없다. id 만 보면 그 목록이 비어서 병합도 폴더 삭제도 조용히 건너뛰어지고, 회차마다 하나씩
      // 쌓인 폴더가 그대로 남는다(그렇게 보고됐다).
      const worktrees = [...doomed].flatMap((r) => runWorktrees(s, r))
      if (args.merge === true && worktrees.length > 0) {
        if (!deps.mergeWorktrees) return bad('merging is not available in this build')
        const cwd = job?.cwd ?? (run && jobOf(s, run)?.cwd)
        if (cwd === undefined) return bad(`no project folder for ${String(id)}`)
        const merged = await deps.mergeWorktrees(cwd, worktrees)
        if (!merged.ok) return conflict(merged.reason)
      }
      // 백업은 지우기 전에. reset 과 같은 관례이고 같은 이유다 — 되돌릴 수 없는 삭제에 .bak 하나는
      // 값이 싸다. 실패해도 삭제를 막지 않는다(deps.backup 이 스스로 접는다).
      if (deps.backup) await deps.backup()
      // 폴더 삭제는 상태를 지우기 전에 한다 — 지운 뒤에는 어느 워크트리였는지 상태에서 읽을 수 없다.
      // 실패한 경로는 응답에 실어 보낸다: 삭제 자체를 막을 이유는 없고(기록을 지우는 것과 폴더를
      // 지우는 것은 다른 일이다) 사람이 남은 것을 알아야 한다.
      let worktreesFailed: string[] = []
      // **세 조건이 모두 참이어야 폴더가 지워진다.** 어느 하나가 거짓이면 조용히 아무 일도 일어나지
      // 않고, 사용자에게는 "체크했는데 폴더가 남았다"로 보인다 — 실제로 그렇게 보고됐고, 그때 로그에
      // 아무 흔적이 없어서 어느 조건이 걸렸는지 알 수 없었다. reapWorktree 는 자기 결과를 남기지만
      // 그것은 불린 뒤의 이야기다. 여기서 한 줄을 남기면 그 물음이 로그로 답해진다.
      if (args.removeWorktrees === true && worktrees.length > 0 && deps.removeWorktrees)
        worktreesFailed = (await deps.removeWorktrees(worktrees)).failed
      else if (args.removeWorktrees === true)
        deps.log?.(
          `run-delete ${id}: asked to remove worktrees but did not — ` +
            `worktrees=${worktrees.length} wired=${deps.removeWorktrees !== undefined}`
        )
      const before = s.tasks.filter((t) => t.runId !== undefined && doomed.has(t.runId)).length
      // Job 을 지목했으면 계획째, 회차를 지목했으면 그 기록만.
      await deps.setState(
        job ? deleteJobs(deps.getState(), new Set([job.id])) : deleteRuns(deps.getState(), doomed)
      )
      return okBody({
        deleted: id,
        tasks: before,
        ...(worktreesFailed.length > 0 ? { worktreesFailed } : {})
      })
    }
    // 사람이 '실행' 을 눌렀거나, Run 줄의 ▶ 로 사라진 코디네이터를 다시 띄운다. 부르는 것은 UI 와
    // `jobs run` 이다.
    case 'run-start': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      // **회차 id 는 그 회차 줄의 ▶ 다**(App.tsx 의 restartCoordinator). 펼쳐진 줄은 회차의 id 를
      // 싣는다(view.ts 의 rowFor): 예약 Job 의 회차와, 회차가 둘 이상인 Job 의 회차가 그렇다. 뜻은
      // "이 회차에 관리자가 있게 하라" 하나이고, 계획의 게이트는 건드리지 않는다. 한때 이 명령은
      // Job id 만 받아 그 줄의 ▶ 가 언제나 404 로 끝났다.
      const namedRun = s.runs.find((r) => r.id === id)
      if (namedRun) {
        const runJob = jobOf(s, namedRun)
        if (!runJob) return notFound(`unknown job for run: ${id}`)
        // **A finished Run gets no coordinator** (fix round 1, I3): there is nothing left for one to
        // manage, and starting it spends an account on a session that only reads a closed Run. The view
        // shows no ▶ for it either (view.ts's rowFor). A start in flight is answered the same way, by
        // handToCoordinator (I1). **So does a paused Run**: `runs resume` takes it back, not ▶, and a Run
        // a fire replaced (U4) is paused with its coordinator stopped on purpose. The view shows no ▶ on it.
        if (
          namedRun.coordinatorSessionId ||
          namedRun.paused === true ||
          !runJob.coordinatorAccountId ||
          !deps.startCoordinator ||
          outcomeOf(s, namedRun.id) !== 'running'
        )
          return okBody(namedRun)
        return handToCoordinator(s, runJob, namedRun, runJob.coordinatorAccountId, true)
      }
      // **그 밖의 id 는 Job 이다.** '실행' 은 계획을 푸는 일이고, 회차는 그 결과로 생긴다.
      const job = s.jobs.find((j) => j.id === id)
      if (!job) return notFound(`unknown job: ${id}`)
      // **Not reachable today.** releaseJob and startJobRun refuse only `unknown job: <id>` — the id
      // this command was given, which the guard above has just found in the same state. Were that
      // guard ever to drift from them, the answer is still "no such id", so they go through
      // `refused` like every other pure-layer refusal here.
      const released = releaseJob(s, id)
      if (!released.ok) return refused(released)
      // 예약 Job 은 여기서 회차를 만들지 않는다 — 발화가 만든다. 게이트만 걷힌다.
      let started = released
      let target = released.state.runs.filter((r) => r.jobId === id).at(-1)
      if (job.schedule === undefined && target === undefined) {
        const first = startJobRun(released.state, id, now)
        if (!first.ok) return refused(first)
        started = { ok: true, state: first.state, value: job }
        target = first.value
      }
      if (target === undefined) return commit(started)
      // **코디네이터를 띄울 수 있으면 띄우고, 이 Run 의 운전자를 그에게 넘긴다.** 넘기는 방식이
      // `autoDispatch` 를 끄는 것이다 — 한 Run 에 운전자는 하나이고, 켜 둔 채로 코디네이터를
      // 붙이면 둘이 같은 ready Task 를 두고 경합한다(Run.autoDispatch 의 주석).
      //
      // 계정 지정이 없거나 배선이 이 기능을 주입하지 않으면 옛 동작이다: 앱이 돌리고, 워커의
      // 질문은 앱의 그물이 풀어 준다(core/orchestration/inbox.ts).
      // **예약 Job 을 지목하면 게이트만 걷는다.** 예약의 계획은 스스로 돌지 않는다 — 회차마다 제
      // 코디네이터를 발화가 띄운다(run-spawn 이 handToCoordinator 를 부른다, U1). 여기서 가장 최근
      // 회차에 붙이면 '실행' 한 번이 이미 끝났을 수도 있는 회차에 관리자를 띄운다. 한 회차의 관리자가
      // 사라졌다면 그 회차 줄의 ▶ 가 회차 id 로 이 명령을 부른다(위).
      // **이미 관리자가 있으면 아무것도 하지 않는다.** 이 명령은 사이드바의 '실행' 과 코디네이터를
      // 다시 띄우는 버튼이 함께 쓴다 — 뜻은 "이 Run 에 관리자가 있게 하라" 이고, 두 번 눌러도 두
      // 세션이 뜨지 않아야 한다.
      if (target.coordinatorSessionId) return commit(started)
      // A Run that was already there and has finished: the same as its own row's ▶ (I3).
      if (s.runs.some((r) => r.id === target.id) && outcomeOf(s, target.id) !== 'running') return commit(started)
      const accountId = job.schedule ? undefined : job.coordinatorAccountId
      if (!accountId || !deps.startCoordinator) return commit(started)
      // Rebased when this call changes nothing on its own (no gate to release, no first Run): the ▶
      // on a Job row restarting its latest Run's coordinator (handToCoordinator's `rebase`).
      return handToCoordinator(started.state, job, target, accountId, started.state === s)
    }
    case 'run-pause': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      const target = s.jobs.find((j) => j.id === id)
      if (!target) return notFound(`unknown job: ${id}`)
      // 일시 중지는 예약에만 있다. 보통 Job 에는 멈출 발화가 없고, 그 Job 의 워커를 멈추는 것은
      // worker-stop 이 Dispatch 하나씩 하는 일이다 — 같은 일을 두 이름으로 두지 않는다.
      if (!target.schedule) return conflict(`job ${id} is not scheduled`)
      // 이 Job 의 회차 전부. run-delete 의 doomed 와 같은 집합이다.
      const family = new Set(s.runs.filter((r) => r.jobId === id).map((r) => r.id))
      const open = s.dispatches.filter((d) => {
        if (d.outcome || d.endedAt) return false
        const runId = s.tasks.find((t) => t.id === d.taskId)?.runId
        return runId !== undefined && family.has(runId)
      })
      // **붙잡아 둔 세션은 죽이지 않는다.** worker-retain 은 사람이 "이 세션을 살려 둬라" 고 말한
      // 것이고, worker-stop 과 run-delete 가 같은 이유로 같은 거절을 한다. 이 거절은 풀 수 있다:
      // worker-release 로 붙잡음을 놓으면 된다.
      const retained = open.filter((d) => d.retained)
      if (retained.length > 0)
        return conflict(
          `refusing to pause while ${retained.length} dispatch(es) are held by worker-retain — release them first`
        )
      const starting = stillStarting(open, now)
      if (starting) return starting
      // 세션을 닫는 것은 부수 효과이고 상태를 쓰지 않는다 — 상태에서 닫히는 것은 아래
      // pauseSchedule 이 한꺼번에 한다(run-delete 가 releaseWorker 를 쓰는 순서와 같다).
      for (const d of open.filter(releases)) await deps.releaseWorker({ dispatchId: d.id })
      return commit(pauseSchedule(s, id, now))
    }
    case 'run-resume': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      // **run-start 와 다른 명령이다.** 그쪽은 pendingStart("아직 시작하지 않았다")를 걷고, 이쪽은
      // paused("세워 뒀다")를 걷는다 — 사람에게 다른 버튼이고 다른 상황이다(Run.paused 의 주석).
      // 하나로 겸하게 했더니 세운 뒤에 '실행' 버튼과 '▶' 가 같은 일을 하는 둘로 나란히 떴다.
      return commit(resumeSchedule(s, id))
    }
    case 'run-worktree-set': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      const worktree = str(args.worktree)
      if (!worktree) return bad('--worktree is required')
      // **Only "already has one" is answered 409, on its own.** setRunWorktree refuses the same thing,
      // but that layer knows no HTTP, and `commit` (above) answers its `unknown run` (marked missing)
      // with 404 and every other refusal with 400 — so a second record would come out as a plain 400, not told
      // apart in the log from a malformed call. It means the wiring **made two worktrees**, one of
      // which stays on disk as a folder nobody remembers.
      //
      // 순수 층의 거절을 여기서 지우지 않는 이유: 이 명령이 유일한 호출자라는 보장이 없고, 그 함수가
      // 조용히 덮어쓰게 되면 이 코드가 지키는 불변식이 이 파일에만 있게 된다.
      const existing = s.runs.find((r) => r.id === id)?.worktree
      if (existing !== undefined)
        return conflict(`run ${id} already has a worktree: ${existing}`)
      return commit(setRunWorktree(s, id, worktree))
    }
    case 'run-merge': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      const run = s.runs.find((r) => r.id === id)
      if (!run) return notFound(`unknown run: ${id}`)
      // **run-delete 의 병합과 같은 호출이다.** 대상은 `run.cwd`(프로젝트 폴더)이고 재료는
      // runWorktrees — Run 워크트리와 아직 합쳐지지 않은 Task 워크트리들이 함께 온다. Task 가
      // 하나뿐인 병렬 Run(Run 워크트리는 비고 그 Task 워크트리에만 일이 있다)까지 이 한 호출로
      // 덮이는 것이 `run.worktree` 하나만 합치지 않는 이유다.
      const worktrees = runWorktrees(s, id)
      if (worktrees.length === 0) return okBody({ merged: [] })
      if (!deps.mergeWorktrees) return bad('merging is not available in this build')
      const mergeCwd = jobOf(s, run)?.cwd
      if (mergeCwd === undefined) return bad(`no project folder for ${id}`)
      const merged = await deps.mergeWorktrees(mergeCwd, worktrees)
      if (!merged.ok) return conflict(merged.reason)
      // **워크트리를 걷지 않는다.** 사람이 결과를 보고 다시 합칠 수도 있고, 폴더 정리는 삭제
      // 모달의 체크박스가 이미 하는 일이다 — 이 명령이 그것까지 하면 "합치기" 가 "합치고 지우기" 가
      // 되고, 그 둘을 따로 고를 수 있게 만든 결정이 무의미해진다.
      // **`worktrees` 가 아니라 `merged.merged` 를 돌려준다.** `worktrees` 는 부르기 전의 요청
      // 목록이라 배선이 걸러 낸 뒤에도 그대로다 — 이걸 돌려주면 실제로는 아무것도 합치지 못했을
      // 때도(모든 폴더가 이미 사라졌을 때) 응답이 성공을 알리게 된다.
      // **커밋되지 않은 변경의 수를 함께 올린다.** git 은 커밋만 옮기므로 그 변경은 합쳐지지 않았고
      // 그 폴더에만 있다 — 폴더를 지우면 사라진다. 병합이 성공했다는 말만 돌려주면 사람은 그것을
      // "일이 다 옮겨졌다" 로 읽고 폴더를 지운다.
      return okBody({ merged: merged.merged, uncommitted: merged.uncommitted })
    }
    // 계획의 회차를 하나 더 만들고 **`jobs run` 이 한 회차를 시작하는 그대로 시작한다**(U1, F65).
    // 부르는 것은 예약의 발화(core/orchestration/exec/dispatchLoop.ts 의 fireTick: 앱의 타이머와,
    // 운전하는 Host 의 tick)와 jobs-run 의 뒤 회차다. 코디네이터에게는 광고하지 않지만 명령으로 두는
    // 이유는 이 파일이 지키는 규율이다: 상태를 쓰는 문은 하나이고, 그 문이 검증·커밋·감사 로그를
    // 함께 지난다. 발화가 이 문을 지나므로 발화와 `jobs run` 이 다른 길로 갈라질 자리가 없다.
    //
    // **시작은 둘 중 하나다.** 계획에 코디네이터 계정이 있으면 이 회차의 코디네이터를 띄운다
    // (handToCoordinator, run-start 와 같은 몸통). 없으면 회차를 만드는 것으로 끝이고, 배치는 루프가
    // 한다: 예약 Job 의 회차라면 startJobRun 이 그 회차에 autoDispatch 를 찍고(R2), 아니면 계획의
    // autoDispatch 가 정한다.
    //
    // **N7 — 코디네이터의 실패는 회차의 실패가 아니다.** 회차는 먼저 커밋되고 그대로 남는다. 실패한
    // 답은 그 회차를 `runId` 로 싣는다: jobs-run 이 재시도 명령을 적고, 발화는 로그에 남기며, 사람은
    // 그 회차 줄의 ▶ 로 다시 띄운다.
    case 'run-spawn': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      // **`--unless-running` is the fire's** (the user's ruling of 2026-09-25): a fire behaves like
      // `jobs run`, which refuses while the Job's latest Run still runs, so the fire is skipped then.
      // Answered 409 with `running`, the Run it was skipped for. The fire does not retry it: its arming
      // moved on to the next fire time before it asked (dispatchLoop.ts's orchFireTick).
      //
      // **A latest Run that is not running but still has a coordinator is replaced** (the user's U4 of
      // 2026-09-25), for a scheduled Job only. Either it finished and its coordinator was not stopped yet
      // (the loop stops it once the Run finishes, `run-coordinator-stop`), or the coordinator is all it
      // has left (idle only, runMoves). Its coordinator is stopped and its slot emptied; an unfinished Run
      // is also paused, the way `runs stop` ends a Run, so `runs resume` takes it back. Then the new Run is
      // made on the state as it is after that, not on `s`.
      let base = s
      if (args.unlessRunning === true) {
        const job = s.jobs.find((j) => j.id === id)
        const running = job && runningRunOf(s, job, now)
        if (running)
          return {
            status: 409,
            body: { error: `job ${id} is still running (run ${running.id}); this run was not made`, jobId: id, running: running.id }
          }
        const latest = job && latestRunOf(s, job)
        if (job?.schedule !== undefined && latest?.coordinatorSessionId !== undefined && latest.paused !== true) {
          const finished = outcomeOf(s, latest.id) !== 'running'
          // **An unfinished Run is replaced only while its coordinator is parked in `check --wait`**
          // (final round 2, I-A): state alone cannot tell that from a coordinator doing the work itself on
          // an objective-only Job. Busy or unknown (`false`, `null`, no dep), the plain U3 skip.
          if (!finished && (await deps.coordinatorIdle?.(latest.id, latest.coordinatorSessionId)) !== true) {
            deps.log?.(`scheduled fire of job ${id}: run ${latest.id} has only its coordinator left, coordinator busy or unknown, skipped`)
            return {
              status: 409,
              body: {
                error: `job ${id}'s run ${latest.id} has only its coordinator left, and it is busy or its state is unknown; this run was not made`,
                jobId: id,
                running: latest.id
              }
            }
          }
          await retireCoordinator(
            latest.id,
            latest.coordinatorSessionId,
            finished ? 'the run had finished' : `the run had nothing left but its coordinator; replaced by the fire of job ${id}`,
            !finished
          )
          base = deps.getState()
        }
      }
      const made = startJobRun(base, id, now)
      // **The Run is committed already marked "coordinator starting"** when it will get one (I1): there
      // is no moment in which a ▶ sees it with neither a coordinator nor a start in flight.
      const willHandOver = made.ok && s.jobs.find((j) => j.id === id)?.coordinatorAccountId !== undefined && deps.startCoordinator !== undefined
      const spawned: typeof made =
        made.ok && willHandOver
          ? (() => {
              const marked: JobRun = { ...made.value, coordinatorStartingAt: now }
              return { ...made, state: { ...made.state, runs: made.state.runs.map((r) => (r.id === marked.id ? marked : r)) }, value: marked }
            })()
          : made
      const reply = await commit(spawned)
      if (!spawned.ok || reply.status >= 300) return reply
      const after = deps.getState()
      const job = after.jobs.find((j) => j.id === id)
      const run = after.runs.find((r) => r.id === spawned.value.id)
      if (!willHandOver || !job?.coordinatorAccountId || !run) return reply
      const handed = await handToCoordinator(after, job, run, job.coordinatorAccountId, true, true)
      if (handed.status >= 200 && handed.status < 300) {
        const withCoordinator = deps.getState().runs.find((r) => r.id === run.id)
        return withCoordinator ? okBody(withCoordinator) : reply
      }
      return { status: handed.status, body: { ...(handed.body as object), jobId: id, runId: run.id } }
    }
    /**
     * **Stops a Run's coordinator once nothing is left for it to do** (the user's U4 of 2026-09-25).
     * The loop of the process that drives sends it for each finished Run of a scheduled Job whose
     * coordinator is still attached (dispatchLoop.ts), so a schedule does not leave one coordinator
     * looping on `check --wait` per fire. A Run of a Job with no schedule is never sent: a person may
     * be reading that coordinator's tab (the controller's ruling on U4's scope).
     *
     * Refused, 409, while the Run still moves (runMoves, the rule `jobs run` and a fire use), so this
     * never stops a coordinator that has work. With no coordinator attached it answers 200 with
     * `stopped: null`, so a repeat does nothing.
     *
     * **A stop still pending is sent again as it was decided** (limits pass L1): the loop sends this
     * for a slot marked `coordinatorStopPending` after a backoff. The idle check is not asked again
     * while the decision still stands: the Run was replaced and is still paused (its coordinator is no
     * longer in `check --wait` once asked to stop), or its work is finished. Otherwise the idle check is
     * asked as for a fresh stop (final review I2), and a busy answer drops the mark: a Run neither paused
     * nor finished is one a person or its coordinator has taken back. `runs resume` drops the mark itself
     * (resumeRun), since a replaced Run with no Tasks does not move and so never reaches the next rule.
     * The Run moving again still refuses it, and then the mark is dropped too.
     */
    case 'run-coordinator-stop': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      const run = s.runs.find((r) => r.id === id)
      if (!run) return notFound(`unknown run: ${id}`)
      // **`--gone <sessionId>`: the driving process saw that session end for real** (L1), with no exit
      // release to empty the slot (its exit was never heard). The stop is confirmed as the exit release
      // would confirm it: `detachCoordinator` empties the slot and drops the pending mark; a replacement's
      // `paused` was written with the mark and stays. Only when the slot still names that session, so a
      // coordinator started meanwhile is never let go; otherwise `released: null`. Nothing is stopped.
      const gone = str(args.gone)
      if (gone) {
        if (run.coordinatorSessionId !== gone) return okBody({ runId: id, released: null })
        const detached = detachCoordinator(s, { runId: id })
        if (!detached.ok) return okBody({ runId: id, released: null })
        await deps.setState(detached.state)
        deps.log?.(`coordinator ${gone} of run ${id} is gone with no exit heard; its slot is emptied, the stop confirmed`)
        return okBody({ runId: id, released: gone })
      }
      const job = jobOf(s, run)
      if (job && runMoves(s, job, run, now)) {
        await dropStopPending(id)
        return conflict(`run ${id} still has work its coordinator can start; its coordinator was left running`)
      }
      const sessionId = run.coordinatorSessionId
      if (sessionId === undefined) return okBody({ runId: id, stopped: null })
      // **An unfinished Run's coordinator is stopped only while parked in `check --wait`** (final round 2,
      // I-A): a Run with no Tasks, whose coordinator may be doing the work itself. A finished Run (every
      // Task terminal) needs no such check: there is nothing left for it to do. Nor does a stop already
      // decided and pending on a replaced Run that is still paused (L1, final review I2).
      const decided = run.coordinatorStopPending !== undefined && run.paused === true
      if (!decided && outcomeOf(s, id) === 'running' && (await deps.coordinatorIdle?.(id, sessionId)) !== true) {
        await dropStopPending(id, 'is neither paused nor finished and its coordinator is not idle')
        return conflict(`run ${id}'s coordinator is busy or its state is unknown; it was left running`)
      }
      // **Asked again on the state after the stop** (Minor 4): the Run may have gained work meanwhile.
      const moved = (current: OrchState): boolean => {
        const r = current.runs.find((x) => x.id === id)
        const j = r && jobOf(current, r)
        return r !== undefined && j !== undefined && runMoves(current, j, r, now)
      }
      const retired = await retireCoordinator(id, sessionId, 'the run has nothing left for it to do', false, (c) => !moved(c))
      if (retired === 'moved') {
        await dropStopPending(id)
        return conflict(`run ${id} gained work while its coordinator was being stopped; its slot is left to the exit release`)
      }
      return okBody({ runId: id, stopped: sessionId })
    }
    /**
     * **Drops every `coordinatorStartingAt` past its window** (limits pass L2). Internal: the driving
     * loop sends it (dispatchLoop.ts) when it sees a stale mark, so the view gets a commit and the ▶
     * comes back. A stale mark already counts for nothing (`coordinatorStarting` ignores it), but a view
     * computed while it was fresh keeps showing no ▶ until some unrelated commit. A mark inside its
     * window is left alone: that start may still be under way. Answers the Runs it cleared.
     */
    case 'run-start-marks-clear': {
      const nowMs = Date.parse(now)
      const stale = new Set(
        s.runs.filter((r) => r.coordinatorStartingAt !== undefined && !coordinatorStarting(r, nowMs)).map((r) => r.id)
      )
      if (stale.size === 0) return okBody({ cleared: [] })
      await deps.setState({
        ...s,
        runs: s.runs.map((r) => {
          if (!stale.has(r.id)) return r
          const { coordinatorStartingAt: _mark, ...rest } = r
          return rest
        })
      })
      return okBody({ cleared: [...stale] })
    }
    case 'task-create': {
      // `--run` 이 없으면 "가장 최근 Run" 이다. **그 뜻을 latestOrdinaryRun 이 정한다** — 예약
      // 템플릿과 그 회차는 배열의 끝에 붙지만 사람이 만든 것이 아니고(회차는 ticker 가 만든다),
      // 여기서 그것을 집으면 Task 가 템플릿에 떨어져 그 뒤 모든 회차로 복사된다. 나머지 세 자리
      // (run-configs·send·check)도 같은 함수를 쓴다.
      // **두 이름을 함께 받는다.** 앱은 IPC 로 `runId` 를 직접 넣고(NewTaskModal), CLI 는 `--run` 을
      // 보내는데 파서가 그것을 `run` 으로 만든다(cliArgs 의 camel). 이 자리만 `runId` 를 읽고 있어서
      // — 다른 여덟 자리는 전부 `args.run` 이다 — CLI 의 `--run` 이 조용히 무시되고 언제나 아래
      // 기본값으로 흘렀다. 오류도 나지 않으므로, 코디네이터가 만든 Task 가 사람이 방금 만든 Job 에
      // 섞여도 알아챌 방법이 없었다.
      // **기본값은 진입 스냅숏에서 고른다 — 아래 재읽기와 다른 점이 여기 있다.** 재읽기는 커밋이
      // 덮지 않게 하는 것이고, 이 줄은 "가장 최근 Run" 이 무엇을 뜻하느냐다. `latest` 에서 고르면
      // 계정을 묻는 사이에 생긴 Run 이 그 뜻이 되어, 부르는 사람이 명령을 낸 순간에는 있지도 않던
      // 곳에 Task 가 붙는다. 그 사이에 지워진 Run 을 가리키게 되는 경우는 아래 createTask 가
      // `latest` 로 검증해 "unknown run" 으로 거절한다 — 매달린 참조가 남지 않는다.
      const runId = str(args.runId) ?? str(args.run) ?? latestRun(s)?.id
      const spec = str(args.spec)
      if (!runId) return bad('--run is required (no run exists)')
      if (!spec) return bad('--spec is required')
      // `--account` 는 이 Task 를 띄울 계정들이다 — **쉼표로 순서 있는 목록**을 받는다(`a,b,c`).
      // 첫 계정으로 띄우고 나머지는 한도에 걸렸을 때 갈아탈 순서다.
      // **필수다.** 이 목록이 provider 의 유일한 출처이므로(Task.accountIds), 없으면 어느 CLI 로
      // 띄울지 알 방법이 없다. 예전에는 Run 이 provider 를 들고 있어 비워 두면 그 provider 의 기본
      // 계정으로 갔다.
      // **여기서 거절하는 이유**: 목록의 한 칸이라도 잘못돼 있으면 dispatch 시점에 Gate 가 열리는데,
      // 그때는 사람이 이미 Task 를 만들어 둔 뒤라 왜 안 도는지 되짚어야 한다. 만들 때 목록 전체를
      // 거절하면 그 자리에서 알 수 있다.
      // 다만 **거절이 유일한 방어는 아니다** — orchestration.json 은 프로세스보다 오래 살고 손으로
      // 고쳐지므로 dispatch 시점 검사도 남는다. 단, 그 자리의 규칙은 다르다: 첫 칸을 못 쓰면 뒤 칸을
      // 올려세우지 않고 그 자체로 실패하고, 첫 칸을 쓸 수 있으면 뒤 칸 중 못 쓰는 것만 골라
      // 버린다(dispatchAccount.ts).
      // **쉼표인 이유**: parseArgs 는 같은 플래그를 두 번 주면 뒤가 앞을 덮고, 배열은 JSON_ARRAY 로만
      // 받는다. `ask --options` 가 이미 CSV 이므로 그 관례를 쓴다 — 계정 하나만 주는 기존 호출은
      // 쉼표가 없으므로 그대로 흐른다.
      const accountArg = str(args.account)
      if (accountArg === null) return bad('--account is required')
      // 검증은 parseAccountList 가 한다 — `run-create --coordinator-account` 와 **같은 규칙**이고,
      // 두 번 적으면 한쪽만 고쳐지는 날이 온다(그 함수의 주석).
      const parsedAccounts = parseAccountList(accountArg, await deps.listAccounts(), '--account')
      if (!parsedAccounts.ok)
        return parsedAccounts.missing ? notFound(parsedAccounts.reason) : bad(parsedAccounts.reason)
      const accountIds: string[] = parsedAccounts.ids
      // `--validate` 는 쉼표 목록이다(설계 D8) — `--account` 와 같은 규약. 옛 단일 값도 한 칸짜리
      // 목록으로 저장한다; validateConfigId 는 더 쓰지 않는다(읽기는 checkConfigIdsOf 가 합친다).
      const validateArg = str(args.validate)
      let validateIds: string[] | undefined
      if (validateArg !== null) {
        const parts = validateArg.split(',').map((x) => x.trim())
        if (parts.some((x) => x === '')) return bad('--validate must not contain an empty entry')
        validateIds = parts
      }
      // **getState is read again here, not the entry snapshot `s`.** `listAccounts` above is now
      // awaited (it may be answered across a socket), and this command commits after it — building
      // from `s` would overwrite whatever landed during that await. Exactly the inversion
      // `run-create`'s re-read documents at length a few hundred lines up, arriving here for the
      // same reason: a dependency that used to be a function call became a round trip.
      const latest = deps.getState()
      return commit(
        createTask(
          latest,
          {
            // **Job 을 지목하면 정의 Task 다.** 화면은 아직 돌지 않은 Job 에 Task 를 짜 넣고('실행'
            // 전), 코디네이터는 자기가 받은 회차에 붙인다. 두 id 는 접두사가 달라 섞이지 않는다.
            ...(latest.jobs.some((j) => j.id === runId) ? { jobId: runId } : { runId }),
            title: str(args.title) ?? spec.split('\n')[0].slice(0, 80),
            spec,
            deps: Array.isArray(args.deps) ? (args.deps as string[]) : [],
            parentId: str(args.parent) ?? undefined,
            ...(accountIds ? { accountIds } : {}),
            ...(validateIds ? { validateConfigIds: validateIds } : {}),
            // `--review` 는 값이 없는 플래그다(task-list --ready 와 같은 모양). 어느 provider 가
            // 읽을지는 앱이 고른다 — 계정 풀을 아는 것은 앱이다.
            reviewRequested: args.review === true ? true : undefined
          },
          now
        )
      )
    }
    case 'tasks-list': {
      let tasks = s.tasks
      // A named Run that is not there is a 404, not an empty list — the list would read as "that
      // Run has no Tasks", which is a different fact.
      const run = str(args.run)
      if (run && !s.runs.some((r) => r.id === run)) return notFound(`unknown run: ${run}`)
      if (run) tasks = tasks.filter((t) => t.runId === run)
      if (str(args.status)) tasks = tasks.filter((t) => t.status === args.status)
      if (args.ready === true) tasks = tasks.filter((t) => t.status === 'ready')
      if (args.brief === true)
        return okBody(
          tasks.map((t) => ({
            ...t,
            spec: t.spec.replace(/\s+/g, ' ').slice(0, 160),
            spec_truncated: t.spec.replace(/\s+/g, ' ').length > 160
          }))
        )
      return okBody(tasks)
    }
    case 'task-update': {
      const id = str(args.id)
      if (!id) return bad('--id is required')
      // --convergence off: 사람이 이 Task 의 자동 수정을 멈춘다(설계 §13.4 의 Stop Auto-Fix). **먼저
      // 처리하고 곧바로 돌아간다** — status 와는 독립인 칸이고, 도는 repair 는 끝까지 가고 그 판정이
      // Gate 로 간다(state.ts 의 routeFailure). 한 호출에 --status 와 함께 오면 거절한다: 둘을 한
      // 쓰기로 섞으면 "멈췄다" 와 "옮겼다" 중 어느 것이 실제로 커밋됐는지 응답만으로 알 수 없다 —
      // 두 호출로 나누면 각각의 결과가 뚜렷하다.
      if (args.convergence !== undefined) {
        if (args.convergence !== 'off')
          return bad('--convergence takes only off (there is no on: a Task follows its Run)')
        if (str(args.status))
          return bad('--convergence and --status cannot be combined — pass them as two calls')
        const target = s.tasks.find((t) => t.id === id)
        if (!target) return notFound(`unknown task: ${id}`)
        await deps.setState({
          ...s,
          tasks: s.tasks.map((t) => (t.id === id ? { ...t, convergenceOff: true as const, updatedAt: now } : t))
        })
        return okBody({ id, convergenceOff: true })
      }
      const status = str(args.status)
      if (!status) return bad('--status is required')
      if (!isTaskStatus(status))
        return bad(`--status must be one of ${TASK_STATUSES.join('|')}`)
      const task = s.tasks.find((t) => t.id === id)
      if (!task) return notFound(`unknown task: ${id}`)
      // Deliberately bypasses the transition table (canTransition): task-update --status is allowed
      // to bypass that table because the orchestrator needs a way to correct things by hand — but
      // the bypass is written to the log. state.ts (moveTask/canTransition) owns the normal
      // transition rules, and this command sidesteps them on purpose for recovery and manual
      // correction, so rather than adding a function to the pure layer the state is set directly
      // here — the same reason the failure rollback below lives in the server.
      const allowedByTable = task.status === status || canTransition(task.status, status)
      deps.log?.(
        `task-update: task=${id} ${task.status} -> ${status} (table-allowed=${allowedByTable})`
      )
      const result = str(args.result)
      // 설계 G4(명세 §30). 완료 정책을 만족하지 않은 채 완료로 옮기는 것이 이 앱의 "완료 강제" 다 —
      // 버튼을 따로 두지 않고 이 명령이 그 자리를 겸한다(백엔드 설계 §3). 비어 있던 것은 버튼이
      // 아니라 기록이었다: 명세는 "사용 시 반드시 reason 을 Journal 에 남긴다" 고 한다.
      //
      // **요구는 이 한 경우에만 건다.** 평범한 손보기(ready 로 되돌리기, 회로 차단 풀기)는 그대로다 —
      // 거기까지 이유를 받으면 이 명령이 쓰이던 모든 구조 경로가 한 번에 막힌다.
      const override = status === 'completed' && isOverrideCompletion(task, policyOf(s, task))
      const reason = str(args.reason)
      if (override && !reason)
        return bad(
          'this task has not satisfied its completion policy — pass --reason to record why it is being completed anyway'
        )
      const nextTask: Task = {
        ...task,
        status,
        updatedAt: now,
        ...(override && reason ? { completionOverride: { reason, at: now } } : {}),
        // **The circuit counter is reset along with the status.** Section 8 of the orchestration
        // guide already advertises task-update as the way to rescue a Task stranded by a circuit
        // break (3 failures), but while the counter stayed put only the status changed and
        // worker-start still rejected the Task with a circuit break, so that rescue did not actually
        // work. The only other path back to a zero counter is applyWorkerDone(succeeded), which is
        // reachable only once the Task has been dispatched, so this human-driven command is the only
        // escape hatch. It happens as part of the same single state change as the status update (the
        // design that opens the circuit at 3 failures is unchanged).
        consecutiveFailures: 0,
        ...(result !== null ? { result } : {})
      }
      // Without recomputeReady, correcting this Task to completed would leave the pending Tasks that
      // depend on it unpromoted to ready, stranded indefinitely until the next trigger (task-create
      // or worker_done) — the whole point of task-update is to rescue a stranded Task so the
      // pipeline keeps moving, so the dependency chain has to be released along with it. Rather than
      // adding a new function this reuses recomputeReady, the existing pure-layer function that
      // createTask and applyWorkerDone already use. recomputeReady only promotes pending to ready
      // and never touches blocked — that property is unchanged.
      const tasks = recomputeReady(s.tasks.map((t) => (t.id === id ? nextTask : t)))
      await deps.setState({ ...s, tasks })
      return okBody(tasks.find((t) => t.id === id)!)
    }
    case 'session-task-start': {
      // A worker is executing a Jobs task, and a Run coordinator is running one — either way that
      // Run already writes its own record when it finishes (onRunFinished). Declaring a session
      // task on top would record the same work twice, once per level.
      if (isWorker || isRunCoordinator)
        return denied('a session already inside a Run cannot declare its own session task')
      if (!deps.sessionTasks) return conflict('work unit tracking is off')
      const objective = str(args.objective)
      if (!objective || objective.trim() === '') return bad('--objective is required')
      const r = await deps.sessionTasks.start(caller.sessionId, objective)
      if (!r.ok) return bad(r.reason)
      return okBody({ id: r.id, interruptedId: r.interruptedId })
    }
    case 'session-task-complete': {
      if (isWorker || isRunCoordinator)
        return denied('a session already inside a Run cannot declare its own session task')
      if (!deps.sessionTasks) return conflict('work unit tracking is off')
      const raw = args.check === undefined ? [] : (args.check as unknown[])
      if (!Array.isArray(raw)) return bad('--check must be <name>=<status>')
      const checks: SessionCheck[] = []
      for (const one of raw) {
        const parsed = parseCheckFlag(String(one))
        if ('error' in parsed) return bad(parsed.error)
        checks.push(parsed)
      }
      const r = await deps.sessionTasks.complete(caller.sessionId, {
        source: 'agent',
        checks,
        summary: str(args.summary) || undefined
      })
      // NO_ACTIVE_TASK is not a retry — it means nothing was started, and a completion must never
      // be able to bring a session task into being.
      if (!r.ok)
        return r.reason === 'NO_ACTIVE_TASK'
          ? conflict('no session task is open — one starts with /astera-task')
          : bad(r.reason)
      return okBody({ id: r.id })
    }
    case 'session-task-cancel': {
      if (isWorker || isRunCoordinator)
        return denied('a session already inside a Run cannot declare its own session task')
      if (!deps.sessionTasks) return conflict('work unit tracking is off')
      const r = await deps.sessionTasks.cancel(caller.sessionId, str(args.reason) || undefined)
      if (!r.ok)
        return r.reason === 'NO_ACTIVE_TASK'
          ? conflict('no session task is open — one starts with /astera-task')
          : bad(r.reason)
      return okBody({ id: r.id })
    }
    case 'dispatch-show': {
      const taskId = str(args.task)
      if (!taskId) return bad('--task is required')
      return okBody(s.dispatches.filter((d) => d.taskId === taskId))
    }
    case 'worker-start': {
      const taskId = str(args.taskId ?? args.task)
      const agent = str(args.agent)
      const account = str(args.account)
      if (!taskId) return bad('--task is required')
      if (agent !== 'claude' && agent !== 'codex') return bad('--agent must be claude|codex')
      if (!account) return bad('--account is required')
      const retryOf = str(args.retryOf) ?? undefined
      const name = str(args.name) ?? undefined
      const terminal = str(args.terminal) ?? undefined

      // Four up-front checks (task does not exist, blocked, circuit break, a dispatch already open
      // for the same task) — they duplicate what openDispatch checks again below, but that is
      // intentional: they give a clearer error at an earlier point. Since openDispatch is now
      // committed *before* the coordinator is called (below), the orphaned-session problem — "the
      // session came up but openDispatch rejected it and there is no way to clean up" — is now
      // structurally impossible: if openDispatch is rejected the coordinator is never called at all.
      const task = s.tasks.find((t) => t.id === taskId)
      if (!task) return notFound(`unknown task: ${taskId}`)
      if (task.status === 'blocked') return bad('task is blocked by an open gate')
      // openDispatch(state.ts) 도 이것을 거절한다 — 여기서 앞질러 보는 이유는 이 함수의 다른 앞선
      // 검사들과 같다: 코디네이터에게 더 뚜렷한 에러를 준다("전이 거절" 문구가 아니라). validating·
      // reviewing 인 Task 에 두 번째 워커를 얹지 못하게 하는 것이 이 자리다 — Run 이 convergence 를
      // 켰는지와 무관하다.
      if (task.status === 'validating' || task.status === 'reviewing')
        return bad(`task is awaiting a verdict: ${task.status}`)
      if (task.consecutiveFailures >= FAILURE_LIMIT)
        return bad(`circuit break: ${FAILURE_LIMIT} consecutive failures`)
      const openForTask = s.dispatches.find((d) => d.taskId === taskId && !d.outcome && !d.endedAt)
      if (openForTask) return bad(`dispatch already open: ${openForTask.id}`)

      const run = s.runs.find((r) => r.id === task.runId)
      const runJob = run && jobOf(s, run)
      // **400, not 404.** The id this command was given is the Task's, and the Task is there; what is
      // missing is the Run it points at (a definition Task has none). `send` answers the same fact 400
      // (applyWorkerDone's refusal carries no `missing`), and one fact must not exit 4 from one
      // command and 2 from the other.
      if (!run) return bad(`unknown run for task: ${taskId}`)
      // **템플릿은 자신의 Task 를 배치하지 않는다.** slotsToFill 이 이미 같은 판단을 하지만 그쪽은
      // 자동 배치 경로뿐이고, 이 명령은 사람과 코디네이터가 직접 부르는 두 번째 문이다. 여기를
      // 열어 두면 템플릿의 Task 가 completed 로 끝나고, 그러면 TTL 정리의 조건(`own.length > 0 &&
      // own.every(terminal)`, store.ts)이 템플릿에서 참이 되어 **30일 뒤 예약과 모든 회차가 조용히
      // 사라진다** — 설계 10절이 일어나지 않는다고 적어 둔 바로 그것이다.
      // 예약 Job 의 정의 Task 는 애초에 이 자리에 오지 않는다 — 정의는 runId 가 없어 Task 조회가
      // 회차를 찾지 못한다. 그래도 남겨 둔다: orchestration.json 은 손으로 고쳐진다.
      if (runJob?.schedule && run.ordinal === 0)
        return bad(`job ${run.jobId} is a schedule — it does not dispatch its own Tasks; its runs do`)

      // **동시 실행 한도.** 지금까지 이 값을 지키는 곳은 앱의 스케줄러뿐이었다(schedule.ts 의
      // slotsToFill) — 앱이 유일한 배치자였으므로 그것으로 충분했다. Run 을 코디네이터에게 넘기는
      // 순간 이것은 **LLM 이 어길 수 있는 규칙**이 되므로, 이 명령이 이미 거절하는 다른 규칙들과
      // 같은 대열에 들어간다(blocked Task, 회로 차단, 중복 Dispatch, 예약 템플릿).
      //
      // 인수 프롬프트도 같은 값을 말해 준다(handover.ts) — 문구가 1차이고 이 거절이 2차다. 문구만
      // 있으면 슬쩍 넘겨도 아무도 모르고, 거절만 있으면 코디네이터가 시행착오로 규칙을 알아내며
      // 턴을 쓴다. 그래서 지금 열린 수와 한도를 문구에 함께 적는다.
      //
      // **`--retry-of` 는 예외가 아니다.** 재시도도 새 Dispatch 를 열고 그 워커도 같은 폴더들에서
      // 돈다 — 한도를 넘겨도 되는 이유가 없다.
      const limit = runJob?.concurrency ?? DEFAULT_CONCURRENCY
      const openHere = s.dispatches.filter((d) => {
        if (d.outcome || d.endedAt) return false
        return s.tasks.find((x) => x.id === d.taskId)?.runId === run.id
      }).length
      if (openHere >= limit)
        return conflict(
          `run ${run.id} is at its concurrency limit: ${openHere} of ${limit} dispatches are open`
        )


      // **`--worktree` 를 생략한 호출은 "이 Run 이 일하는 자리" 를 뜻한다** — 그것은 Run 이
      // 워크트리를 가진 뒤에는 그 워크트리다. 기본값이 여기 있는 이유: 배치를 정하는 것은 부르는
      // 쪽이 아니라 Run 이다. 렌더러의 수동 띄우기 버튼이 `'current'` 를 명시하던 동안 이 기능이
      // 우회됐다 — 그 버튼이 나오는 조건이 하필 동시 실행 1 이하(= 이 기능이 존재하는 이유인 Run)
      // 여서, 사람이 누를 때마다 워커가 사용자의 프로젝트 폴더에서 돌고 그 Dispatch 가 Run
      // 워크트리를 향한 병합 재료로 세어졌다.
      //
      // 리터럴 `'current'` 는 **워크트리가 없는 Run** 에만 남는다 — 코디네이터가 끌고 가는 Run 이
      // 그것이다(앱이 워크트리를 만들어 준 적이 없다). 그 분기를 지우지 않는 이유는 설계 9절에
      // 있다: CLI 에서 사람이 `--worktree current` 를 직접 쓸 수 있다.
      //
      // **다만 앱이 스스로 돌리는 Run(`run.autoDispatch`) 은 그 분기를 타면 안 된다.** 그런 Run 은
      // 코디네이터가 없고, 앱이나 Host 가 언젠가 워크트리를 만들어 준다(exec/dispatchLoop.ts 의
      // runScheduler 가 첫 슬롯을 채우기 직전에) — `run.worktree` 가 아직 없다는 것은 "코디네이터가 원래부터 안 만든다"가 아니라
      // "아직 시작 전"이라는 뜻이다. 그 상태에서 `--worktree` 없이 이 명령이 들어오면 위 로직대로
      // `'current'` 로 떨어져 워커가 프로젝트 폴더에서 돌게 된다 — 설계 2절이 금지하는 바로 그것
      // 이다. 되돌아갈 자리가 없으니 거절한다: `--worktree` 를 **명시적으로** 준 호출(값이 무엇이든,
      // `'current'` 를 직접 써도)은 이 거절을 지나간다 — 그것은 사람이 자리를 골랐다는 뜻이고, 그
      // 선택을 막을 이유가 없다.
      //
      // **`autoDispatch` 만 보면 인계된 Run 이 이 거절에서 빠져나간다.** 사이드바 Run 을 코디네이터에게
      // 넘기는 방식이 그 깃발을 끄는 것이므로(run-start), 넘긴 뒤에는 "앱이 돌리는 Run" 검사가
      // 거짓이 된다 — 그런데 그 Run 의 워크트리를 만들어 주던 것도 앱이었다. 그래서 넘긴 Run 에서
      // `--worktree` 를 생략하면 조용히 `'current'` 로 떨어져 워커가 프로젝트 폴더에서 돈다. 사람이
      // 사이드바에서 짠 Run 임을 말하는 칸은 `coordinatorAccountId` 이므로 그것으로 함께 묻는다.
      //
      // **이것은 완전한 답이 아니다.** 넘긴 Run 에서는 앱이 첫 슬롯을 채우지 않으므로 Run 워크트리가
      // 아예 만들어지지 않고, 한도 1 인 Run 의 코디네이터는 "생략하라"는 배치 규칙을 따를 자리가
      // 없다(handover.ts 가 그렇게 말한다). 그때 이 거절이 그 사실을 **소리 내어** 말해 주므로
      // 코디네이터는 `--worktree new --name` 으로 갈 수 있다. 제대로 된 답은 인계 시점에 Run
      // 워크트리를 미리 만들어 두는 것이고, 그것은 별개 작업이다.
      if (
        str(args.worktree) === null &&
        (placedByApp(runJob, run) || runJob?.coordinatorAccountId !== undefined) &&
        !run.worktree
      )
        return conflict(
          `run ${run.id} has no worktree yet — there is nowhere to run a worker without writing ` +
            `into the project folder; pass --worktree new --name <name>`
        )
      const worktree = str(args.worktree) ?? run.worktree ?? 'current'
      // **배치 규칙은 여기서 거절되지 않는다 — 문구로만 지켜진다**(handover.ts 의 인수 프롬프트).
      // 막고 싶은 것은 "병렬 워커가 한 폴더를 나눠 쓴다" 하나인데, 그것을 이 자리에서 확인할 수
      // 없다: 위 값은 **의도**('current'·'new'·경로)이고 실제 cwd 로 푸는 것은 배선이다
      // (startWorker). 이미 열린 Dispatch 의 `cwd` 와 비교하려면 그 풀이가 한 곳에 있어야 한다.
      //
      // 대신 쓸 수 있는 대용은 "한도 ≥2 인 Run 에서 --worktree 생략 금지" 였는데, 기본 한도가 3
      // 이므로 그것은 **모든 기본 Run** 에서 생략을 금지하는 셈이 되고, 생략은 오늘 문서화된
      // 정상 호출이다(이 주석 위의 기본값 단락). 대용을 넣어 보고 기존 테스트 21개가 거절당하는
      // 것으로 확인했다.
      //
      // 그래서 이 가드는 cwd 풀이를 한 곳으로 모으는 작업과 함께 와야 한다. 그때까지 병렬 Run 에
      // 잘못된 배치를 부를 수 있는 유일한 호출자는 코디네이터이고, 그에게는 규칙과 **이유**가
      // 프롬프트로 간다.

      // For a --terminal reuse the server looks up in advance which dispatch actually owned that
      // session (its cwd, provider and accountId) and passes them to the coordinator as arguments —
      // the coordinator does not read state.
      let terminalCwd: string | undefined
      let terminalProvider: Provider | undefined
      let terminalAccountId: string | undefined
      if (terminal) {
        const prev = s.dispatches.find((d) => d.sessionId === terminal)
        if (!prev) return notFound(`unknown terminal: ${terminal}`)
        // Only a session of this same Run may be reused. Finding *some* dispatch with that id was
        // the whole check before, so a coordinator that knew another run's worker session id could
        // type its Task into that run's session. Refused before openDispatch, so nothing is typed.
        const prevRunId = s.tasks.find((t) => t.id === prev.taskId)?.runId
        if (prevRunId !== run.id)
          return denied(
            `terminal ${terminal} is a session of ${prevRunId ? `run ${prevRunId}` : 'no known run'}, ` +
              `not of run ${run.id} — --terminal reuses only a session of the same run; start a fresh worker instead`
          )
        terminalCwd = prev.cwd
        terminalProvider = prev.provider
        terminalAccountId = prev.accountId
      }

      // openDispatch is committed *before* the coordinator is called — the server owns OrchState and
      // the coordinator only produces side effects such as the session process and the spec file
      // (calling openDispatch from both sides killed the feature outright). sessionId is a
      // placeholder unique per call (for a reuse the already-known real sessionId is used as is) —
      // cwd and specPath are provisional and get patched to their real values once the coordinator
      // returns (below).
      const pendingSessionId = terminal ?? `pending:${randomBytes(4).toString('hex')}`
      const opened = openDispatch(
        s,
        {
          taskId,
          provider: agent,
          accountId: account,
          sessionId: pendingSessionId,
          cwd: runJob?.cwd ?? '',
          specPath: '',
          retryOf
        },
        now
      )
      // A `--retry-of` that names nothing is the 404 that reaches here (its `unknown task` is the
      // up-front check's, already answered above from this same `s`).
      if (!opened.ok) return refused(opened)
      await deps.setState(opened.state)
      const dispatchId = opened.value.id
      const previousStatus = task.status // value to restore on rollback — the status before openDispatch moved it

      let started: { sessionId: string; cwd: string; specPath: string }
      try {
        started = await deps.startWorker({
          dispatchId,
          taskId,
          title: task.title,
          spec: task.spec,
          provider: agent,
          accountId: account,
          runCwd: runJob?.cwd ?? '',
          worktree,
          name,
          terminal,
          terminalCwd,
          terminalProvider,
          terminalAccountId
        })
      } catch (e) {
        // Failure rollback — this is the server's transaction handling, not a pure-layer transition
        // rule. Calling closeDispatch alone would leave the Task at dispatched, and the --ready list
        // does not show those, so nothing would pick it up on its own. A Gate can reach it now:
        // recovery added the dispatched -> blocked edge to ALLOWED (core/orchestration/types.ts) and
        // main/recovery/execute.ts opens exactly that Gate when startWorker fails on it. But that is
        // for a lost worker with nobody waiting on an answer; here a caller is, so putting the Task
        // back where it was needs no question of anyone.
        // So this removes the dispatch from the array entirely and restores the Task directly to its
        // pre-openDispatch status. It also leaves no bogus status message (recording "ended without
        // reporting" when the session never even existed) — the cause of the failure is carried in
        // the bad(...) of this response.
        //
        // **Said to be a rollback only when the start says it left nothing** (`rollsBack`, A36):
        // `leftNothingBehind(e)` is true for either tag. `undoneBeforeFailing` is a `--worktree new`
        // fork the Host removed again after its spawn failed. `refusedBeforeActing` is a start the
        // Host refused before touching anything: a retiring Host, a fork a damaged worktrees.json
        // refused, or the permission setting refusing a start with no fork (follow-up round m6).
        // Then the Dispatch is gone, the Task is back where it was, and nothing on disk names this
        // call, so a keyed call keeps no receipt and the same id can really start once the cause is
        // fixed. Any other failure stays an ordinary commit and keeps its receipt, which is what the
        // receipts design pinned for a start refused for want of the app (host/orch.test.ts).
        const latest = deps.getState()
        const rolledBack: OrchState = {
          ...latest,
          dispatches: latest.dispatches.filter((d) => d.id !== dispatchId),
          tasks: latest.tasks.map((t) =>
            t.id === taskId ? { ...t, status: previousStatus, updatedAt: now } : t
          )
        }
        if (leftNothingBehind(e)) await deps.setState(rolledBack, { rollsBack: true })
        else await deps.setState(rolledBack)
        return bad(`failed to start worker: ${e instanceof Error ? e.message : String(e)}`)
      }

      // Success — read the latest state again and patch this dispatch's placeholders to their real
      // values. The snapshot taken on entry (s) is deliberately not used: while waiting for the
      // coordinator a concurrent change such as another worker's worker_done may have landed on that
      // dispatch, and the patch must not overwrite those fields (outcome, endedAt, workerState) —
      // only the three fields sessionId, cwd and specPath are carried over.
      //
      // **The spec sweep reads this invariant** (host/driving.ts's tick, R22; final review M2). The
      // Host's tick sweeps `orch/specs` only while its spawner has no start in flight, and a spec
      // stays only while an open Dispatch names it. The spawner's in-flight count drops as its start
      // returns, before this patch names the spec, so the patch must land with nothing but microtask
      // hops after that: `startWorker`'s return, the `getState()` here, and `setState`, whose store
      // moves memory before its first await. An `await` of real I/O put between the start and this
      // patch (a log flush, a git probe) lets a tick land in the gap and delete the spec the worker was
      // just told to read. review.ts and repair.ts patch the same way and carry the same constraint.
      const latest = deps.getState()
      await deps.setState({
        ...latest,
        dispatches: latest.dispatches.map((d) =>
          d.id === dispatchId
            ? { ...d, sessionId: started.sessionId, cwd: started.cwd, specPath: started.specPath }
            : d
        )
      })
      return okBody({ ...started, dispatchId })
    }
    case 'worker-show': {
      const id = str(args.dispatch)
      const d = s.dispatches.find((x) => x.id === id)
      return d ? okBody(d) : notFound(`unknown dispatch: ${String(id)}`)
    }
    case 'worker-read': {
      const id = str(args.dispatch)
      if (!id) return bad('--dispatch is required')
      return okBody({
        output: await deps.readWorker({
          dispatchId: id,
          limit: typeof args.limit === 'number' ? args.limit : undefined
        })
      })
    }
    case 'worker-release': {
      const id = str(args.dispatch)
      if (!id) return bad('--dispatch is required')
      // The only command that does not validate that the dispatch exists (the wiring logs an unknown
      // id instead) — that property is left as is, and only the retained flag is added to the
      // response. When retained, the coordinator skips killSession so **nothing actually happens**,
      // and if that is not reported the orchestrator reads the call as "cleaned up" — cleanup is
      // never skipped silently.
      const d = s.dispatches.find((x) => x.id === id)
      // 수렴 중인 Task 의 세션은 repair 를 받을 자리다(설계 §9). 지금 닫으면 same-session 이 fresh 로
      // 바뀌어 워커가 자기가 무엇을 했는지 잊는다 — 닫는 세션이 바로 그 세션이라 다음 워커는 다시
      // 처음부터다. **Dispatch 자신이 이미 끝났어도(outcome+endedAt) 세션은 살아 있을 수 있다** — 워커는
      // 보고 뒤에도 일부러 기다리는 것이 규칙이다(가이드 8절). 그래서 `d.outcome` 이 아니라 그
      // Dispatch 가 가리키는 **Task 의 지금 상태**로 판정한다. 수렴이 끝난 뒤(completed·failed·blocked)
      // 에는 지금처럼 닫는다.
      if (d) {
        const task = s.tasks.find((t) => t.id === d.taskId)
        const run = task && s.runs.find((r) => r.id === task.runId)
        const converging =
          !!(run && jobOf(s, run)?.convergence) &&
          !!task &&
          (task.status === 'validating' ||
            task.status === 'reviewing' ||
            s.dispatches.some((x) => x.taskId === task.id && x.repair !== undefined && !x.endedAt))
        if (converging) return conflict(`task ${task!.id} is still converging — release after it completes`)
      }
      await deps.releaseWorker({ dispatchId: id })
      return okBody(d?.retained === true ? { released: id, skipped: 'retained' } : { released: id })
    }
    case 'worker-retain': {
      const id = str(args.dispatch)
      const d = s.dispatches.find((x) => x.id === id)
      if (!d) return notFound(`unknown dispatch: ${String(id)}`)
      await deps.setState({
        ...s,
        dispatches: s.dispatches.map((x) => (x.id === d.id ? { ...x, retained: true } : x))
      })
      return okBody({ retained: d.id })
    }
    case 'worker-stop': {
      // Closes the session and marks it stopped. The Task is left alone —
      // the orchestrator looks at worker-show and decides for itself.
      const id = str(args.dispatch)
      const d = s.dispatches.find((x) => x.id === id)
      if (!d) return notFound(`unknown dispatch: ${String(id)}`)
      // A retained dispatch is rejected with 409. releaseWorker sees retained and skips killSession
      // (coordinator.releaseWorker), but this used to set workerState:'stopped' plus endedAt without
      // looking at that outcome — the session stays alive and keeps working while the orchestrator
      // believes it is dead, brings up a new worker in the same cwd with --retry-of, and **two
      // agents edit the same Task in the same worktree at once.** The user explicitly asked for this
      // session to be kept alive, so rejecting is the right answer.
      if (d.retained)
        return conflict(
          `dispatch is retained: ${d.id} — a session held by worker-retain is not stopped`
        )
      // Only an open Dispatch: a closed one carrying a placeholder is a start that failed, and has
      // nothing still starting.
      const starting = !d.outcome && !d.endedAt ? stillStarting([d], now) : null
      if (starting) return starting
      if (releases(d)) await deps.releaseWorker({ dispatchId: d.id })
      await deps.setState({
        ...deps.getState(),
        dispatches: deps
          .getState()
          .dispatches.map((x) =>
            x.id === d.id
              ? { ...x, workerState: 'stopped' as const, endedAt: now, closedBy: 'stop' as const }
              : x
          )
      })
      return okBody({ stopped: d.id })
    }
    case 'worker-abandon': {
      // Does nothing remote, nothing to any process, nothing on the filesystem.
      // It accepts that the resources may still be live and only gives up tracking them.
      const id = str(args.dispatch)
      const d = s.dispatches.find((x) => x.id === id)
      if (!d) return notFound(`unknown dispatch: ${String(id)}`)
      await deps.setState({
        ...s,
        dispatches: s.dispatches.map((x) =>
          x.id === d.id
            ? { ...x, workerState: 'outcome_unknown' as const, endedAt: now, closedBy: 'abandon' as const }
            : x
        )
      })
      // 이 명령은 아무 프로세스도 건드리지 않으므로 그 세션은 살아 있을 수 있다 — Dispatch 는 닫혔고
      // 세션은 살아 있는, unregisterRolling 이 다루는 바로 그 조합이다. 추적을 포기한 일에 롤링이
      // 재개 프롬프트를 밀어 넣거나(claude) 그 세션을 죽이고 다시 띄우는(codex) 것은 이 명령이
      // 약속한 "아무것도 하지 않는다" 와 어긋난다. 이미 죽은 세션이면 무해한 no-op 이다.
      deps.unregisterRolling?.(d.sessionId)
      return okBody({ abandoned: d.id, note: 'resources may still be live' })
    }
    case 'run-use': {
      // Run binding. For now this assumes real use has exactly one Run and is left as a no-op
      // success — check falls back to latestRun(s) anyway, so for an ordinary Run the
      // result is the same.
      //
      // **That equivalence stopped being unconditional once schedules existed.** Bind a template
      // or one of its executions and check still resolves to the most recent *ordinary* Run, so
      // the two disagree. Not guarded here because this command already changes nothing; the note
      // is here so the next reader does not carry the old "the result is the same" any further
      // than it now reaches.
      const id = str(args.id)
      if (!s.runs.some((r) => r.id === id)) return notFound(`unknown run: ${String(id)}`)
      return okBody({ bound: id })
    }
    case 'send': {
      const type = str(args.type) as MessageType | null
      if (!type) return bad('--type is required')
      if (type === 'worker_done') {
        // The check lives in core (workerDoneFieldError) because the pending-reports queue has to
        // ask the same question with no server to ask — a report it queues that this would refuse
        // is a Task stalled rather than a command the worker could have fixed. Same function, so
        // the two cannot drift apart.
        const fieldError = workerDoneFieldError(args)
        if (fieldError) return bad(fieldError)
        const taskId = str(args.taskId) as string
        const dispatchId = str(args.dispatchId) as string
        const outcome = str(args.outcome) as 'succeeded' | 'failed'
        // Only ownership is checked, regardless of state — a re-send for one's own already-closed
        // dispatch is not blocked here but passed on to applyWorkerDone so it comes back as the
        // idempotent alreadyReported. Checking here whether it is still open would block that
        // idempotent response with a 403.
        if (isWorker && !myDispatchIds.has(dispatchId))
          return denied('cannot report for another dispatch')
        const reporting = s.dispatches.find((d) => d.id === dispatchId)
        // Limit probe — only when outcome is failed. handleExit alone is not enough: a claude TUI
        // that hit a limit does not die, it prints a notice and then stops, so there are sessions
        // that close only through this path, where the worker reports worker_done --outcome failed
        // itself.
        //
        // **검토 분기보다 위에 있다.** 아래에 두면 한도가 다 된 검토자의 보고는 이 탐침을 지나지
        // 못하고, 코디네이터는 "검토자가 일을 반려했다"만 읽는다 — 멀쩡한 작업에 구현자를 다시 띄워
        // 회로 차단에 한 걸음 다가가면서, 그 계정이 언제 풀리는지는 아무도 알지 못한다. 위 주석이
        // 말하는 "이 경로로만 닫히는 세션"은 검토자에게도 똑같이 있다.
        let limitResetsAt: number | null = null
        if (outcome === 'failed' && deps.probeLimit && reporting) {
          // The probe reads files — a failure there must not block handling the worker's report.
          try {
            limitResetsAt = await deps.probeLimit(reporting)
          } catch (err) {
            deps.log?.(`limit probe failed dispatch=${reporting.id}: ${String(err)}`)
          }
        }
        /** limitResetsAt 을 그 Dispatch 에 싣고 같은 소식을 status 메시지로도 남긴다. 두 경로(검토
         *  보고와 구현 보고)가 같은 것을 해야 하므로 한 군데에 둔다 — 복사해 두면 한쪽만 고쳐진다.
         *
         *  Adds a status message in the same shape as closeDispatch (state.ts) — section 7 of
         *  the orchestration guide ("when limitResetsAt is set it also arrives in the inbox as a
         *  status message") applies to every path, not just the handleExit one. The worker's own
         *  worker_done message (subject, body) is left untouched — this is a separate message added
         *  alongside it. Not finding the task should be impossible (applyWorkerDone and
         *  applyReviewResult have already validated it) but is handled defensively. */
        const withLimit = (next: OrchState): OrchState => {
          if (limitResetsAt === null) return next
          const task = next.tasks.find((t) => t.id === taskId)
          return {
            ...next,
            dispatches: next.dispatches.map((d) =>
              d.id === dispatchId ? { ...d, limitResetsAt } : d
            ),
            messages: task
              ? [
                  ...next.messages,
                  {
                    // 16 hex — the same width as newId in the pure layer (types.ts). 8 hex has a
                    // collision probability of ≈1.2% over 10,000 messages, and on a collision reply
                    // answers the wrong question.
                    id: `msg_${randomBytes(8).toString('hex')}`,
                    runId: runIdOf(task),
                    type: 'status' as MessageType,
                    taskId,
                    dispatchId,
                    subject: 'session ended at a usage limit',
                    body: `limitResetsAt=${new Date(limitResetsAt).toISOString()}. After that time, a --retry-of on the same account can proceed.`,
                    answered: false,
                    createdAt: now
                  }
                ]
              : next.messages
          }
        }
        /** 방금 닫힌 Dispatch 의 세션에서 롤링 체인을 걷는다. **세션은 죽이지 않는다** — 워커는
         *  보고 뒤에도 프롬프트에서 기다리는 것이 규칙이고(가이드 8절), 체인만 남으면 롤링이 끝난
         *  일의 세션에 손을 댄다(unregisterRolling 의 JSDoc). 두 보고 경로(검토·구현)가 같은 일을
         *  해야 하므로 withLimit 과 같은 이유로 한 군데에 둔다.
         *
         *  **방금 커밋한 상태에서 sessionId 를 다시 읽는다.** 위 탐침의 await 동안 롤이 일어나
         *  Dispatch 가 새 세션으로 옮겨 갔을 수 있고(ipc.ts 의 OrchRollTap), 진입 스냅숏의 값은 그때
         *  이미 죽은 세션을 가리킨다 — 그러면 살아 있는 체인은 그대로 남는다. */
        const dropRollingChain = (): void => {
          const closed = deps.getState().dispatches.find((d) => d.id === dispatchId)
          if (closed) deps.unregisterRolling?.(closed.sessionId)
        }
        // 검토 Dispatch 의 보고는 다른 판정으로 간다. applyWorkerDone 으로 보내면 dispatched 에서만
        // 나가는 전이를 reviewing 인 Task 에 적용하려다 거절되고, 검토 결과가 어디에도 반영되지 않는다.
        if (reporting?.review) {
          // 구조화된 판정(설계 §8.2). 파일이 없으면 undefined(outcome 으로 해석), 깨졌거나 읽을 수
          // 없으면 'malformed'(Gate) — 조용히 "이슈 없음" 으로 읽지 않는다. **convergence 가 없는
          // Run 은 읽지 않는다** — applyReviewResult 는 issues 를 그 경로에서 무시하므로 읽어도
          // 헛돌고, 그 Run 의 동작은 오늘과 바이트 단위로 같아야 한다(이 파일의 다른 규율과 같다).
          //
          // **suffix(`.review.json`)를 붙이는 자리는 여기 하나뿐이다.** deps.readReviewFile 은
          // 완성된 경로를 받는다 — 배선이 또 붙이면 `….md.review.json.review.json` 을 찾다가
          // 조용히 못 찾고, 구조화된 판정 기능이 죽은 채로 아무 신호도 내지 않는다.
          const beforeReview = deps.getState()
          const reviewTask = beforeReview.tasks.find((t) => t.id === taskId)
          const reviewRun = reviewTask && beforeReview.runs.find((r) => r.id === reviewTask.runId)
          const reviewJob = reviewRun && jobOf(beforeReview, reviewRun)
          let issues: ReviewIssueInput[] | 'malformed' | undefined
          if (reviewJob?.convergence && deps.readReviewFile && reporting.specPath) {
            try {
              const text = await deps.readReviewFile(`${reporting.specPath}.review.json`)
              if (text !== null) {
                const parsed = parseReviewFile(text)
                if (parsed.ok) {
                  issues = parsed.issues
                } else {
                  issues = 'malformed'
                  deps.log?.(`review.json for dispatch=${dispatchId} is malformed: ${parsed.error}`)
                }
              }
            } catch (e) {
              issues = 'malformed'
              deps.log?.(`review.json for dispatch=${dispatchId} could not be read: ${String(e)}`)
            }
          }
          // **상태를 읽기 전에 기다린다.** repairTargetFor 도 이제 소켓을 건널 수 있고(그 선언),
          // 인자는 왼쪽부터 평가되므로 객체 리터럴 안에서 await 하면 그 await 는 위의
          // `deps.getState()` **뒤에** 일어난다 — 그 사이에 커밋된 것을 아래 setState 가 덮는다.
          // 먼저 받아 두면 그 창이 없다.
          const repairTarget = deps.repairTargetFor ? (await deps.repairTargetFor(taskId)) ?? undefined : undefined
          // **같은 이유로 여기서 받아 둔다.** `lang` 도 이제 소켓을 건널 수 있고(그 선언), 아래
          // 리터럴 안에서 await 하면 그 await 는 첫 인자인 `deps.getState()` 뒤에 일어난다 — 바로
          // 위 줄이 막 없앤 그 창을 도로 여는 셈이다.
          const gateLang = (await deps.lang?.()) ?? 'en'
          // 진입 스냅숏(s)이 아니라 지금 상태를 읽는다 — 위 탐침과 방금 파일 읽기의 await 동안 다른
          // 흐름이 커밋했을 수 있고, 낡은 스냅숏으로 부르면 setState 가 그것을 덮어 잃는다(아래 구현
          // 경로와 같은 이유).
          const r = applyReviewResult(
            deps.getState(),
            {
              taskId,
              dispatchId,
              outcome,
              subject: str(args.subject) ?? '',
              body: str(args.body) ?? '',
              ...(issues !== undefined ? { issues } : {}),
              ...(deps.repairTargetFor ? { repair: repairTarget } : {}),
              lang: gateLang
            },
            now
          )
          if (!r.ok) return refused(r)
          await deps.setState(withLimit(r.state))
          // 'alreadyReported' 는 아무것도 닫지 않았다(재전송) — 그때 이미 걷혔다
          if (r.value === 'accepted') dropRollingChain()
          // 판정이 repair Dispatch 를 새로 열었으면 그 부수 효과를 시작한다(repair.ts). **커밋 뒤에만
          // 부른다** — worker-start 의 서버 분기와 같은 순서(Dispatch 먼저, 세션은 그다음)다.
          if (r.value === 'accepted') {
            const afterReview = deps.getState()
            const repairOpen = afterReview.dispatches.find(
              (x) => x.taskId === taskId && x.repair !== undefined && !x.endedAt && !x.specPath
            )
            if (repairOpen) deps.startRepair?.({ dispatchId: repairOpen.id })
          }
          return okBody(r.value)
        }
        // getState is read again here — the state may have changed during the probeLimit await
        // above, and calling applyWorkerDone with the pre-await snapshot (s) would overwrite and
        // lose that change (the same reason as in handleExit — the write inversion this has caused
        // before).
        const result = applyWorkerDone(
          deps.getState(),
          {
            taskId,
            dispatchId,
            outcome,
            subject: str(args.subject) ?? '',
            body: str(args.body) ?? '',
            filesModified:
              typeof args.filesModified === 'string'
                ? args.filesModified.split(',').filter(Boolean)
                : undefined,
            // 검증기가 주입되지 않은 배선에서는 검증이 없는 것으로 동작한다. validating 으로
            // 보내면 결과를 가져다줄 것이 없어 Task 가 거기서 영원히 멈춘다(startValidation 참고).
            canValidate: !!deps.startValidation,
            // startValidation 과 같은 이유 — 주입되지 않은 배선에서는 검토가 없는 것으로 동작한다.
            canReview: !!deps.startReview
          },
          now
        )
        if (!result.ok) return refused(result)
        await deps.setState(withLimit(result.state))
        if (result.value === 'accepted') dropRollingChain() // 위 검토 경로와 같은 이유·같은 조건
        // 커밋 뒤에 부른다 — 검증이 먼저 끝나면 아직 validating 이 아닌 Task 에 결과를 쓰게 된다.
        // result.value가 'alreadyReported'인 재전송은 상태를 바꾸지 않았다(첫 호출의 커밋을 그대로
        // 다시 읽을 뿐이다) — 걸러내지 않으면 재전송마다 검증이 다시 큐에 들어가고, 그 사이 Task가
        // 재시도돼 validating으로 다시 들어왔다면 낡은 검증의 종료 코드가 새 시도를 정산해 버린다.
        const settled = deps.getState().tasks.find((t) => t.id === taskId)
        const dispatch = deps.getState().dispatches.find((d) => d.id === dispatchId)
        if (result.value === 'accepted' && settled?.status === 'validating' && dispatch)
          deps.startValidation?.({ taskId, cwd: dispatch.cwd })
        // 검증이 걸리지 않고 검토만 걸린 Task 는 여기서 곧바로 reviewing 이다. 검증이 걸린 Task 는
        // 검증이 통과한 뒤 배선의 onSettled 가 같은 일을 한다(core/orchestration/exec/validation.ts).
        else if (result.value === 'accepted' && settled?.status === 'reviewing')
          deps.startReview?.({ taskId })
        return okBody(result.value)
      }
      // status, escalation and heartbeat — recorded only, with no bearing on lifetime.
      // If a worker omits dispatchId it is filled in from that session's open dispatch (the only
      // case where the server has no way to guess which dispatch was meant, so the default is drawn
      // only from open ones). If dispatchId is given, only ownership is checked, regardless of state
      // — otherwise simply omitting dispatchId would bypass the whole "cannot send for another
      // dispatch" check. When taskId is given it must match the taskId of *the dispatch that
      // dispatchId points at* — comparing against myDispatch.taskId would make the comparison
      // impossible when sending for one's own closed dispatch, because there is no myDispatch then.
      let dispatchId = str(args.dispatchId)
      if (isWorker) {
        if (!dispatchId) {
          if (!myDispatch) return denied('no open dispatch for this session')
          dispatchId = myDispatch.id
        } else if (!myDispatchIds.has(dispatchId)) {
          return denied('cannot send for another dispatch')
        }
        const taskIdArg = str(args.taskId)
        const targetTaskId = s.dispatches.find((d) => d.id === dispatchId)?.taskId
        if (taskIdArg && targetTaskId && taskIdArg !== targetTaskId)
          return denied('cannot send for another task')
      }
      const task = s.tasks.find((t) => t.id === str(args.taskId))
      const runId = task?.runId ?? latestRun(s)?.id
      if (!runId) return bad('no run to post into')
      const next: OrchState = {
        ...s,
        messages: [
          ...s.messages,
          {
            // 16 hex — the same reason as the limit status message above
            id: `msg_${randomBytes(8).toString('hex')}`,
            runId,
            type,
            taskId: str(args.taskId) ?? undefined,
            dispatchId: dispatchId ?? undefined,
            subject: str(args.subject) ?? '',
            body: str(args.body) ?? '',
            answered: false,
            createdAt: now
          }
        ]
      }
      await deps.setState(next)
      return okBody({ sent: type })
    }
    case 'reply': {
      const id = str(args.id)
      const body = str(args.body)
      if (!id) return bad('--id is required')
      if (body === null) return bad('--body is required')
      return commit(applyReply(s, { messageId: id, body }, now))
    }
    case 'check': {
      const runId = str(args.run) ?? latestRun(s)?.id
      if (!runId) return bad('no run exists')
      // **A named Run that is not there is a 404, before anything is acked or waited on.**
      // nextDelivery does not look the Run up — it only filters by it — so a mistyped `--run`
      // answered an empty batch, and with `--wait` sat out the whole deadline, on the command a
      // coordinator calls in a loop.
      if (!s.runs.some((r) => r.id === runId)) return notFound(`unknown run: ${runId}`)
      if (str(args.ack)) {
        const acked = ackDelivery(s, { deliveryId: str(args.ack)! }, now)
        // **The 404 carries the Run it was checked against**, so the CLI's next step can be
        // `check --run <runId>` (cliOutput.ts, STEPS.NOT_FOUND), which hands back the batch still
        // unacknowledged and its deliveryId. The `--run` 404 above carries none: that Run is not there.
        if (!acked.ok) return acked.missing ? { status: 404, body: { error: acked.error, runId } } : bad(acked.error)
        await deps.setState(acked.state)
      }
      const types =
        typeof args.types === 'string' ? (args.types.split(',') as MessageType[]) : undefined
      // The same logic is used whether or not wait was requested. pollUntil's probe has to be a
      // synchronous function, so take() does not commit — it only holds on to "the state to
      // commit", and deps.setState is awaited exactly once after leaving the polling loop.
      // Returning the response without awaiting setState would let the disk write of an overlapping
      // second setState land before this one, so this batch creation could be lost on disk. A
      // pure-layer error (r.ok === false) is kept distinct rather than folded into null —
      // otherwise the wait path would mistake the error for "no batch yet" and poll uselessly until
      // the deadline.
      type Taken =
        | { kind: 'batch'; state: OrchState; body: { deliveryId: string; count: number; messages: unknown[] } }
        | { kind: 'error'; error: string }
      const take = (): Taken | null => {
        const r = nextDelivery(deps.getState(), { runId, types }, now)
        if (!r.ok) return { kind: 'error', error: r.error }
        if (r.value === null) return null
        return {
          kind: 'batch',
          state: r.state,
          body: {
            deliveryId: r.value.delivery.id,
            count: r.value.messages.length,
            messages: r.value.messages
          }
        }
      }
      const commitTaken = async (t: Taken): Promise<Reply> => {
        if (t.kind === 'error') return bad(t.error)
        await deps.setState(t.state)
        return okBody(t.body)
      }
      if (args.wait !== true) {
        const got = take()
        return got ? commitTaken(got) : okBody({ count: 0, messages: [] })
      }
      const timeoutMs =
        typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_CHECK_TIMEOUT_MS
      // **The wait is recorded while it is in flight** (final round 2, I-A): it is the one sure sign that
      // a coordinator is parked rather than thinking, which a fire asks before it replaces its Run.
      const leave = deps.enterCheckWait?.(runId, caller.sessionId)
      let waited: Awaited<ReturnType<typeof pollUntil<Taken>>>
      try {
        waited = await pollUntil(take, timeoutMs)
      } finally {
        leave?.()
      }
      if ('value' in waited) return commitTaken(waited.value)
      return okBody({ count: 0, messages: [], timedOut: true })
    }
    case 'inbox': {
      const limit = typeof args.limit === 'number' ? args.limit : 50
      return okBody(s.messages.slice(-limit))
    }
    case 'ask': {
      const timeoutMs =
        typeof args.timeoutMs === 'number' ? args.timeoutMs : DEFAULT_ASK_TIMEOUT_MS
      // --resume: does not create a new question, it keeps waiting on an existing one.
      let questionId = str(args.resume)
      if (questionId) {
        // The resume target has to be validated three ways (without them a nonexistent id folds into
        // "an answer arrived (with no content)" and the worker moves on, leaving a genuinely
        // unanswered question behind): does it exist; is it of type question (passing the id of some
        // other message such as worker_done or status makes answered read as true/false by accident
        // and yields a wrong result); and does this session own that question's dispatch (the same
        // myDispatchIds boundary as the send and ask creation paths — otherwise a worker could peek
        // at the coordinator's answer to another worker's question).
        //
        // **For a worker, ownership comes first, and a missing id is answered the same** (R3): 403
        // whether the message is not there or belongs to another dispatch, before the type is
        // looked at. Otherwise the 404/400/403 split tells a worker which ids exist elsewhere and
        // what kind of message each one is. A worker's own dispatch still gets the 400 for a
        // message that is not a question. A non-worker (the coordinator, a shell) keeps 404 and 400.
        const q = s.messages.find((m) => m.id === questionId)
        if (isWorker && (!q || !myDispatchIds.has(q.dispatchId ?? '')))
          return denied('cannot resume a question for another dispatch')
        if (!q) return notFound(`unknown question: ${questionId}`)
        if (q.type !== 'question') return bad(`not a question: ${questionId}`)
      } else {
        const taskId = str(args.taskId)
        const dispatchId = str(args.dispatchId) ?? myDispatch?.id ?? null
        const question = str(args.question)
        if (!question) return bad('--question or --resume is required')
        if (!taskId || !dispatchId) return bad('--task-id and --dispatch-id are required')
        // Only ownership is checked, regardless of state (the same reason as worker_done in send) —
        // an ask for one's own closed dispatch is not blocked here but passed on to createQuestion.
        // createQuestion already rejects it more precisely with 'dispatch already settled'.
        if (isWorker && !myDispatchIds.has(dispatchId))
          return denied('cannot ask for another dispatch')
        const created = createQuestion(
          s,
          {
            taskId,
            dispatchId,
            question,
            options: typeof args.options === 'string' ? args.options.split(',') : undefined
          },
          now
        )
        if (!created.ok) return refused(created)
        await deps.setState(created.state)
        questionId = created.value.id
      }
      const probe = ():
        | { answered: true; answer: string }
        | { answered: false; abandoned: true }
        | null => {
        const st = deps.getState()
        const q = st.messages.find((m) => m.id === questionId)
        // The question is gone — reset, the only path that deletes messages past this point, is
        // rejected while even one dispatch is open (the reset guard), so this is unreachable while
        // this question's dispatch is open. It is still not folded into an answer but guarded as
        // abandoned.
        if (!q) return { answered: false, abandoned: true }
        // Invariant: a real answerBody can never be the empty string — reply turns '' into null via
        // str(args.body) and rejects it with 400 (the 'reply' branch above). The fake settlement
        // that settlePendingQuestions (state.ts) leaves on an unanswered question when a dispatch
        // goes terminal is always answerBody:''. Without that distinction, once a real answer has
        // arrived and the dispatch then goes terminal for an unrelated reason (a parallel
        // worker_done from the same worker, worker-stop, worker-abandon), the terminal check would
        // fire first and mask the real answer that already arrived as abandoned — a regression
        // introduced by an earlier fix. So the real answer has to be checked before the dispatch
        // state.
        if (q.answered && (q.answerBody ?? '') !== '') return { answered: true, answer: q.answerBody! }
        const dispatch = st.dispatches.find((d) => d.id === q.dispatchId)
        // The dispatch has gone terminal (outcome or endedAt) — worker-stop, worker-abandon and
        // restart cleanup do not call settlePendingQuestions, so the question is left unanswered;
        // applyWorkerDone does call it, but the answer it leaves is not a real answer, it is a
        // settlement with ''. In both cases there is nobody left to answer (and the check above has
        // already established this is not a real answer), so bail out early as abandoned.
        if (dispatch && (dispatch.outcome || dispatch.endedAt))
          return { answered: false, abandoned: true }
        // Reaching here with q.answered set can only be the empty answerBody left by
        // settlePendingQuestions (and even in the extremely narrow window where the dispatch goes
        // terminal between the terminal check and this one while it was still alive, the dispatch
        // terminal check above catches it as abandoned on the very next polling tick).
        return q.answered ? { answered: false, abandoned: true } : null
      }
      const waited = await pollUntil(probe, timeoutMs)
      if ('value' in waited) return okBody({ ...waited.value, questionId })
      return okBody({ answered: false, timedOut: true, questionId })
    }
    case 'gate-create': {
      const taskId = str(args.task)
      const question = str(args.question)
      if (!taskId) return bad('--task is required')
      if (!question) return bad('--question is required')
      return commit(
        createGate(
          s,
          {
            taskId,
            question,
            options: Array.isArray(args.options) ? (args.options as string[]) : undefined
          },
          now
        )
      )
    }
    case 'gate-resolve': {
      const gateId = str(args.id)
      const resolution = str(args.resolution)
      if (!gateId) return bad('--id is required')
      if (!resolution) return bad('--resolution is required')
      const gate = s.gates.find((g) => g.id === gateId)
      const r = resolveGate(s, { gateId, resolution }, now)
      if (!r.ok) return refused(r)
      // 소진 Gate 의 두 답(설계 §5.2). **다른 모든 Gate·다른 모든 resolution 은 지금처럼 풀린다** —
      // 이 갈래는 kind 가 'convergence-exhausted' 이고 이번 호출이 실제로 그 Gate 를 닫았을 때만
      // 탄다(위 snapshot 의 `gate.status === 'open'`; resolveGate 는 이미 resolved 인 Gate 를 다시
      // 부르면 no-op 이다). gate 가 있으면 r.ok 이므로(resolveGate 도 같은 gateId 로 같은 s 를
      // 찾는다) 아래 `gate!` 는 안전하다.
      const exhaustedOpen = gate?.kind === 'convergence-exhausted' && gate.status === 'open'
      // mark-failed 는 task-update 와 같은 전이표 우회다(회로 카운터는 그대로 둔다 — 이것은 구제가
      // 아니라 포기다) — **resolveGate 의 커밋과 한 번에 묶는다.** resolveGate 는 이미 blocked ->
      // pending(그리고 recomputeReady 가 deps 없는 Task 를 ready 로) 을 정했다; 그 상태를 먼저
      // 커밋하고 나중에 failed 로 또 한 번 덮어쓰면, 그 사이 창에서 Task 가 ready 로 보인다 —
      // autoDispatch 를 켠 Run 의 스케줄러(slotsToFill)가 사람이 방금 포기한 Task 에 워커를 띄울 수
      // 있는 창이다.
      let finalState = r.state
      if (exhaustedOpen && resolution === 'mark-failed') {
        const before = r.state.tasks.find((t) => t.id === gate!.taskId)?.status
        const allowedByTable = before !== undefined && (before === 'failed' || canTransition(before, 'failed'))
        deps.log?.(
          `gate-resolve: task=${gate!.taskId} ${before ?? '?'} -> failed (mark-failed on an exhausted Gate, table-allowed=${allowedByTable})`
        )
        finalState = {
          ...finalState,
          tasks: finalState.tasks.map((t) =>
            t.id === gate!.taskId ? { ...t, status: 'failed' as const, updatedAt: now } : t
          )
        }
      }
      await deps.setState(finalState)
      // retry-once 는 repair.ts 의 repairOnce — **그 Dispatch 커밋까지만 기다린다.** repairOnce 는
      // Dispatch 를 열어 커밋한 뒤에야 resolve 하고, 부수 효과(spec 파일 쓰기, 세션 띄우기)는
      // 백그라운드로 넘긴다(repair.ts 의 주석). 여기서 기다리지 않으면 이 응답이 먼저 나가고, 그
      // 사이 Task 는 ready 에 Dispatch 없이 있어 worker-release·worker-start 가 그 창으로 같은
      // 세션(same-session repair 가 노리는 바로 그 세션)에 슬쩍 들어올 수 있다.
      //
      // **실패를 응답에 싣는다(전체 브랜치 리뷰, Finding 5).** 이 Task 를 막는 다른 Gate 가 이미
      // 열려 있으면(openDispatch 의 "task is blocked by an open gate") repairOnce 는 아무것도 열지
      // 못한 채 그 사실을 로그만 하고 돌아온다 — 이 Gate 자체는 정상적으로 풀렸으니 200 이 맞지만,
      // 사람의 "한 번 더" 가 조용히 무효가 된 사실까지 감추면 안 된다.
      const retried = exhaustedOpen && resolution === 'retry-once' ? await deps.repairOnce?.({ taskId: gate!.taskId }) : undefined
      if (retried && !retried.ok)
        return okBody({ ...r.value, retryOnceFailed: retried.error })
      return okBody(r.value)
    }
    /** 질문에 답한다 — `gate-resolve` 의 공개 이름(공개 CLI 설계 §5 Phase B).
     *  답을 받는 플래그 이름도 사람의 말로 바뀐다(`--answer`). 서버 안에서는 한 자리로 간다 —
     *  같은 일을 두 번 적지 않는다. */
    case 'questions-answer': {
      const answer = str(args.answer) ?? str(args.resolution)
      if (!answer) return bad('--answer is required')
      return handleCommand(deps, caller, 'gate-resolve', { id: args.id, resolution: answer })
    }
    case 'questions-get': {
      const id = str(args.id)
      if (!id) return bad('--id is required')
      const gate = s.gates.find((g) => g.id === id)
      return gate ? okBody(gate) : notFound(`unknown question: ${id}`)
    }
    case 'questions-list': {
      let gates = s.gates
      if (str(args.task)) gates = gates.filter((g) => g.taskId === args.task)
      if (str(args.status)) gates = gates.filter((g) => g.status === args.status)
      return okBody(gates)
    }
    // **오케스트레이터가 거기 있는가, 그리고 무엇이 돌고 있는가**(공개 CLI 설계 §5). 이 명령에
    // 닿았다는 것이 이미 "Host 가 있다" 의 답이다 — 없으면 CLI 가 접속에서 걸리거나(HOST_NOT_RUNNING)
    // 아무도 쓰지 않는 상태 파일로 대신 답한다(stateFile.ts).
    //
    // 세는 것은 사람이 한 화면에서 보고 싶은 넷이다. 질문을 따로 세는 이유는 그것만이 **사람을
    // 기다리는** 수이기 때문이다 — CI 가 분기하는 값이고(명세 §19), 그래서 `wait` 의 종료 코드
    // 8 과 같은 것을 센다.
    case 'status': {
      const openGates = s.gates.filter((g) => g.status === 'open')
      const waiting = new Set(openGates.map((g) => g.runId))
      return okBody({
        running: true,
        pid: process.pid,
        version: deps.appVersion?.() ?? null,
        protocol: CLI_PROTOCOL,
        projects: s.projects.length,
        jobs: s.jobs.length,
        // 일이 도는 회차 — `host stop` 의 거절과 Host 의 유휴 종료가 세는 것과 **같은 규칙**이다
        // (running.ts 의 runningRunCount, 감사 #100). 예전에는 끝나지 않은 회차(outcomeOf)를 세어,
        // 아직 시작하지 않은 계획도 도는 것으로 적으면서 Host 는 그 회차를 두고 떠났다.
        runsRunning: runningRunCount(s),
        runsWaitingForInput: waiting.size,
        questionsOpen: openGates.length,
        sessionsRunning: deps.runningSessions?.() ?? null
      })
    }
    // CLI 는 자기 버전을 빌드에서 받아 알고 있다(§4) — 여기서 답하는 것은 앱 쪽 값이다.
    case 'version':
      return okBody({ version: deps.appVersion?.() ?? null, protocol: CLI_PROTOCOL })
    // 공개 이름(phase C). 같은 목록이고, 공개 표면의 칸은 cliPublic 이 세 칸으로 가린다.
    case 'accounts':
    case 'accounts-list': {
      const agent = str(args.agent)
      return okBody(await deps.listAccounts(agent === 'claude' || agent === 'codex' ? agent : undefined))
    }
    /**
     * 세션을 보고, 읽고, 친다 — 공개 이름(phase C). 답은 Host 의 레지스트리다(`listSessions` 셋).
     *
     * **COORDINATOR_ONLY 에 넣지 않는다 — 사용자 결정이다.** 워커 세션도 부를 수 있다. 경계는 이
     * CLI 의 나머지와 같은 OS 계정이고(docs/cli.md 의 Security), 그 안의 누구든 이미 이 세션들을 띄운
     * 프로그램을 돌릴 수 있다.
     *
     * **`sessions send` 가 영수증에 남는 것은 커밋이 아니라 `sendSession` 때문이다** — 상태는 그대로다.
     * host/orchDeps.ts 가 그 의존을 "움직인다" 로 적어 두었으므로 같은 `--request-id` 의 재시도는 한 번
     * 더 치지 않고 첫 답을 재생한다.
     */
    case 'sessions-list':
    case 'sessions-read':
    case 'sessions-send': {
      if (!deps.listSessions || !deps.readSession || !deps.sendSession || !deps.readChat || !deps.chatSend)
        return conflict('sessions are answered by the Astera Host, and this caller is not one')
      if (routed === 'sessions-list') return okBody(await deps.listSessions())
      const id = str(args.id)
      if (id === null) return bad('--id is required: a session id from `sessions list`')
      const lines = routed === 'sessions-read' && args.lines !== undefined ? posInt(args.lines) : 200
      if (lines === null) return bad('--lines must be a whole number, 1 or more')
      // The emulator holds that many rows, in the Host that holds every session: a million costs it
      // about half a gigabyte for one read. The Host keeps 256,000 characters of a session, so this
      // is more rows than a session can have.
      if (lines > 10_000) return bad('--lines is at most 10000')
      const turns =
        routed === 'sessions-read' && args.turns !== undefined ? posInt(args.turns) : CHAT_TURNS_DEFAULT
      if (turns === null) return bad('--turns must be a whole number, 1 or more')
      if (turns > CHAT_TURNS_MAX) return bad(`--turns is at most ${CHAT_TURNS_MAX}`)
      const text = routed === 'sessions-send' ? str(args.text) : null
      if (routed === 'sessions-send' && text === null)
        return bad('--text is required: what to type (a value of `-` reads it from stdin)')
      const session = (await deps.listSessions()).find((x) => x.id === id)
      if (!session) return notFound(`unknown session: ${id}`)
      // **한 명령에 두 모양이다.** 터미널은 화면의 줄(--lines), 대화는 턴(--turns)이다. 맞지 않는
      // 쪽의 플래그는 조용히 버리지 않고 400 으로 돌려보낸다 — 준 것이 안 먹은 줄 모르게 두지 않는다.
      if (session.kind === 'chat') {
        if (args.lines !== undefined)
          return bad(`--lines is for terminal sessions; ${id} is a chat session, which reads in turns (--turns)`)
        if (routed === 'sessions-send' && args.noEnter !== undefined)
          return bad(`--no-enter is for terminal sessions; ${id} is a chat session, where a send is one turn`)
      } else if (args.turns !== undefined)
        return bad(`--turns is for chat sessions; ${id} is a terminal session, which reads in rows (--lines)`)
      // 대화는 CLI 가 쓰는 transcript·rollout 파일에서 읽는다 — 대화 화면이 읽는 그 파일, 그 reducer 다.
      // 열린 카드는 앱만 안다. 앱이 답하지 못하면(`undefined`) 칸을 싣지 않는다 — "카드 없음" 이 아니다.
      if (routed === 'sessions-read' && session.kind === 'chat') {
        const read = await deps.readChat(id, turns)
        const pending = deps.chatPending ? await deps.chatPending(id) : undefined
        return okBody({ id, kind: 'chat', alive: session.alive, turns: read, ...(pending === undefined ? {} : { pending }) })
      }
      // 화면은 Host 가 그린다 — 흐름에서 escape 만 벗기면 ConPTY 가 커서로 옮긴 줄이 한 줄로 붙는다.
      if (routed === 'sessions-read')
        return okBody({ id, kind: 'terminal', alive: session.alive, ...(await deps.readSession(id, lines)) })
      if (!session.alive) return conflict(`session ${id} has ended; there is nothing to type into`)
      // 앱이 붙어 있으면 앱의 세션 드라이버로, 없으면 Host 가 어댑터의 바이트를 직접 쓴다(orchDeps 의
      // chatSend). 카드가 열려 있으면 앱이 거절한다 — 그 답은 앱에서 사람이 한다(R4.3).
      if (session.kind === 'chat') {
        const r = await deps.chatSend(id, text as string)
        if (!r.sent && 'reason' in r)
          return conflict(`Astera does not hold ${id} right now (it may still be taking its sessions back); nothing was sent, try again in a moment`)
        if (!r.sent)
          return conflict(
            `${id} is waiting on ${r.pending.kind === 'approval' ? 'an approval' : 'a question'}: ${r.pending.summary}. Answer it in Astera; a send does not answer it`
          )
        return okBody({ id, sent: true })
      }
      const enter = args.noEnter !== true
      // 붙여 넣고 Enter 를 치는 약속(ptyDriver)과 세션마다 한 번에 하나씩은 Host 가 지킨다.
      await deps.sendSession(id, text as string, enter)
      return okBody({ id, sent: true, enter })
    }
    /**
     * The permission prompts chat sessions wait on, and one answer to one of them (chat takeover §3.5).
     * Both are answered by the Host: it lists the sessions it writes to itself and asks an attached app
     * for the rest, and an answer goes to the session's writer (host/orchDeps.ts HOST_CHATS). Only an
     * approval can be answered here (plan ruling P6); a prompt id is per process, so an id open in two
     * sessions needs `--session` (P7).
     */
    case 'chats-pending':
    case 'chats-answer': {
      // **An answer is for a person** (Task 8 fix round 1, the controller's ruling). Letting a tool run
      // is the decision the prompt exists to put to someone, so every caller inside an agent session is
      // refused: a worker, a coordinator and a plain tab alike. The shell's CLI has no ASTERA_SESSION
      // and calls with an empty session id. `chats pending` is a read and stays open to every caller.
      if (routed === 'chats-answer' && caller.sessionId !== '')
        return denied('chats answer is for a person: run it from a shell, not from inside an agent session')
      if (!deps.chatPrompts || !deps.chatAnswer)
        return conflict('chat prompts are answered by the Astera Host, and this caller is not one')
      const session = args.session === undefined ? undefined : str(args.session)
      if (session === null) return bad('--session needs a session id (from `sessions list`)')
      const list = await deps.chatPrompts(session)
      if (routed === 'chats-pending') return okBody(list)
      const id = str(args.id)
      if (id === null) return bad('--id is required: a prompt id from `chats pending`')
      const allow = args.allow === true
      if (allow === (args.deny === true)) return bad('give exactly one of --allow and --deny')
      const matches = list.prompts.filter((x) => x.id === id)
      if (matches.length > 1)
        return bad(`prompt ${id} is open in ${matches.map((x) => x.sessionId).join(' and ')}; say which with --session`)
      const target = matches[0]
      if (!target)
        return conflict(
          list.complete
            ? `no open prompt ${id}${session ? ` in ${session}` : ''}; it may have been answered already (\`chats pending\` lists what is open)`
            : `no open prompt ${id} that the Host can see, and Astera could not be asked; try again in a moment`
        )
      if (target.kind === 'question') return conflict(`${id} is a question, not a permission prompt; answer it in Astera`)
      const decision = allow ? 'allow' : 'deny'
      const r = await deps.chatAnswer(target.sessionId, id, decision)
      if (!r.answered)
        return conflict(
          r.detail !== undefined
            ? r.detail
            : r.reason === 'not-held'
              ? `nothing holds ${target.sessionId} right now (Astera may still be taking its sessions back); nothing was answered, try again in a moment`
              : r.reason === 'question'
                ? `${id} is a question, not a permission prompt; answer it in Astera`
                : `prompt ${id} is no longer open; nothing was answered`
        )
      return okBody({ sessionId: target.sessionId, id, decision, answered: true })
    }
    case 'reset': {
      const open = s.dispatches.filter((d) => !d.endedAt)
      if (open.length > 0)
        return conflict(`refusing to reset while ${open.length} dispatch(es) are open`)
      // Rejected when none of the three flags is given — args.all used not to be read at all, so
      // --all was ignored (the else branch happened to do the same full reset, so only the result
      // was right) and a full reset ran silently with no flag at all. Defaulting a destructive
      // operation to "wipe everything" is dangerous — following this repo's principle of never
      // silently introducing dependencies or destructive operations, not saying what to wipe is
      // rejected with bad(...).
      // The flag check comes before the backup — a call that wipes nothing must not overwrite .bak
      // and destroy the backup from the previous reset.
      // **deps.getState() is read, not the snapshot s taken on entry.** backup() below is a new
      // yield point (write queue + copyFile), so overwriting with s any change that landed in the
      // meantime would lose it — if a worker's send disappears that way, the message an unacked
      // Delivery refers to is gone, an empty batch is replayed, the coordinator skips the ack and
      // everything after that goes undelivered (a livelock, seen in practice).
      // --all is emptyState, so there is nothing to capture.
      const wipe: (() => OrchState) | null =
        args.tasks === true
          ? () => ({ ...deps.getState(), tasks: [], dispatches: [] })
          : args.messages === true
            ? () => ({ ...deps.getState(), messages: [], deliveries: [] })
            : args.all === true
              ? emptyState
              : null
      if (!wipe) return bad('specify one of --tasks, --messages, --all')
      // The documented safety net for destructive operations — copies the current file **before** setState.
      await deps.backup?.()
      await deps.setState(wipe())
      return okBody({ reset: true })
    }
    default: {
      // **모르는 명령은 501 이지 404 가 아니다**(공개 CLI 설계 §8). 404 는 없는 id 의 자리다 — 둘을
      // 같은 것으로 두면 스크립트가 \"그 Job 이 없다\" 와 \"이 앱은 그 명령을 모른다\" 를 가르지
      // 못한다. 뒤의 것은 앱과 CLI 의 버전이 갈렸다는 뜻이고, 그것이 VERSION_MISMATCH(9) 의 뜻이다.
      //
      // **`never` 인 것이 빠짐 검사다.** 위의 `case` 들이 `SwitchedCommand` 를 다 덮으면 여기 남는
      // 타입이 `never` 이고, 하나라도 빠지면 그 이름이 남아 이 줄이 그 이름을 대며 깨진다. 값은
      // 런타임에 그냥 `cmd` 이므로 문구는 달라지지 않는다.
      const unhandled: never = routed
      return { status: 501, body: { error: `unknown command: ${String(unhandled)}` } }
    }
  }
}

/** Closes a Dispatch when its session goes away (exit). Moved here from coordinator.ts — because
 *  closeDispatch touches OrchState it has to live on the server side, which owns the state (the
 *  coordinator neither reads nor writes state at all). The wiring taps session exit events into
 *  here. Unlike handleCommand this is a session lifecycle event rather than a CLI command, so it is
 *  a separate function. */
export async function handleExit(
  deps: OrchServerDeps,
  e: { sessionId: string; exitCode: number }
): Promise<void> {
  // **An exit is not always an ending.** A Host-backed pty handle fabricates this code when the socket
  // to the Host goes away: no `pty-exit` can arrive for a pty whose channel is gone, so the handle ends
  // itself rather than leave the record waiting forever. The process on the other side is very probably
  // still running — the Host outlives the app, and a dropped connection is not the Host dying, so the
  // app re-attaches by id on the next handshake (slice 2 design §11).
  //
  // Closing the Dispatch on it is the one thing that must not happen. `candidates()` selects Tasks whose
  // latest Dispatch is closed, so a Dispatch closed here hands P1's reconciler a worker it reads as lost
  // and it starts a second agent in the worktree the first is still working in — spec §29 Scenario 2, the
  // failure this slice exists to prevent, reached through the app's own exit path rather than through the
  // boot cleanup that was hardened against it.
  //
  // Leaving it open costs a stall: if the pty really is gone (the reconnect reached a *different* Host),
  // nothing re-asks in this session and the Dispatch stays open until the next boot, whose cleanup reads
  // the Host's answer and closes it. That is the same asymmetry the rest of this slice chose, and the
  // same outcome `OrchRollTap.dispose` already accepts for an exit that arrives during a quit — a stalled
  // Job is a person noticing nothing moved, a duplicate agent is two agents writing one worktree.
  if (e.exitCode === PTY_LOST_SIGHT_EXIT_CODE) {
    deps.log?.(`session=${e.sessionId} was lost sight of rather than ended — its dispatch stays open`)
    return
  }
  const now = deps.now?.() ?? new Date().toISOString()
  // The probe needs the provider and sessionId, and those are only on the Dispatch before it closes.
  const open = deps.getState().dispatches.find((d) => d.sessionId === e.sessionId && !d.endedAt)
  let limitResetsAt: number | null = null
  if (open && deps.probeLimit) {
    // The probe reads files — a failure there must not block the session cleanup path.
    try {
      limitResetsAt = await deps.probeLimit(open)
    } catch (err) {
      deps.log?.(`limit probe failed dispatch=${open.id}: ${String(err)}`)
    }
  }
  // getState is read again here — the state may have changed during the await above, and calling
  // setState with the pre-await snapshot would overwrite and lose that change (the write inversion
  // this has caused before). The same snapshot is kept in `before`: closeDispatch bumps
  // consecutiveFailures, and the review branch below needs the value it had before that bump.
  const before = deps.getState()
  const r = closeDispatch(before, { ...e, ...(limitResetsAt !== null ? { limitResetsAt } : {}) }, now)
  if (!r.ok || r.value === null) return
  const closed = r.value
  const task = r.state.tasks.find((t) => t.id === closed.taskId)
  // 검토 Dispatch 가 보고 없이 닫혔으면 Gate 를 연다. closeDispatch 는 **Task 의 상태를 일부러
  // 건드리지 않는다** — 증명할 수 없는 결과를 주장하지 않는다는 규칙이고, 구현 Dispatch 에는 그것이
  // 맞다: Task 는 dispatched 에 남고 worker-start --retry-of 가 집어 간다. 검토 Dispatch 에는 그 길이
  // 없다. 검토자를 띄운 것은 앱이고 코디네이터에게는 그것을 다시 띄우는 명령이 없으며, worker-start
  // --retry-of 가 여는 openDispatch(state.ts) 는 reviewing 인 Task 를 명시적으로 거절한다("task is
  // awaiting a verdict") — ALLOWED.reviewing 이 dispatched 로 가는 칸을 열어 두는 것은
  // openRepairDispatch 하나만을 위해서지 이 문을 위해서가 아니다. 그대로 두면 Task 는 세션도 Gate 도
  // 없이 영원히 reviewing 이고, recomputeReady 는 completed 에서만 의존 Task 를 풀어 주므로 그 아래
  // 서브트리 전체가 pending 에 멈춘다. 가이드 2절의 표가 이 Gate 를 이미 약속하고 있다.
  if (!closed.review || task?.status !== 'reviewing') {
    await deps.setState(r.state)
    // `closedBy` is always absent here today: closeDispatch only matches a Dispatch with no
    // `endedAt`, and all three writers that set `closedBy` (worker-stop, worker-abandon,
    // run-pause) set `endedAt` in the same object — a person-closed Dispatch never reaches this
    // line. The branch stays as defence in depth, because it is the last place that can refuse:
    // a future writer that sets `closedBy` without `endedAt` would otherwise hand a deliberately
    // closed worker to recovery, which is the one thing recovery must never restart.
    if (!closed.closedBy) deps.onDispatchLost?.({ dispatchId: closed.id })
    return
  }
  const gated = blockForReview(
    r.state,
    { taskId: task.id, reason: `검토자의 세션이 보고 없이 끝났습니다(dispatch=${closed.id})` },
    now
  )
  if (!gated.ok) {
    // 여기까지 왔으면 Gate 를 열 수 없는 이유는 하나뿐이다(그 Task 에 또 다른 열린 Dispatch 가 있다).
    // Dispatch 를 닫은 것은 그대로 커밋한다 — 그것은 실제로 일어난 일이다.
    deps.log?.(`could not gate task=${task.id} after the reviewer session ended: ${gated.error}`)
    await deps.setState(r.state)
    return
  }
  // **consecutiveFailures 를 닫기 전 값으로 되돌린다.** closeDispatch 가 그것을 올리는 것은 회로
  // 차단이 무한 재시도를 막기 위한 것인데, 여기서는 그 재시도가 아예 불가능하고 되돌릴 사람은
  // Gate 를 받은 사람이다. 남겨 두면 검토자가 세 번 죽는 것만으로 멀쩡한 작업의 회로가 끊기고, 그것은
  // 이 Gate 가 막으려는 바로 그 일이다. store.ts 의 재시작 정리가 같은 상황에 같은 원칙을 적는다 —
  // "consecutiveFailures 는 건드리지 않는다: 작업이 틀렸다는 증거가 아니다". Gate 와 함께 한 번의
  // setState 로 커밋한다.
  const priorFailures = before.tasks.find((t) => t.id === task.id)?.consecutiveFailures
  await deps.setState({
    ...gated.state,
    tasks: gated.state.tasks.map((t) =>
      t.id === task.id && priorFailures !== undefined ? { ...t, consecutiveFailures: priorFailures } : t
    )
  })
}
