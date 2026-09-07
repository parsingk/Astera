import { describe, it, expect } from 'vitest'
import { edgePath, LANE_H, layoutRows, NODE_H, NODE_W } from './graphLayout'

describe('layoutRows', () => {
  // The band, not the box, is what the graph is made of now — it reaches past the widest row on
  // both sides so a row never touches the band's dashes.
  it('gives every layer a band that is wider than the row inside it', () => {
    const l = layoutRows([1])
    expect(l.lanes).toEqual([{ x: 0, y: 0, width: l.width, height: LANE_H, labelY: 17 }])
    expect(l.width).toBeGreaterThan(NODE_W)
    expect(l.height).toBe(LANE_H)
    expect(l.rows).toEqual([[{ x: 10, y: 24 }]])
  })

  it('같은 층은 나란히 선다', () => {
    const l = layoutRows([2])
    expect(l.width).toBe(NODE_W * 2 + 24 + 20)
    expect(l.rows[0]).toEqual([
      { x: 10, y: 24 },
      { x: 10 + NODE_W + 24, y: 24 }
    ])
  })

  // 부모와 자식이 같은 세로축 가까이에 있어야 선이 짧다 — 좁은 층은 넓은 층의 가운데로 모인다
  it('좁은 층은 가장 넓은 층의 가운데에 놓인다', () => {
    const l = layoutRows([1, 2])
    expect(l.width).toBe(NODE_W * 2 + 24 + 20)
    expect(l.rows[0][0].x).toBe(10 + Math.round((NODE_W + 24) / 2))
    expect(l.rows[1][0].x).toBe(10)
  })

  it('층은 위에서 아래로 쌓인다', () => {
    const l = layoutRows([1, 1, 1])
    expect(l.rows.map((r) => r[0].y)).toEqual([24, 24 + 96, 24 + 192])
    expect(l.lanes.map((b) => b.y)).toEqual([0, 96, 192])
    expect(l.height).toBe(LANE_H * 3 + 12 * 2)
  })

  // layers 가 비어 있는 Run — Task 가 하나도 없거나 전부 순환이다. 크기가 0 이어야 빈 SVG 가
  // 자리를 먹지 않는다
  it('층이 없으면 크기가 0 이다', () => {
    expect(layoutRows([])).toEqual({ width: 0, height: 0, rows: [], lanes: [] })
  })
})

describe('edgePath', () => {
  it('drops straight down when both boxes share a centre line', () => {
    const l = layoutRows([1, 1])
    const cx = 10 + NODE_W / 2
    expect(edgePath(l.rows[0][0], l.rows[1][0])).toBe(`M${cx} ${24 + NODE_H} L${cx} 120`)
  })

  // The horizontal run belongs in the gutter between two bands. Inside a band it would cross the
  // dashes and read as part of the frame.
  it('turns in the gutter above the target band', () => {
    const l = layoutRows([1, 2])
    const from = l.rows[0][0]
    const to = l.rows[1][1]
    const x1 = from.x + NODE_W / 2
    const x2 = to.x + NODE_W / 2
    expect(edgePath(from, to)).toBe(`M${x1} 76 L${x1} 90 L${x2} 90 L${x2} 120`)
  })

  // A dep may skip a layer. The turn still happens right above the target, so the line runs down
  // past the bands it crosses instead of jogging inside one of them.
  it('turns above the target band even when the edge skips a layer', () => {
    const l = layoutRows([1, 1, 2])
    const from = l.rows[0][0]
    const to = l.rows[2][1]
    const x1 = from.x + NODE_W / 2
    const x2 = to.x + NODE_W / 2
    expect(edgePath(from, to)).toBe(`M${x1} 76 L${x1} 186 L${x2} 186 L${x2} 216`)
  })

  // Two deps arriving at one Task must not stack their arrowheads on the same pixel. They fan out
  // around the box's centre, so "two lines meet here" stays readable.
  it('fans several arrivals symmetrically around the centre of the box', () => {
    const l = layoutRows([2, 1])
    const to = l.rows[1][0]
    const centre = to.x + NODE_W / 2
    const left = edgePath(l.rows[0][0], to, { index: 0, count: 2 })
    const right = edgePath(l.rows[0][1], to, { index: 1, count: 2 })
    expect(left).toContain(`L${centre - 14} 120`)
    expect(right).toContain(`L${centre + 14} 120`)
  })

  it('keeps the outermost arrival inside the box when a Task has many deps', () => {
    const l = layoutRows([13, 1])
    const to = l.rows[1][0]
    const first = edgePath(l.rows[0][0], to, { index: 0, count: 13 })
    const last = edgePath(l.rows[0][12], to, { index: 12, count: 13 })
    expect(first).toContain(`L${to.x + 16} 120`)
    expect(last).toContain(`L${to.x + NODE_W - 16} 120`)
  })

  it('lands on the centre when the Task has a single dep', () => {
    const l = layoutRows([1, 1])
    const centre = l.rows[1][0].x + NODE_W / 2
    expect(edgePath(l.rows[0][0], l.rows[1][0], { index: 0, count: 1 })).toContain(`L${centre} 120`)
  })
})
