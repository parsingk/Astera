import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextMenu, type MenuItem } from './ContextMenu'

const items: MenuItem[] = [
  { label: 'Open', onSelect: () => {} },
  {
    label: 'Kubernetes',
    submenu: [
      { heading: 'Heading line' },
      { label: 'Compare', onSelect: () => {} },
      { label: 'Reload', onSelect: () => {}, disabled: true, title: 'Only one file' }
    ]
  }
]

const render = (initialSubmenu?: number): string =>
  renderToStaticMarkup(
    React.createElement(ContextMenu, { x: 0, y: 0, items, onClose: () => {}, initialSubmenu })
  )

describe('ContextMenu submenus', () => {
  it('renders no nested menu until the group item is opened', () => {
    expect(render().match(/role="menu"/g)).toHaveLength(1)
  })

  it('renders a nested role=menu when the group item is open', () => {
    const html = render(1)
    expect(html.match(/role="menu"/g)).toHaveLength(2)
    expect(html).toContain('aria-haspopup="menu"')
  })

  it('renders a heading without role=menuitem', () => {
    const html = render(1)
    expect(html).toContain('Heading line')
    expect(html).toContain('class="context-menu-heading">Heading line')
    // Open, Kubernetes, Compare, Reload are items; the heading is not
    expect(html.match(/role="menuitem"/g)).toHaveLength(4)
  })

  it('puts the tooltip on a disabled item', () => {
    expect(render(1)).toContain('title="Only one file"')
  })
})
