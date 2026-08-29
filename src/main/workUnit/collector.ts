// 트랜스크립트·git·세션 이벤트를 모아 core 의 순수 함수를 부르고 그 결과를 저장한다 (설계 §16).
//
// **여기에는 규칙이 없다.** 경계(boundary.ts)·완료(completion.ts)·전이(transition.ts)·출처
// (provenance.ts)의 판정은 전부 core 의 순수 함수이고, 이 파일은 그것을 잇는 껍데기다. 이 저장소가
// main 의 배선에 판단을 두지 않는 이유는 humanRequest.ts 의 `titleOf` 주석에 적혀 있다.
//
// **감시자를 만들지 않는다.** `.git` 감시자도 트랜스크립트 감시자도 ipc.ts 가 이미 들고 있고,
// 그쪽이 여기 방아쇠 메서드를 부른다. 그래서 이 수집기는 감시자 없이, 임시 파일과 가짜 git 만으로
// 전부 테스트된다(collector.test.ts).
//
// **주기적 폴링이 없다.** 방아쇠는 넷뿐이다 — 트랜스크립트 변경 · `.git` 변경 · 세션 유휴 ·
// 세션 종료. EG §25 가 "지나치게 짧은 polling 은 피한다"고 했고 설계 §16 이 이 넷으로 충분하다고
// 적었다. (`onSessionForked` 는 다섯째 방아쇠가 아니다 — 회차를 돌리지 않고 커서만 잡는다.)
//
// **codex 세션에서는 Unit 이 만들어지지 않는다.** 빠뜨린 것이 아니라 형식의 성질이다. 사람의
// 요청을 가리는 판정(humanRequest.ts)은 레코드의 구조 표지 — `type:'user'` · `toolUseResult` ·
// `isMeta` · `promptSource` — 를 보는데, codex rollout 레코드의 최상위 키는 `payload` ·
// `timestamp` · `type` 셋뿐이다(실측: codexParser.ts 의 `CODEX_WRAPPER_PREFIXES` 주석).
// 구조로 물어볼 것이 없으니 지원하려면 그 파일이 쓰는 접두사 차단 목록으로 돌아가야 하는데,
// 그 목록은 이 계획이 일부러 버린 것이다(humanRequest.ts 의 허용 목록 주석). 그래서 codex
// 세션은 여기까지 흘러오되 한 줄도 사람의 요청으로 인정되지 않는다.
import { promises as fs, statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { git } from '../../core/worktrees/git'
import { parsePorcelainZ } from '../../core/git/status'
import type { ExternalGitChange, GitRef, PendingGitOperation } from '../../core/git/types'
import { classifyTransition } from '../../core/git/transition'
import { isAsteraOperation } from '../../core/git/provenance'
import type { SessionWorkUnit } from '../../core/workUnit/types'
import { isOpen } from '../../core/workUnit/status'
import { isHumanRequest, requestTextOf, titleOf } from '../../core/workUnit/humanRequest'
import { decideBoundary } from '../../core/workUnit/boundary'
import {
  onAgentIdle,
  onBoundaryConfirm,
  onFeatureDisabled,
  onSessionEnd
} from '../../core/workUnit/completion'
import { readNewLines } from './tail'
import type { WorkUnitState, WorkUnitStore } from './store'

/** `core/history/index.ts` 와 같은 값이다. 상한이 있는 이유도 그 파일 주석 그대로다 —
 *  *"계속 리셋되기만 하는 디바운스는 세션이 쓰는 동안 영영 발화하지 않는다."* 세션이 트랜스크립트에
 *  계속 덧붙이는 동안 우리도 정확히 그 조건에 놓인다. */
const DEBOUNCE_MS = 150
const MAX_WAIT_MS = 1000

/** `git status` 는 감시 고리 안에서 돌므로 매달리면 안 된다. ipc.ts 의 git.status 와 같은 값 */
const STATUS_TIMEOUT_MS = 5_000

/** 지금 보고 있는 세션 하나. **수집기는 세션을 스스로 찾지 않는다** — 어느 세션이 어느 프로바이더의
 *  어느 파일을 쓰는지는 ipc.ts 만 아는 일이고(claude 는 statusLine 페이로드, codex 는 rollout 경로),
 *  그것을 여기로 끌고 오면 이 파일이 electron 하네스 없이는 테스트되지 않는다. */
export interface CollectorSession {
  sessionId: string
  /** 이 세션의 작업이 속한 프로젝트. V1 은 세션의 cwd 를 그대로 쓴다 (설계 §20) */
  projectPath: string
  /** 아직 모르면 null — 그 세션은 이번 회차에서 건너뛴다 */
  transcriptPath: string | null
  /** `ProviderDescriptor.busyTitleReliable`. codex 는 false 이고, 그때 Unit 은 유휴로 닫히지 않는다 */
  idleSignalTrusted: boolean
}

/** git 에게 묻는 것. 실행은 main 의 일이고 판정은 core 의 일이라, 이 사이에 경계를 둔다 */
export interface CollectorGit {
  readRef(repoPath: string): Promise<GitRef>
  isAncestor(repoPath: string, before: string | null, after: string | null): Promise<boolean | null>
  /** 작업 트리에서 지금 바뀌어 있는 파일들 (저장소 루트 기준 상대 경로, git 이 찍은 그대로) */
  changedFiles(repoPath: string): Promise<string[]>
}

export interface CollectorDeps {
  store: WorkUnitStore
  listSessions: () => Promise<CollectorSession[]>
  git: CollectorGit
  /** 지금 시각(ms). **인자로 받는 이유는 이 수집기가 시각을 기록하고 시각으로 기다리기 때문이다** —
   *  Unit 의 `startedAt` · `completedAt` 과 외부 변경의 `detectedAt` 이 이 값에서 나오고(`nowIso`),
   *  디바운스의 상한도 이 값으로 잰다(`arm`). 시계를 밖에서 주면 테스트가 그 값들을 고정된 값으로
   *  확인할 수 있다. */
  now: () => number
  /** Astera 가 지금 돌리고 있는 git 동작들 (EG §26).
   *
   *  **V1 에는 이것을 등록하는 곳이 없다.** 워크트리 생성·병합 같은 Astera 자신의 git 조작을
   *  등록하는 일은 이 계획의 어느 태스크도 만들지 않았고, 그래서 ipc.ts 는 빈 목록을 준다 —
   *  결과적으로 V1 은 모든 전이를 외부 변경으로 본다. `isAsteraOperation` 을 그래도 부르는 이유는
   *  등록하는 쪽이 생기는 즉시 이 자리가 맞게 동작해야 하기 때문이다. **유예 경계 자체는 이 주입점이
   *  아니라 provenance.test.ts 가 확인한다** — 이 수집기의 테스트는 이 자리를 채우지 않으므로
   *  (빈 목록이 기본값이다) 여기를 지나는 판정은 늘 "Astera 것이 아니다"로 떨어진다. */
  pendingGitOps?: () => readonly PendingGitOperation[]
  log?: (m: string) => void
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const emptyState = (): WorkUnitState => ({
  units: [],
  cursors: [],
  messages: [],
  externalGitChanges: []
})

/**
 * 작업 트리에서 지금 바뀌어 있는 파일들. `CollectorGit.changedFiles` 의 실제 구현이다.
 *
 * `--no-optional-locks` 가 반드시 필요하다: 없으면 status 가 `.git/index` 를 갱신하고 그것이 다시
 * GitWatcher 를 깨워 무한 고리가 된다 (ipc.ts 의 git.status 핸들러가 같은 이유로 같은 플래그를 쓴다).
 * `trim:false` 도 같다 — porcelain 레코드는 `XY<공백>경로` 라 앞 공백을 깎으면 경로의 첫 글자가 함께 날아간다.
 *
 * **이 함수가 gitProbe.ts 가 아니라 여기 있는 이유:** 그 파일은 이 계획의 다른 태스크가 만들어
 * 리뷰까지 끝난 자리이고, 이 배선 태스크는 그것을 고치지 않기로 했다. 대신 수집기의 기본 구현으로
 * 두고 주입점을 열어 둔다 — 테스트는 가짜를 넣고, ipc.ts 는 이것을 그대로 쓴다.
 */
export async function readChangedFiles(repoPath: string): Promise<string[]> {
  const r = await git(
    ['--no-optional-locks', 'status', '--porcelain', '-z', '--untracked-files=all'],
    { cwd: repoPath, timeoutMs: STATUS_TIMEOUT_MS, trim: false }
  )
  if (!r.ok) return [] // 저장소가 아니거나 git 이 실패했다 — 관찰된 변경이 없는 것으로 본다
  return parsePorcelainZ(r.stdout).map((e) => e.relPath)
}

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
  /** 프로젝트마다 "마지막으로 안 git 상태". gitWatcher 의 콜백은 인자가 없으므로 전이를 판정하려면
   *  이전 값을 여기서 들고 있어야 한다 (설계 §9 의 ProjectGitSnapshot) */
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
      this.lastRef.clear()
      this.known.clear()
      this.touched.clear()
      await this.seed()
    })
  }

  /** 끈다. 열려 있던 Unit 을 `onFeatureDisabled` 로 그 자리에서 닫고 **커서를 버린다**.
   *  이어받으면 꺼져 있던 동안 쌓인 것을 다시 켤 때 전부 읽게 되고, 그것이 스펙 §16.1 이 금지한 것이다. */
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

  /** 에이전트가 한 턴을 끝냈다 (session:busy → false). 상태 변화에만 오므로 디바운스하지 않는다 */
  onSessionIdle(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.running) return
      await this.round(false) // 유휴 판정 전에 그 턴이 남긴 줄까지 따라잡는다
      const s = this.known.get(sessionId)
      if (!s) return
      const state = this.stateOf(s.projectPath)
      const open = state.units.find((u) => u.sessionId === sessionId && isOpen(u.status))
      if (!open) return
      this.observe(state, s.projectPath, await this.changedFiles(s.projectPath))
      open.status = onAgentIdle({
        status: open.status,
        observedChangeCount: open.git.observedChangedFiles.length,
        idleSignalTrusted: s.idleSignalTrusted
      })
      await this.persist(s.projectPath, state)
    })
  }

  /** 세션을 이어받았다 — 한도에 걸려 굴렸거나(rolling.ts) 사람이 기록에서 대화를 다시 열었다.
   *  **새 세션만의 일이다**: 옛 세션의 커서와 Unit 은 건드리지 않는다. 그 세션은 곧 끝나고
   *  `onSessionExit` 가 닫는다.
   *
   *  **왜 파일 끝인가.** `--resume` 은 이전 대화를 통째로 다시 적고, 되읽힌 요청들은 `promptSource`
   *  를 그대로 달고 있어 사람의 요청 판정을 전부 통과한다. 수집기는 이 세션 id 를 처음 보므로
   *  커서가 없고, 커서가 없다는 것만으로 0 부터 읽으면 켜기 전의 대화가 Unit 이 되고 켠 뒤의 것은
   *  두 번 읽힌다. 파일 끝은 되읽힌 내용을 건너뛰는 유일하게 정확한 지점이다 — 잃는 것은 재개
   *  브리핑 한 줄일 수 있고, 얻는 것은 "켜기 전의 대화는 읽지 않는다"는 약속이다(스펙 §16.1).
   *
   *  **부르는 쪽이 토글을 확인하지 않아도 된다.** 꺼져 있으면 아무 일도 하지 않는다 — 다시 켜면
   *  `seed` 가 그때의 파일 끝을 잡으므로 이 자리에 남길 것이 없다.
   *
   *  크기를 동기로 읽는 이유: `--resume` 이 되쓰기를 시작하기 전의 크기여야 "그 순간"이 뜻이 있다.
   *  파일 하나의 stat 이고, 이어받기마다 한 번뿐이다. */
  onSessionForked(newSessionId: string, transcriptPath: string): void {
    if (!this.running) return
    this.startAtEnd.add(newSessionId)
    let size: number
    try {
      size = statSync(transcriptPath).size
    } catch {
      // 아직 없다 — 새 파일에 처음부터 쓰인다면 그 처음이 이 세션의 시작이다. 그래도 위의 집합에는
      // 남겨 둔다: 이 세션이 결국 **다른** 파일(되쓰인 쪽)을 쓰면 그때는 끝부터 읽어야 한다
      return
    }
    this.forkAnchors.set(newSessionId, { filePath: transcriptPath, offset: size })
  }

  /** 세션이 끝났다 (WU §14-4). 관찰이 여기서 멈추므로 후보로 남기지 않는다 */
  onSessionExit(sessionId: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.running) return
      await this.round(false)
      const s = this.known.get(sessionId)
      if (!s) return
      const state = this.stateOf(s.projectPath)
      // 끝난 세션은 listSessions 에서 이미 빠져 있어 위 회차가 읽지 않는다. 종료 직전에 온 요청도
      // 그 세션의 것이므로, 이 하나만 따로 마지막까지 읽는다
      let dirty = await this.tail(state, s)
      const open = state.units.filter((u) => u.sessionId === sessionId && isOpen(u.status))
      if (open.length > 0) {
        this.observe(state, s.projectPath, await this.changedFiles(s.projectPath))
        for (const u of open)
          this.close(
            u,
            onSessionEnd({ observedChangeCount: u.git.observedChangedFiles.length }),
            s.projectPath
          )
        dirty = true
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
    return this.enqueue(async () => {
      this.disarm()
      if (!this.running) return
      const wantGit = this.pendingGit
      this.pendingGit = false
      await this.round(wantGit)
    })
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
    for (const [projectPath, group] of groupByProject(sessions)) {
      const state = this.stateOf(projectPath)
      state.cursors = []
      for (const s of group) {
        if (s.transcriptPath === null) continue
        const size = await fileSize(s.transcriptPath)
        state.cursors.push({
          sessionId: s.sessionId,
          filePath: s.transcriptPath,
          offset: size,
          sizeAtRead: size
        })
      }
      await this.persist(projectPath, state)
    }
    this.seeded = true
  }

  /** 한 세션의 트랜스크립트를 뒤만 읽고, 거기서 나온 사람의 요청을 경계 규칙에 먹인다 */
  private async tail(state: WorkUnitState, s: CollectorSession): Promise<boolean> {
    if (s.transcriptPath === null) return false
    const cursor = state.cursors.find((c) => c.sessionId === s.sessionId)
    // 파일이 달라졌으면(세션이 fork/resume 되었다) 옛 오프셋은 전혀 다른 내용의 한가운데를 가리킨다.
    // 그때 — 그리고 커서가 아예 없을 때 — 어디서부터 읽을지는 anchorFor 가 답한다. **버리면 0 이 되고,
    // 0 이 옳은 경우는 하나뿐이다**(설계 문서 §16 의 "오프셋을 버린다"는 그 하나만 보고 쓴 문장이다).
    const usable =
      cursor && cursor.filePath === s.transcriptPath
        ? { offset: cursor.offset, sizeAtRead: cursor.sizeAtRead }
        : await this.anchorFor(s.sessionId, s.transcriptPath)
    const r = await readNewLines(s.transcriptPath, usable)

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
      if (!isObj(record) || !isHumanRequest(record)) continue
      await this.applyRequest(state, s, record)
      dirty = true
    }
    return dirty
  }

  /** 쓸 커서가 없을 때 어디서부터 읽는가. **`null` 은 "파일 처음부터"라는 뜻**이고(readNewLines),
   *  그것이 옳은 세션은 켠 뒤에 새로 시작한 세션뿐이다.
   *
   *  이어받기 표시(`forkAnchors`)를 먼저 보는 이유: 그 값은 되쓰기가 시작되기 전에 잡은 자리라,
   *  이어받은 직후 사람이 한 말까지 읽는다. 지금 파일 끝을 잡으면 그 한 줄을 놓친다. 다만 그
   *  표시는 알림이 준 경로에 대해서만 쓸 수 있다 — 이어받은 세션이 결국 다른 파일을 쓰면(`--resume`
   *  이 새 파일에 되쓰는 경우) 그 파일에서 잡을 수 있는 정확한 자리는 지금의 끝뿐이다. */
  private async anchorFor(
    sessionId: string,
    filePath: string
  ): Promise<{ offset: number; sizeAtRead: number } | null> {
    const anchor = this.forkAnchors.get(sessionId)
    if (anchor && anchor.filePath === filePath) {
      // 한 번 쓰면 상태의 커서가 그 자리를 이어받는다 — 남겨 두면 파일이 한 바퀴 돌았을 때 이미
      // 읽은 자리로 되돌아간다
      this.forkAnchors.delete(sessionId)
      return { offset: anchor.offset, sizeAtRead: anchor.offset }
    }
    if (!this.startAtEnd.has(sessionId)) return null
    const size = await fileSize(filePath)
    return { offset: size, sizeAtRead: size }
  }

  /** 사람의 요청 하나 — WU §13 의 세 경우 (boundary.ts) */
  private async applyRequest(
    state: WorkUnitState,
    s: CollectorSession,
    record: Record<string, unknown>
  ): Promise<void> {
    const text = requestTextOf(record)
    const at = typeof record.timestamp === 'string' ? record.timestamp : this.nowIso()
    // 트랜스크립트 파서가 메시지 식별자를 싣지 않으므로 순번으로 대신한다 (types.ts 의 firstMessageIndex)
    const index = state.messages.reduce((n, m) => (m.sessionId === s.sessionId ? n + 1 : n), 0)
    state.messages.push({ sessionId: s.sessionId, index, at, text })

    const open = state.units.find((u) => u.sessionId === s.sessionId && isOpen(u.status))
    const decision = decideBoundary(open ? open.status : null)
    if (decision.kind === 'append') {
      open!.messageCount += 1
      return
    }
    // 새 Unit 이 열린다. **HEAD 를 먼저 묻는다** — 닫히는 Unit 의 endHead 도 같은 값이고,
    // close() 는 여기서 채워지는 캐시를 읽는다
    const head = (await this.refOf(s.projectPath)).head
    if (decision.kind === 'close-and-open') {
      // 앞 Unit 을 확정하는 것은 이 메시지다 (WU §6)
      this.close(open!, onBoundaryConfirm(open!.status), s.projectPath, at)
    }
    const unit: SessionWorkUnit = {
      id: randomUUID(),
      sessionId: s.sessionId,
      projectPath: s.projectPath,
      title: titleOf(text),
      status: 'active',
      startedAt: at,
      firstMessageIndex: index,
      messageCount: 1,
      git: { startHead: head, observedChangedFiles: [] },
      encounteredExternalGitChangeIds: []
    }
    state.units.push(unit)
  }

  /** `.git` 이 움직였다. 전이를 판정하고, Astera 가 한 일이 아니면 외부 변경으로 남긴다 */
  private async gitRound(state: WorkUnitState, projectPath: string): Promise<boolean> {
    const after = await this.deps.git.readRef(projectPath)
    const before = this.lastRef.get(projectPath)
    this.lastRef.set(projectPath, after)
    if (!before) return false // 처음 본 저장소 — 비교할 앞이 없으니 기준선만 잡는다

    const type = classifyTransition(
      before,
      after,
      await this.deps.git.isAncestor(projectPath, before.head, after.head)
    )
    // 작업 트리는 전이가 없어도 바뀌어 있을 수 있다 (`git add` 가 index 만 건드린 경우)
    const observed = this.observe(state, projectPath, await this.changedFiles(projectPath))
    if (type === 'none') return observed

    const open = state.units.filter((u) => isOpen(u.status))
    for (const u of open) u.git.endHead = after.head
    if (!isAsteraOperation(projectPath, this.deps.now(), this.ops())) {
      const change: ExternalGitChange = {
        id: randomUUID(),
        projectPath,
        type,
        before,
        after,
        // **V1 은 둘 다 채우지 않는다.** 범위 diff 를 물으려면 git 을 더 부려야 하고, 설계 §17 이
        // 그 정교화를 다음 계획(Change Interpreter)으로 미뤘다. 지금 필요한 것은 관계뿐이다 —
        // "이 작업 중 외부 변경이 있었다"는 id 로만 이어진다 (설계 §11).
        commits: [],
        changedFiles: [],
        detectedAt: this.nowIso()
      }
      state.externalGitChanges.push(change)
      // "겪었다"이지 "만들었다"가 아니다 (EG §27)
      for (const u of open) u.encounteredExternalGitChangeIds.push(change.id)
    }
    return true
  }

  // ── 닫기 ────────────────────────────────────────────────────────────

  /** 기능을 껐다. 열려 있던 Unit 을 그 자리에서 닫고 커서를 버린다 (스펙 §16.1) */
  private async closeAll(): Promise<void> {
    const projects = new Set(this.touched)
    for (const s of this.known.values()) projects.add(s.projectPath)
    for (const projectPath of projects) {
      const state = this.deps.store.get(projectPath)
      if (!state) continue
      const open = state.units.filter((u) => isOpen(u.status))
      let dirty = false
      if (open.length > 0) {
        this.observe(state, projectPath, await this.changedFiles(projectPath))
        for (const u of open)
          this.close(u, onFeatureDisabled({ observedChangeCount: u.git.observedChangedFiles.length }), projectPath)
        dirty = true
      }
      if (state.cursors.length > 0) {
        state.cursors = []
        dirty = true
      }
      if (dirty) await this.persist(projectPath, state)
    }
    this.known.clear()
    this.lastRef.clear()
    this.touched.clear()
    // 커서와 함께 버린다. 남겨 두면 꺼져 있는 동안 쓰인 줄들 앞에 잡힌 자리가 살아남아, 다시 켤 때
    // 그 줄들이 읽힌다 — 커서를 버리는 이유(스펙 §16.1) 그대로다
    this.startAtEnd.clear()
    this.forkAnchors.clear()
  }

  private close(unit: SessionWorkUnit, status: SessionWorkUnit['status'], projectPath: string, at?: string): void {
    unit.status = status
    if (!isOpen(status)) {
      unit.completedAt = at ?? this.nowIso()
      const head = this.lastRef.get(projectPath)?.head
      if (head !== undefined) unit.git.endHead = head
    }
  }

  // ── 잔일 ────────────────────────────────────────────────────────────

  /** 관찰된 변경을 그 프로젝트의 **열린 Unit 전부**에 더한다.
   *
   *  한 프로젝트에 세션이 여럿이면 같은 파일 목록이 여러 Unit 에 들어간다. 그것이 틀린 것이 아닌
   *  이유는 이 필드의 뜻이 "이 구간에 **관찰된** 변경"이지 "이 Unit 이 만든 변경"이 아니기 때문이다
   *  (스펙 §11). 어느 Unit 이 만들었는지 가리는 것은 다음 계획의 Change Interpreter 다. */
  private observe(state: WorkUnitState, projectPath: string, files: string[]): boolean {
    if (files.length === 0) return false
    let changed = false
    for (const u of state.units) {
      if (u.projectPath !== projectPath || !isOpen(u.status)) continue
      const seen = new Set(u.git.observedChangedFiles)
      for (const f of files) {
        if (seen.has(f)) continue
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

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size
  } catch {
    return 0 // 아직 없다 — 그 앞에 읽지 않은 것도 없다
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
