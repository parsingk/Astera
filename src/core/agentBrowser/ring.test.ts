import { describe, it, expect } from 'vitest'
import { Ring } from './ring'

describe('Ring', () => {
  it('returns everything before any mark', () => {
    const r = new Ring<number>()
    r.push(1); r.push(2)
    expect(r.sinceMark()).toEqual([1, 2])
  })

  it('returns only what came after the mark', () => {
    const r = new Ring<number>()
    r.push(1); r.push(2)
    r.mark()
    r.push(3)
    expect(r.sinceMark()).toEqual([3])
  })

  it('a mark on an empty ring, then pushes, returns the pushes', () => {
    const r = new Ring<number>()
    r.mark()
    r.push(9)
    expect(r.sinceMark()).toEqual([9])
  })

  it('drops the oldest past capacity and keeps sinceMark honest across the drop', () => {
    const r = new Ring<number>(3)
    r.push(1); r.push(2)
    r.mark()
    r.push(3); r.push(4); r.push(5)
    expect(r.size).toBe(3)
    // 1 and 2 were dropped; everything left is after the mark
    expect(r.sinceMark()).toEqual([3, 4, 5])
  })

  it('a second mark moves the boundary', () => {
    const r = new Ring<number>()
    r.push(1); r.mark(); r.push(2); r.mark(); r.push(3)
    expect(r.sinceMark()).toEqual([3])
  })

  it('defaults to 500', () => {
    const r = new Ring<number>()
    for (let i = 0; i < 600; i += 1) r.push(i)
    expect(r.size).toBe(500)
    expect(r.sinceMark()[0]).toBe(100)
  })
})
