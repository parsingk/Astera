// 한 Run 의 Task 를 의존 깊이로 묶는다. 상세 창의 그래프가 이 층을 줄로 그린다.
//
// view.ts·timeline.ts 와 같은 층이고 같은 이유로 여기 있다 — 렌더러에는 테스트가 없으므로
// 화면이 필요로 하는 판정은 전부 이쪽에 있어야 한다.
import type { OrchState } from './state'

/** 의존 깊이별 Task id, 이 Run 안에서만 유효한 의존 목록, 그리고 깊이를 정할 수 없었던 것들.
 *
 *  깊이는 "모든 의존의 깊이 + 1" 의 최댓값이다 — 가장 깊은 의존을 따라야 어떤 Task 도 자기가
 *  기다리는 것보다 위에 그려지지 않는다.
 *
 *  **deps 를 함께 돌려주는 이유는 선이다.** 층만으로는 어느 노드가 어느 노드를 기다리는지 정해지지
 *  않는다 — N 층의 Task 는 N-1 층에 의존을 적어도 하나 갖지만 그 층 전부에 갖지는 않고, 층을
 *  건너뛰는 의존도 있다. 층 사이를 전부 이으면 상세 창이 있지도 않은 의존을 청록으로 그리게 되고,
 *  그러면 "선의 색이 대기의 이유"라는 이 화면의 주장이 거짓이 된다. Run 밖을 가리키는 deps 를
 *  걸러내는 규칙이 이미 여기 있으므로 여기서 함께 내보낸다 — 렌더러나 ipc 가 그 규칙을 다시 쓰면
 *  둘이 갈라진다.
 *
 *  **cyclic 은 버그를 드러내는 자리다.** deps 에 순환이 있으면 깊이가 정의되지 않는데,
 *  순환은 코디네이터의 실수이고 지금 아무도 잡아 주지 않는다(createTask 는 deps 를 검사하지 않고,
 *  recomputeReady 는 그 Task 들을 영원히 pending 에 둔다 — 증상은 "아무 이유 없이 안 도는 Task" 다).
 *  그래서 조용히 버리지 않고 따로 돌려주며, 상세 창이 그것을 보여준다. */
export function layersOf(
  state: OrchState,
  runId: string
): { layers: string[][]; deps: Record<string, string[]>; cyclic: string[] } {
  // createdAt 순서로 훑는다 — 층 안의 순서가 곧 코디네이터가 선언한 순서가 된다(snapshotFor 와 같은 규칙)
  const tasks = state.tasks
    .filter((t) => t.runId === runId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const own = new Set(tasks.map((t) => t.id))
  // 이 Run 밖을 가리키는 deps 는 버린다. Run 은 독립한 이름공간이고, 다른 Run 의 Task 가 이 Run 의
  // 순서를 정하게 두면 그 Run 이 지워졌을 때 이 그림이 무너진다.
  const deps = new Map(tasks.map((t) => [t.id, t.deps.filter((d) => own.has(d))]))

  const depth = new Map<string, number>()
  let rest = tasks.map((t) => t.id)
  for (;;) {
    const next: string[] = []
    for (const id of rest) {
      const ds = deps.get(id)!
      if (!ds.every((d) => depth.has(d))) {
        next.push(id)
        continue
      }
      depth.set(id, ds.length === 0 ? 0 : Math.max(...ds.map((d) => depth.get(d)!)) + 1)
    }
    // 한 바퀴에 하나도 못 정했으면 남은 것은 전부 순환이거나 그 뒤에 매달린 것이다
    if (next.length === rest.length) break
    rest = next
    if (rest.length === 0) break
  }

  const depthOf = [...depth.values()]
  const layers: string[][] = Array.from(
    { length: depthOf.length === 0 ? 0 : Math.max(...depthOf) + 1 },
    () => []
  )
  for (const t of tasks) {
    const d = depth.get(t.id)
    if (d !== undefined) layers[d].push(t.id)
  }
  return { layers, deps: Object.fromEntries(deps), cyclic: rest }
}
