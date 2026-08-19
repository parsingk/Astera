// 검토를 누구에게 맡기는가. 순수 함수이고 배선이 계정 목록과 로그인 여부를 모아 부른다 —
// 그 둘은 main 의 것이라(core.accounts) 이 층이 직접 읽지 않는다.
import { defaultAccountIdOf } from '../accounts/defaultAccount'
import { PROVIDERS } from '../providers/meta'
import type { Account, Provider } from '../types'

/** 구현자와 **다른** provider 의 계정 하나. 없으면 null(그것이 Gate 가 된다).
 *
 *  자기 코드를 자기가 읽으면 같은 맹점을 두 번 지나므로 provider 를 갈라야 한다.
 *
 *  **계정 선택 규칙을 새로 만들지 않는다.** defaultAccountIdOf 가 "그 provider 의 가장 먼저 등록된
 *  로그인 계정"을 이미 정의하고, UI 가 default 배지를 붙이는 계정도 그것이다 — 여기에 두 번째 규칙을
 *  두면 화면이 가리키는 계정과 검토가 쓰는 계정이 갈라진다.
 *
 *  provider 를 PROVIDERS 순서로 훑는다. 지금 둘뿐이라 순서가 곧 우선순위이고, 그 우선순위를
 *  정교하게 만드는 것은 4단계(Account Pool)의 일이다 — quota 와 성공률로 고르게 된다. */
export function pickReviewer(a: {
  implProvider: Provider
  accounts: readonly Account[]
  loggedInIds: ReadonlySet<string>
}): { provider: Provider; accountId: string } | null {
  for (const provider of PROVIDERS) {
    if (provider === a.implProvider) continue
    const accountId = defaultAccountIdOf(provider, a.accounts, a.loggedInIds)
    if (accountId) return { provider, accountId }
  }
  return null
}
