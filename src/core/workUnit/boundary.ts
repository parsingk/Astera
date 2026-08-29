// 새 사용자 메시지가 왔을 때 Work Unit 을 어떻게 하는가 — WU §13 의 세 경우.
// 렌더러가 아니라 core 에 있는 이유는 graphLayout.ts 와 같다: 규칙이 있는 계산은 테스트가 닿는
// 자리에 있어야 한다.
import type { WorkUnitStatus } from './types'
import { isOpen } from './status'

export type BoundaryDecision =
  /** Case A — 열린 Unit 이 없다. 이 메시지가 새 Unit 을 연다 */
  | { kind: 'open' }
  /** Case B — 완료 후보를 확정하고 이 메시지로 새 Unit 을 연다 */
  | { kind: 'close-and-open' }
  /** Case C — 진행 중인 Unit 에 붙인다 */
  | { kind: 'append' }

/** **V1 은 메시지를 분류하지 않는다.** WU §4 의 다섯 종류(NEW_GOAL/REFINEMENT/CONSTRAINT/
 *  CORRECTION/QUESTION)를 가리려면 분류기가 필요하고 그것은 WU §22 의 V2 다. 그래서 이 함수는
 *  메시지 내용을 아예 받지 않는다 — 받으면 쓰고 싶어지고, 쓰면 근거 없는 판정이 된다.
 *
 *  질문이 Unit 을 여는 문제(WU §4.5)는 여기서 막지 않고 completion.ts 가 처리한다: 관찰된 변경이
 *  없는 채로 닫히는 Unit 은 `abandoned` 가 되어 하류로 흐르지 않는다(스펙 §7). */
export function decideBoundary(activeStatus: WorkUnitStatus | null): BoundaryDecision {
  if (activeStatus === null || !isOpen(activeStatus)) return { kind: 'open' }
  if (activeStatus === 'completed-candidate') return { kind: 'close-and-open' }
  return { kind: 'append' }
}
