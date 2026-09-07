// 상세 창 그래프의 자리 계산. 층(graph.ts 의 layersOf)이 준 "층마다 몇 개인가"만으로 노드 상자의
// 좌표와 선의 경로가 정해진다 — 이제 층을 감싸는 띠의 사각형도 함께 나온다.
//
// 렌더러가 아니라 여기 있는 이유는 elapsed.ts 와 같다 — 렌더러에는 테스트가 없으므로(vitest 가
// environment: 'node' 로 돈다) 규칙이 있는 계산은 테스트가 닿는 자리에 있어야 한다. 순수 함수이고
// node: 모듈을 끌고 오지 않아서 tsconfig.web.json 에 들어간다.

/** 노드 상자의 크기. **렌더러가 이 값을 그대로 style 로 준다** — CSS 에 같은 숫자를 한 번 더 적으면
 *  한쪽만 고쳐졌을 때 선이 상자 가장자리에서 어긋난다(선의 끝점은 이 파일이 계산한다). */
export const NODE_W = 176
export const NODE_H = 52
/** 같은 층에서 칸과 칸 사이 */
const GAP_X = 24
/** Room a band leaves above its row. The band's label sits there, so it is not spare space. */
const LANE_PAD_TOP = 24
/** Room a band leaves below its row. Smaller than the top, because nothing is drawn in it. */
const LANE_PAD_BOTTOM = 8
/** One band, its label included. Exported for the same reason as NODE_W: the renderer states no
 *  size of its own, and edgePath's turn is derived from this same geometry. */
export const LANE_H = LANE_PAD_TOP + NODE_H + LANE_PAD_BOTTOM
/** Between two bands. edgePath turns in the middle of this gutter, so it cannot be 0. */
const LANE_GAP = 12
/** How far a band reaches past the widest row on each side, so no box touches its dashes. */
const LANE_INSET_X = 10
/** Baseline of a band's label, measured down from the band's top. */
const LANE_LABEL_Y = 17
/** Between two arrows arriving at one box, and the margin the outermost one keeps from the box's
 *  corner. Arrowheads stacked on one pixel would hide how many deps a Task is waiting on. */
const PORT_GAP = 28
const PORT_MARGIN = 16

/** 노드 상자의 왼쪽 위 */
export interface GraphBox {
  x: number
  y: number
}

/** 한 층을 감싸는 띠. 어떤 Task 가 몇 층인지는 graph.ts 가 정하고, 여기서는 그 층이 화면에서
 *  차지하는 사각형만 준다. */
export interface GraphLane {
  x: number
  y: number
  width: number
  height: number
  /** Baseline for the band's label, in the same coordinate space as `y`. */
  labelY: number
}

export interface GraphLayout {
  width: number
  height: number
  /** 층별 상자. rows[i][j] 는 counts[i] 의 j 번째다 */
  rows: GraphBox[][]
  /** rows 와 같은 순서의 띠 — rows[i] 를 감싸는 것이 lanes[i] 다 */
  lanes: GraphLane[]
}

/** 층마다 노드가 몇 개인지만 주면 자리가 정해진다 — 층은 가운데로 모으고 위에서 아래로 쌓는다.
 *
 *  가운데 정렬인 이유는 선이다: 부모와 자식이 같은 세로축 가까이에 있어야 선이 짧고 서로 덜 겹친다.
 *  폭은 가장 넓은 층이 정한다 — 그래야 어느 층도 잘리지 않고, 화면보다 넓어지면 그래프 칸이 가로로
 *  스크롤된다(상자를 줄여서 맞추면 제목이 사라진다).
 *
 *  Every row also gets a band around it, and a band is what sets the graph's width: it reaches
 *  LANE_INSET_X past the widest row on both sides, so the widest row's boxes do not sit on its
 *  dashes. Rows are therefore offset by that inset, which is why a single-box graph is wider than
 *  a box. */
export function layoutRows(counts: number[]): GraphLayout {
  const rowWidth = (n: number): number => (n <= 0 ? 0 : n * NODE_W + (n - 1) * GAP_X)
  const content = counts.reduce((max, n) => Math.max(max, rowWidth(n)), 0)
  // 층이 없으면 크기가 0 이어야 한다 — 띠의 여백까지 더하면 빈 SVG 가 자리를 먹는다
  const width = counts.length === 0 ? 0 : content + LANE_INSET_X * 2
  const pitch = LANE_H + LANE_GAP
  const rows = counts.map((n, i) =>
    Array.from({ length: Math.max(0, n) }, (_, j) => ({
      // 소수점을 남기지 않는다 — 0.5px 에 걸린 선은 브라우저가 두 픽셀에 나눠 그려 흐리게 보인다
      x: LANE_INSET_X + Math.round((content - rowWidth(n)) / 2) + j * (NODE_W + GAP_X),
      y: LANE_PAD_TOP + i * pitch
    }))
  )
  const lanes = counts.map((_, i) => ({
    x: 0,
    y: i * pitch,
    width,
    height: LANE_H,
    labelY: i * pitch + LANE_LABEL_Y
  }))
  const height =
    counts.length === 0 ? 0 : counts.length * LANE_H + (counts.length - 1) * LANE_GAP
  return { width, height, rows, lanes }
}

/** 부모 상자의 아래 가운데에서 자식 상자의 위로 가는 직각 선.
 *
 *  The horizontal run sits in the middle of the gutter above the target's band. Inside a band it
 *  would cross that band's dashed frame and read as part of the frame rather than as an edge. The
 *  same rule covers an edge that skips a layer — the line runs straight down past the bands in
 *  between and turns only once, right above its target.
 *
 *  `port` fans several arrivals around the target's centre. Without it the deps of one Task all
 *  land on the same pixel, and "this one is waiting on two things" stops being visible — which is
 *  the one thing this graph exists to say. */
export function edgePath(
  from: GraphBox,
  to: GraphBox,
  port?: { index: number; count: number }
): string {
  const x1 = from.x + NODE_W / 2
  const y1 = from.y + NODE_H
  const x2 = to.x + NODE_W / 2 + portOffset(port)
  const y2 = to.y
  // A turn needs somewhere to turn to. Same centre line means one straight segment, not three.
  if (x1 === x2) return `M${x1} ${y1} L${x2} ${y2}`
  const turn = y2 - LANE_PAD_TOP - LANE_GAP / 2
  return `M${x1} ${y1} L${x1} ${turn} L${x2} ${turn} L${x2} ${y2}`
}

/** How far off the target's centre one arrival lands. The spread narrows to fit the box, so a Task
 *  with many deps keeps every arrowhead on its own top edge instead of past the corner. */
const portOffset = (port?: { index: number; count: number }): number => {
  if (port === undefined || port.count <= 1) return 0
  const gap = Math.min(PORT_GAP, (NODE_W - PORT_MARGIN * 2) / (port.count - 1))
  return Math.round((port.index - (port.count - 1) / 2) * gap)
}
