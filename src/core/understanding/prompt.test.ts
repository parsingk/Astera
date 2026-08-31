import { describe, it, expect } from 'vitest'
import { EXPLANATION_CONTRACT } from './prompt'

describe('EXPLANATION_CONTRACT — 스펙 §24 의 계약이 온전한가', () => {
  // 조항을 빼면 그 구멍으로 도망간다 — 14개 번호와 §25 요지(7-1)가 전부 있어야 한다
  it('14개 규칙의 번호가 전부 들어 있다', () => {
    for (let n = 1; n <= 14; n++) expect(EXPLANATION_CONTRACT).toMatch(new RegExp(`^${n}\\. `, 'm'))
    expect(EXPLANATION_CONTRACT).toMatch(/^7-1\. /m) // §25 Vocabulary Guard
  })

  it('계약의 핵심 문장들이 원문 그대로다', () => {
    expect(EXPLANATION_CONTRACT).toContain('product manager')
    expect(EXPLANATION_CONTRACT).toContain('Do not invent behavior')
    expect(EXPLANATION_CONTRACT).toContain('grounded in supplied evidence')
    expect(EXPLANATION_CONTRACT).toContain('needs\n    review instead of guessing')
    expect(EXPLANATION_CONTRACT).toContain('chain-of-thought')
  })
})
