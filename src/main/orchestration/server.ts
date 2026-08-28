// The local orchestration server.
// handleCommand is kept separate from HTTP because routing, authorization and argument validation
// are the logic worth testing, and HTTP is a thin shell on top of it. Server tests never have to
// open a port.
import { createServer, type Server } from 'node:http'
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
  createRun,
  createTask,
  emptyState,
  latestOrdinaryRun,
  nextDelivery,
  openDispatch,
  resolveGate,
  deleteRuns,
  spawnScheduledRun,
  startRun,
  attachCoordinator,
  pauseSchedule,
  resumeSchedule,
  setRunWorktree,
  type OrchState,
  type Res
} from '../../core/orchestration/state'
import {
  DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  DEFAULT_CONCURRENCY,
  FAILURE_LIMIT,
  canTransition,
  recomputeReady,
  type Dispatch,
  type MessageType,
  type Task,
  type TaskStatus
} from '../../core/orchestration/types'
import { runWorktrees } from '../../core/orchestration/integrate'
import { buildHandoverPrompt } from '../../core/orchestration/handover'
import { nameForRun } from '../../core/worktrees/naming'
import type { Provider } from '../../core/providers/meta'
import { isValidRule, type ScheduleRule } from '../../core/scheduler/rule'

export interface OrchServerDeps {
  getState(): OrchState
  setState(next: OrchState): Promise<void>
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
   *  체크박스가 따로 하는 일이다(배선의 reap 옵션, src/main/ipc.ts).
   *  주입인 이유: 실제 병합은 git 을 돌리고 Gate 문구까지 만드는 배선의 일이라 src/main/ipc.ts 에
   *  있고, 이 파일은 그것을 호출만 한다 — now?/backup? 과 같은 관례로 optional 이다(주입되지 않으면
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
  listAccounts(provider?: Provider): { id: string; label: string; provider: Provider }[]
  readWorker(a: { dispatchId: string; limit?: number }): Promise<string>
  enabled(): boolean
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
  listRunConfigs?(projectPath: string): Promise<{ id: string; name: string; type: string }[]>
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
  /** Audit log left behind when task-update bypasses the transition table (canTransition) — the same
   *  shape as log(message: string) in coordinator.ts. The wiring decides where it goes. If it is not
   *  injected (existing tests and the like) logging is skipped — optional for the same reason as
   *  now?. */
  log?(message: string): void
}

export interface OrchServer {
  port: number
  token: string
  close(): Promise<void>
}

type Reply = { status: number; body: unknown }
const okBody = (body: unknown): Reply => ({ status: 200, body })
const bad = (msg: string): Reply => ({ status: 400, body: { error: msg } })
const denied = (msg: string): Reply => ({ status: 403, body: { error: msg } })
const conflict = (msg: string): Reply => ({ status: 409, body: { error: msg } })

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
 *  commands (worker-show, worker-read, task-list, gate-list, accounts, run-list, run-show,
 *  dispatch-show) do not carry another worker's private conversation, so they are not blocked. */
const COORDINATOR_ONLY = new Set([
  'run-create',
  'run-use',
  'run-delete',
  'run-spawn',
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
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  const parts = raw.split(',').map((x) => x.trim())
  if (parts.some((x) => x === '')) return { ok: false, reason: `${flag} must not contain an empty entry` }
  const dup = parts.find((x, i) => parts.indexOf(x) !== i)
  if (dup !== undefined) return { ok: false, reason: `${flag} lists ${dup} twice` }
  const unknown = parts.find((x) => !known.some((k) => k.id === x))
  if (unknown !== undefined) return { ok: false, reason: `unknown account: ${unknown}` }
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
  if (!deps.enabled()) return conflict('orchestration disabled')
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

  const commit = async <T>(r: Res<T>): Promise<Reply> => {
    if (!r.ok) return bad(r.error)
    await deps.setState(r.state)
    return okBody(r.value)
  }

  switch (cmd) {
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
        if (!deps.listAccounts().some((k) => k.id === coordArg))
          return bad(`unknown account: ${coordArg}`)
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
      return commit(
        createRun(
          latest,
          {
            objective,
            cwd,
            ...(concurrency !== null ? { concurrency } : {}),
            ...(coordinatorAccountId ? { coordinatorAccountId } : {}),
            // `--auto` 는 값이 없는 플래그다(task-create --review 와 같은 모양). **예약이면 켜지
            // 않는다** — 템플릿은 자신이 돌지 않고, 발화가 만든 자식 Run 이 돈다(그 자식은
            // spawnScheduledRun 이 autoDispatch 를 켠다).
            ...(args.auto === true && schedule === undefined ? { autoDispatch: true } : {}),
            ...(schedule !== undefined ? { schedule } : {}),
            // `--auto` 는 "앱이 돌린다" 이고, 그 시작 시점은 사람이 정한다 — Task 를 하나 만드는
            // 순간 돌기 시작하던 것을 '실행' 버튼 뒤로 미룬다(Run.pendingStart).
            //
            // **예약도 이 게이트를 쓴다.** 템플릿 자신은 돌지 않지만 발화는 시작이고, Task 를 다 짜기
            // 전에 첫 회차가 도는 것은 보통 Run 에서 없앤 바로 그 문제다. 게이트가 걷히는 순간부터
            // 무장하므로(firesDue), '실행' 을 누른 뒤의 첫 예약 시각이 첫 회차가 된다.
            ...(args.auto === true ? { pendingStart: true } : {})
          },
          now
        )
      )
    }
    case 'run-list':
      return okBody(s.runs)
    // 코디네이터가 --validate 에 넣을 id 를 알아야 한다. 상태를 바꾸지 않으므로 COORDINATOR_ONLY
    // 가 아니다 — 워커도 자기가 무엇으로 검증될지 볼 수 있어야 한다.
    case 'run-configs': {
      if (!deps.listRunConfigs) return okBody([])
      const run = latestOrdinaryRun(s)
      if (!run) return bad('no run exists')
      return okBody(await deps.listRunConfigs(run.cwd))
    }
    case 'run-show': {
      const id = str(args.id)
      const run = s.runs.find((r) => r.id === id)
      return run ? okBody(run) : bad(`unknown run: ${String(id)}`)
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
      if (!s.runs.some((r) => r.id === id)) return bad(`unknown run: ${String(id)}`)
      // **템플릿을 지우면 그 회차도 함께 지운다.** 자식만 남기면 정의가 사라진 회차 기록이
      // 프로젝트 목록에 떠돌고, 사이드바에서 접을 부모가 없다. 자식 하나만 지우는 것은 그대로
      // 된다 — 그것은 기록 하나를 버리는 일이고 정의는 템플릿에 있다.
      const run = s.runs.find((r) => r.id === id)
      if (!run) return bad(`unknown run: ${String(id)}`)
      const doomed = new Set([id, ...s.runs.filter((r) => r.templateId === id).map((r) => r.id)])
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
        const target = s.runs.find((r) => r.id === id)
        if (!target?.schedule)
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
        // 순차로 닫는다. releaseWorker 는 세션을 죽이는 부수 효과이고 상태를 쓰지 않는다 — 상태에서
        // 사라지는 것은 아래 deleteRuns 가 한꺼번에 한다.
        for (const d of open) await deps.releaseWorker({ dispatchId: d.id })
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
        const merged = await deps.mergeWorktrees(run.cwd, worktrees)
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
      const before = s.tasks.filter((t) => doomed.has(t.runId)).length
      await deps.setState(deleteRuns(deps.getState(), doomed))
      return okBody({
        deleted: id,
        tasks: before,
        ...(worktreesFailed.length > 0 ? { worktreesFailed } : {})
      })
    }
    // 예약 템플릿의 한 회차를 만든다. **부르는 것은 앱의 ticker 뿐이다**(src/main/ipc.ts) —
    // 코디네이터에게 이 명령을 광고하지 않는다. 그래도 명령으로 두는 이유는 이 파일이 지키는
    // 규율이다: 상태를 쓰는 문은 하나이고, 그 문이 검증·커밋·감사 로그를 함께 지난다.
    // 사람이 '실행' 을 눌렀다. **부르는 것은 UI 뿐이다** — 코디네이터 Run 에는 pendingStart 가
    // 없으므로 이 명령이 할 일도 없다(startRun 이 그때 아무것도 바꾸지 않는다).
    case 'run-start': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      const target = s.runs.find((r) => r.id === id)
      if (!target) return bad(`unknown run: ${id}`)
      const started = startRun(s, id)
      if (!started.ok) return bad(started.error)
      // **코디네이터를 띄울 수 있으면 띄우고, 이 Run 의 운전자를 그에게 넘긴다.** 넘기는 방식이
      // `autoDispatch` 를 끄는 것이다 — 한 Run 에 운전자는 하나이고, 켜 둔 채로 코디네이터를
      // 붙이면 둘이 같은 ready Task 를 두고 경합한다(Run.autoDispatch 의 주석).
      //
      // 계정 지정이 없거나 배선이 이 기능을 주입하지 않으면 옛 동작이다: 앱이 돌리고, 워커의
      // 질문은 앱의 그물이 풀어 준다(core/orchestration/inbox.ts).
      // **예약 템플릿에는 코디네이터를 붙이지 않는다.** 템플릿은 자신이 돌지 않고 발화가 만든
      // 회차가 돈다(Run.schedule) — 붙이면 아무 Task 도 없는 Run 을 관리하는 세션이 떠서 할당량만
      // 쓴다. 회차는 `coordinatorAccountIds` 를 물려받으므로(spawnScheduledRun) 관리자는 그쪽에
      // 붙는다. worker-start 가 템플릿의 Task 를 거절하는 것과 같은 이유다.
      const accountId = target.schedule ? undefined : target.coordinatorAccountId
      if (!accountId || !deps.startCoordinator) return commit(started)
      // **워크트리를 먼저 만든다.** 코디네이터를 띄운 뒤에 만들면 그 세션이 첫 명령을 부르는 사이에
      // 워크트리 없는 Run 을 보게 된다. 실패하면 아래 spawn 실패와 같은 처리다 — 아무것도 바꾸지
      // 않고 거절해서 `pendingStart` 를 남긴다.
      let withWorktree = started.state
      if (!target.worktree && deps.makeRunWorktree) {
        try {
          const created = await deps.makeRunWorktree({
            repoPath: target.cwd,
            name: nameForRun(target)
          })
          const recorded = setRunWorktree(withWorktree, id, created)
          if (!recorded.ok) return bad(recorded.error)
          withWorktree = recorded.state
        } catch (e) {
          return bad(`could not create the run worktree: ${String(e)}`)
        }
      }
      let sessionId: string
      try {
        const spawned = await deps.startCoordinator({
          runId: id,
          cwd: target.cwd,
          accountId,
          brief: buildHandoverPrompt({
            runId: id,
            objective: target.objective,
            concurrency: target.concurrency ?? DEFAULT_CONCURRENCY,
            taskCount: s.tasks.filter((t) => t.runId === id).length
          })
        })
        sessionId = spawned.sessionId
      } catch (e) {
        // **`pendingStart` 를 그대로 둔다.** 걷어 버리면 실행 버튼이 사라져 사람이 다시 누를 수
        // 없고, 운전자도 없는 Run 이 남는다 — 아무것도 돌지 않는데 화면은 시작한 것처럼 보인다.
        // 그래서 이 실패는 상태를 하나도 바꾸지 않는다.
        return bad(`could not start the coordinator: ${String(e)}`)
      }
      // autoDispatch 는 **지운다** — false 로 두면 JSON 비교에서 "없음" 과 다른 값이 되고, 이
      // 코드베이스는 해당 없는 칸을 두지 않는다(startRun 이 pendingStart 를 지우는 것과 같다).
      const handed = withWorktree.runs.map((r) => {
        if (r.id !== id) return r
        const { autoDispatch: _drop, ...rest } = r
        return rest
      })
      return commit(attachCoordinator({ ...withWorktree, runs: handed }, { runId: id, sessionId }))
    }
    case 'run-pause': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      const target = s.runs.find((r) => r.id === id)
      if (!target) return bad(`unknown run: ${id}`)
      // 일시 중지는 예약에만 있다. 보통 Run 에는 멈출 발화가 없고, 그 Run 의 워커를 멈추는 것은
      // worker-stop 이 Dispatch 하나씩 하는 일이다 — 같은 일을 두 이름으로 두지 않는다.
      if (!target.schedule) return conflict(`run ${id} is not scheduled`)
      // 템플릿과 회차 전부. run-delete 의 doomed 와 같은 집합이다 — 일시 중지도 삭제도 "이 예약에
      // 딸린 것 전부" 를 대상으로 하므로 같은 방식으로 모은다.
      const family = new Set([id, ...s.runs.filter((r) => r.templateId === id).map((r) => r.id)])
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
      // 세션을 닫는 것은 부수 효과이고 상태를 쓰지 않는다 — 상태에서 닫히는 것은 아래
      // pauseSchedule 이 한꺼번에 한다(run-delete 가 releaseWorker 를 쓰는 순서와 같다).
      for (const d of open) await deps.releaseWorker({ dispatchId: d.id })
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
      // **"이미 있다" 만 409 로 따로 낸다.** setRunWorktree 도 같은 것을 거절하지만 그 층은 HTTP 를
      // 모르고, commit 은 모든 실패를 400 으로 낸다(위) — 없는 Run 과 두 번 기록하려는 것이 같은
      // 코드로 나오면 로그에서 구별되지 않는다. 뒤쪽은 배선이 워크트리를 **두 개 만들었다**는 뜻이고
      // 그중 하나가 아무도 기억하지 못하는 폴더로 디스크에 남는다.
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
      // 없는 Run 은 400 이다 — 이 파일에 notFound 는 없고 404 는 알 수 없는 명령의 자리다
      // (run-worktree-set 과 같은 이유).
      const run = s.runs.find((r) => r.id === id)
      if (!run) return bad(`unknown run: ${id}`)
      // **run-delete 의 병합과 같은 호출이다.** 대상은 `run.cwd`(프로젝트 폴더)이고 재료는
      // runWorktrees — Run 워크트리와 아직 합쳐지지 않은 Task 워크트리들이 함께 온다. Task 가
      // 하나뿐인 병렬 Run(Run 워크트리는 비고 그 Task 워크트리에만 일이 있다)까지 이 한 호출로
      // 덮이는 것이 `run.worktree` 하나만 합치지 않는 이유다.
      const worktrees = runWorktrees(s, id)
      if (worktrees.length === 0) return okBody({ merged: [] })
      if (!deps.mergeWorktrees) return bad('merging is not available in this build')
      const merged = await deps.mergeWorktrees(run.cwd, worktrees)
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
    case 'run-spawn': {
      const id = str(args.run)
      if (!id) return bad('--run is required')
      return commit(spawnScheduledRun(s, id, now))
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
      const runId = str(args.runId) ?? str(args.run) ?? latestOrdinaryRun(s)?.id
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
      const parsedAccounts = parseAccountList(accountArg, deps.listAccounts(), '--account')
      if (!parsedAccounts.ok) return bad(parsedAccounts.reason)
      const accountIds: string[] = parsedAccounts.ids
      return commit(
        createTask(
          s,
          {
            runId,
            title: str(args.title) ?? spec.split('\n')[0].slice(0, 80),
            spec,
            deps: Array.isArray(args.deps) ? (args.deps as string[]) : [],
            parentId: str(args.parent) ?? undefined,
            ...(accountIds ? { accountIds } : {}),
            validateConfigId: str(args.validate) ?? undefined,
            // `--review` 는 값이 없는 플래그다(task-list --ready 와 같은 모양). 어느 provider 가
            // 읽을지는 앱이 고른다 — 계정 풀을 아는 것은 앱이다.
            reviewRequested: args.review === true ? true : undefined
          },
          now
        )
      )
    }
    case 'task-list': {
      let tasks = s.tasks
      if (str(args.run)) tasks = tasks.filter((t) => t.runId === args.run)
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
      const status = str(args.status)
      if (!id) return bad('--id is required')
      if (!status) return bad('--status is required')
      if (!isTaskStatus(status))
        return bad(`--status must be one of ${TASK_STATUSES.join('|')}`)
      const task = s.tasks.find((t) => t.id === id)
      if (!task) return bad(`unknown task: ${id}`)
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
      const nextTask: Task = {
        ...task,
        status,
        updatedAt: now,
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
      if (!task) return bad(`unknown task: ${taskId}`)
      if (task.status === 'blocked') return bad('task is blocked by an open gate')
      if (task.consecutiveFailures >= FAILURE_LIMIT)
        return bad(`circuit break: ${FAILURE_LIMIT} consecutive failures`)
      const openForTask = s.dispatches.find((d) => d.taskId === taskId && !d.outcome && !d.endedAt)
      if (openForTask) return bad(`dispatch already open: ${openForTask.id}`)

      const run = s.runs.find((r) => r.id === task.runId)
      if (!run) return bad(`unknown run for task: ${taskId}`)
      // **템플릿은 자신의 Task 를 배치하지 않는다.** slotsToFill 이 이미 같은 판단을 하지만 그쪽은
      // 자동 배치 경로뿐이고, 이 명령은 사람과 코디네이터가 직접 부르는 두 번째 문이다. 여기를
      // 열어 두면 템플릿의 Task 가 completed 로 끝나고, 그러면 TTL 정리의 조건(`own.length > 0 &&
      // own.every(terminal)`, store.ts)이 템플릿에서 참이 되어 **30일 뒤 예약과 모든 회차가 조용히
      // 사라진다** — 설계 10절이 일어나지 않는다고 적어 둔 바로 그것이다.
      if (run.schedule)
        return bad(
          `run ${run.id} is a schedule template — it does not dispatch its own Tasks; its executions do`
        )

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
      const limit = run.concurrency ?? DEFAULT_CONCURRENCY
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
      // 코디네이터가 없고, 앱이 언젠가 워크트리를 만들어 준다(runScheduler 가 첫 슬롯을 채우기
      // 직전에) — `run.worktree` 가 아직 없다는 것은 "코디네이터가 원래부터 안 만든다"가 아니라
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
        (run.autoDispatch || run.coordinatorAccountId !== undefined) &&
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
        if (!prev) return bad(`unknown terminal: ${terminal}`)
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
          cwd: run.cwd,
          specPath: '',
          retryOf
        },
        now
      )
      if (!opened.ok) return bad(opened.error)
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
          runCwd: run.cwd,
          worktree,
          name,
          terminal,
          terminalCwd,
          terminalProvider,
          terminalAccountId
        })
      } catch (e) {
        // Failure rollback — this is the server's transaction handling, not a pure-layer transition
        // rule. Calling closeDispatch alone would pin the Task at dispatched forever: there is no
        // blocked entry in ALLOWED.dispatched (core/orchestration/types.ts) so no Gate can catch it
        // either, and dispatched Tasks do not show up in the --ready list — leaving no way to retry.
        // So this removes the dispatch from the array entirely and restores the Task directly to its
        // pre-openDispatch status. It also leaves no bogus status message (recording "ended without
        // reporting" when the session never even existed) — the cause of the failure is carried in
        // the bad(...) of this response.
        const latest = deps.getState()
        await deps.setState({
          ...latest,
          dispatches: latest.dispatches.filter((d) => d.id !== dispatchId),
          tasks: latest.tasks.map((t) =>
            t.id === taskId ? { ...t, status: previousStatus, updatedAt: now } : t
          )
        })
        return bad(`failed to start worker: ${e instanceof Error ? e.message : String(e)}`)
      }

      // Success — read the latest state again and patch this dispatch's placeholders to their real
      // values. The snapshot taken on entry (s) is deliberately not used: while waiting for the
      // coordinator a concurrent change such as another worker's worker_done may have landed on that
      // dispatch, and the patch must not overwrite those fields (outcome, endedAt, workerState) —
      // only the three fields sessionId, cwd and specPath are carried over.
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
      return d ? okBody(d) : bad(`unknown dispatch: ${String(id)}`)
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
      await deps.releaseWorker({ dispatchId: id })
      return okBody(d?.retained === true ? { released: id, skipped: 'retained' } : { released: id })
    }
    case 'worker-retain': {
      const id = str(args.dispatch)
      const d = s.dispatches.find((x) => x.id === id)
      if (!d) return bad(`unknown dispatch: ${String(id)}`)
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
      if (!d) return bad(`unknown dispatch: ${String(id)}`)
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
      await deps.releaseWorker({ dispatchId: d.id })
      await deps.setState({
        ...deps.getState(),
        dispatches: deps
          .getState()
          .dispatches.map((x) =>
            x.id === d.id ? { ...x, workerState: 'stopped' as const, endedAt: now } : x
          )
      })
      return okBody({ stopped: d.id })
    }
    case 'worker-abandon': {
      // Does nothing remote, nothing to any process, nothing on the filesystem.
      // It accepts that the resources may still be live and only gives up tracking them.
      const id = str(args.dispatch)
      const d = s.dispatches.find((x) => x.id === id)
      if (!d) return bad(`unknown dispatch: ${String(id)}`)
      await deps.setState({
        ...s,
        dispatches: s.dispatches.map((x) =>
          x.id === d.id ? { ...x, workerState: 'outcome_unknown' as const, endedAt: now } : x
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
      // success — check falls back to latestOrdinaryRun(s) anyway, so for an ordinary Run the
      // result is the same.
      //
      // **That equivalence stopped being unconditional once schedules existed.** Bind a template
      // or one of its executions and check still resolves to the most recent *ordinary* Run, so
      // the two disagree. Not guarded here because this command already changes nothing; the note
      // is here so the next reader does not carry the old "the result is the same" any further
      // than it now reaches.
      const id = str(args.id)
      if (!s.runs.some((r) => r.id === id)) return bad(`unknown run: ${String(id)}`)
      return okBody({ bound: id })
    }
    case 'send': {
      const type = str(args.type) as MessageType | null
      if (!type) return bad('--type is required')
      if (type === 'worker_done') {
        const taskId = str(args.taskId)
        const dispatchId = str(args.dispatchId)
        const outcome = str(args.outcome)
        if (!taskId || !dispatchId) return bad('--task-id and --dispatch-id are required')
        if (outcome !== 'succeeded' && outcome !== 'failed')
          return bad('--outcome must be succeeded|failed')
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
                    runId: task.runId,
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
          // 진입 스냅숏(s)이 아니라 지금 상태를 읽는다 — 위 탐침의 await 동안 다른 흐름이 커밋했을 수
          // 있고, 낡은 스냅숏으로 부르면 setState 가 그것을 덮어 잃는다(아래 구현 경로와 같은 이유).
          const r = applyReviewResult(
            deps.getState(),
            {
              taskId,
              dispatchId,
              outcome,
              subject: str(args.subject) ?? '',
              body: str(args.body) ?? ''
            },
            now
          )
          if (!r.ok) return bad(r.error)
          await deps.setState(withLimit(r.state))
          // 'alreadyReported' 는 아무것도 닫지 않았다(재전송) — 그때 이미 걷혔다
          if (r.value === 'accepted') dropRollingChain()
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
        if (!result.ok) return bad(result.error)
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
        // 검증이 통과한 뒤 배선의 onSettled 가 같은 일을 한다(ipc.ts).
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
      const runId = task?.runId ?? latestOrdinaryRun(s)?.id
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
      const runId = str(args.run) ?? latestOrdinaryRun(s)?.id
      if (!runId) return bad('no run exists')
      if (str(args.ack)) {
        const acked = ackDelivery(s, { deliveryId: str(args.ack)! }, now)
        if (!acked.ok) return bad(acked.error)
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
      const waited = await pollUntil(take, timeoutMs)
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
        const q = s.messages.find((m) => m.id === questionId)
        if (!q) return bad(`unknown question: ${questionId}`)
        if (q.type !== 'question') return bad(`not a question: ${questionId}`)
        if (isWorker && !myDispatchIds.has(q.dispatchId ?? ''))
          return denied('cannot resume a question for another dispatch')
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
        if (!created.ok) return bad(created.error)
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
      return commit(resolveGate(s, { gateId, resolution }, now))
    }
    case 'gate-list': {
      let gates = s.gates
      if (str(args.task)) gates = gates.filter((g) => g.taskId === args.task)
      if (str(args.status)) gates = gates.filter((g) => g.status === args.status)
      return okBody(gates)
    }
    case 'accounts': {
      const agent = str(args.agent)
      return okBody(deps.listAccounts(agent === 'claude' || agent === 'codex' ? agent : undefined))
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
    default:
      return { status: 404, body: { error: `unknown command: ${cmd}` } }
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
  // 없다. 검토자를 띄운 것은 앱이고 코디네이터에게는 그것을 다시 띄우는 명령이 없으며,
  // reviewing -> dispatched 전이 자체가 없어서 --retry-of 도 거절된다(ALLOWED.reviewing). 그대로 두면
  // Task 는 세션도 Gate 도 없이 영원히 reviewing 이고, recomputeReady 는 completed 에서만 의존
  // Task 를 풀어 주므로 그 아래 서브트리 전체가 pending 에 멈춘다. 가이드 2절의 표가 이 Gate 를
  // 이미 약속하고 있다.
  if (!closed.review || task?.status !== 'reviewing') {
    await deps.setState(r.state)
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

export async function startOrchServer(deps: OrchServerDeps): Promise<OrchServer> {
  const token = randomBytes(32).toString('hex')
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      const buf = Buffer.from(JSON.stringify(body), 'utf8')
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length })
      res.end(buf)
    }
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' })
    const sessionId = String(req.headers['x-astera-session'] ?? '')
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      let payload: { cmd?: string; args?: Record<string, unknown> } = {}
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      } catch {
        return send(400, { error: 'invalid json' })
      }
      if (!payload.cmd) return send(400, { error: 'cmd is required' })
      handleCommand(deps, { sessionId }, payload.cmd, payload.args ?? {})
        .then((r) => send(r.status, r.body))
        .catch((e: unknown) => send(500, { error: String(e) }))
    })
  })
  // Turns a listen failure into a reject. Without an error listener, the 'error' that net.Server
  // emits (EACCES, EADDRNOTAVAIL — genuinely possible with security products that block loopback) is
  // raised as a throw and becomes an uncaught exception in the Electron main process — the caller's
  // .catch() does not catch it (it is not a rejection), and at the same time this Promise stays
  // pending forever so the boot latch never releases.
  // After listen succeeds the reject is removed and replaced with a logging listener: rejecting an
  // already-settled Promise just disappears quietly, and removing the listener entirely would turn
  // a runtime error back into a throw.
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      server.on('error', (e) => deps.log?.(`orch server error: ${String(e)}`))
      resolve()
    })
  })
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0
  return {
    port,
    token,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
