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
  // **job id 를 그 계획이 나온 옛 Run 의 id 에서 만든다** — `run_1` 이 `job_run_1` 이 된다. 실패한
  // 기대값을 사람이 읽고 어느 입력에서 나온 것인지 바로 알 수 있어야 한다. splitLegacyRuns 는
  // 순서대로 Job 을 만들므로(회차가 아닌 것 먼저, 그다음 고아 회차) 이 순서로 짚어 나가면 맞는다.
  const order = [...runs.filter((r) => r.templateId === undefined), ...runs.filter((r) => r.templateId !== undefined)]
  let n = 0
  const split = splitLegacyRuns(runs, tasks, () => `job_${order[n++]?.id ?? n}`)
  return { ...emptyState(), ...rest, ...split }
}
