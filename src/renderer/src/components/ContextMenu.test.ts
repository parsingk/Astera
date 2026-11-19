import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Submenu,
  INITIAL_MENU_STATE,
  focusable,
  menuHover,
  menuKey,
  step,
  type MenuItem,
  type MenuState
} from './ContextMenu'

const noop = (): void => {}
const sub: MenuItem[] = [
  { heading: 'Heading line' },
  { label: 'Compare', onSelect: noop },
  { label: 'Reload', onSelect: noop, disabled: true, title: 'Only one file' },
  'separator',
  { label: 'Delete', onSelect: noop, danger: true }
]
// 0 Open, 1 heading, 2 Kubernetes (group), 3 separator, 4 disabled, 5 Close
const items: MenuItem[] = [
  { label: 'Open', onSelect: noop },
  { heading: 'Section' },
  { label: 'Kubernetes', submenu: sub },
  'separator',
  { label: 'Off', onSelect: noop, disabled: true },
  { label: 'Close', onSelect: noop }
]
const allOff: MenuItem[] = [{ heading: 'H' }, { label: 'Apply', onSelect: noop, disabled: true }]
const helmOnly: MenuItem[] = [{ label: 'Kubernetes', submenu: allOff }]
const at = (over: Partial<MenuState>): MenuState => ({ ...INITIAL_MENU_STATE, ...over })

describe('Submenu markup', () => {
  const html = renderToStaticMarkup(
    React.createElement(Submenu, { items: sub, cursor: -1, onHover: noop, onPick: noop })
  )
  it('renders a nested role=menu', () => {
    expect(html.match(/role="menu"/g)).toHaveLength(1)
  })
  it('renders a heading without role=menuitem', () => {
    expect(html).toContain('class="context-menu-heading">Heading line')
    expect(html.match(/role="menuitem"/g)).toHaveLength(3)
  })
  it('puts the tooltip on a disabled item', () => {
    expect(html).toContain('title="Only one file"')
  })
})

describe('step and focusable', () => {
  it('headings, separators and disabled actions are not focusable; groups are', () => {
    expect(items.map(focusable)).toEqual([true, false, true, false, false, true])
  })
  it('skips headings in both directions, in the parent and in the submenu', () => {
    expect(step(items, 0, 1)).toBe(2)
    expect(step(items, 2, -1)).toBe(0)
    expect(step(sub, 1, 1)).toBe(4) // past the disabled item and the separator
    expect(step(sub, 4, -1)).toBe(1)
    expect(step(sub, 2, 1)).toBe(1) // a cursor on a non-focusable index falls back to the first
    expect(step(sub, 4, 1)).toBe(1) // wraps past the separator and heading to the first focusable
  })
  it('with no cursor, down goes to the first focusable and up to the last', () => {
    expect(step(items, -1, 1)).toBe(0)
    expect(step(items, -1, -1)).toBe(5)
    expect(step(sub, -1, 1)).toBe(1)
    expect(step(sub, -1, -1)).toBe(4)
  })
  it('leaves the cursor alone when nothing is focusable', () => {
    expect(step(allOff, -1, 1)).toBe(-1)
  })
})

describe('menuKey', () => {
  it('right and Enter on a group open its submenu on the first focusable item', () => {
    for (const key of ['ArrowRight', 'Enter']) {
      const r = menuKey(at({ cursor: 2 }), key, items)
      expect(r.state).toEqual({ cursor: 2, openSub: 2, subCursor: 1, inSub: true })
      expect(r.close).toBe(false)
      expect(r.select).toBeNull()
    }
  })
  it('an all-disabled submenu keeps the sub cursor at -1 and Enter does nothing', () => {
    const open = menuKey(at({ cursor: 0 }), 'Enter', helmOnly).state
    expect(open).toEqual({ cursor: 0, openSub: 0, subCursor: -1, inSub: true })
    expect(menuKey(open, 'Enter', helmOnly)).toEqual({ state: open, close: false, select: null })
  })
  it('arrows inside the submenu move the sub cursor past the heading, separator and disabled item', () => {
    const open = at({ cursor: 2, openSub: 2, subCursor: 1, inSub: true })
    expect(menuKey(open, 'ArrowDown', items).state.subCursor).toBe(4)
    expect(menuKey(open, 'ArrowUp', items).state.subCursor).toBe(4)
    expect(menuKey(open, 'ArrowDown', items).state.cursor).toBe(2)
  })
  it('arrows in the parent skip the heading and close a hover-opened submenu', () => {
    const r = menuKey(at({ cursor: 0, openSub: 2 }), 'ArrowDown', items)
    expect(r.state).toEqual({ cursor: 2, openSub: null, subCursor: -1, inSub: false })
  })
  it('left and the first Escape close only the submenu and keep the group cursor', () => {
    const open = at({ cursor: 2, openSub: 2, subCursor: 4, inSub: true })
    for (const key of ['ArrowLeft', 'Escape']) {
      const r = menuKey(open, key, items)
      expect(r.state).toEqual({ cursor: 2, openSub: null, subCursor: -1, inSub: false })
      expect(r.close).toBe(false)
    }
  })
  it('a second Escape closes the menu', () => {
    const after = menuKey(at({ cursor: 2, openSub: 2, subCursor: 1, inSub: true }), 'Escape', items).state
    expect(menuKey(after, 'Escape', items).close).toBe(true)
  })
  it('Enter on an enabled item selects it and closes; on a disabled item it is a no-op', () => {
    const r = menuKey(at({ cursor: 5 }), 'Enter', items)
    expect(r.close).toBe(true)
    expect(r.select).toBe(items[5])
    const inSub = menuKey(at({ cursor: 2, openSub: 2, subCursor: 4, inSub: true }), 'Enter', items)
    expect(inSub.select).toBe(sub[4])
    const off = at({ cursor: 4 })
    expect(menuKey(off, 'Enter', items)).toEqual({ state: off, close: false, select: null })
    const offSub = at({ cursor: 2, openSub: 2, subCursor: 2, inSub: true })
    expect(menuKey(offSub, 'Enter', items)).toEqual({ state: offSub, close: false, select: null })
  })
  it('left and right do nothing when there is nothing to open or close', () => {
    const s = at({ cursor: 0 })
    expect(menuKey(s, 'ArrowLeft', items).state).toBe(s)
    expect(menuKey(s, 'ArrowRight', items).state).toBe(s)
  })
})

describe('menuHover', () => {
  const open = at({ cursor: 2, openSub: 2, subCursor: 1, inSub: true })
  it('hovering a group opens its submenu', () => {
    expect(menuHover(at({ cursor: 0 }), items, 2)).toEqual({ cursor: 2, openSub: 2, subCursor: -1, inSub: false })
  })
  it('hovering any non-group row closes the open submenu, even a disabled row, heading or separator', () => {
    for (const i of [0, 1, 3, 4, 5]) {
      const r = menuHover(open, items, i)
      expect(r.openSub).toBeNull()
      expect(r.inSub).toBe(false)
      expect(r.subCursor).toBe(-1)
    }
  })
  it('only a focusable row takes the cursor', () => {
    expect(menuHover(open, items, 5).cursor).toBe(5)
    expect(menuHover(open, items, 4).cursor).toBe(2)
    expect(menuHover(open, items, 1).cursor).toBe(2)
  })
})
