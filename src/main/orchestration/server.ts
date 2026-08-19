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
  nextDelivery,
  openDispatch,
  resolveGate,
  type OrchState,
  type Res
} from '../../core/orchestration/state'
import {
  DEFAULT_ASK_TIMEOUT_MS,
  DEFAULT_CHECK_TIMEOUT_MS,
  FAILURE_LIMIT,
  canTransition,
  recomputeReady,
  type Dispatch,
  type MessageType,
  type Task,
  type TaskStatus
} from '../../core/orchestration/types'
import type { Provider } from '../../core/providers/meta'

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
  /** Copies the current `orchestration.json` to `.bak` right before a destructive operation. The
   *  wiring passes OrchestrationStore.backup. Optional for the same reason as now? and log? — if it
   *  is not injected the backup is skipped (existing tests that do not use the store). */
  backup?(): Promise<void>
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
      const providerArg = str(args.provider)
      if (providerArg !== null && providerArg !== 'claude' && providerArg !== 'codex')
        return bad('--provider must be claude|codex')
      const concurrency = args.concurrency === undefined ? null : posInt(args.concurrency)
      if (args.concurrency !== undefined && concurrency === null)
        return bad('--concurrency must be an integer >= 1')
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
            ...(providerArg ? { provider: providerArg } : {}),
            ...(concurrency !== null ? { concurrency } : {}),
            // `--auto` 는 값이 없는 플래그다(task-create --review 와 같은 모양)
            ...(args.auto === true ? { autoDispatch: true } : {})
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
      const run = s.runs[s.runs.length - 1]
      if (!run) return bad('no run exists')
      return okBody(await deps.listRunConfigs(run.cwd))
    }
    case 'run-show': {
      const id = str(args.id)
      const run = s.runs.find((r) => r.id === id)
      return run ? okBody(run) : bad(`unknown run: ${String(id)}`)
    }
    case 'task-create': {
      const runId = str(args.runId) ?? s.runs[s.runs.length - 1]?.id
      const spec = str(args.spec)
      if (!runId) return bad('--run is required (no run exists)')
      if (!spec) return bad('--spec is required')
      return commit(
        createTask(
          s,
          {
            runId,
            title: str(args.title) ?? spec.split('\n')[0].slice(0, 80),
            spec,
            deps: Array.isArray(args.deps) ? (args.deps as string[]) : [],
            parentId: str(args.parent) ?? undefined,
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
      const worktree = str(args.worktree) ?? 'current'
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
      return okBody({ abandoned: d.id, note: 'resources may still be live' })
    }
    case 'run-use': {
      // Run binding. For now this assumes real use has exactly one Run and is left as a no-op
      // success — check uses "the most recent Run" anyway, so the result is the same.
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
         *  Adds a status message in the same shape as closeDispatch (state.ts:264-284) — section 7 of
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
      const runId = task?.runId ?? s.runs[s.runs.length - 1]?.id
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
      const runId = str(args.run) ?? s.runs[s.runs.length - 1]?.id
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
