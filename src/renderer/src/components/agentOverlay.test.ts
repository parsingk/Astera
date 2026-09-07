import { describe, expect, it } from 'vitest'
import { pointerToView } from './agentOverlay'

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
})
