import { describe, it, expect } from 'vitest'
import { pseudoize } from './pseudo'

describe('pseudoize', () => {
  it('원문을 알아볼 수 있게 두고 길이만 늘린다', () => {
    const out = pseudoize('Settings')
    expect(out).toContain('Séttíngs')
    expect(out.length).toBeGreaterThan('Settings'.length)
  })
  it('자리표시자는 건드리지 않는다 — 치환이 깨지면 테스트 도구가 아니라 버그가 된다', () => {
    expect(pseudoize('Cannot use {char}')).toContain('{char}')
  })
  it('경계 표시로 잘림을 눈에 보이게 한다', () => {
    const out = pseudoize('OK')
    expect(out.startsWith('⟦')).toBe(true)
    expect(out.endsWith('⟧')).toBe(true)
  })
  it('빈 문자열도 안전하다', () => {
    expect(() => pseudoize('')).not.toThrow()
  })
})
