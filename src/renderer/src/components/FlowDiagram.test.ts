import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FlowNode } from '../../../core/understanding/types'
import { FlowDiagram } from './FlowDiagram'

const nodes: FlowNode[] = [
  { id: 'login', label: '로그인 클릭', type: 'start', next: [{ targetId: 'q' }] },
  { id: 'q', label: '기존 사용자?', type: 'decision', next: [
    { targetId: 'yes', condition: '예' }, { targetId: 'no', condition: '아니오' }
  ] },
  { id: 'yes', label: '바로 로그인', type: 'step', next: [{ targetId: 'end' }], evidenceIds: ['e1'] },
  { id: 'no', label: '계정 생성', type: 'step', next: [{ targetId: 'end' }] },
  { id: 'end', label: '로그인 완료', type: 'success', next: [], evidenceIds: ['e2'] }
]

const render = (selectedId: string | null = null): string =>
  renderToStaticMarkup(React.createElement(FlowDiagram, { nodes, selectedId, onPick: () => {} }))

describe('FlowDiagram', () => {
  it('노드마다 상자와 이름이 하나씩 나온다', () => {
    const html = render()
    for (const n of nodes) expect(html).toContain(n.label)
    expect((html.match(/class="hiw-node/g) ?? []).length).toBe(nodes.length)
  })

  it('선은 SVG 에, 상자는 HTML 에 그린다 — RunDetail 과 같은 갈래다', () => {
    const html = render()
    // 간선 다섯(login→q, q→yes, q→no, yes→end, no→end) + 화살촉 marker 하나
    expect((html.match(/<path/g) ?? []).length).toBe(6)
    expect(html).not.toContain('<rect')
  })

  it('분기 조건을 그린다', () => {
    const html = render()
    expect((html.match(/class="hiw-cond"/g) ?? []).length).toBe(2)
    expect(html).toContain('예')
    expect(html).toContain('아니오')
  })

  it('종류가 클래스로 나온다', () => {
    const html = render()
    expect(html).toContain('hiw-node--decision')
    expect(html).toContain('hiw-node--success')
  })

  it('근거가 있는 단계만 고를 수 있는 표시를 갖는다', () => {
    const html = render()
    expect((html.match(/ pickable/g) ?? []).length).toBe(2)
  })

  it('고른 단계에 selected 가 붙고 나머지는 흐려진다', () => {
    const html = render('end')
    expect(html).toContain('selected')
    expect((html.match(/ muted/g) ?? []).length).toBe(4)
  })

  it('빈 흐름은 아무것도 그리지 않는다', () => {
    const html = renderToStaticMarkup(
      React.createElement(FlowDiagram, { nodes: [], selectedId: null, onPick: () => {} })
    )
    expect(html).toBe('')
  })
})
