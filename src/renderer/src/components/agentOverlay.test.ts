import { describe, expect, it } from 'vitest'
import { escStopsAgent, pointerToView } from './agentOverlay'

const view = { left: 10, top: 20, width: 400, height: 300 }

describe('pointerToView', () => {
  it('maps one to one when the view is the size of the guest viewport', () => {
    expect(pointerToView({ x: 100, y: 50, w: 400, h: 300 }, view)).toEqual({ left: 110, top: 70 })
  })

  it('scales when a viewport preset draws the guest at another size', () => {
    // A 800x600 guest shown in a 400x300 box: every guest pixel is half a view pixel.
    expect(pointerToView({ x: 800, y: 600, w: 800, h: 600 }, view)).toEqual({ left: 410, top: 320 })
    expect(pointerToView({ x: 200, y: 150, w: 800, h: 600 }, view)).toEqual({ left: 110, top: 95 })
  })

  it('lands on the box edges for the guest edges', () => {
    expect(pointerToView({ x: 0, y: 0, w: 640, h: 480 }, view)).toEqual({ left: 10, top: 20 })
    expect(pointerToView({ x: 640, y: 480, w: 640, h: 480 }, view)).toEqual({ left: 410, top: 320 })
  })

  it('maps a zero-size viewport to the box origin rather than to Infinity', () => {
    expect(pointerToView({ x: 5, y: 5, w: 0, h: 0 }, view)).toEqual({ left: 10, top: 20 })
  })

  // Every other case here uses a 4:3 guest and a 4:3 view, so an implementation that swaps sx and sy
  // (applies the width ratio to y and the height ratio to x) still passes them. This pair is neither
  // square nor 4:3 in either box, so a swapped scale factor lands on the wrong edge.
  it('does not cross-apply the x and y scale factors', () => {
    const wide = { left: 0, top: 0, width: 300, height: 600 }
    expect(pointerToView({ x: 1000, y: 0, w: 1000, h: 500 }, wide)).toEqual({ left: 300, top: 0 })
    expect(pointerToView({ x: 0, y: 500, w: 1000, h: 500 }, wide)).toEqual({ left: 0, top: 600 })
  })
})

const esc = { key: 'Escape', altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }

describe('escStopsAgent', () => {
  it('stops when a script runs, the agent tab is the focused pane\'s shown tab, and nothing else owns the key', () => {
    expect(escStopsAgent(esc, true, true, false)).toBe(true)
  })

  it('does nothing when no script runs', () => {
    expect(escStopsAgent(esc, false, true, false)).toBe(false)
  })

  // The agent tab is drawn invisibly behind the tab the user is on while a script runs. Esc there is
  // the user's, not the agent's: they are looking at something else.
  it('does nothing when the agent tab is not the one the user is looking at', () => {
    expect(escStopsAgent(esc, true, false, false)).toBe(false)
  })

  it('leaves the key to a menu this pane has open', () => {
    expect(escStopsAgent(esc, true, true, true)).toBe(false)
  })

  it('is Escape alone, not a chord and not another key', () => {
    expect(escStopsAgent({ ...esc, shiftKey: true }, true, true, false)).toBe(false)
    expect(escStopsAgent({ ...esc, ctrlKey: true }, true, true, false)).toBe(false)
    expect(escStopsAgent({ ...esc, key: 'Enter' }, true, true, false)).toBe(false)
  })
})
