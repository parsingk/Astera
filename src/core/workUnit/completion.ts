// Work Unit 이 언제 끝나는가 — WU §14 의 종료 규칙.
//
// **에이전트가 "완료했습니다"라고 말하는 것을 듣지 않는다.** WU §5 가 그 말만으로 완료 처리하지
// 말라고 하는데, 이 구현은 아예 그 말을 읽지 않는 것으로 그 요구를 지킨다 — 완료 문구는 언어마다
// 모델마다 프롬프트마다 다르고, 문자열 대조는 조용히 깨지면서 깨진 것을 알릴 방법이 없다.
// 대신 앱이 이미 내는 신호를 쓴다: session:busy 의 유휴 전환, 관찰된 변경 수, 다음 사용자 메시지.
import type { WorkUnitStatus } from './types'

export interface IdleInput {
  status: WorkUnitStatus
  /** 이 Unit 이 열린 뒤 관찰된 변경 파일 수 */
  observedChangeCount: number
  /** 이 프로바이더의 유휴 신호를 믿을 수 있는가 (ProviderDescriptor.busyTitleReliable) */
  idleSignalTrusted: boolean
}

export interface CloseInput {
  observedChangeCount: number
}

/** 에이전트가 한 턴을 끝냈다. 무언가 바뀌었으면 완료 **후보**가 된다 — 확정은 다음 사용자
 *  메시지의 몫이다(WU §6). 바뀐 것이 없으면 그대로 둔다: 읽기만 하다 멈춘 턴일 수 있고,
 *  그것으로 목표가 끝났다고 볼 수 없다. */
export function onAgentIdle(input: IdleInput): WorkUnitStatus {
  if (!input.idleSignalTrusted) return input.status
  if (input.status !== 'active') return input.status
  return input.observedChangeCount > 0 ? 'completed-candidate' : 'active'
}

/** 다음 사용자 메시지가 앞 Unit 을 확정한다 (WU §6, boundary 의 close-and-open) */
export function onBoundaryConfirm(status: WorkUnitStatus): WorkUnitStatus {
  return status === 'completed-candidate' ? 'completed' : status
}

/** 세션이 끝났다 (WU §14-4). 관찰이 여기서 멈추므로 후보로 남기지 않는다 */
export function onSessionEnd(input: CloseInput): WorkUnitStatus {
  return input.observedChangeCount > 0 ? 'completed' : 'abandoned'
}

/** 기능을 껐다 (스펙 §16.1). 세션 종료와 같은 이유로 같은 규칙이다 — 관찰이 멈추면 더 정교해질
 *  길이 없고, `completed-candidate` 는 "다음 메시지가 확정해 준다"는 약속인데 껐다 켜면 그 사이가
 *  비어 있어 지킬 수 없는 약속이 된다. */
export function onFeatureDisabled(input: CloseInput): WorkUnitStatus {
  return onSessionEnd(input)
}
