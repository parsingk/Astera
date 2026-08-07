// 이 렌더러의 액션 목록. 플랫폼은 프로세스가 사는 동안 바뀌지 않으므로 한 번만 만들어 공유한다.
// core/keys/binding.ts 가 팩토리인 이유(테스트에서 플랫폼을 고정)는 그대로 살아 있고, 여기는
// 그 팩토리를 렌더러에서 딱 한 번 호출하는 자리다.
import { makeActions } from '../../../core/keys/binding'

export const ACTIONS = makeActions(window.api.platform)
