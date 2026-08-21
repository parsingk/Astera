// 이미 접힌 OrchSnapshot 안에서 Run 하나를 찾는다. **회차가 최상위 runs 에 없기 때문에 필요하다** —
// snapshotFor(view.ts)는 예약 회차를 템플릿의 children 으로 접으면서 최상위 배열에서 빼므로,
// `snapshot.runs.find(...)` 는 회차를 절대 찾지 못한다. 그 조회 하나로 상세 창은 run 없이 한 프레임
// 그려지고 곧 닫히고(App.tsx 의 "스냅샷에 없으면 닫는다" 효과가 같은 조회를 쓴다), 지우기는 조용히
// 아무 일도 하지 않는다. 회차에서 Gate 응답·재시도·워커 정지가 되어야 한다는 것이 이 기능의 결정
// 중 하나이므로(설계 2절) 그 조회를 한 자리에 모은다.
//
// **이 파일이 view.ts 와 갈라져 있는 이유**는 그쪽이 node:path 를 끌고 와(isSamePath, repoPathOf)
// tsconfig.web.json 에 들어갈 수 없다는 것이다. 여기는 ../types 의 타입만 import 하므로 렌더러가
// 그대로 쓴다 — core/scheduler/summary.ts 가 같은 이유로 같은 자리에 있다.
import type { JobRun, OrchSnapshot } from '../types'

/** 최상위 Run 을 먼저 보고, 없으면 각 Run 의 회차를 본다. 없으면 undefined — "스냅샷에 없다"를
 *  부르는 쪽이 그대로 다루게 한다(App.tsx 의 네 자리가 각자 다르게 다룬다: 조회를 미루고, 창을
 *  닫고, 지우기를 건너뛰고, 그래프에 undefined 를 넘긴다).
 *
 *  회차의 회차는 찾지 않는다 — 한 단계뿐인 것이 자료 모형이다(자식에는 schedule 을 넣지 않으므로
 *  자식이 다시 템플릿이 되지 않는다, spawnScheduledRun). */
export function findRun(snapshot: OrchSnapshot, runId: string): JobRun | undefined {
  const top = snapshot.runs.find((r) => r.id === runId)
  if (top) return top
  for (const run of snapshot.runs) {
    const kid = run.children?.find((k) => k.id === runId)
    if (kid) return kid
  }
  return undefined
}
