import { describe, it, expect } from 'vitest'
import type { FlowNode } from './types'
import { layoutFlow, NODE_H, NODE_W } from './flowLayout'

const n = (id: string, next: string[], type: FlowNode['type'] = 'step'): FlowNode => ({
  id,
  label: id,
  type,
  next: next.map((targetId) => ({ targetId }))
})

describe('layoutFlow', () => {
  it('한 줄기는 세로로 쌓이고 가로 중심이 같다', () => {
    const l = layoutFlow([n('a', ['b'], 'start'), n('b', ['c']), n('c', [], 'success')])
    const [a, b, c] = ['a', 'b', 'c'].map((id) => l.boxes.find((x) => x.id === id)!)
    expect(a.x).toBe(b.x)
    expect(b.x).toBe(c.x)
    expect(a.y).toBeLessThan(b.y)
    expect(b.y).toBeLessThan(c.y)
  })

  it('분기는 같은 층에서 중심을 두고 갈라진다', () => {
    const l = layoutFlow([
      n('q', ['yes', 'no'], 'decision'),
      n('yes', ['end']),
      n('no', ['end']),
      n('end', [], 'success')
    ])
    const q = l.boxes.find((x) => x.id === 'q')!
    const yes = l.boxes.find((x) => x.id === 'yes')!
    const no = l.boxes.find((x) => x.id === 'no')!
    expect(yes.y).toBe(no.y)
    expect(yes.y).toBeGreaterThan(q.y)
    const center = q.x + NODE_W / 2
    expect(yes.x + NODE_W / 2 - center).toBe(center - (no.x + NODE_W / 2))
  })

  it('합류점은 가장 깊은 부모 아래에 선다', () => {
    const l = layoutFlow([
      n('a', ['b', 'end'], 'start'),
      n('b', ['end']),
      n('end', [], 'success')
    ])
    const b = l.boxes.find((x) => x.id === 'b')!
    const end = l.boxes.find((x) => x.id === 'end')!
    expect(end.y).toBeGreaterThan(b.y)
  })

  it('간선마다 경로가 하나씩 나온다', () => {
    const l = layoutFlow([n('a', ['b'], 'start'), n('b', [], 'success')])
    expect(l.edges).toHaveLength(1)
    expect(l.edges[0]).toMatchObject({ fromId: 'a', toId: 'b' })
    expect(l.edges[0].d.startsWith('M')).toBe(true)
  })

  it('없는 노드를 가리키는 간선은 버린다 — 화면이 죽지 않아야 한다', () => {
    const l = layoutFlow([n('a', ['ghost'], 'start')])
    expect(l.edges).toHaveLength(0)
    expect(l.boxes).toHaveLength(1)
  })

  it('빈 흐름은 빈 배치', () => {
    const l = layoutFlow([])
    expect(l.boxes).toEqual([])
    expect(l.width).toBe(0)
    expect(l.height).toBe(0)
  })

  it('크기는 상자를 모두 담는다', () => {
    const l = layoutFlow([n('a', ['b'], 'start'), n('b', [], 'success')])
    for (const b of l.boxes) {
      expect(b.x + NODE_W).toBeLessThanOrEqual(l.width)
      expect(b.y + NODE_H).toBeLessThanOrEqual(l.height)
    }
  })
})
