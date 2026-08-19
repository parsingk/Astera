import { describe, it, expect } from 'vitest'
import { edgePath, layoutRows, NODE_H, NODE_W } from './graphLayout'

describe('layoutRows', () => {
  it('한 층에 하나면 그래프는 상자 하나 크기다', () => {
    const l = layoutRows([1])
    expect(l).toEqual({ width: NODE_W, height: NODE_H, rows: [[{ x: 0, y: 0 }]] })
  })

  it('같은 층은 나란히 선다', () => {
    const l = layoutRows([2])
    expect(l.width).toBe(NODE_W * 2 + 10)
    expect(l.rows[0]).toEqual([
      { x: 0, y: 0 },
      { x: NODE_W + 10, y: 0 }
    ])
  })

  // 부모와 자식이 같은 세로축 가까이에 있어야 선이 짧다 — 좁은 층은 넓은 층의 가운데로 모인다
  it('좁은 층은 가장 넓은 층의 가운데에 놓인다', () => {
    const l = layoutRows([1, 2])
    expect(l.width).toBe(NODE_W * 2 + 10)
    expect(l.rows[0][0].x).toBe(Math.round((NODE_W + 10) / 2))
    expect(l.rows[1][0].x).toBe(0)
  })

  it('층은 위에서 아래로 쌓인다', () => {
    const l = layoutRows([1, 1, 1])
    expect(l.rows.map((r) => r[0].y)).toEqual([0, NODE_H + 34, (NODE_H + 34) * 2])
    expect(l.height).toBe(NODE_H * 3 + 34 * 2)
  })

  // layers 가 비어 있는 Run — Task 가 하나도 없거나 전부 순환이다. 크기가 0 이어야 빈 SVG 가
  // 자리를 먹지 않는다
  it('층이 없으면 크기가 0 이다', () => {
    expect(layoutRows([])).toEqual({ width: 0, height: 0, rows: [] })
  })
})

describe('edgePath', () => {
  it('부모 상자의 아래 가운데에서 자식 상자의 위 가운데로 간다', () => {
    const l = layoutRows([1, 1])
    const d = edgePath(l.rows[0][0], l.rows[1][0])
    const cx = NODE_W / 2
    // y: 부모의 아래(32) → 자식의 위(66), 제어점은 그 중간(49)
    expect(d).toBe(`M${cx} 32 C${cx} 49, ${cx} 49, ${cx} 66`)
  })

  it('가로로 어긋난 두 상자는 중간 높이에서 휜다', () => {
    const l = layoutRows([1, 2])
    const d = edgePath(l.rows[0][0], l.rows[1][1])
    expect(d).toBe(`M${79 + NODE_W / 2} 32 C${79 + NODE_W / 2} 49, ${158 + NODE_W / 2} 49, ${158 + NODE_W / 2} 66`)
  })
})
