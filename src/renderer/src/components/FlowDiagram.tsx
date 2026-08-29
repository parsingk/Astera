import type { FlowNode } from '../../../core/understanding/types'
import { layoutFlow, NODE_H, NODE_W } from '../../../core/understanding/flowLayout'
import { isScopable } from '../../../core/understanding/scope'

/** 흐름도. 자리는 core 가 계산하고(flowLayout.ts) 여기서는 그리기만 한다 —
 *  RunDetail 의 의존 그래프가 graphLayout.ts 와 나눠 갖는 것과 같은 갈래다.
 *
 *  **선만 SVG 이고 상자는 HTML 이다** — RunDetail 의 `.detail-edges` + `.detail-node` 가 하는 그대로.
 *  상자를 <rect> 로 두면 모서리 반경을 테마 토큰(--radius-sm)에서 받을 수 없고(기하 속성은 var() 를
 *  풀지 않는다), 한글 라벨의 줄바꿈과 말줄임도 SVG <text> 로는 되지 않는다. HTML 이면 둘 다 CSS 가
 *  한다. 선의 stroke 에 var() 를 쓰는 것은 RunDetail 이 이미 하는 방식이라 안전하다. */
export function FlowDiagram({
  nodes,
  selectedId,
  onPick
}: {
  nodes: FlowNode[]
  selectedId: string | null
  onPick: (nodeId: string | null) => void
}): React.JSX.Element | null {
  if (nodes.length === 0) return null
  const { boxes, edges, width, height } = layoutFlow(nodes)
  const byId = new Map(nodes.map((n) => [n.id, n]))

  return (
    <div className="hiw-flow" style={{ width, height }}>
      <svg className="hiw-edges" width={width} height={height} aria-hidden="true">
        <defs>
          <marker
            id="hiw-arrow"
            viewBox="0 0 8 8"
            refX="6.5"
            refY="4"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M0.5 1 L6.5 4 L0.5 7 z" fill="var(--text-faint)" />
          </marker>
        </defs>
        {edges.map((e) => (
          <path
            key={`${e.fromId}:${e.toId}`}
            d={e.d}
            fill="none"
            stroke="var(--text-faint)"
            strokeWidth="1"
            markerEnd="url(#hiw-arrow)"
          />
        ))}
      </svg>

      {/* 분기 조건. 선 위에 얹히므로 상자와 같은 층의 HTML 이다 */}
      {edges
        .filter((e) => e.condition !== undefined)
        .map((e) => (
          <span
            key={`c:${e.fromId}:${e.toId}`}
            className="hiw-cond"
            style={{ left: e.labelX, top: e.labelY }}
          >
            {e.condition}
          </span>
        ))}

      {boxes.map((b) => {
        const node = byId.get(b.id)
        if (!node) return null
        const pickable = isScopable(node)
        const selected = selectedId !== null && b.id === selectedId
        // 고른 것이 있으면 나머지는 흐려진다 — 무엇을 보고 있는지가 왼쪽에서도 읽혀야 한다
        const muted = selectedId !== null && !selected
        const cls = [
          'hiw-node',
          `hiw-node--${node.type}`,
          pickable ? 'pickable' : '',
          selected ? 'selected' : '',
          muted ? 'muted' : ''
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div
            key={b.id}
            className={cls}
            style={{ left: b.x, top: b.y, width: NODE_W, height: NODE_H }}
            title={node.label}
            onClick={pickable ? () => onPick(selected ? null : b.id) : undefined}
          >
            {node.label}
          </div>
        )
      })}
    </div>
  )
}
