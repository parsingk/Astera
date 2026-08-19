// 상세 창 그래프의 자리 계산. 층(graph.ts 의 layersOf)이 준 "층마다 몇 개인가"만으로 노드 상자의
// 좌표와 선의 경로가 정해진다.
//
// 렌더러가 아니라 여기 있는 이유는 elapsed.ts 와 같다 — 렌더러에는 테스트가 없으므로(vitest 가
// environment: 'node' 로 돈다) 규칙이 있는 계산은 테스트가 닿는 자리에 있어야 한다. 순수 함수이고
// node: 모듈을 끌고 오지 않아서 tsconfig.web.json 에 들어간다.

/** 노드 상자의 크기. **렌더러가 이 값을 그대로 style 로 준다** — CSS 에 같은 숫자를 한 번 더 적으면
 *  한쪽만 고쳐졌을 때 선이 상자 가장자리에서 어긋난다(선의 끝점은 이 파일이 계산한다). */
export const NODE_W = 148
export const NODE_H = 32
/** 같은 층에서 칸과 칸 사이 */
const GAP_X = 10
/** 층과 층 사이. 선이 곡선으로 휘려면 세로 여유가 필요하다 */
const GAP_Y = 34

/** 노드 상자의 왼쪽 위 */
export interface GraphBox {
  x: number
  y: number
}

export interface GraphLayout {
  width: number
  height: number
  /** 층별 상자. rows[i][j] 는 counts[i] 의 j 번째다 */
  rows: GraphBox[][]
}

/** 층마다 노드가 몇 개인지만 주면 자리가 정해진다 — 층은 가운데로 모으고 위에서 아래로 쌓는다.
 *
 *  가운데 정렬인 이유는 선이다: 부모와 자식이 같은 세로축 가까이에 있어야 선이 짧고 서로 덜 겹친다.
 *  폭은 가장 넓은 층이 정한다 — 그래야 어느 층도 잘리지 않고, 화면보다 넓어지면 그래프 칸이 가로로
 *  스크롤된다(상자를 줄여서 맞추면 제목이 사라진다). */
export function layoutRows(counts: number[]): GraphLayout {
  const rowWidth = (n: number): number => (n <= 0 ? 0 : n * NODE_W + (n - 1) * GAP_X)
  const width = counts.reduce((max, n) => Math.max(max, rowWidth(n)), 0)
  const rows = counts.map((n, i) =>
    Array.from({ length: Math.max(0, n) }, (_, j) => ({
      // 소수점을 남기지 않는다 — 0.5px 에 걸린 선은 브라우저가 두 픽셀에 나눠 그려 흐리게 보인다
      x: Math.round((width - rowWidth(n)) / 2) + j * (NODE_W + GAP_X),
      y: i * (NODE_H + GAP_Y)
    }))
  )
  const height = counts.length === 0 ? 0 : counts.length * NODE_H + (counts.length - 1) * GAP_Y
  return { width, height, rows }
}

/** 부모 상자의 아래 가운데에서 자식 상자의 위 가운데로 가는 곡선. 두 제어점을 중간 높이에 두므로
 *  선이 상자에서 수직으로 떨어졌다가 휜다 — 층을 건너 이어져도 다른 상자 위를 곧게 가로지르지 않는다. */
export function edgePath(from: GraphBox, to: GraphBox): string {
  const x1 = from.x + NODE_W / 2
  const y1 = from.y + NODE_H
  const x2 = to.x + NODE_W / 2
  const y2 = to.y
  const mid = (y1 + y2) / 2
  return `M${x1} ${y1} C${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`
}
