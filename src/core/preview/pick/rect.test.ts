import { describe, it, expect } from 'vitest'
import { clampToView, isFiniteRect, isSaneRect, scaleRect } from './rect'

describe('isSaneRect', () => {
  it('accepts a finite rect with positive size', () => {
    expect(isSaneRect({ x: 0, y: 0, width: 1, height: 1 })).toBe(true)
    expect(isSaneRect({ x: 812.4, y: 24, width: 96, height: 36 })).toBe(true)
  })
  it.each([
    ['NaN x', { x: Number.NaN, y: 0, width: 1, height: 1 }],
    ['infinite width', { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 }],
    ['zero width', { x: 0, y: 0, width: 0, height: 1 }],
    ['negative height', { x: 0, y: 0, width: 1, height: -1 }],
    ['negative origin', { x: -1, y: 0, width: 1, height: 1 }],
    ['a string', { x: '0', y: 0, width: 1, height: 1 }],
    ['missing height', { x: 0, y: 0, width: 1 }],
    ['null', null]
  ])('refuses %s', (_l, v) => expect(isSaneRect(v)).toBe(false))
})

describe('scaleRect', () => {
  it('multiplies all four and rounds to whole pixels', () => {
    expect(scaleRect({ x: 200, y: 100, width: 200, height: 100 }, 0.5)).toEqual({ x: 100, y: 50, width: 100, height: 50 })
    expect(scaleRect({ x: 10.4, y: 10.6, width: 3.3, height: 3.5 }, 1)).toEqual({ x: 10, y: 11, width: 3, height: 4 })
  })
  it('never rounds a size down to zero', () => {
    expect(scaleRect({ x: 0, y: 0, width: 1, height: 1 }, 0.1)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })
})

describe('isFiniteRect vs isSaneRect', () => {
  // The split exists because using the capture precondition on a picked payload rejected every element
  // scrolled past the top of the window — the click did nothing, silently.
  it('a negative origin is a normal picked rect and not a capturable one', () => {
    const scrolledPastTheTop = { x: 0, y: -140, width: 800, height: 900 }
    expect(isFiniteRect(scrolledPastTheTop)).toBe(true)
    expect(isSaneRect(scrolledPastTheTop)).toBe(false)
  })

  it('both refuse a non-finite number and a zero size', () => {
    for (const bad of [{ x: 0, y: 0, width: Number.NaN, height: 1 }, { x: 0, y: 0, width: 0, height: 1 }]) {
      expect(isFiniteRect(bad)).toBe(false)
      expect(isSaneRect(bad)).toBe(false)
    }
  })
})

describe('clampToView', () => {
  const view = { width: 800, height: 600 }

  it('keeps the part on screen of an element that starts above the fold', () => {
    expect(clampToView({ x: 10, y: -140, width: 200, height: 900 }, view)).toEqual({ x: 10, y: 0, width: 200, height: 600 })
  })

  it('cuts an element wider than the window down to the window', () => {
    expect(clampToView({ x: 700, y: 10, width: 400, height: 50 }, view)).toEqual({ x: 700, y: 10, width: 100, height: 50 })
  })

  it('leaves a rect that already fits alone, rounded to whole pixels', () => {
    expect(clampToView({ x: 10.4, y: 20.6, width: 100.2, height: 50 }, view)).toEqual({ x: 10, y: 21, width: 100, height: 50 })
  })

  it('null when none of it is on screen — nothing to capture', () => {
    expect(clampToView({ x: 0, y: -900, width: 100, height: 100 }, view)).toBeNull()
    expect(clampToView({ x: 900, y: 0, width: 100, height: 100 }, view)).toBeNull()
  })

  // A tampering page can hand back any numbers it likes; the result still has to be capturable
  it('a preposterous rect comes back inside the window', () => {
    const out = clampToView({ x: -1e9, y: -1e9, width: 2e9, height: 2e9 }, view)!
    expect(out).toEqual({ x: 0, y: 0, width: 800, height: 600 })
    expect(isSaneRect(out)).toBe(true)
  })
})
