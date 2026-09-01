// Gathers transcript/git/session events, calls core's pure functions, and persists the result.
//
// **The boundary is no longer guessed here.** When work starts and ends is declared — the person
// types `/astera-task`, the agent calls `session-task-complete` (lifecycle.ts's `startedTask`/
// `completedTask`/`cancelledTask`/`interruptedTask`) — and this file is only the shell that takes
// that declaration and reflects it into the store. Transition (transition.ts) and provenance
// (provenance.ts) verdicts are still core's pure functions.
//
// **The transcript is still read — just not for the boundary.** Evidence that a session touched a
// file itself (`hasWriteEvidence`, humanRequest.ts) is the one question observation cannot answer
// ("is this change **this** session's?"), so that keeps coming from the transcript. The verdicts
// that used to pick out a human request — `isHumanRequest`, `titleOf`, codex's `task_complete` —
// are gone with this plan, because the `SessionWorkUnit` they used to create is no longer created
// that way.
//
// **감시자를 만들지는 않되 `.git` 감시자의 수명은 이 수집기가 쥔다.** 트랜스크립트 쪽은 ipc.ts 가
// 이미 상시로 들고 있고(HistoryIndex 가 창이 뜬 뒤 한 번 켜져 프로세스가 사는 동안 본다) 그쪽이
// 여기 방아쇠 메서드를 부른다. `.git` 쪽은 그렇지 않았다 — 탐색기 패널의 감시자를 얻어 타고 있었고,
// 그것은 사이드바가 탐색기일 때만 살아 있어 패널을 Jobs 로 바꾸면 수집기가 git 이벤트를 하나도 받지
// 못했다(외부 변경도, 스냅샷 전진도, 새 Unit 의 startHead 도). 그래서 이 수집기가 프로젝트마다
// 하나씩 자기 감시자를 들고 `start()`/`stop()` 에 그 수명을 건다(`syncWatchers`·`closeAll`).
// **만드는 일만 주입받는다**(`deps.watchGit`) — 그래서 이 수집기는 여전히 감시자 없이, 임시 파일과
// 가짜 git 만으로 전부 테스트된다(collector.test.ts).
//
// **No periodic polling.** There are only four triggers — a transcript change, a `.git` change, a
// session going idle, a session exiting — plus the declaration methods (`startTask`/`completeTask`/
// `cancelTask`). (`onSessionForked` and `onSessionBusy` are not a fifth and sixth trigger in the same
// sense — neither reads a transcript or asks git anything on its own. `onSessionBusy` only opens a
// registration. `onSessionForked` usually only sets up a cursor, and when a roll hands it the old
// session's id it also re-keys that session's active unit onto the new one — still not a round, just
// a queued rename ahead of the `onSessionExit` that would otherwise interrupt it.)
import { promises as fs, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ExternalGitChange, GitRef, PendingGitOperation } from '../../core/git/types'
import { classifyTransition } from '../../core/git/transition'
import { isAsteraOperation, OPERATION_GRACE_MS } from '../../core/git/provenance'
import { isSamePath } from '../../core/files/tree'
import type { SessionCheck, SessionWorkUnit } from '../../core/workUnit/types'
import type { OpenSessionTask } from '../../core/types'
import { isOpen } from '../../core/workUnit/status'
import { hasWriteEvidence } from '../../core/workUnit/humanRequest'
import { goalSignalOf, type GoalSignal } from '../../core/workUnit/goalSignal'
import { startedTask, completedTask, cancelledTask, interruptedTask } from '../../core/workUnit/lifecycle'
import { readNewLines } from './tail'
import type { ProjectGitSnapshot, WorkUnitState, WorkUnitStore } from './store'

/** `core/history/index.ts` 와 같은 값이다. 상한이 있는 이유도 그 파일 주석 그대로다 —
 *  *"계속 리셋되기만 하는 디바운스는 세션이 쓰는 동안 영영 발화하지 않는다."* 세션이 트랜스크립트에
 *  계속 덧붙이는 동안 우리도 정확히 그 조건에 놓인다. */
const DEBOUNCE_MS = 150
const MAX_WAIT_MS = 1000

/** 지금 보고 있는 세션 하나. **수집기는 세션을 스스로 찾지 않는다** — 어느 세션이 어느 프로바이더의
 *  어느 파일을 쓰는지는 ipc.ts 만 아는 일이고(claude 는 statusLine 페이로드, codex 는 rollout 경로),
 *  그것을 여기로 끌고 오면 이 파일이 electron 하네스 없이는 테스트되지 않는다. */
export interface CollectorSession {
  sessionId: string
  /** 이 세션의 작업이 속한 프로젝트. V1 은 세션의 cwd 를 그대로 쓴다 (설계 §20) */
  projectPath: string
  /** 아직 모르면 null — 그 세션은 이번 회차에서 건너뛴다 */
  transcriptPath: string | null
  /** `ProviderDescriptor.busyTitleReliable` — false for codex. **Not read anywhere in this file
   *  today.** Idle no longer closes or interrupts a unit at all under this declared boundary —
   *  `onSessionIdle` only closes the busy-git-operation registration (`endBusyOperation`), regardless
   *  of this flag. ipc.ts still computes and passes it per session because the same descriptor value
   *  also drives `busySignalTrusted` (`onSessionBusy`'s own parameter, which *is* read); this field
   *  is carried alongside it rather than singled out at the call site. */
  idleSignalTrusted: boolean
}

/** git 에게 묻는 것. 실행은 main 의 일이고 판정은 core 의 일이라, 이 사이에 경계를 둔다 */
export interface CollectorGit {
  readRef(repoPath: string): Promise<GitRef>
  isAncestor(repoPath: string, before: string | null, after: string | null): Promise<boolean | null>
  /** 작업 트리에서 지금 바뀌어 있는 파일들 (저장소 루트 기준 상대 경로, git 이 찍은 그대로) */
  changedFiles(repoPath: string): Promise<string[]>
  /** before..after 구간의 커밋과 그 구간에서 바뀐 파일들 (gitProbe.ts 의 readRange). **두 HEAD 가
   *  다른 전이에서 부른다.** 돌려받은 셋의 쓰임은 다르다 — 커밋 목록과 author 목록은
   *  fast-forward 에서만 쓰고(그 밖에는 범위를 신뢰할 수 없다, ExternalGitChange.commits 주석),
   *  파일 목록은 두 트리의 비교라 어느 전이에서나 쓴다(gitRound 의 주석).
   *
   *  `authors` 가 선택인 것은 **구현이 그것 없이도 계약을 지키기 때문이다** — 이름은 표시용이고
   *  (EG §7) 판정에 쓰이지 않는다. 실제 구현(gitProbe.readRange)은 늘 준다. */
  readRange(
    repoPath: string,
    before: string,
    after: string
  ): Promise<{ commits: string[]; changedFiles: string[]; authors?: string[] }>
}

export interface CollectorDeps {
  store: WorkUnitStore
  listSessions: () => Promise<CollectorSession[]>
  git: CollectorGit
  /** The current time (ms). **Injected because this collector both stamps time and waits on it** —
   *  a unit's `startedAt`/`endedAt` and an external change's `detectedAt` all come from this value
   *  (via `nowIso`), and the debounce ceiling is measured against it too (`arm`). Injecting the clock
   *  lets a test pin those values to a fixed answer. */
  now: () => number
  /** 지금 열려 있는 등록들 (EG §26) — Astera 자신의 git 동작과 세션이 바쁜 구간, 둘 다다. ipc.ts 는
   *  이 수집기 자신의 `getPendingGitOps()` 를 그대로 넘긴다 — 그 목록은
   *  `beginGitOperation`/`endGitOperation` 이 채운다(ipc.ts 의 job-merge 자리와 `onSessionBusy` 가
   *  부른다). 주입 가능하게 남겨 둔 이유는 테스트가 가짜 목록으로
   *  유예 경계(이 파일의 collector.test.ts)와 판정 자체(provenance.test.ts)를 각각 따로 확인할 수
   *  있게 하기 위해서다. 넘기지 않으면(`undefined`) 빈 목록으로 본다. */
  pendingGitOps?: () => readonly PendingGitOperation[]
  /** 프로젝트 하나의 `.git` 을 보기 시작한다. 돌려주는 함수가 그 감시를 닫고, **`null` 은 볼 것이
   *  없었다는 답이다**(아직 저장소가 아닌 프로젝트) — 그때 수집기는 자리를 잡지 않고 다음 회차에
   *  다시 묻는다.
   *
   *  **만드는 일만 밖에 둔다.** 수명은 이 수집기의 `start()`/`stop()` 이 쥐고(`syncWatchers`·
   *  `closeAll`), 무엇을 볼지도 이 수집기가 정한다(`listSessions()` 가 주는 프로젝트들). 만드는
   *  일까지 여기 두면 이 파일이 chokidar 를 끌고 오고, 그러면 감시자 없이 전부 테스트한다는
   *  이 파일의 전제가 깨진다 — `git`·`now` 를 주입받는 것과 같은 이유다.
   *
   *  넘기지 않으면 감시하지 않는다. 그때 `.git` 방아쇠는 밖에서 오는 `onGitChanged()` 뿐이다. */
  watchGit?: (projectPath: string) => Promise<(() => Promise<void>) | null>
  /** Is this session's work already going to be recorded by a Run? A `/goal` typed inside one is
   *  ignored for the same reason `session-task-*` is refused there (server.ts's
   *  `isWorker || isRunCoordinator`) — the Run records itself. Not passed means "no Run knowledge",
   *  and then nothing is skipped. */
  inRun?: (sessionId: string) => boolean
  /** A goal signal arrived while a unit was already open, so it opened nothing. **The person is
   *  told**: they typed the goal, and silence would read as the feature not working. Nothing is
   *  lost when this fires — the goal still runs and its work still lands on the open unit. */
  onGoalIgnored?: (projectPath: string, objective: string) => void
  /** Unit 이 닫혔다 — 완료·버림·기능 끄기·세션 종료 어느 쪽이든.
   *
   *  **이 수집기는 하류가 무엇을 하는지 모른다.** 설명을 만드는 것은 다음 층의 일이고, 여기서
   *  아는 것은 "이 Unit 이 닫혔다"까지다. 넘기지 않으면 아무 일도 일어나지 않는다 — 그래서
   *  이 파일의 테스트가 하류 없이 그대로 돈다. */
  onUnitClosed?: (projectPath: string, unit: SessionWorkUnit) => void
  /** the open-task section's redraw trigger; the record list has its own in `onUnitClosed` */
  onTasksChanged?: (projectPath: string) => void
  log?: (m: string) => void
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const failed = (e: unknown) => ({ ok: false as const, reason: String(e) })

const emptyState = (): WorkUnitState => ({
  units: [],
  cursors: [],
  externalGitChanges: []
})

/** 저장된 스냅샷을 전이 판정이 다루는 모양으로 (설계 §9 → EG §22). 없으면 `undefined` — 그때가
 *  "처음 보는 프로젝트"이고, 기준선만 잡는 자리다. **`{ branch: null, head: null }` 로 채워 넣지
 *  않는다**: 그것은 "커밋도 브랜치도 없는 저장소"라는 뜻이 있는 값이라, 처음 보는 프로젝트가
 *  브랜치 전환을 한 것으로 잡힌다. */
const snapshotRef = (s: ProjectGitSnapshot | undefined): GitRef | undefined =>
  s === undefined ? undefined : { branch: s.branch, head: s.head }

export class WorkUnitCollector {
  /** 기능이 켜져 있는가. 꺼져 있으면 어떤 방아쇠도 저장소를 건드리지 않는다 */
  private running = false
  /** 커서를 잡았는가 (스펙 §16.1). 잡기 전에는 트랜스크립트를 한 줄도 읽지 않는다 */
  private seeded = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** 디바운스 상한이 만료되는 시각. null 이면 대기 중인 방아쇠가 없다 */
  private ceilingAt: number | null = null
  private pendingGit = false
  /** 회차를 겹치지 않게 한다. FileWatcher·GitWatcher 의 직렬화 고리와 같은 관례 */
  private chain: Promise<void> = Promise.resolve()
  /** 프로젝트마다 "이 실행에서 마지막으로 물어본 git 상태". gitWatcher 의 콜백은 인자가 없으므로
   *  지금 상태는 늘 우리가 직접 물어야 하고, 그 답을 여기 들고 있어 같은 회차 안에서 두 번 묻지
   *  않는다(refOf).
   *
   *  **전이의 "앞"을 대는 자리는 여기가 아니다.** 그 값은 디스크에 남는 스냅샷
   *  (`WorkUnitState.gitSnapshot`, 설계 §9)이고, 이 Map 은 그것이 아직 없을 때만 답한다 —
   *  프로세스와 함께 사라지는 값을 앞으로 쓰면 앱이 꺼져 있던 동안의 변화가 통째로 사라진다. */
  private lastRef = new Map<string, GitRef>()
  /** 마지막 회차에 본 세션들. 종료 이벤트가 왔을 때 그 세션은 이미 목록에서 빠졌을 수 있어서 든다 */
  private known = new Map<string, CollectorSession>()
  /** 이 회차 동안 쓴 적이 있는 프로젝트. 끌 때 닫아야 할 곳을 찾는 데 쓴다 —
   *  `WorkUnitStore` 는 키를 열거하는 길을 주지 않는다 */
  private touched = new Set<string>()
  /** **쓸 커서가 없을 때 0 이 아니라 파일 끝을 잡아야 하는 세션들.** 두 갈래가 여기 든다 —
   *  켤 때 이미 돌던 세션(seed)과 `--resume` 으로 이어받은 세션(onSessionForked). 둘 다 그 파일의
   *  앞부분이 **켜기 전 또는 이 세션 이전의 대화**여서, 0 은 곧 과거 전체다.
   *
   *  켠 뒤에 새로 시작한 세션은 여기 없고, 그래서 지금까지처럼 0 부터 읽힌다 — 그 파일은 켠 뒤에
   *  만들어진 것이므로 처음이 곧 세션의 시작이다(스펙 §16.1 표의 첫 줄).
   *
   *  **디스크에 남기지 않는다.** 이 집합이 말하는 것은 "이번 실행에서 언제 무엇을 보았는가"이고,
   *  다음 실행에는 그 앎이 없다 — 커서를 버리는 것과 같은 이유다(stop 의 주석). */
  private startAtEnd = new Set<string>()
  /** onSessionForked 가 **그 순간** 잡아 둔 자리. 저장소의 커서는 프로젝트별인데 이어받기를
   *  알리는 자리(ipc.ts 의 resume 경로)는 프로젝트를 함께 주지 않으므로, 다음 회차의 tail 이
   *  같은 파일을 보고 있을 때 옮겨 심는다. */
  private forkAnchors = new Map<string, { filePath: string; offset: number }>()
  /** Astera 자신이 지금 돌리고 있는 git 동작들 (EG §26) — `beginGitOperation`/`endGitOperation` 이
   *  채운다. **지우지 않는다** — provenance.ts 의 유예가 끝난 동작을 보고 판단하기 때문이다. 재시작하면
   *  사라지는 메모리 목록이다(디스크에 남기지 않는다 — 동작은 늘 이 실행 안에서 시작하고 끝난다). */
  private pendingOps: PendingGitOperation[] = []
  /** 지금 바쁜 세션마다 그 구간의 등록 id (`onSessionBusy` 가 넣고 `onSessionIdle`·`onSessionExit`
   *  이 닫는다). **`closeAll` 이 비우지 않는다** — 추적을 끄는 사이에 유휴가 와도 그 등록을 찾아
   *  닫을 수 있어야 하고, 그것이 `endGitOperation` 이 토글과 무관하게 항상 닫는 이유와 같다. */
  private busyOps = new Map<string, string>()
  /** 이 수집기가 세워 둔 `.git` 감시자들 — 프로젝트마다 하나이고, 값은 그것을 닫는 함수다.
   *  `syncWatchers` 가 채우고 `closeAll` 이 비운다. */
  private gitWatches = new Map<string, () => Promise<void>>()
  /** Goal boundaries seen during a round, applied after it. **Never applied inside one** —
   *  `startTask`/`completeTask` enqueue onto the same serial chain the round occupies, so awaiting
   *  one from the per-line loop would wait on a link that cannot run yet. */
  private pendingGoals: { sessionId: string; signal: GoalSignal }[] = []
  /** Per session, the id and objective of the unit **a goal opened**. Three jobs: the objective
   *  makes a repeated codex `active` record idempotent (it re-sends one per status change, and also
   *  every turn boundary, whether or not the unit it names is still open — the entry survives the
   *  unit closing for exactly this reason, spec §4); the id is what the close path matches against —
   *  two units can carry the same objective text (a pasted sentence typed into both `/goal` and
   *  `/astera-task`), and only the id says which one is the goal's, so a goal's end can never close
   *  an `/astera-task` unit that merely repeats its words; and its absence is how we know there is
   *  nothing to close. Moved onto the new session id by `reKeyRolledUnit` — a goal outlives a
   *  usage-limit roll the same way its unit does. */
  private goalUnits = new Map<string, { id: string; objective: string }>()
  /** Per session, the objective last handed to `onGoalIgnored`. Codex re-sends `thread_goal_updated`
   *  with `status: "active"` on every turn boundary, not only when the goal itself changes — without
   *  this, a goal blocked behind an already-open unit would toast the same notice on every turn while
   *  the block persists (final review, item 4). Retrying the goal itself is unaffected: this only
   *  gates the notice, never the retry, and the retry is what lets the goal open its own unit the
   *  moment the block clears. Cleared once that retry succeeds — a fresh block afterwards, even with
   *  the same objective text, is a new occurrence and earns its own notice. */
  private goalIgnoredNotices = new Map<string, string>()

  constructor(private deps: CollectorDeps) {}

  // ── 생명주기 ────────────────────────────────────────────────────────

  /** 켠다. **켠 순간의 파일 끝을 커서로 잡는다** — 그 앞의 대화는 한 줄도 읽지 않는다 (스펙 §16.1) */
  async start(): Promise<void> {
    if (this.running) return
    this.running = true
    this.seeded = false
    return this.enqueue(async () => {
      if (!this.running) return // 켜자마자 다시 껐다
      // **이 셋을 동기적으로 비우지 않는다.** 껐다 곧바로 켜면 아직 돌지 않은 closeAll 이 큐에 남아
      // 있고, 그것이 닫아야 할 프로젝트를 찾는 유일한 길이 이 둘이다 — 먼저 비우면 열려 있던 Unit 이
      // 닫히지 않은 채 남는다.
      //
      // **비우는 것은 이 실행의 캐시뿐이고 저장된 스냅샷은 그대로 둔다.** 다음 회차의 gitRound 가
      // 그것을 앞으로 읽어(프로젝트마다 저장 파일에서 온다) 꺼져 있던 동안의 변화를 판정한다 —
      // 여기서 프로젝트를 훑어 미리 넣지 않는 이유는 `WorkUnitStore` 가 키를 열거하는 길을 주지
      // 않기 때문이다(closeAll 이 `touched` 를 드는 것과 같은 제약).
      this.lastRef.clear()
      this.known.clear()
      this.touched.clear()
      await this.seed()
    })
  }

  /** Turns off. Any open unit is put into interrupted right there, and **the cursor is
   *  discarded** — carrying it over would mean everything written while tracking was off gets
   *  read in full the next time it turns on, which spec §16.1 forbids. */
  async stop(): Promise<void> {
    if (!this.running) return
    this.running = false
    this.disarm()
    this.pendingGit = false
    this.seeded = false
    return this.enqueue(() => this.closeAll())
  }

  onEnabledChanged(enabled: boolean): Promise<void> {
    return enabled ? this.start() : this.stop()
  }

  // ── Declarations ────────────────────────────────────────────────────

  /** The same queue, with an answer. `enqueue` above logs and swallows — right for a background
   *  round, wrong for a declaration the agent is waiting on. `chain` stays `Promise<void>`, so the
   *  result is mapped away before it is stored. */
  private enqueueFor<T>(fn: () => Promise<T>, onError: (e: unknown) => T): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        return await fn()
      } catch (e) {
        this.log(String(e))
        return onError(e)
      }
    }
    const p = this.chain.then(run, run)
    this.chain = p.then(
      () => undefined,
      () => undefined
    )
    return p
  }

  /** Catch up every known session's transcript before a path that might end a unit — completing
   *  it, or interrupting it to make room for a new one. `sawWrite` freezes the instant a unit
   *  leaves `active` (`isOpen` excludes everything else from `tail`'s write-evidence branch), so a
   *  line that already sits in the transcript but has not been read yet would otherwise land on
   *  whatever unit opens *next* — or on nothing at all — instead of the one that actually made it,
   *  and `finish` drops a unit closed with no write evidence at all. Cancelling never calls this:
   *  nothing is recorded either way, so catching up buys nothing.
   *
   *  **Not usable from `closeAll`.** `stop()` sets `seeded = false` before enqueuing `closeAll`, so
   *  `round()` would seed here — jumping every cursor to the file's current end — instead of
   *  tailing, discarding exactly the lines this exists to read. `closeAll` tails each known
   *  session directly instead; see its own comment. */
  private async catchUpTranscripts(): Promise<void> {
    await this.round(false)
  }

  /** The person typed /astera-task and the agent relayed it. **An active task is interrupted, not
   *  closed** — the person may still want it, and the screen is where they say so. */
  startTask(
    sessionId: string,
    objective: string
  ): Promise<{ ok: true; id: string; interruptedId?: string } | { ok: false; reason: string }> {
    return this.enqueueFor(() => this.startTaskCore(sessionId, objective), failed)
  }

  /** The atomic body of `startTask`. Factored out so the goal path (`applyGoalSignal`) can put its
   *  own "is a unit already open?" read and this mutation inside **one** enqueued link — reading
   *  that check outside `enqueueFor` and only mutating through it left a window for the person's
   *  own `/astera-task` to land in between, which a goal must never win against. Called directly
   *  (never through another `enqueueFor`) by both callers: the public `startTask` above already
   *  supplies the link, and calling `enqueueFor` again from inside one already running on the same
   *  chain would deadlock. */
  private async startTaskCore(
    sessionId: string,
    objective: string
  ): Promise<{ ok: true; id: string; interruptedId?: string } | { ok: false; reason: string }> {
    if (!this.running) return { ok: false as const, reason: 'work unit tracking is off' }
    const s = this.known.get(sessionId)
    if (!s) return { ok: false as const, reason: `unknown session: ${sessionId}` }
    if (objective.trim() === '') return { ok: false as const, reason: 'an objective is required' }
    // Catch up before possibly interrupting whatever is open — see catchUpTranscripts. It must
    // run while the previous unit is still active, because that is the only status tail's
    // write-evidence branch reads.
    await this.catchUpTranscripts()
    const state = this.stateOf(s.projectPath)
    const at = this.nowIso()
    let interruptedId: string | undefined
    const open = state.units.find((u) => u.sessionId === sessionId && u.status === 'active')
    if (open) {
      // A live look before the transition — see observe's own doc for why all three interrupt
      // paths (this one, onSessionExit, closeAll) take one at exactly this moment.
      this.observe(state, s.projectPath, await this.changedFiles(s.projectPath))
      const i = state.units.indexOf(open)
      state.units[i] = interruptedTask(open, { at, reason: 'INTERRUPTED_BY_NEW_TASK' })
      interruptedId = open.id
    }
    const head = (await this.refOf(s.projectPath)).head
    state.units.push(
      startedTask({
        id: randomUUID(),
        sessionId,
        projectPath: s.projectPath,
        objective,
        at,
        startHead: head,
        baselineDirtyFiles: await this.changedFiles(s.projectPath)
      })
    )
    const id = state.units[state.units.length - 1].id
    await this.persist(s.projectPath, state)
    this.deps.onTasksChanged?.(s.projectPath)
    return { ok: true as const, id, interruptedId }
  }

  /** The agent said it is done. **Never creates anything** — a completion that could bring a task
   *  into being would infer the start from the end, which is the bug this plan removes. */
  completeTask(
    sessionId: string,
    input: { source: 'agent' | 'user'; checks?: SessionCheck[]; summary?: string }
  ): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    return this.enqueueFor(() => this.completeTaskCore(sessionId, input), failed)
  }

  /** The atomic body of `completeTask` — split out for the same reason as `startTaskCore`: the
   *  goal path (`applyGoalSignal`) needs its own id check and this mutation inside one enqueued
   *  link, and `completeTask` itself enqueues, so calling it from inside a link already on the
   *  chain would deadlock. */
  private async completeTaskCore(
    sessionId: string,
    input: { source: 'agent' | 'user'; checks?: SessionCheck[]; summary?: string }
  ): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    if (!this.running) return { ok: false as const, reason: 'work unit tracking is off' }
    const s = this.known.get(sessionId)
    if (!s) return { ok: false as const, reason: `unknown session: ${sessionId}` }
    // Catch up first, then read — see catchUpTranscripts. `round` writes into the live state
    // object, so a unit read before it can be stale by the time it is closed.
    await this.catchUpTranscripts()
    const state = this.stateOf(s.projectPath)
    const open = state.units.find((u) => u.sessionId === sessionId && u.status === 'active')
    if (!open) return { ok: false as const, reason: 'NO_ACTIVE_TASK' }
    this.observe(state, s.projectPath, await this.changedFiles(s.projectPath))
    this.finish(state, open, completedTask(open, { ...input, at: this.nowIso() }), s.projectPath)
    await this.persist(s.projectPath, state)
    this.deps.onTasksChanged?.(s.projectPath)
    return { ok: true as const, id: open.id }
  }

  /** The person pressed 완료 on a row. Reaches interrupted tasks too, which is the whole reason
   *  that state exists.
   *
   *  **`recorded` answers what the button press actually did.** `finish` silently drops a unit with
   *  no write evidence or no changed files (spec §12) — from the row's point of view that means
   *  pressing 완료 makes it vanish with no explanation, which reads as a bug rather than the correct
   *  "there was nothing here to record". Reported here, not swallowed, so the renderer can say so
   *  (App.tsx's `completeOpenTask`, `hiw.open.completeEmpty`). */
  completeTaskById(
    projectPath: string,
    unitId: string
  ): Promise<{ ok: true; recorded: boolean } | { ok: false; reason: string }> {
    return this.enqueueFor(async () => {
      // Catch up first — see catchUpTranscripts. Only matters while `u` is still `active`
      // (already-`interrupted` units cannot gain new evidence, whatever runs here), but this is
      // the path that completes a still-active unit directly from the screen, so the race applies
      // just the same as it does to `completeTask`.
      if (this.running) await this.catchUpTranscripts()
      const state = this.deps.store.get(projectPath)
      const u = state?.units.find((x) => x.id === unitId)
      if (!state || !u) return { ok: false as const, reason: `unknown task: ${unitId}` }
      if (u.status !== 'active' && u.status !== 'interrupted')
        return { ok: false as const, reason: `task is ${u.status}` }
      if (this.running) this.observe(state, projectPath, await this.changedFiles(projectPath))
      const recorded = this.finish(
        state,
        u,
        completedTask(u, { source: 'user', at: this.nowIso() }),
        projectPath
      )
      await this.persist(projectPath, state)
      this.deps.onTasksChanged?.(projectPath)
      return { ok: true as const, recorded }
    }, failed)
  }

  /** No catch-up here, deliberately: a cancelled unit is never handed to `finish`, and nothing is
   *  recorded either way, so reading one more pending transcript line first would buy nothing. */
  cancelTask(
    sessionId: string,
    reason?: string
  ): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    return this.enqueueFor(async () => {
      if (!this.running) return { ok: false as const, reason: 'work unit tracking is off' }
      const s = this.known.get(sessionId)
      if (!s) return { ok: false as const, reason: `unknown session: ${sessionId}` }
      const state = this.stateOf(s.projectPath)
      const open = state.units.find((u) => u.sessionId === sessionId && u.status === 'active')
      if (!open) return { ok: false as const, reason: 'NO_ACTIVE_TASK' }
      const i = state.units.indexOf(open)
      state.units[i] = cancelledTask(open, { at: this.nowIso(), reason })
      await this.persist(s.projectPath, state)
      this.deps.onTasksChanged?.(s.projectPath)
      return { ok: true as const, id: open.id }
    }, failed)
  }

  /** Same as `cancelTask`: no catch-up, because nothing here is ever recorded. */
  cancelTaskById(
    projectPath: string,
    unitId: string
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    return this.enqueueFor(async () => {
      const state = this.deps.store.get(projectPath)
      const u = state?.units.find((x) => x.id === unitId)
      if (!state || !u) return { ok: false as const, reason: `unknown task: ${unitId}` }
      if (u.status !== 'active' && u.status !== 'interrupted')
        return { ok: false as const, reason: `task is ${u.status}` }
      state.units[state.units.indexOf(u)] = cancelledTask(u, { at: this.nowIso() })
      await this.persist(projectPath, state)
      this.deps.onTasksChanged?.(projectPath)
      return { ok: true as const }
    }, failed)
  }

  /** What the screen shows above the record list. Synchronous and off the queue: it only reads,
   *  and the screen asks for it on every push.
   *
   *  **Newest first.** `state.units` is store order (oldest first — new units are pushed onto the
   *  end), which is the opposite of what this method's own contract promises. Sorted by `startedAt`
   *  here rather than left to the renderer, because the renderer splits this into two sections
   *  (active, interrupted — UnderstandingView.tsx) and a single sort before the split is enough:
   *  filtering by status preserves relative order, so each section comes out newest-first too. */
  listOpen(projectPath: string): OpenSessionTask[] {
    const state = this.deps.store.get(projectPath)
    if (!state) return []
    return state.units
      .filter((u) => u.status === 'active' || u.status === 'interrupted')
      .map((u) => ({
        id: u.id,
        objective: u.objective,
        status: u.status as 'active' | 'interrupted',
        startedAt: u.startedAt,
        endedAt: u.endedAt,
        reason: u.reason,
        sessionId: u.sessionId
      }))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  // ── Astera 자신의 git 동작 등록 (EG §26) ───────────────────────────────

  /** "이 이동은 이 앱 안에서 벌어진 일이다"라고 말할 구간 하나를 등록한다. 부르는 자리가 둘이다 —
   *  Astera 자신의 git 조작을 시작하기 **직전에**(ipc.ts 의 job-merge 자리)와, 세션이 바빠진
   *  순간(`onSessionBusy`). `startedAt` 은 주입된 시각(deps.now)을 쓴다. **꺼져 있으면 아무 일도 하지 않는다** — 부르는
   *  쪽이 토글을 신경 쓰지 않아도 된다(`endGitOperation` 이 토글과 무관하게 항상 닫는 것으로 그 몫까지
   *  진다 — 아래 주석).
   *
   *  새로 넣기 전에 **유예가 지나 이미 끝난** 동작을 먼저 치운다. 지우지 않으면 Job 병합마다
   *  기록이 하나씩 쌓여 이 프로세스가 사는 동안 매 git 회차마다 다시 훑게 된다. **끝나지 않은
   *  동작은 절대 건드리지 않는다** — 오래 걸리는 병합을 유예로 착각해 지우면 그 동작이 도중에
   *  외부로 오판된다(끝나지 않은 것을 헤아리는 판단은 `isAsteraOperation` 하나로 남긴다). */
  beginGitOperation(kind: PendingGitOperation['kind'], projectPath: string): string {
    if (!this.running) return ''
    const now = this.deps.now()
    this.pendingOps = this.pendingOps.filter((o) => {
      if (o.endedAt === undefined) return true
      const ended = Date.parse(o.endedAt)
      return Number.isFinite(ended) && now - ended <= OPERATION_GRACE_MS
    })
    const id = randomUUID()
    this.pendingOps.push({ id, kind, projectPath, startedAt: this.nowIso() })
    return id
  }

  /** 그 동작이 끝났다(성공이든 실패든). **지우지 않는다** — `isAsteraOperation`(provenance.ts)의
   *  유예가 끝난 동작을 보고 판단하기 때문이다.
   *
   *  **꺼져 있어도 닫는다.** `beginGitOperation` 과 달리 여기에 `!running` 가드를 두면, 추적을
   *  끈 사이에 `endGitOperation` 이 불려도 아무 일도 하지 않고 `endedAt` 이 영영 비게 된다 —
   *  `isAsteraOperation` 은 `endedAt` 이 없는 동작을 "아직 도는 중"으로 읽으므로, 그 프로젝트의
   *  **모든** 외부 변경이 그때부터 조용히 Astera 것으로 삼켜진다(브리핑이 말한, 지어낸 외부 기록
   *  하나보다 훨씬 나쁜 실패). 꺼진 채로 `endedAt` 만 적는 것은 해가 없다 — 다음에 켜졌을 때
   *  `isAsteraOperation` 이 유예를 그대로 적용해 판단한다. */
  endGitOperation(id: string): void {
    const op = this.pendingOps.find((o) => o.id === id)
    if (op) op.endedAt = this.nowIso()
  }

  /** ipc.ts 가 `pendingGitOps` 로 그대로 넘기는 값 — 이 수집기 자신이 등록한 동작들 */
  getPendingGitOps(): readonly PendingGitOperation[] {
    return this.pendingOps
  }

  // ── 방아쇠 ──────────────────────────────────────────────────────────

  /** 트랜스크립트가 바뀌었다. 세션이 쓰는 동안 계속 오므로 디바운스한다 */
  onTranscriptChanged(): void {
    this.arm()
  }

  /** `.git` 의 index 나 HEAD 가 바뀌었다. **무엇이 바뀌었는지는 오지 않는다** — 저장소 상태는
   *  다음 회차가 직접 읽는다 (gitWatcher 의 emit 은 인자가 없는 콜백이다) */
  onGitChanged(): void {
    this.pendingGit = true
    this.arm()
  }

  /** 에이전트가 한 턴을 시작했다 (session:busy → true). **그 구간을 등록 목록에 넣는다.**
   *
   *  **왜 이것이 필요한가.** 원장(`pendingOps`)에는 Astera 가 직접 돌린 git 동작만 들어 있었다.
   *  그런데 `.git` 감시자는 애초에 **에이전트가** 세션 터미널에서 친 커밋을 보라고 만든 것이고
   *  (ipc.ts 의 그 감시자 주석), 그 커밋은 Astera 가 돌린 것이 아니라 등록될 자리가 없었다. 그래서
   *  세션 자신의 커밋이 외부 변경으로 기록되고, 그 id 가 방금 그 커밋을 만든 Unit 에 "겪은 것"으로
   *  달렸다 — 다음 계획이 그 집합을 Unit 의 성과에서 빼도록 명세돼 있으므로, 그대로 두면 그 Unit 이
   *  실제로 한 일이 지워진다.
   *
   *  **새 감지를 만들지 않는다.** 커밋을 미리 등록할 수는 없다 — Astera 가 돌리는 것이 아니다.
   *  대신 앱이 이미 아는 신호를 쓴다: `session:busy` 다. 설계 §6 이 그것을 완료 신호로 이미 신뢰하고,
   *  ipc.ts 가 이미 수집기에 전달한다. **어떤 프로젝트에서 HEAD 가 움직였는데 그 프로젝트의 세션이
   *  방금까지 바쁜 상태였다면 그 이동은 그 세션의 것이다.**
   *
   *  **`PendingGitOperation` 으로 만들어 같은 목록에 넣는다.** `kind` 의 `'commit'` 은 이 브랜치
   *  내내 아무도 만들지 않는 값이었다 — 그 이름이 있던 이유가 이것이다. 판정도 유예도
   *  `isAsteraOperation` 하나를 그대로 쓴다: 바쁜 구간은 "아직 도는 중"(endedAt 없음)이고, 끝난
   *  구간은 `OPERATION_GRACE_MS` 만큼 더 그 세션의 것이다. 유예가 같은 폭인 이유도 같다 —
   *  감시자의 awaitWriteFinish 와 이 파일의 디바운스 때문에 `.git` 회차는 busy → false 보다 **뒤에**
   *  오고, 그 순서 역전이 유예 없이는 전부 오판된다.
   *
   *  **틀리는 방향을 골랐다.** 에이전트가 일하는 동안 들어온 **진짜** 외부 pull 은 이 규칙이
   *  놓친다. 반대(자기 커밋을 남의 것으로 기록)보다 낫다 — 놓친 외부 기록은 줄 하나지만, 잘못 붙은
   *  기록은 다음 계획이 그 Unit 의 성과를 지우게 만든다.
   *
   *  **믿을 수 없는 신호로는 등록하지 않는다** (`busySignalTrusted`, 곧
   *  `ProviderDescriptor.busyTitleReliable`). codex 의 창 제목은 장식이라 스피너가 초당 열 프레임쯤
   *  흐르고 턴이 끝난 뒤에도 계속 흐르며, codex 가 띄운 자식 프로세스가 그것을 덮어쓴다. 그 신호를
   *  그대로 믿으면 rising edge 가 유예보다 빨리 오므로 **그 프로젝트는 세션이 사는 동안 영구 사면**
   *  이 되고, 마지막에 찍힌 것이 스피너면 등록이 닫히지도 않는다. `externalGitChanges` 는 프로젝트
   *  단위라 피해가 그 세션에 머물지도 않는다 — 같은 cwd 의 claude 세션이 겪은 기록까지 사라진다.
   *  이것은 위에서 고른 "놓치는 쪽"이 아니라 `endGitOperation` 이 "훨씬 나쁜 실패"라고 부른 쪽이다.
   *
   *  **`projectPath` 도 `busySignalTrusted` 도 인자로 받는다.** 둘 다 이 수집기가 스스로 알 수 없다:
   *  `known` 은 회차가 돌아야 채워지는데 세션의 첫 턴은 그 회차보다 먼저 온다. 세션 → 계정 →
   *  descriptor 를 찾을 수 있는 쪽(ipc.ts, `orchIsBusy` 가 같은 값을 같은 방식으로 읽는 자리)이
   *  판정해서 준다. */
  onSessionBusy(sessionId: string, projectPath: string, busySignalTrusted: boolean): void {
    if (!busySignalTrusted) return
    if (this.busyOps.has(sessionId)) return // 이미 열려 있다 — 같은 구간을 두 번 등록하지 않는다
    const id = this.beginGitOperation('commit', projectPath)
    if (id !== '') this.busyOps.set(sessionId, id) // 꺼져 있으면 '' 이고, 그때는 들 것이 없다
  }

  /** 그 세션의 바쁜 구간을 닫는다. **유휴와 종료 둘 다에서 부른다** — 바쁜 채로 죽은 세션은 유휴
   *  신호를 영영 보내지 않고, 끝나지 않은 등록 하나가 그 프로젝트의 **모든** 외부 변경을 조용히
   *  삼킨다(`endGitOperation` 의 주석이 적은, 지어낸 기록 하나보다 훨씬 나쁜 실패). */
  private endBusyOperation(sessionId: string): void {
    const id = this.busyOps.get(sessionId)
    if (id === undefined) return
    this.busyOps.delete(sessionId)
    this.endGitOperation(id)
  }

  /** The agent finished a turn (session:busy → false). **Only the git-operation registration
   *  closes here now** — a turn ending says nothing about whether the work is done, and that was
   *  the inference this plan removes. */
  onSessionIdle(sessionId: string): Promise<void> {
    this.endBusyOperation(sessionId)
    return Promise.resolve()
  }

  /** A session was continued — either rolled after a usage limit (rolling.ts) or reopened by the
   *  person from a past record (ipc.ts's resume path).
   *
   *  **Why the file end.** `--resume` rewrites the whole prior conversation, and the replayed
   *  requests still carry `promptSource`, so they pass the human-request check same as a fresh one.
   *  The collector has never seen this session id, so it has no cursor, and reading from 0 on that
   *  alone would turn the pre-fork conversation into a unit and read the post-fork part twice. The
   *  file's end is the one point that skips exactly the replay — the cost is possibly missing one
   *  resume-briefing line, the benefit is keeping "the conversation before turning tracking on is
   *  never read" (spec §16.1).
   *
   *  **Callers do not need to check the toggle.** Off, this does nothing — `start` re-anchors every
   *  cursor at the file end anyway, so there is nothing to leave behind here.
   *
   *  **Why `transcriptPath` is optional: the two callers know different things.**
   *    - History resume (ipc.ts) already has the file it just copied the conversation into — it
   *      hands that path straight over.
   *    - A usage-limit roll (index.ts's `session:rolled` tap) only carries the new session id; on
   *      claude, nobody knows yet which file that session will write to (the statusline has not
   *      arrived). Rather than guess, only the id goes into the set above, and the round that first
   *      sees this session anchors it at that file's end then (`anchorFor`). What is lost is at most
   *      the couple of lines written in between; what is prevented is reading the whole replayed
   *      conversation.
   *
   *  The size is read synchronously because "the moment" only means anything if it is the size
   *  *before* `--resume` starts rewriting — one file stat, once per fork.
   *
   *  **`oldSessionId` re-keys an in-flight unit — but only for a roll.** Passed by the two rolling
   *  taps (index.ts's `session:rolled` handlers), never by history resume. Spec's "Never" list is
   *  explicit: *"A usage limit is not a completion. A rolling session that pauses at 100% and
   *  resumes later is still inside the same `active` session task."* The unit the killed session
   *  left `active` has to survive under the id the resumed process gets, or the exit that follows
   *  finds it and interrupts it for no reason the person would recognize. History resume is not
   *  that case — it reopens a conversation the person picked from the sidebar, one that has usually
   *  already ended, and reviving an interrupted unit as `active` under a session nobody typed
   *  `/astera-task` on would invent a continuation. So history resume never passes this argument,
   *  and nothing here moves unless a roll hands one over.
   *
   *  **The ordering this relies on:** `rolling.ts`'s `roll()` calls `kill(old)` then `spawn(new)`
   *  then `send('session:rolled', ...)` with no `await` in between (its own comment notes the old
   *  session's exit event may arrive later, "even if... under the old key"). A PTY's exit is
   *  inherently asynchronous — Node cannot deliver it in the middle of that synchronous run — so this
   *  notification always reaches the collector before `onSessionExit(old)` does. Re-keying here first
   *  means that later exit finds no active unit left under the old id to interrupt. */
  onSessionForked(newSessionId: string, transcriptPath?: string, oldSessionId?: string): void {
    if (!this.running) return
    // **Added to the set first.** This is what a missing or wrong path falls back on — without this
    // line, both fall to 0 instead.
    this.startAtEnd.add(newSessionId)
    if (transcriptPath !== undefined) {
      try {
        const size = statSync(transcriptPath).size
        this.forkAnchors.set(newSessionId, { filePath: transcriptPath, offset: size })
      } catch {
        // Not there yet — if this session ends up writing a brand-new file, its start really is this
        // session's start. Still left in the set above: if it instead ends up on a *different* file
        // (the replayed one), that has to be read from its end.
      }
    }
    if (oldSessionId !== undefined) void this.enqueue(() => this.reKeyRolledUnit(oldSessionId, newSessionId))
  }

  /** The re-keying half of `onSessionForked` — moves a roll's active unit onto the new session id.
   *  Queued rather than run inline: `onSessionExit(old)` is queued too (its own call below), and
   *  `enqueue`'s FIFO ordering is what guarantees this lands first, before that exit reads the same
   *  state and finds nothing under the old id.
   *
   *  **Catches up the old session's transcript before renaming.** `tail`'s write-evidence branch
   *  matches on `sessionId`; once the unit's `sessionId` is the new one, a write-evidence line still
   *  sitting unread in the *old* transcript would never be attributed to anything again. Reading it
   *  first is the same reasoning as `catchUpTranscripts`, aimed at a session about to disappear
   *  instead of one about to open a new unit.
   *
   *  **Does nothing if the old session is not `known`.** That should not happen for a roll — the
   *  unit being moved could only exist because `startTask` found this session in `known` in the
   *  first place — but if it ever does, guessing a project would be worse than leaving today's
   *  behavior (the exit interrupts the unit) in place. */
  private async reKeyRolledUnit(oldSessionId: string, newSessionId: string): Promise<void> {
    const old = this.known.get(oldSessionId)
    if (!old) return
    const state = this.stateOf(old.projectPath)
    await this.tail(state, old)
    const u = state.units.find((x) => x.sessionId === oldSessionId && x.status === 'active')
    if (!u) return
    u.sessionId = newSessionId
    // A goal's unit survives the roll under the new id too, so its bookkeeping moves with it —
    // otherwise the goal's own end never finds this unit again (it is on the `usageLimited` ignore
    // list precisely because a goal outlives a roll), and a re-sent `active` afterwards reads as a
    // second goal opened on top of the first, wrongly.
    const goal = this.goalUnits.get(oldSessionId)
    if (goal) {
      this.goalUnits.delete(oldSessionId)
      this.goalUnits.set(newSessionId, goal)
    }
    await this.persist(old.projectPath, state)
    this.deps.onTasksChanged?.(old.projectPath)
  }

  /** A session exited. Any open unit becomes **interrupted**, not completed — it stays that way
   *  until the person closes it from the screen. */
  onSessionExit(sessionId: string): Promise<void> {
    this.endBusyOperation(sessionId) // 바쁜 채로 죽었을 수 있다 — 유휴와 같은 자리, 같은 이유다
    return this.enqueue(async () => {
      if (!this.running) return
      await this.round(false)
      const s = this.known.get(sessionId)
      if (!s) return
      const state = this.stateOf(s.projectPath)
      // 끝난 세션은 listSessions 에서 이미 빠져 있어 위 회차가 읽지 않는다. 종료 직전에 온 요청도
      // 그 세션의 것이므로, 이 하나만 따로 마지막까지 읽는다
      let dirty = await this.tail(state, s)
      const open = state.units.filter((u) => u.sessionId === sessionId && u.status === 'active')
      if (open.length > 0) {
        this.observe(state, s.projectPath, await this.changedFiles(s.projectPath))
        const at = this.nowIso()
        for (const u of open)
          state.units[state.units.indexOf(u)] = interruptedTask(u, {
            at,
            reason: 'INTERRUPTED_BY_SESSION_END'
          })
        dirty = true
        this.deps.onTasksChanged?.(s.projectPath)
      }
      // 죽은 세션의 커서는 더 자랄 파일을 가리키지 않는다
      const cursorCount = state.cursors.length
      state.cursors = state.cursors.filter((c) => c.sessionId !== sessionId)
      if (cursorCount !== state.cursors.length) dirty = true
      this.known.delete(sessionId)
      // 커서와 같은 이유로 함께 지운다 — 이 둘도 "그 세션을 어디서부터 읽을 것인가"의 답이고,
      // 끝난 세션에는 그 물음이 없다
      this.startAtEnd.delete(sessionId)
      this.forkAnchors.delete(sessionId)
      if (dirty) await this.persist(s.projectPath, state)
    })
  }

  /** 한 회차를 지금 돌린다. **디바운스를 거치지 않는 유일한 길**이다 — 대기 중인 타이머는 취소한다.
   *  테스트가 150ms 를 기다리지 않고 확인할 수 있는 것이 이 메서드 덕분이다. */
  flush(): Promise<void> {
    const round = this.enqueue(async () => {
      this.disarm()
      if (!this.running) return
      const wantGit = this.pendingGit
      this.pendingGit = false
      await this.round(wantGit)
    })
    // **After the round, not in it.** Each call below enqueues its own link, which can only run
    // once the round's link is done — so this must not be awaited from inside that link.
    return round.then(() => this.applyGoalSignals())
  }

  /** Turn the boundaries this round saw into declarations. Runs outside the round's own link. */
  private async applyGoalSignals(): Promise<void> {
    const pending = this.pendingGoals
    this.pendingGoals = []
    if (!this.running) return
    for (const { sessionId, signal } of pending) {
      try {
        await this.applyGoalSignal(sessionId, signal)
      } catch (e) {
        // A signal's own attempt, or a host callback it calls (`inRun`, `onGoalIgnored` — a later
        // task backs both with ipc.ts code that can throw, e.g. sending on a destroyed window),
        // failed. Logged and swallowed, the same as `enqueue`'s own run: one bad signal must not
        // stop the rest from being applied, and this method must never reject — `flush()` chains it
        // onto its own return value with no `.catch` of its own.
        this.log(String(e))
      }
    }
  }

  /** One boundary, applied. **The "is a unit already open?" read and the mutation it gates share a
   *  single enqueued link** (`startTaskCore`/`completeTaskCore`) — reading that check outside
   *  `enqueueFor` and only mutating through it would let the person's own `/astera-task` land in
   *  between the two, which is exactly the race a goal must never win. */
  private async applyGoalSignal(sessionId: string, signal: GoalSignal): Promise<void> {
    const s = this.known.get(sessionId)
    if (!s) return
    // A Run records itself (spec §5.4). No notice: an agent inside the Run typed this, not a person.
    if (this.deps.inRun?.(sessionId)) return

    if (signal.kind === 'start') {
      await this.enqueueFor(async () => {
        if (!this.running) return
        const state = this.stateOf(s.projectPath)
        const entry = this.goalUnits.get(sessionId)
        if (!signal.declared && entry?.objective === signal.objective) {
          // Codex's `active` is a state broadcast, re-sent on every turn boundary as well as on
          // every status change — this repeat names the same goal this session's unit was opened
          // for, so it changes nothing, **whether or not that unit is still open**. Treating it as
          // a fresh start would find nothing open once the person closes that unit through
          // [complete]/[cancel] and silently mint a duplicate row for a goal they just dismissed
          // (spec §4) — the one case this rule exists to stop. Claude's `sentinel` never takes this
          // branch: it is a declaration, not a broadcast, and always falls through to open a new
          // unit below.
          return
        }
        // Either a declaration (claude's `sentinel` always counts as a new start) or a broadcast
        // naming a different objective (a genuinely new codex goal). Either way, whatever entry was
        // here no longer answers "is a unit already open" for the goal about to run below.
        if (entry) this.goalUnits.delete(sessionId)
        const open = state.units.find((u) => u.sessionId === sessionId && isOpen(u.status))
        if (open) {
          // Spec §5.2 — a goal adds a finish line to work already declared; it does not start a
          // second piece of work, and interrupting here would split one job into two records.
          // The notice is deduped separately from the retry above (final review, item 4) — the
          // retry must run every time so the goal gets its own unit the instant the block clears,
          // but the toast saying so must not repeat while the block persists.
          if (this.goalIgnoredNotices.get(sessionId) !== signal.objective) {
            this.goalIgnoredNotices.set(sessionId, signal.objective)
            this.deps.onGoalIgnored?.(s.projectPath, signal.objective)
          }
          return
        }
        this.goalIgnoredNotices.delete(sessionId)
        const r = await this.startTaskCore(sessionId, signal.objective)
        if (r.ok) this.goalUnits.set(sessionId, { id: r.id, objective: signal.objective })
      }, () => undefined)
      return
    }

    const entry = this.goalUnits.get(sessionId)
    if (entry === undefined) return // this session's open unit, if any, is not a goal's
    this.goalUnits.delete(sessionId)
    await this.enqueueFor(async () => {
      if (!this.running) return
      const open = this.stateOf(s.projectPath).units.find(
        (u) => u.sessionId === sessionId && isOpen(u.status)
      )
      // Closed by something else in between, or replaced by a new `/astera-task` on the same
      // session — the person's button, a session exit. Matched by id, not objective: two units can
      // carry the same text, and only the id says which one is the goal's — an `/astera-task` unit
      // must never be closed by a goal that merely repeats its words.
      if (!open || open.id !== entry.id) return
      await this.completeTaskCore(sessionId, {
        source: 'agent',
        ...(signal.summary ? { summary: signal.summary } : {})
      })
    }, () => undefined)
  }

  // ── 회차 ────────────────────────────────────────────────────────────

  /** 한 회차. 트랜스크립트는 늘 따라잡고(증분이라 싸다), git 은 방아쇠가 있었을 때만 묻는다 —
   *  `readGitRef` 는 프로세스를 둘 띄우므로 매 회차마다 부를 수 있는 값이 아니다. */
  private async round(doGit: boolean): Promise<void> {
    const sessions = await this.deps.listSessions()
    for (const s of sessions) this.known.set(s.sessionId, s)
    if (!this.seeded) {
      // start() 의 커서 잡기가 실패했다면 여기서 다시 잡는다. 잡기 전에는 한 줄도 읽지 않는다
      await this.seed(sessions)
      return
    }
    await this.syncWatchers(sessions)
    for (const [projectPath, group] of groupByProject(sessions)) {
      const state = this.stateOf(projectPath)
      let dirty = false
      for (const s of group) dirty = (await this.tail(state, s)) || dirty
      if (doGit) dirty = (await this.gitRound(state, projectPath)) || dirty
      if (dirty) await this.persist(projectPath, state)
    }
  }

  /** 스펙 §16.1 — 켠 순간의 파일 끝을 잡는다. **이전 커서는 버린다.**
   *  지금 목록에 없는 세션은 이 뒤에 나타나면 커서 없이 처음부터 읽히는데, 그것이 표의 첫 줄
   *  ("켠 뒤 시작한 세션은 0")이다 — 그 파일은 켠 뒤에 만들어진 것이므로 처음이 곧 세션의 시작이다.
   *
   *  **경로를 못 읽은 세션도 켤 때 이미 돌던 세션이다.** `transcriptPath` 는 그 순간 `null` 로 올 수
   *  있고(statusline 캡처 파일이 아직 없거나 쓰이는 중이다) 그러면 여기서 커서를 잡지 못한다. 그
   *  세션을 그냥 건너뛰면 다음 회차에 "커서 없는 세션"으로 보여 0 부터 읽히므로, 본 것만은 남긴다 —
   *  그 구분을 하는 것이 `startAtEnd` 다. */
  private async seed(listed?: CollectorSession[]): Promise<void> {
    const sessions = listed ?? (await this.deps.listSessions())
    for (const s of sessions) this.known.set(s.sessionId, s)
    // 커서처럼 비우고 다시 잡는 것이 아니라 **더한다.** 비우면 잡기가 한 번 실패해 다시 부를 때
    // (round 의 재시도) 첫 목록에서 본 세션을 잊고, 켜자마자 온 이어받기 표시도 함께 지워진다.
    // 비우는 자리는 끄기 하나뿐이다 — 커서를 버리는 그 자리다(closeAll).
    for (const s of sessions) this.startAtEnd.add(s.sessionId)
    const grouped = groupByProject(sessions)
    for (const [projectPath, group] of grouped) {
      const state = this.stateOf(projectPath)
      state.cursors = []
      for (const s of group) {
        if (s.transcriptPath === null) continue
        const size = await fileSize(s.transcriptPath)
        // 못 읽었다. **0 으로 적지 않는다** — 경로가 null 이었을 때와 같은 자리로 미룬다:
        // 집합에 남아 있으므로 다음 회차가 다시 묻고, 그때 파일 끝을 잡는다
        if (size === null) continue
        state.cursors.push({
          sessionId: s.sessionId,
          filePath: s.transcriptPath,
          offset: size,
          sizeAtRead: size
        })
      }
      // An active task whose session is gone did not finish — the app was closed, or the tab was.
      // It waits on screen for the person rather than being recorded or thrown away.
      const at = this.nowIso()
      let anyInterrupted = false
      for (const u of state.units) {
        if (u.status !== 'active' || this.known.has(u.sessionId)) continue
        state.units[state.units.indexOf(u)] = interruptedTask(u, {
          at,
          reason: 'INTERRUPTED_BY_APP_RESTART'
        })
        anyInterrupted = true
      }
      await this.persist(projectPath, state)
      // Item 9 (final review): without this, the screen keeps showing a stale "in progress" row
      // after a restart until some other event happens to trigger a re-read. The other interrupt
      // paths (onSessionExit, onSessionForked's roll re-key, closeAll below) all notify; this one
      // (and the orphaned-project pass further down) did not.
      if (anyInterrupted) this.deps.onTasksChanged?.(projectPath)
    }
    // **Projects `grouped` never visits.** A project whose only session ended entirely while the
    // app was off contributes no session to `sessions`, so `groupByProject` never produces it and
    // the loop above never reaches its stored units. Every active unit found here is an orphan by
    // definition — this project put nothing into `sessions`, so nothing in it can be in
    // `this.known` either. `WorkUnitStore` has no way to answer "which projects have I stored"
    // except by asking directly (`projectPaths()`), which is why this is a second pass rather than
    // folded into the loop above.
    const orphanedAt = this.nowIso()
    for (const projectPath of this.deps.store.projectPaths()) {
      if (grouped.has(projectPath)) continue
      const state = this.deps.store.get(projectPath)
      if (!state) continue
      let dirty = false
      for (const u of state.units) {
        if (u.status !== 'active') continue
        state.units[state.units.indexOf(u)] = interruptedTask(u, {
          at: orphanedAt,
          reason: 'INTERRUPTED_BY_APP_RESTART'
        })
        dirty = true
      }
      if (dirty) {
        await this.persist(projectPath, state)
        this.deps.onTasksChanged?.(projectPath) // item 9 — same reason as the loop above
      }
    }
    this.seeded = true
    // 켠 자리에서 바로 세운다. 여기서 하지 않으면 첫 `.git` 감시는 다음 회차까지 미뤄지는데,
    // 회차를 부르는 방아쇠 자체가 감시자에서 오는 경우가 있어 영영 오지 않을 수 있다
    await this.syncWatchers(sessions)
  }

  /** 세션이 있는 프로젝트마다 `.git` 감시자를 하나씩 세우고, 볼 세션이 없어진 프로젝트의 것은 닫는다.
   *
   *  **왜 수집기가 자기 감시자를 드는가.** `.git` 방아쇠는 탐색기 패널의 감시자를 얻어 타고 있었고,
   *  그것은 사이드바가 탐색기일 때만 살아 있다(렌더러의 `useGitStatus` 가 언마운트에서
   *  `git.unwatch` 를 부른다). 패널을 Jobs 로 바꾸면 수집기는 그 순간부터 git 이벤트를 하나도 받지
   *  못했다 — 외부 변경도, 스냅샷 전진도, 새 Unit 의 `startHead` 도. 트랜스크립트 쪽
   *  (`HistoryIndex.startBackground`)은 창이 뜬 뒤 한 번 켜져 프로세스가 사는 동안 계속 보는데,
   *  설계 §16 의 그림은 둘을 나란한 상시 방아쇠로 그렸다. 그래서 이쪽도 그렇게 만든다.
   *
   *  **프로젝트마다 인스턴스를 하나씩 든다.** `GitWatcher` 를 여러 경로를 받게 넓히면 `unwatch()`
   *  의 뜻이 함께 바뀐다 — 지금 그것은 "그 하나를 닫는다"이고, 여러 개를 들면 경로를 받거나 전부
   *  닫는 것이 되어 기존 사용처(탐색기)의 계약이 달라진다. 인스턴스를 여러 개 드는 쪽은
   *  `GitWatcher` 를 **한 줄도 바꾸지 않는다.** (탐색기가 `watch()` 의 "앞의 것을 닫는다"에 기대고
   *  있는 것은 아니다 — 그쪽 훅은 다음 root 를 보기 전에 `unwatch()` 를 직접 부른다.)
   *
   *  **직렬화는 회차 고리가 이미 해 준다** — 부르는 자리(`round`·`seed`)가 둘 다 `enqueue` 안이라
   *  두 syncWatchers 가 겹치지 않는다. 그 안에서는 나란히 연다: 하나하나가 chokidar 의 `ready` 를
   *  기다리므로, 직렬로 열면 프로젝트가 여럿일 때 토글을 켜는 IPC 응답이 그 합만큼 붙잡힌다. */
  private async syncWatchers(sessions: readonly CollectorSession[]): Promise<void> {
    const watch = this.deps.watchGit
    if (!watch) return
    const wanted = new Set(sessions.map((s) => s.projectPath))
    for (const [projectPath, stop] of [...this.gitWatches]) {
      if (wanted.has(projectPath)) continue
      this.gitWatches.delete(projectPath)
      await this.stopWatch(projectPath, stop)
    }
    // `has` 검사가 각 갈래의 첫 await 앞에서 동기로 끝나므로, 나란히 돌아도 같은 프로젝트를 두 번
    // 열지 않는다
    await Promise.all(
      [...wanted].map(async (projectPath) => {
        if (this.gitWatches.has(projectPath)) return
        try {
          const stop = await watch(projectPath)
          // `null` 은 **볼 것이 없었다**는 답이다 — 아직 저장소가 아닌 프로젝트가 그렇다. 자리를
          // 잡지 않아야 그 프로젝트에서 나중에 `git init` 을 했을 때 다음 회차가 다시 묻는다
          if (stop) this.gitWatches.set(projectPath, stop)
        } catch (e) {
          // 감시를 걸다가 던졌다(git dir 조회나 chokidar 의 I/O 실패). **회차를 멈추지 않는다** —
          // 자리를 잡지 않았으므로 다음 회차가 다시 시도한다
          this.log(`git watch failed ${projectPath}: ${String(e)}`)
        }
      })
    )
  }

  private async stopWatch(projectPath: string, stop: () => Promise<void>): Promise<void> {
    try {
      await stop()
    } catch (e) {
      this.log(`git unwatch failed ${projectPath}: ${String(e)}`)
    }
  }

  /** Reads only the new tail of one session's transcript. There is no boundary rule to feed any
   *  more — what this looks for now is write evidence (`hasWriteEvidence`) to mark the open unit's
   *  `sawWrite`, the one thing a declared boundary still needs the transcript for. */
  private async tail(state: WorkUnitState, s: CollectorSession): Promise<boolean> {
    if (s.transcriptPath === null) return false
    const cursor = state.cursors.find((c) => c.sessionId === s.sessionId)
    // 파일이 달라졌으면(세션을 이어받았거나 그 세션이 다른 파일을 보게 됐다) 옛 오프셋은
    // 전혀 다른 내용의 한가운데를 가리킨다. 그때 — 그리고 커서가 아예 없을 때 — 어디서부터
    // 읽을지는 anchorFor 가 답한다. **버리면 0 이 되고, 0 이 증명되는 경우는 하나뿐이다** —
    // 세션 id 도 파일도 지금 처음 본다(설계 문서 §16 의 "오프셋을 버린다"는 그 하나만 보고 쓴 문장이다).
    let usable: { offset: number; sizeAtRead: number } | null = null
    if (cursor && cursor.filePath === s.transcriptPath) {
      usable = { offset: cursor.offset, sizeAtRead: cursor.sizeAtRead }
    } else {
      const anchor = await this.anchorFor(s.sessionId, s.transcriptPath, cursor !== undefined)
      // 지금은 정할 수 없다. **아무것도 쓰지 않고 나간다** — 무엇을 적든 다음 회차에는
      // 경로가 맞는 커서가 있어 이 판정을 다시 거치지 않게 된다
      if (anchor === 'skip') return false
      usable = anchor
    }
    const r = await readNewLines(s.transcriptPath, usable)

    // **되감았다.** 파일이 커서보다 작아져 tail 이 처음부터 다시 읽었다(잘렸거나 같은
    // 이름으로 다른 파일이 놓였다). 켜질 때 이미 돌던 세션과 이어받은 세션에게 그 "처음"은
    // 우리 것이 아니다 — 읽은 줄을 버리고 지금 끝을 다시 잡는다. `readNewLines` 가 `restarted` 를
    // 돌려주는 이유가 이 한 자리다.
    if (r.restarted && this.startAtEnd.has(s.sessionId)) {
      this.moveCursor(state, s.sessionId, s.transcriptPath, r.offset, r.sizeAtRead)
      return true
    }

    let dirty = false
    if (cursor) {
      dirty =
        cursor.filePath !== s.transcriptPath ||
        cursor.offset !== r.offset ||
        cursor.sizeAtRead !== r.sizeAtRead
      cursor.filePath = s.transcriptPath
      cursor.offset = r.offset
      cursor.sizeAtRead = r.sizeAtRead
    } else {
      state.cursors.push({
        sessionId: s.sessionId,
        filePath: s.transcriptPath,
        offset: r.offset,
        sizeAtRead: r.sizeAtRead
      })
      dirty = true
    }

    for (const raw of r.lines) {
      let record: unknown
      try {
        record = JSON.parse(raw)
      } catch {
        continue // 반쪽 줄은 tail 이 이미 걸렀다. 그래도 남는 깨진 줄 하나가 회차를 멈추게 하지 않는다
      }
      if (!isObj(record)) continue
      // Did this session write anything? Marked here, on the unit that is open at the time, because
      // this is the only place a record is read per session — observed git changes cannot tell the
      // sessions apart (see SessionWorkUnit.sawWrite). Marked once; the flag never goes back.
      if (hasWriteEvidence(record)) {
        const open = state.units.find((u) => u.sessionId === s.sessionId && isOpen(u.status))
        if (open && !open.sawWrite) {
          open.sawWrite = true
          dirty = true
        }
      }
      // A goal boundary. Only noted here — see pendingGoals for why it cannot be acted on inside
      // a round.
      const goal = goalSignalOf(record)
      if (goal) this.pendingGoals.push({ sessionId: s.sessionId, signal: goal })
    }

    return dirty
  }

  /** 쓸 커서가 없을 때 어디서부터 읽는가. 답은 셋이다 — 잡은 자리 · `null`(파일 처음부터) ·
   *  `'skip'`(지금은 정할 수 없다).
   *
   *  **0 이 증명되는 경우는 하나뿐이다: 세션 id 도 파일도 지금 처음 본다.** 이미 커서를 가진
   *  세션이 다른 파일을 보게 됐다면 그 파일의 앞부분은 우리가 본 적 없는 대화이지 "그 세션의
   *  시작"이 아니다. 이 저장소는 같은 물음에 이미 같은 답을 냈다 — rolling.ts 의 `applyMeta` 는
   *  경로가 바뀌면 `since = now` 로 tail 을 새로 세우고, 그 이유를 "그 앞의 것들은 이 체인이 보기
   *  전에 이미 거기 있었다"라고 적어 두었다.
   *
   *  이어받기 표시(`forkAnchors`)를 먼저 보는 이유: 그 값은 되쓰기가 시작되기 전에 잡은 자리라,
   *  이어받은 직후 사람이 한 말까지 읽는다. 지금 파일 끝을 잡으면 그 한 줄을 놓친다. 다만 그
   *  표시는 알림이 준 경로에 대해서만 쓸 수 있다 — 이어받은 세션이 결국 다른 파일을 쓰면(`--resume`
   *  이 새 파일에 되쓰는 경우) 그 파일에서 잡을 수 있는 정확한 자리는 지금의 끝뿐이다.
   *
   *  **크기 0 과 "못 읽음"은 다른 답이다.** stat 이 실패했는데 0 으로 적으면 그것이 진짜 커서로
   *  남고, 다음 회차에는 경로가 맞는 커서가 있어 이 함수를 다시 거치지 않은 채 0 에서 읽는다 —
   *  되쓰인 대화 전체다. 그래서 실패는 `'skip'` 이고, 그 회차는 아무것도 쓰지 않고 지나간다. */
  private async anchorFor(
    sessionId: string,
    filePath: string,
    hasCursor: boolean
  ): Promise<{ offset: number; sizeAtRead: number } | null | 'skip'> {
    const anchor = this.forkAnchors.get(sessionId)
    if (anchor && anchor.filePath === filePath) {
      // 한 번 쓰면 상태의 커서가 그 자리를 이어받는다 — 남겨 두면 파일이 한 바퀴 돌았을 때 이미
      // 읽은 자리로 되돌아간다
      this.forkAnchors.delete(sessionId)
      return { offset: anchor.offset, sizeAtRead: anchor.offset }
    }
    if (!hasCursor && !this.startAtEnd.has(sessionId)) return null
    const size = await fileSize(filePath)
    if (size === null) return 'skip'
    return { offset: size, sizeAtRead: size }
  }

  /** 한 세션의 커서를 그 자리로 옮긴다 — 있으면 고치고 없으면 만든다 */
  private moveCursor(
    state: WorkUnitState,
    sessionId: string,
    filePath: string,
    offset: number,
    sizeAtRead: number
  ): void {
    const cursor = state.cursors.find((c) => c.sessionId === sessionId)
    if (!cursor) {
      state.cursors.push({ sessionId, filePath, offset, sizeAtRead })
      return
    }
    cursor.filePath = filePath
    cursor.offset = offset
    cursor.sizeAtRead = sizeAtRead
  }

  /** `.git` 이 움직였다. 전이를 판정하고, Astera 가 한 일이 아니면 외부 변경으로 남긴다 */
  private async gitRound(state: WorkUnitState, projectPath: string): Promise<boolean> {
    const after = await this.deps.git.readRef(projectPath)
    // **앞은 저장된 스냅샷이 먼저다.** 그것이 "Astera 가 마지막으로 견준 상태"이고, 앱이 꺼져 있던
    // 동안의 pull·브랜치 전환·rebase 가 다시 켠 첫 회차에서 **보통의 전이**로 판정되는 이유다
    // (설계 §9, EG §41-10·§42-17). 메모리 캐시를 먼저 보면 그 회차 전에 refOf 가 지금 HEAD 를
    // 물어 둔 경우(경계에서 Unit 이 열렸다) 지금과 지금을 견주게 되어 그 변화가 도로 사라진다.
    // 스냅샷이 아직 없을 때만 캐시가 답한다 — 저장 전에 이 실행이 이미 본 값이다.
    const before = snapshotRef(state.gitSnapshot) ?? this.lastRef.get(projectPath)
    this.lastRef.set(projectPath, after)
    // 스냅샷을 지금 상태로 옮긴다. **값이 실제로 달라졌을 때만 dirty 다** — 매 회차 쓰면 아무 일도
    // 없는 회차마다 파일을 다시 쓰게 된다(tail 이 커서에 쓰는 규칙 그대로).
    let dirty = false
    const snapshot = state.gitSnapshot
    if (
      snapshot === undefined ||
      snapshot.branch !== after.branch ||
      snapshot.head !== after.head
    ) {
      state.gitSnapshot = {
        projectPath,
        branch: after.branch,
        head: after.head,
        capturedAt: this.nowIso()
      }
      dirty = true
    }
    if (!before) return dirty // 처음 본 저장소 — 비교할 앞이 없으니 기준선만 잡는다

    // **조상 답이 쓰이는 갈래에서만 묻는다.** classifyTransition 은 브랜치가 다르면 그 답을 보지
    // 않고, head 가 같아도 보지 않는다(transition.ts 의 갈래 순서). 그 밖에서 물으면 프로세스 셋을
    // 띄워 얻은 답이 버려진다 — 이 파일 위의 "git 은 방아쇠가 있었을 때만 묻는다"와 같은 규칙이다.
    // 안 물을 때 넘기는 null 은 이미 "git 이 답하지 못했다"의 값이라 그 갈래들은 그것을 읽지 않는다.
    const needsAncestry = before.branch === after.branch && before.head !== after.head
    const type = classifyTransition(
      before,
      after,
      needsAncestry ? await this.deps.git.isAncestor(projectPath, before.head, after.head) : null
    )
    // 작업 트리는 전이가 없어도 바뀌어 있을 수 있다 (`git add` 가 index 만 건드린 경우)
    const observed = this.observe(state, projectPath, await this.changedFiles(projectPath))
    if (type === 'none') return observed || dirty

    const open = state.units.filter((u) => isOpen(u.status))
    // **이 전이의 앞에 있던 Unit 들.** 시각이 아니라 HEAD 로 가른다 — Unit 의 `startedAt` 은
    // 트랜스크립트 레코드의 시각이고 `detectedAt` 은 이 수집기의 시계라 서로 견줄 수 있는 값이
    // 아니고, 더 근본적으로는 **두 경우의 시각 순서가 같다**: 재시작 직후에 열린 Unit 도 이 회차보다
    // 먼저 열린다. 가려 주는 증거는 그 Unit 이 어느 자리에서 열렸는가 하나뿐이다 — 이미 옮겨진
    // HEAD 에서 열렸다면(startHead = after.head) 그 이동은 이 Unit 이 생기기 전에 끝난 일이다
    // (EG §27 — "겪었다"이지 "만들었다"가 아니고, 겪지도 않은 것은 더더욱 아니다).
    // **endHead 를 덮기 전에 가른다** — 바로 아래 줄이 그 값을 after.head 로 바꾼다.
    const encountered = open.filter((u) => (u.git.endHead ?? u.git.startHead) === before.head)
    for (const u of open) u.git.endHead = after.head
    // samePath: 등록 쪽(ipc.ts 의 mergeInto)과 이 projectPath(세션의 cwd 에서 뽑았다)는 따로
    // 기록되어 대소문자·구분자가 다를 수 있다(provenance.ts 의 isAsteraOperation 주석). 그 비교를
    // provenance.ts 는 직접 하지 못하므로(node: 없음) 여기서 isSamePath 를 넘긴다.
    //
    // **이 목록에는 두 종류가 들어 있다** — Astera 가 직접 돌린 동작(`job-merge`)과 세션이 바빴던
    // 구간(`commit`, onSessionBusy). 둘 다 "이 이동은 이 앱 안에서 벌어진 일이다"라는 같은 뜻이고,
    // 판정은 그 구분을 하지 않는다.
    if (!isAsteraOperation(projectPath, this.deps.now(), this.ops(), OPERATION_GRACE_MS, isSamePath)) {
      // **돌려받은 둘은 믿을 수 있는 정도가 다르고, 그래서 버리는 것도 한쪽뿐이다.**
      // `git log before..after` 는 fast-forward 가 아니면 뜻이 없다 — 그 밖의 전이에서 이 범위를
      // 신뢰할 수 없다(types.ts 의 ExternalGitChange.commits 주석). 그러나 `changedFiles` 를 내는
      // 것은 `git diff --name-only before..after` 이고 그것은 **두 트리의 비교**라 브랜치를 갈아타든
      // 역사를 다시 쓰든 "무엇이 달라졌는가"에 정확히 답한다. 다음 계획의 기능 매핑이 브랜치
      // 전환에서 바로 그 목록을 받아야 한다(EG §18·§19).
      //
      // 그래서 두 HEAD 가 다르기만 하면 묻고, 커밋 목록만 fast-forward 밖에서 버린다. 두 HEAD 가
      // 같으면(브랜치만 갈아탔다) 견줄 트리가 하나뿐이라 묻지 않는다 — 답이 늘 빈 목록이다.
      // Astera 자신의 동작으로 판정된 경우는 이 블록에 들어오지 않으므로, 버려질 range 를 위해
      // git 을 더 부르지 않는다.
      const range =
        before.head && after.head && before.head !== after.head
          ? await this.deps.git.readRange(projectPath, before.head, after.head)
          : { commits: [], changedFiles: [] }
      const change: ExternalGitChange = {
        id: randomUUID(),
        projectPath,
        type,
        before,
        after,
        commits: type === 'fast-forward' ? range.commits : [],
        // author 는 `git log before..after` 에서 오므로 **커밋과 같은 조건으로** 버린다 —
        // 범위를 믿을 수 없는 전이에서 이름만 믿을 이유가 없다 (EG §6·§7)
        authors: type === 'fast-forward' ? (range.authors ?? []) : [],
        changedFiles: range.changedFiles,
        detectedAt: this.nowIso()
      }
      state.externalGitChanges.push(change)
      // "겪었다"이지 "만들었다"가 아니다 (EG §27). 그리고 **겪은 Unit 에만** 담는다 — 위에서 가른
      // 그 집합이다
      for (const u of encountered) u.encounteredExternalGitChangeIds.push(change.id)
    }
    return true
  }

  // ── 닫기 ────────────────────────────────────────────────────────────

  /** Tracking was turned off. Any open unit is put into interrupted right there, and the cursor
   *  is discarded (spec §16.1). */
  private async closeAll(): Promise<void> {
    // **아래 루프보다 먼저 닫는다.** 그 루프는 프로젝트마다 저장하고, 저장소의 쓰기는 실패하면
    // 거절한다(store.ts) — 그 거절은 회차 큐가 삼켜 로그만 남기므로, 처분이 루프 뒤에 있으면 한
    // 번의 쓰기 실패로 감시자가 전부 살아남아 추적이 꺼진 채로 계속 이 수집기를 두드린다.
    // **탐색기의 감시자는 여기 없다**: 그것은 렌더러가 열고 닫는 다른 감시자다.
    for (const [projectPath, stop] of [...this.gitWatches]) {
      this.gitWatches.delete(projectPath)
      await this.stopWatch(projectPath, stop)
    }
    const projects = new Set(this.touched)
    for (const s of this.known.values()) projects.add(s.projectPath)
    for (const projectPath of projects) {
      const state = this.deps.store.get(projectPath)
      if (!state) continue
      let dirty = false
      // Catch up before interrupting — see catchUpTranscripts's doc for why this matters.
      // `round()` cannot be used here: `stop()` already set `seeded = false` before enqueuing this
      // method, so `round()` would seed — jumping every cursor to the file's current end — instead
      // of tailing, discarding exactly the pending write-evidence lines this is trying to read.
      // Tail each known session in this project directly instead.
      for (const s of this.known.values()) {
        if (s.projectPath === projectPath) dirty = (await this.tail(state, s)) || dirty
      }
      const open = state.units.filter((u) => u.status === 'active')
      if (open.length > 0) {
        this.observe(state, projectPath, await this.changedFiles(projectPath))
        const at = this.nowIso()
        for (const u of open)
          state.units[state.units.indexOf(u)] = interruptedTask(u, {
            at,
            reason: 'INTERRUPTED_BY_TRACKING_OFF'
          })
        dirty = true
      }
      if (state.cursors.length > 0) {
        state.cursors = []
        dirty = true
      }
      if (dirty) await this.persist(projectPath, state)
      // Item 9 (final review): gated on `open.length`, not the broader `dirty` — a tail-only or
      // cursor-only round has nothing new for the screen to redraw. Without this, the screen kept
      // showing a stale "in progress" row after tracking was turned off until some other event
      // happened to trigger a re-read. `onSessionExit` and `onSessionForked`'s roll re-key already
      // notify the same way.
      if (open.length > 0) this.deps.onTasksChanged?.(projectPath)
    }
    this.known.clear()
    this.pendingGoals = []
    this.goalUnits.clear()
    this.goalIgnoredNotices.clear()
    // 이 실행의 캐시만 비운다. **저장된 스냅샷은 건드리지 않는다** — 커서와 반대 방향의 규칙이고
    // 그것이 맞다: 커서에 걸린 약속은 "켜기 전의 대화는 읽지 않는다"(스펙 §16.1)이고 스냅샷에 걸린
    // 약속은 "실제로 일어난 변화를 놓치지 않는다"(EG §41-10)다. 대화는 사람의 말이고 저장소의
    // 역사는 사실이라, 꺼져 있던 사이의 pull 도 다시 켜면 보여야 한다.
    this.lastRef.clear()
    this.touched.clear()
    // 커서와 함께 버린다. 남겨 두면 꺼져 있는 동안 쓰인 줄들 앞에 잡힌 자리가 살아남아, 다시 켤 때
    // 그 줄들이 읽힌다 — 커서를 버리는 이유(스펙 §16.1) 그대로다
    this.startAtEnd.clear()
    this.forkAnchors.clear()
  }

  /** Put a transitioned unit back in state, and hand it downstream if it is worth recording.
   *
   *  **Two guards decide "worth recording", and they catch different things.**
   *    - `!next.sawWrite` — this session's own transcript never showed it touching a file
   *      (`hasWriteEvidence`). Catches a session that only talked: read code, answered a question,
   *      ran `git log` — `CLAUDE_WRITE_TOOLS` (humanRequest.ts) also counts `Bash`/`PowerShell`, so a
   *      read-only shell command still passes this guard on its own; sawWrite answers "did *this*
   *      session touch anything", not "did anything change".
   *    - `next.git.observedChangedFiles.length === 0` — nothing changed in the working tree during
   *      this unit's window, full stop. Spec §12: *"A `completed` record with no changed files is
   *      still not recorded. The person may have started a record and then only talked."* This is
   *      the guard that actually enforces that sentence — `sawWrite` alone does not, because a run of
   *      `Bash`/`PowerShell` that changed nothing still sets it.
   *  Neither subsumes the other: a session can satisfy one and fail the other, and both must hold
   *  for a completion to be worth keeping.
   *
   *  **What this does not fix.** Observed changes land on every open unit in the project because git
   *  cannot say who made them, so a session that only asked a question carries whatever another
   *  session was editing beside it — measured 2026-08-31, two such units held the seven files that
   *  conversation was changing. That means `observedChangedFiles.length > 0` can be true for a unit
   *  that changed nothing itself; the fix for that is a later plan's Change Interpreter, not this
   *  guard.
   *
   *  Dropping rather than marking: the record would answer no question later. It says a session
   *  existed and did nothing, which the transcript already says. */
  private finish(
    state: WorkUnitState,
    unit: SessionWorkUnit,
    next: SessionWorkUnit,
    projectPath: string
  ): boolean {
    const i = state.units.indexOf(unit)
    if (next.status === 'completed' && (!next.sawWrite || next.git.observedChangedFiles.length === 0)) {
      if (i >= 0) state.units.splice(i, 1)
      return false
    }
    if (i >= 0) state.units[i] = next
    if (next.status !== 'completed') return true
    const head = this.lastRef.get(projectPath)?.head
    if (head !== undefined) next.git.endHead = head
    // **Called and not awaited.** The write-up runs an agent for tens of seconds; waiting would
    // delay this round's save. The pipeline's own queue keeps the order.
    this.deps.onUnitClosed?.(projectPath, next)
    return true
  }

  // ── 잔일 ────────────────────────────────────────────────────────────

  /** Adds observed changes to **every open unit** in that project.
   *
   *  With several sessions on one project, the same file list lands on more than one unit. That is
   *  not a mistake — this field means "changed **during** this window", not "changed **by** this
   *  unit" (spec §11). Sorting out which unit actually made a change is a later plan's Change
   *  Interpreter, not this method.
   *
   *  **Called with a live read right before every interrupt.** `onSessionExit`, `closeAll`, and
   *  `startTask`'s new-task branch all call `changedFiles()` and hand it to `observe` in the same
   *  breath as the `interruptedTask` transition that follows. That ordering is load-bearing, not a
   *  style choice: `isOpen` excludes everything but `active`, so once a unit is interrupted this
   *  method never touches it again — whatever `observedChangedFiles` holds at that exact moment is
   *  what a later 완료 (`finish`, Critical 1's second guard) judges the unit by. A fourth path that
   *  interrupts a unit without this same live look first can freeze it holding zero observed files
   *  despite real, already-made edits sitting right there in the working tree. */
  private observe(state: WorkUnitState, projectPath: string, files: string[]): boolean {
    if (files.length === 0) return false
    let changed = false
    for (const u of state.units) {
      if (u.projectPath !== projectPath || !isOpen(u.status)) continue
      // 열릴 때 이미 더러웠던 파일은 이 Unit 의 관찰이 아니다. 기준선에 있던 파일이 이 구간에
      // **또** 바뀌었어도 가려낼 방법이 없어(status 는 경로만 준다) 세지 않는다 — 덜 세는 쪽이
      // 낫다: 더 세면 질문 Unit 이 completed 로 확정되고, 덜 세면 다음 신호가 다시 기회를 준다
      const baseline = new Set(u.git.baselineDirtyFiles ?? [])
      const seen = new Set(u.git.observedChangedFiles)
      for (const f of files) {
        if (seen.has(f) || baseline.has(f)) continue
        seen.add(f)
        u.git.observedChangedFiles.push(f)
        changed = true
      }
    }
    return changed
  }

  private async changedFiles(projectPath: string): Promise<string[]> {
    try {
      return await this.deps.git.changedFiles(projectPath)
    } catch (e) {
      this.log(`changed files failed ${projectPath}: ${String(e)}`)
      return []
    }
  }

  /** 그 프로젝트의 지금 git 상태. 한 번 물으면 다음 git 회차까지 들고 있는다 */
  private async refOf(projectPath: string): Promise<GitRef> {
    const known = this.lastRef.get(projectPath)
    if (known) return known
    let ref: GitRef = { branch: null, head: null }
    try {
      ref = await this.deps.git.readRef(projectPath)
    } catch (e) {
      this.log(`git ref failed ${projectPath}: ${String(e)}`)
    }
    this.lastRef.set(projectPath, ref)
    return ref
  }

  private stateOf(projectPath: string): WorkUnitState {
    return this.deps.store.get(projectPath) ?? emptyState()
  }

  /** **돌려주는 Promise 를 버리지 않는다.** 쓰기가 실패했을 때 아무도 받지 않으면 node 의 기본
   *  설정이 프로세스를 죽인다 — 저장소 리뷰에서 나온 지적이다. */
  private async persist(projectPath: string, state: WorkUnitState): Promise<void> {
    this.touched.add(projectPath)
    await this.deps.store.set(projectPath, state)
  }

  private ops(): readonly PendingGitOperation[] {
    return this.deps.pendingGitOps?.() ?? []
  }

  private nowIso(): string {
    return new Date(this.deps.now()).toISOString()
  }

  private log(m: string): void {
    this.deps.log?.(`work unit collector: ${m}`)
  }

  /** 디바운스를 건다. 상한이 있어서, 세션이 계속 쓰는 동안에도 최소 1초마다 한 번은 발화한다 */
  private arm(): void {
    if (!this.running) return
    const now = this.deps.now()
    if (this.ceilingAt === null) this.ceilingAt = now + MAX_WAIT_MS
    if (this.timer) clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(DEBOUNCE_MS, this.ceilingAt - now))
    this.timer = setTimeout(() => {
      void this.flush()
    }, wait)
    this.timer.unref?.() // 이 타이머가 종료를 붙잡지 않는다
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.ceilingAt = null
  }

  /** 회차를 겹치지 않게 한다. **한 번의 실패가 이후 회차를 막지 않는다** — `then(run, run)` 인
   *  이유는 store.ts 의 저장 큐와 같다. `run` 자신이 던지지 않으므로 고리는 늘 살아 있다. */
  private enqueue(fn: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        await fn()
      } catch (e) {
        this.log(String(e))
      }
    }
    const p = this.chain.then(run, run)
    this.chain = p
    return p
  }
}

/** 파일 크기, 못 읽으면 `null`. **0 을 돌려주지 않는다** — 부르는 둘 다 그 0 을
 *  커서로 적고, 이어받은 세션에게 그것은 되쓰인 대화를 통째로 읽으라는 뜻이 된다.
 *
 *  이전에는 실패를 0 으로 삼키며 *아직 없다, 그 앞에 읽지 않은 것도 없다* 라고 적어
 *  두었는데, 그 말이 맞는 것은 켜기 전에 없던 파일뿐이다. 이어받은 세션의 전제는 그
 *  반대다 — 그 파일에는 이미 과거가 들어 있다. 부르는 쪽이 그 둘을 가리게 한다. */
async function fileSize(filePath: string): Promise<number | null> {
  try {
    return (await fs.stat(filePath)).size
  } catch {
    return null
  }
}

function groupByProject(sessions: readonly CollectorSession[]): Map<string, CollectorSession[]> {
  const out = new Map<string, CollectorSession[]>()
  for (const s of sessions) {
    const group = out.get(s.projectPath)
    if (group) group.push(s)
    else out.set(s.projectPath, [s])
  }
  return out
}
