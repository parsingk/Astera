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
// **이 구조는 Slack 에서 빌려 왔다.** main/slack.ts 가 같은 사건에 같은 방법을 쓴다 — EXIT_DELAY_MS
// 만큼 종료 알림을 미루고 onRolled 에서 그 타이머를 취소한다. 공통 층은 세우지 않는다:
// core/rolling/retry.ts 머리말이 "타이머 수명을 공통 부모로 올리는 것은 이 앱에서 버그를 가장 많이
// 낸 축" 이라고 적어 두었고, 두 구독자가 각자 자기 타이머를 갖는 것이 그 경고를 지키는 모양이다.
import { rekeyDispatch } from '../../core/orchestration/state'
import type { Dispatch } from '../../core/orchestration/types'
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

export class OrchRollTap {
  /** 미뤄 둔 exit. 키는 **옛** 세션 id 다 */
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private deps: OrchServerDeps) {}

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
    return r.value
  }

  /** 오케스트레이션/앱 종료. 미뤄 둔 exit 는 **버린다** — 열린 채 남은 Dispatch 는 다음 실행에서
   *  store.load 가 outcome_unknown 으로 정리한다. 그것이 이미 정해진 정책이므로 여기서 서둘러
   *  닫으려 하지 않는다(닫으려 해도 setState 가 끝날 보장이 없다 — will-quit 는 동기다). */
  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
