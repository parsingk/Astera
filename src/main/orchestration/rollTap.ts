// 롤링과 오케스트레이션의 이음매.
//
// **문제.** 롤은 세션을 죽이고 새 id 로 다시 띄운다. 그 kill 이 만든 exit 는 ipc.ts 의
// core.sessions.onExit 로 흘러 오케스트레이션의 handleExit 에도 도달하는데, 그 함수는 sessionId 로
// Dispatch 를 찾아 닫는다(closeDispatch). 그러면 **Dispatch 는 닫혔는데 워커는 살아서 일하는** 상태가
// 되고, 그 워커의 worker_done 은 받아 줄 열린 Dispatch 를 찾지 못한다. 게다가 닫는 과정에서
// consecutiveFailures 가 올라가 세 번이면 회로가 끊긴다.
//
// **해법.** exit 를 잠깐 미뤄 두고, 그 창 안에 롤 통지가 오면 미뤄 둔 것을 취소한 뒤 Dispatch 의
// 키를 새 세션으로 옮긴다(rekeyDispatch). 미룬 뒤에 도착한 exit 는 옛 id 로 열린 Dispatch 를 찾지
// 못하므로 저절로 no-op 이 된다(closeDispatch 가 ok(state, null) 을 낸다).
//
// **두 번째 책임: 정지 시점 스냅샷.** 이것도 같은 이음매의 일이다 — 정지 스냅샷은 "한 번의 정지에
// 한 번" 이어야 하는데, 한 번의 정지는 롤 상태를 여러 번 게시하므로 세션별 기억이 필요하다. 그
// 기억을 가질 수 있는 자리가 여기다(onRollState 의 주석에 자세히). ipc.ts 에 있던 동안은 이벤트마다
// 새로 시작하는 클로저였고, 그래서 마지막 게시가 정지 시점의 기준점을 덮어썼다.
//
// **이 구조는 Slack 에서 빌려 왔다.** main/slack.ts 가 같은 사건에 같은 방법을 쓴다 — EXIT_DELAY_MS
// 만큼 종료 알림을 미루고 onRolled 에서 그 타이머를 취소한다. 공통 층은 세우지 않는다:
// core/rolling/retry.ts 머리말이 "타이머 수명을 공통 부모로 올리는 것은 이 앱에서 버그를 가장 많이
// 낸 축" 이라고 적어 두었고, 두 구독자가 각자 자기 타이머를 갖는 것이 그 경고를 지키는 모양이다.
import { recordResume, recordStopSnapshot, rekeyDispatch } from '../../core/orchestration/state'
import type { Dispatch } from '../../core/orchestration/types'
import type { RollStateEvent } from '../../core/types'
import { git } from '../../core/worktrees/git'
import { handleExit, type OrchServerDeps } from './server'

/** exit 처리를 미뤄 두는 창.
 *
 *  **Slack 의 EXIT_DELAY_MS 와 같은 값이고 같은 목적이다.** 원리상으로는 훨씬 짧아도 된다 — 롤은
 *  kill → spawn → 재키잉 → send('session:rolled') 를 한 동기 블록에서 하고 PTY exit 는 그 뒤 tick 에
 *  오기 때문이다. 3초를 쓰는 이유는 여유가 아니라 **일치**다: 같은 사건을 같은 창으로 보는 두
 *  구독자가 다른 값을 쓰면 한쪽만 취소된 상태가 존재할 수 있고, 그것을 재현하는 사람은 두 값을
 *  나란히 놓기 전에는 원인을 찾지 못한다.
 *
 *  코디네이터에게 이 지연은 보이지 않는다 — check --wait 의 기본 창은 300초다
 *  (DEFAULT_CHECK_TIMEOUT_MS). */
export const EXIT_DEFER_MS = 3_000

export interface OrchRollTapDeps {
  /** git 실행 어댑터. gitSummary.ts 의 `GitSummaryDeps.git` 과 같은 관례 — 테스트 주입용이고,
   *  넘기지 않으면 실제 git(core/worktrees/git.ts)을 쓴다. */
  git?: typeof git
}

export class OrchRollTap {
  /** 미뤄 둔 exit. 키는 **옛** 세션 id 다 */
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 지금 정지 에피소드 안에 있는 세션들. 정지 스냅샷을 **에피소드에 들어갈 때 한 번만** 남기기
   *  위한 기억이고, 이 클래스가 그것을 가질 수 있는 유일한 자리다(ipc.ts 의 탭은 이벤트마다 새로
   *  시작하는 클로저였다).
   *
   *  키가 롤과 함께 옮겨 다닌다 — onRolled 에서 옛 id 의 표시를 새 id 로 이관한다. 한 에피소드는
   *  옛 세션에서 시작해 새 세션에서 끝나기 때문이다(정지→kill→respawn→재개).
   *
   *  **`'nudged'` 를 재개로 볼지 가르는 판별자도 겸한다** — onRollState 의 'nudged' 처리를 보라.
   *  이 세션에 정지가 기록돼 있을 때만 재개도 기록한다. */
  private stopped = new Set<string>()
  private readonly git: typeof git

  constructor(
    private deps: OrchServerDeps,
    tapDeps: OrchRollTapDeps = {}
  ) {
    this.git = tapDeps.git ?? git
  }

  /** 세션 종료. 곧바로 처리하지 않고 EXIT_DEFER_MS 뒤에 handleExit 을 부른다. */
  onExit(e: { sessionId: string; exitCode: number }): void {
    // 같은 세션의 두 번째 exit 는 무시한다 — 창을 다시 늘리면 첫 exit 가 그만큼 늦어진다.
    // slack.ts 의 `if (record.exitTimer) return` 과 같은 검사다.
    if (this.timers.has(e.sessionId)) return
    this.timers.set(
      e.sessionId,
      setTimeout(() => {
        this.timers.delete(e.sessionId)
        // handleExit 은 비동기이고(probeLimit 의 파일 읽기 + setState 의 디스크 쓰기) 타이머 콜백은
        // 그것을 기다려 줄 자리가 없다. 잡히지 않은 rejection 은 프로세스를 죽이므로 ipc.ts 의 기존
        // 호출과 같은 .catch 관례를 따른다.
        void handleExit(this.deps, e).catch((err) =>
          this.deps.log?.(`handleExit failed session=${e.sessionId}: ${String(err)}`)
        )
      }, EXIT_DEFER_MS)
    )
  }

  /** 롤링 전환. 열린 Dispatch 를 새 세션·계정으로 옮기고, **그것이 실제로 성공했을 때만** 미뤄 둔
   *  exit 를 취소한다. 반환값은 재키잉된 Dispatch — 옮길 것이 없었거나 실패했으면 null 이다.
   *
   *  **취소를 rekeyDispatch 성공 뒤로 미루는 이유.** 거절 경로(다른 열린 Dispatch 가 이미 그
   *  세션 id 를 쓰고 있는 경우)에서 먼저 취소해 버리면 Dispatch 는 죽은 옛 세션 id 에 묶인 채
   *  남고, 그것을 닫을 유일한 길(미뤄 둔 exit)까지 함께 버려진다 — 열려 있는데 아무도 닫지 않는
   *  Dispatch 가 영원히 남는다. 거절 경로와 "옮길 Dispatch 가 없었다" 경로 모두 이 함수는 타이머를
   *  건드리지 않고 그대로 반환한다: 옛 세션은 어차피 죽었으므로, 미뤄 둔 exit 가 창 끝에 도착해
   *  (열려 있던 경우) Dispatch 를 정상적으로 닫아 준다.
   *
   *  **취소는 rekeyDispatch 가 ok 를 낸 뒤, setState 커밋 *전*에 한다.** 커밋이 실패해도 타이머를
   *  되살리지 않는다 — 되살려도 다시 올 exit 가 없다(옛 세션은 이미 죽었고, 그 죽음이 만든 exit는
   *  이 함수를 부르기 전에 이미 소비됐다). setState 실패는 로그로만 남고, 그 Dispatch 는 열린
   *  채(옛 세션 id 로) 남아 다음 앱 재시작의 outcome_unknown 정리(store.load)가 맡는다 — dispose()
   *  가 미뤄 둔 exit 를 버릴 때와 같은 결말이다.
   *
   *  **던지지 않는다** — 부르는 쪽은 롤링의 send 탭이고, 거기서 예외가 새면 롤 자체가 막힌다. */
  async onRolled(
    oldSessionId: string,
    newInfo: { id: string; accountId: string }
  ): Promise<Dispatch | null> {
    // 정지 에피소드 표시를 새 세션 id 로 옮긴다. **재키잉 성공 여부와 무관하다** — 이 표시는
    // Dispatch 가 아니라 *이벤트 흐름*을 따라가는 것이고, 롤 뒤의 'switching'(reattach)·'none' 은
    // 재키잉이 어떻게 됐든 새 id 로 온다. 옮기지 않으면 옛 id 의 표시가 그것을 지울 'none' 을
    // 영원히 못 만나고, 새 id 는 표시가 없어 respawn 직후의 게시를 새 정지로 오인한다.
    if (this.stopped.delete(oldSessionId)) this.stopped.add(newInfo.id)
    const now = this.deps.now?.() ?? new Date().toISOString()
    const r = rekeyDispatch(
      this.deps.getState(),
      { oldSessionId, newSessionId: newInfo.id, accountId: newInfo.accountId },
      now
    )
    if (!r.ok) {
      this.deps.log?.(`dispatch rekey rejected ${oldSessionId} -> ${newInfo.id}: ${r.error}`)
      return null
    }
    if (r.value === null) return null // 워커 세션이 아니었다 — 사용자 탭 세션의 롤이 그렇다
    // 여기서부터는 재키잉이 확정이다 — 미뤄 둔 exit 를 지금 취소한다. setState 가 실패해도(아래
    // catch) 되돌리지 않는다: 커밋이 안 됐다고 다시 무장하면, 그 사이에 도착한 exit 가 옛 id 로
    // Dispatch 를 찾아 닫아 버려 재키잉 재시도와 경합한다.
    const timer = this.timers.get(oldSessionId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(oldSessionId)
    }
    try {
      await this.deps.setState(r.state)
    } catch (err) {
      this.deps.log?.(`dispatch rekey commit failed dispatch=${r.value.id}: ${String(err)}`)
      return null
    }
    this.deps.log?.(
      `dispatch ${r.value.id} rekeyed ${oldSessionId} -> ${newInfo.id} account=${newInfo.accountId}`
    )
    // 계정이 바뀌는 재개다 — 세션 id 도 새것으로 옮겨졌으므로 이력은 새 세션 id·새 계정으로 닫는다.
    // recordResume 안에 넣지 않은 이유는 이 함수의 머리말과 같다: 그 함수는 순수 core 이고 시각을
    // 모른다. 정지가 기록돼 있지 않으면(사용자 탭 세션이거나, 정지 없이 롤된 경우) recordResume 이
    // 조용히 no-op 한다 — rekeyDispatch 자신과 같은 관례라 여기서 따로 가를 필요가 없다.
    const resumed = recordResume(
      this.deps.getState(),
      { sessionId: newInfo.id, accountId: newInfo.accountId },
      now
    )
    if (resumed.ok && resumed.value !== null) {
      try {
        await this.deps.setState(resumed.state)
      } catch (err) {
        this.deps.log?.(`resume record commit failed dispatch=${r.value.id}: ${String(err)}`)
      }
    }
    return r.value
  }

  /** 롤 상태 게시. **정지 에피소드에 들어갈 때 한 번만** 정지 스냅샷을 남긴다.
   *
   *  **왜 필터가 이렇게 촘촘한가.** 한 번의 정지는 롤 상태를 여러 번 게시한다. 계정을 바꾸는 롤은
   *  'switching' 을 **두 번** 낸다 — kill 앞에서 한 번(옛 세션 id), respawn 뒤에 배너를 새 세션에
   *  다시 붙이며 한 번(`reattach: true`). 리셋을 기다리는 정지는 'waiting' 을 먼저 내고, 그
   *  대기가 끝나 계정을 바꾸게 되면 그 뒤에 'switching' 을 또 낸다. 이 게시마다 스냅샷을 남기면
   *  기준점이 **정지 시점에서 재개 직전으로 밀린다** — 그러면 `worktreeMoved` 는 "respawn 몇 초
   *  전의 HEAD" 를 "지금의 HEAD" 와 비교하고, 그 둘은 당연히 같아서 브리핑이 "네가 멈춘 뒤로
   *  워크트리는 바뀌지 않았다" 를 **확인하지 않은 채 사실로 단정한다**. 몇 시간을 기다리는 동안
   *  사람이 같은 디렉터리에서 편집하는 것이 흔한, 바로 그 경우에.
   *
   *  `reattach` 만 걸러서는 부족하다 — kill 앞의 'switching' 은 reattach 가 아니면서 앞선
   *  'waiting' 을 덮어쓴다. 그래서 세션별 기억(`stopped`)이 필요하다.
   *
   *  **에피소드는 'none' 또는 'stalled' 로 끝난다.**
   *   - 'none' — 두 코디네이터 모두 재개가 실제로 이뤄진 뒤에 게시한다(in-place 재개·idle nudge·
   *     리셋 앵커는 Enter 뒤, claude 롤은 auto-prompt 뒤, codex 롤은 롤 끝에서). 포기하는 갈래에서도
   *     게시한다(롤 중단·롤 실패·체인 dispose).
   *   - 'stalled' — 재개가 듣지 않았다는 **판정**이다. 그 회복 시도는 그것으로 끝나고 **뒤에 'none'
   *     이 오지 않는다** — rolling.ts 의 두 게시 자리(scheduleAutoPrompt 의 auto-prompt 타임아웃,
   *     idleNudgeCheck 의 nudge 후 재정지)가 모두 'stalled' 를 게시하고 곧바로 return 한다. 앞쪽은
   *     **롤 경로**다: kill·respawn 까지 갔는데 ready 신호가 끝내 오지 않은 경우다. 이것을 끝으로
   *     세지 않으면 그 세션의 표시가 영구히 남아, **다음 정지가
   *     전부 건너뛰어진다** — 그러면 Checkpoint 는 몇 시간 전 에피소드의 기준점과 리셋 시각을 계속
   *     재사용한다.
   *
   *  나머지는 전부 에피소드 *안*에서 일어난다: 'trust' 는 respawn 뒤 신뢰 프롬프트를 받는 중이고,
   *  'nudged' 는 재개 프롬프트를 보내기 직전이다.
   *
   *  **완벽하지 않다는 것을 적어 둔다.** 네 재개 경로의 'none' 은 조건부다(`chain.stateSeq === stateSeq`)
   *  — Enter 를 기다리는 150ms 사이에 다른 상태가 게시되면 그 'none' 은 건너뛰어진다. 그때 표시는
   *  다음 'none'/'stalled' 까지 남는다. 그 방향은 안전한 쪽으로만 틀린다: 기준점이 **더 옛것**이
   *  되므로 "워크트리가 바뀌었다" 를 과하게 말할 수 있을 뿐, "바뀌지 않았다" 를 잘못 말하지는
   *  않는다. 눈에 보이는 잔여물 — 이미 지난 리셋 시각 — 은 조립 쪽에서 막는다
   *  (core/orchestration/checkpoint.ts 의 upcomingResetsAt).
   *
   *  **던지지 않는다** — 부르는 쪽은 롤링의 send 탭이고, 거기서 예외가 새면 롤 자체가 막힌다.
   *  스냅샷 기록은 비동기라 던져 놓고 간다(그 자리에서 기다릴 수 없다). 실패해도 로그만 남긴다:
   *  스냅샷이 없으면 `worktreeMoved` 가 null(모른다)이 되고, 그것이 정확히 옳은 결과다. */
  onRollState(e: RollStateEvent): void {
    if (e.state === 'none' || e.state === 'stalled') {
      this.stopped.delete(e.sessionId)
      return
    }
    // 'nudged' = 같은 계정에서 제자리 재개했다(claude 의 resumeInPlace, codex 의 resumeInPlace).
    // 세션 id 가 바뀌지 않아 `session:rolled` 가 오지 않으므로, 계정을 유지하는 재개에서는 **이
    // 이벤트가 유일한 신호다.** 여기서 버리면 계정 하나짜리 워커는 몇 번 이어졌는지가 영원히
    // 기록되지 않는다.
    //
    // **`stopped` 로 가른다.** `'nudged'` 는 이 경로 말고도 두 곳에서 더 온다 — idle stall nudge
    // (한도와 무관한 재촉)와 reset anchor(그 가드가 대기 중이 아닐 때만 닿으므로, 여기 온 것은
    // 'waiting'/'switching' 없이 온 것이다). 그 둘은 이 세션에 정지를 남기지 않았으므로 `stopped`
    // 에 없다 — 표식이 없으면 이력을 지어내지 않고 조용히 넘긴다. `Set.delete` 는 지우면서 있었는지도
    // 함께 알려 주므로 그 반환값을 판별자로 쓴다.
    if (e.state === 'nudged') {
      if (!this.stopped.delete(e.sessionId)) return
      void this.recordResumed(e.sessionId).catch((err) =>
        this.deps.log?.(`resume record failed session=${e.sessionId}: ${String(err)}`)
      )
      return
    }
    if (e.state !== 'waiting' && e.state !== 'switching') return
    if (e.reattach) return
    if (this.stopped.has(e.sessionId)) return
    this.stopped.add(e.sessionId)
    void this.recordStop(e.sessionId, e.state, e.nextRetryAt).catch((err) =>
      this.deps.log?.(`stop snapshot failed session=${e.sessionId}: ${String(err)}`)
    )
  }

  /** 정지 시점의 HEAD 를 읽어 열린 Dispatch 에 남긴다. HEAD 하나만 읽는 이유는 SPEC §8 에 있다 —
   *  나머지 Checkpoint 재료는 대기가 몇 시간이어도 디스크에 그대로 있고 재개 직전에 읽는 것이 더
   *  정확하다. 정지 사유와 리셋 시각은 읽는 것이 아니라 이 이벤트가 들고 온 것이다. */
  private async recordStop(
    sessionId: string,
    reason: 'waiting' | 'switching',
    nextRetryAt: string | undefined
  ): Promise<void> {
    const dispatch = this.deps
      .getState()
      .dispatches.find((d) => d.sessionId === sessionId && !d.endedAt)
    if (!dispatch) return // Job 워커가 아니다(사용자 탭 세션) — 잡을 것이 없다
    const head = await this.git(['rev-parse', 'HEAD'], { cwd: dispatch.cwd })
    // 위 await 사이에 다른 커밋이 있었을 수 있다 — 반영할 상태는 다시 읽는다(onRolled 와 같은 관례).
    const r = recordStopSnapshot(
      this.deps.getState(),
      {
        sessionId,
        headCommit: head.ok && head.stdout !== '' ? head.stdout : null,
        reason,
        ...(nextRetryAt !== undefined ? { resetsAt: nextRetryAt } : {})
      },
      this.deps.now?.() ?? new Date().toISOString()
    )
    if (!r.ok || r.value === null) return
    await this.deps.setState(r.state)
  }

  /** `'nudged'` 재개를 이력의 마지막 항목에 닫는다. 계정은 바뀌지 않았으므로 지금 Dispatch 가
   *  들고 있는 계정을 그대로 쓴다 — recordStop 이 Dispatch 를 찾는 것과 같은 관례다. */
  private async recordResumed(sessionId: string): Promise<void> {
    const state = this.deps.getState()
    const dispatch = state.dispatches.find((d) => d.sessionId === sessionId && !d.endedAt)
    if (!dispatch) return // Job 워커가 아니다(사용자 탭 세션) — 잡을 것이 없다
    const r = recordResume(
      state,
      { sessionId, accountId: dispatch.accountId },
      this.deps.now?.() ?? new Date().toISOString()
    )
    if (!r.ok || r.value === null) return
    await this.deps.setState(r.state)
  }

  /** 오케스트레이션/앱 종료. 미뤄 둔 exit 는 **버린다** — 열린 채 남은 Dispatch 는 다음 실행에서
   *  store.load 가 outcome_unknown 으로 정리한다. 그것이 이미 정해진 정책이므로 여기서 서둘러
   *  닫으려 하지 않는다(닫으려 해도 setState 가 끝날 보장이 없다 — will-quit 는 동기다). */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    this.stopped.clear()
  }
}
