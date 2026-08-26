import type { Account, Provider } from '../types'
import { providerOf } from '../providers/meta'
import { defaultAccountIdOf } from './defaultAccount'

/** 워커를 띄울 계정을 못 골랐을 때의 이유. 부르는 쪽이 이것으로 사람에게 할 말을 고른다 —
 *  "고른 계정을 못 쓴다"와 "쓸 계정이 아예 없다"는 사람이 해야 할 일이 다르다. */
export type NoDispatchAccount = 'assigned-unusable' | 'none-logged-in'

/**
 * 이 Task 의 워커를 어느 계정으로 띄울까.
 *
 * **defaultAccountIdOf 와 다른 질문이다.** 그 함수는 "이 provider 의 **대표** 계정"을 답하고, 그
 * 답은 ⤓ 설정 가져오기가 복사해 오는 원본이자 UI 가 `default` 배지를 붙이는 계정이다(그 파일의
 * 주석). 그 값이 일마다 돌아다니면 설정 가져오기의 원본이 바뀌고 배지가 움직인다. 그래서 이 질문은
 * 따로 두고, 지정이 없을 때만 그 함수에 기댄다.
 *
 * **지정이 있으면 그것이 이긴다.** 사람이 계정을 고른 것은 다른 계정을 피하려는 뜻일 수 있으므로,
 * 그 계정을 못 쓸 때 말없이 기본 계정으로 갈아타지 않는다 — 아끼려던 계정에 일이 가는 것은 고르지
 * 않은 것보다 나쁘다. 실패로 답하고, 부르는 쪽이 Gate 를 연다(ipc.ts 의 gateSlot — 스케줄러가
 * "로그인된 계정이 없다"에 이미 그렇게 한다).
 *
 * **provider 가 어긋난 지정도 실패다.** task-create 가 그 조합을 거절하지만 입력은 명령이 아니라
 * 파일이다 — orchestration.json 은 프로세스보다 오래 살고 손으로 고쳐진다(schedule.ts 가 provider
 * 없는 Run 을 다루는 것, graph.ts 가 순환을 다루는 것과 같은 이유).
 *
 * **지정은 하나가 아니라 순서 있는 목록이다.** 첫 계정으로 띄우고, 나머지는 한도에 걸렸을 때
 * 갈아탈 순서다 — 이 답의 `chain` 이 그 순서이고 배선이 그것을 세션의 롤링 체인(rollAccountIds)
 * 으로 넘긴다. 쓸 수 없는 칸은 빼고 나머지로 진행한다: 사람이 고른 것 안에서 도는 것은 위 교리를
 * 어기지 않는다. 하나도 남지 않을 때만 실패다.
 */
export function accountToDispatchOn(a: {
  /** Task.accountIds — 사람이 이 Task 에 지정해 둔 계정들, **순서대로**. 없거나 비면 기본 계정으로
   *  간다. 첫 계정으로 띄우고, 나머지는 한도에 걸렸을 때 갈아탈 순서다(rollAccountIds). */
  assigned?: readonly string[]
  /** Run 이 정한 provider. 지정된 계정은 이것과 같은 provider 여야 한다 */
  provider: Provider
  accounts: readonly Account[]
  loggedInIds: ReadonlySet<string>
}): { ok: true; accountId: string; chain: string[] } | { ok: false; reason: NoDispatchAccount } {
  if (a.assigned !== undefined && a.assigned.length > 0) {
    // **쓸 수 없는 칸은 빼고 나머지로 진행한다.** 위 교리("말없이 기본 계정으로 갈아타지 않는다")는
    // *고르지 않은* 계정에 일을 보내지 않는다는 뜻이다 — 사람이 a→b 를 골랐고 b 가 로그아웃돼 있으면
    // a 로 도는 것은 그가 고른 것 안에 있다. 하나도 남지 않을 때만 실패다.
    // **중복을 접는 이유**: 같은 계정이 두 칸이면 RollCycle 은 두 계정인 줄 알고 한 바퀴를 세고,
    // pickAvailable 은 현재 칸을 건너뛰므로 "갈아탄" 결과가 같은 계정이 된다. 명령은 중복을 거절하지만
    // 입력은 명령이 아니라 파일이다(이 파일의 provider 어긋남 단락과 같은 이유).
    const seen = new Set<string>()
    const chain: string[] = []
    for (const id of a.assigned) {
      if (seen.has(id)) continue
      seen.add(id)
      const account = a.accounts.find((x) => x.id === id)
      if (account === undefined) continue
      if (providerOf(account) !== a.provider) continue
      if (!a.loggedInIds.has(account.id)) continue
      chain.push(account.id)
    }
    return chain.length > 0
      ? { ok: true, accountId: chain[0], chain }
      : { ok: false, reason: 'assigned-unusable' }
  }
  const fallback = defaultAccountIdOf(a.provider, a.accounts, a.loggedInIds)
  return fallback
    ? { ok: true, accountId: fallback, chain: [fallback] }
    : { ok: false, reason: 'none-logged-in' }
}
