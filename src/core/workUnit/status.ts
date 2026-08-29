import type { WorkUnitStatus } from './types'

/** 이 Unit 이 아직 메시지를 받을 수 있는가.
 *
 *  **completed-candidate 도 열려 있다.** 그 상태는 "에이전트가 조용해졌고 무언가 바뀌었다" 일 뿐
 *  아직 확정이 아니고, 확정하는 것은 다음 사용자 메시지다(WU §6). 그 메시지가 오기 전까지는
 *  같은 Unit 의 것이다. */
export const isOpen = (status: WorkUnitStatus): boolean =>
  status === 'active' || status === 'completed-candidate'
