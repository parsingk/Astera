import { describe, expect, it } from 'vitest'
import { scrollThumb, tabFloor, wheelShift } from './tabStrip'

describe('tabFloor', () => {
  // The icon, the close button and the padding never shrink; only the name gives way. Halving the
  // whole tab instead left a short name nothing at all: .gitignore's 128px tab came down to 64px,
  // less than its icon, close button and padding take.
  it('keeps everything but the name, and half the name', () => {
    expect(tabFloor(78, [66])).toBe(111)
  })

  it('counts a file tab’s hint as part of its name', () => {
    expect(tabFloor(78, [100, 40])).toBe(148)
  })

  it('rounds up, so a name never shows less than half', () => {
    expect(tabFloor(78, [49])).toBe(103)
    expect(tabFloor(78.4, [50])).toBe(104)
  })
})

describe('wheelShift', () => {
  it('turns a vertical wheel over an overflowing bar into a sideways scroll', () => {
    expect(wheelShift(0, 100, true)).toBe(100)
    expect(wheelShift(0, -100, true)).toBe(-100)
  })

  it('leaves a sideways trackpad swipe to the browser', () => {
    expect(wheelShift(40, 5, true)).toBeNull()
  })

  it('does nothing while every tab fits', () => {
    expect(wheelShift(0, 100, false)).toBeNull()
  })
})

describe('scrollThumb', () => {
  it('draws nothing while every tab fits', () => {
    expect(scrollThumb(0, 250, 250)).toBeNull()
  })

  it('sizes the thumb by how much of the row is in view', () => {
    expect(scrollThumb(0, 1000, 250)).toEqual({ left: 0, width: 62.5 })
  })

  it('reaches the right edge when scrolled to the end', () => {
    expect(scrollThumb(750, 1000, 250)).toEqual({ left: 187.5, width: 62.5 })
  })
})
