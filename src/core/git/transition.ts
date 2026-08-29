// HEAD/브랜치가 어떻게 움직였는가 — EG §22.
//
// git 을 **실행하지 않는다.** 조상 관계는 부르는 쪽(main)이 `git merge-base --is-ancestor` 로
// 물어 그 답을 넘긴다. core 는 node: 모듈을 끌고 오지 않는다는 이 저장소의 규약이고,
// 덕분에 이 판정이 프로세스 없이 전수 테스트된다.
import type { GitRef, GitTransitionType } from './types'

/**
 * @param isAncestor `before.head` 가 `after.head` 의 조상인가. **git 이 답하지 못했으면 null** —
 *   물을 수 없었던 경우(before.head 가 없다)와 물었는데 실패한 경우를 부르는 쪽이 구별하지
 *   않아도 되도록 한 값으로 받는다. 어느 쪽이든 답은 `unknown` 이다.
 *
 * merge 와 cherry-pick 을 따로 가리지 않는 이유: 둘 다 fast-forward 아니면 history-rewritten 으로
 * 떨어지고, 그 구별은 EG §38 이 V2 로 둔 것이다. 여기서 추측으로 이름을 붙이면 EG §22 의
 * "정확한 transition type 을 판별할 수 없으면 unknown 을 사용한다. 억지로 추정하지 않는다" 를 어긴다.
 */
export function classifyTransition(
  before: GitRef,
  after: GitRef,
  isAncestor: boolean | null
): GitTransitionType {
  if (before.branch !== after.branch) return 'branch-switch'
  if (before.head === after.head) return 'none'
  if (isAncestor === null) return 'unknown'
  return isAncestor ? 'fast-forward' : 'history-rewritten'
}
