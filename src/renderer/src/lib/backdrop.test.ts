import { describe, it, expect } from 'vitest'
import { backdropProps } from './backdrop'

// Audit UI-5: every modal closed on a click on its backdrop, and a drag that began inside the modal (selecting a pasted
// token) and ended outside it is a click on the backdrop too: the modal closed and what was typed was lost. It closes
// only when the press began on the backdrop itself.
describe('backdropProps', () => {
  const backdrop = {}
  const inner = {}
  it('closes on a press and release both on the backdrop', () => {
    let closed = 0
    const p = backdropProps(() => closed++)
    p.onMouseDown({ target: backdrop, currentTarget: backdrop })
    p.onClick({ target: backdrop, currentTarget: backdrop })
    expect(closed).toBe(1)
  })
  it('does not close when the press began inside the modal', () => {
    let closed = 0
    const p = backdropProps(() => closed++)
    p.onMouseDown({ target: inner, currentTarget: backdrop })
    p.onClick({ target: backdrop, currentTarget: backdrop })
    expect(closed).toBe(0)
  })
  it('keeps what it saw across renders, which make new handlers', () => {
    let closed = 0
    backdropProps(() => closed++).onMouseDown({ target: backdrop, currentTarget: backdrop })
    backdropProps(() => closed++).onClick({ target: backdrop, currentTarget: backdrop })
    expect(closed).toBe(1)
  })
  it('does not close for a click inside the modal', () => {
    let closed = 0
    const p = backdropProps(() => closed++)
    p.onMouseDown({ target: inner, currentTarget: backdrop })
    p.onClick({ target: inner, currentTarget: backdrop })
    expect(closed).toBe(0)
  })
})
