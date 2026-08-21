// 예약 Job 의 발화 판정. **부수 효과가 없고 같은 입력에 같은 답을 준다** — schedule.ts 의
// slotsToFill 이 순수해야 하는 것과 같은 이유다: 이것을 매다는 자리는 main 의 배선이라
// (src/main/ipc.ts) 테스트가 닿지 않는다.
//
// 다음 발화 시각이 **상태가 아니라 인자**인 것이 이 파일의 핵심이다. 배선이 그 Map 을 메모리에
// 들고 있고 재시작하면 비어 있으므로, 앱이 꺼져 있던 동안의 발화는 무장 단계에서 조용히 사라진다 —
// 그것이 "놓친 발화는 버린다"는 규칙의 구현이고, 세션 스케줄러가 같은 이유로 같은 선택을 했다.
import { nextFireAt } from '../scheduler/rule'
import type { OrchState } from './state'

export interface Fires {
  /** 지금 한 회차를 만들 템플릿 Run 의 id 들 */
  fire: string[]
  /** 이 바퀴가 끝난 뒤의 무장 상태 **전부**. 부르는 쪽은 자기 Map 을 이것으로 갈아 끼운다 —
   *  더하는 것이 아니라 갈아 끼우는 것이라, 상태에서 사라진 템플릿이 저절로 빠진다. */
  arm: Map<string, number>
}

export function firesDue(
  s: OrchState,
  armed: ReadonlyMap<string, number>,
  nowMs: number
): Fires {
  const fire: string[] = []
  const arm = new Map<string, number>()
  for (const run of s.runs) {
    const rule = run.schedule
    // 템플릿만 본다: schedule 이 있고 자신은 회차가 아닌 Run. 자식에는 schedule 을 넣지 않으므로
    // (spawnScheduledRun) 앞의 검사로 충분하지만, 손으로 고친 파일에서 둘 다 가진 Run 이
    // 스스로 회차를 낳는 일은 막는다.
    if (rule === undefined || run.templateId !== undefined) continue
    const next = (): void => {
      const at = nextFireAt(rule, nowMs)
      // isValidRule 이 거절할 규칙이 파일에서 들어온 경우 — 무장하지 않으면 영원히 발화하지
      // 않는다. main/scheduler.ts 의 register 가 같은 자리에서 같은 판단을 한다.
      if (Number.isFinite(at)) arm.set(run.id, at)
    }
    const at = armed.get(run.id)
    // 처음 본 템플릿은 무장만 한다. 여기서 곧바로 발화시키면 앱을 켤 때마다 한 회차가 돈다.
    if (at === undefined) {
      next()
      continue
    }
    if (nowMs < at) {
      arm.set(run.id, at)
      continue
    }
    fire.push(run.id)
    // **재무장은 nowMs 기준이다.** 지난 시각을 기준으로 잡으면 오래 자고 깬 뒤 한 tick 안에서
    // 밀린 회차가 전부 쏟아진다 — 놓친 발화는 버린다는 규칙이 여기서 지켜진다.
    next()
  }
  return { fire, arm }
}
