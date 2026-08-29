import { describe, it, expect } from 'vitest'
import { isOpen } from './status'

describe('isOpen', () => {
  it('active 와 completed-candidate 만 열려 있다 — 새 메시지를 받을 수 있는 상태다', () => {
    expect(isOpen('active')).toBe(true)
    expect(isOpen('completed-candidate')).toBe(true)
  })

  it('끝난 것은 닫혀 있다 — 다시 열지 않는다', () => {
    expect(isOpen('completed')).toBe(false)
    expect(isOpen('abandoned')).toBe(false)
  })
})
