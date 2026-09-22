// 옛 모양(`Run` 하나에 계획과 실행이 함께 있던)으로 적은 상태를 지금 모양으로 옮긴다.
//
// **테스트를 위한 것이다** — core/testPaths.ts 와 같은 갈래로, 프로덕션 경로에서는 부르지 않는다.
// 분리 이전에 쓰인 테스트가 수십 개이고 그 대부분은 Job 과 회차의 구분을 검사하지 않는다(수렴 정책,
// 그래프 층, 타임라인, 받은 편지함…). 그 파일들이 본문을 그대로 둔 채 계속 자기 일을 검사하게 하는
// 것이 이 함수의 목적이고, 덤으로 그 테스트들이 이행 자체도 한 번씩 지나간다.
//
// 새로 쓰는 테스트는 이것을 쓰지 말고 `jobs` 와 `runs` 를 직접 적는다 — 두 층의 구분이 곧 검사
// 대상인 테스트에서 이 함수는 그 구분을 가려 버린다.
import { splitLegacyRuns, type LegacyRun } from './legacy'
import { emptyState, type OrchState } from './state'
import type { Task } from './types'

export function stateFromLegacy(
  over: Omit<Partial<OrchState>, 'runs' | 'tasks' | 'jobs'> & {
    runs?: LegacyRun[]
    tasks?: Task[]
  } = {}
): OrchState {
  const { runs = [], tasks = [], ...rest } = over
  // **id 를 주입하지 않는다.** `run_1` 이 `job_run_1` 이 되는 것은 이제 splitLegacyRuns 의 기본값이고
  // (legacy.ts 의 jobIdForLegacyRun), 여기서 한 벌 더 세면 그것이 곧 세는 자리가 된다 — 실제로
  // 그랬다: 여기 있던 카운터는 부모를 찾은 회차까지 세어서, 고아 회차가 섞이면 남의 id 를 집었다.
  const split = splitLegacyRuns(runs, tasks)
  return { ...emptyState(), ...rest, ...split }
}
