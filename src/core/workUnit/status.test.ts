import { describe, it, expect } from 'vitest'
import { isOpen } from './status'

describe('isOpen', () => {
  it('active 만 열려 있다', () => {
    expect(isOpen('active')).toBe(true)
  })

  it('중단된 것은 열려 있지 않다 — 사람을 기다릴 뿐 관찰을 더 받지 않는다', () => {
    expect(isOpen('interrupted')).toBe(false)
    expect(isOpen('completed')).toBe(false)
    expect(isOpen('cancelled')).toBe(false)
  })
})
