import type { FlowNode } from '../../../core/understanding/types'

/** 흐름도. **아직 뼈대다** — 자리 계산(core/understanding/flowLayout.ts)과 SVG 선·HTML 상자는
 *  Task 11 이 이 파일을 통째로 갈아 쓰면서 넣는다. 지금은 FeatureDetail 이 그릴 자리를 잡아 둘
 *  만큼만 있다. props 는 그때의 것과 같은 모양이라 잇는 쪽을 다시 고치지 않아도 된다. */
export function FlowDiagram({
  nodes
}: {
  nodes: FlowNode[]
  selectedId: string | null
  onPick: (nodeId: string | null) => void
}): React.JSX.Element {
  return <div className="hiw-flow">{nodes.length}</div>
}
