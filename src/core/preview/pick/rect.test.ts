import { describe, it, expect } from 'vitest'
import { isSaneRect, scaleRect } from './rect'

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
