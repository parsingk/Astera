import { describe, it, expect } from 'vitest'
import { buildDiscoverPrompt, buildExplainPrompt, EXPLANATION_CONTRACT } from './prompt'

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

describe('buildExplainPrompt', () => {
  const req = {
    feature: { id: 'auth', name: '인증', summary: '로그인과 세션' },
    implementationPaths: ['src/auth', 'src/core/session.ts'],
    recentChangeBodies: ['로그인 고쳐줘'],
    projectRoot: 'D:/p'
  }

  it('계약·기능·경로·변화·출력 모양이 모두 실린다', () => {
    const p = buildExplainPrompt(req)
    expect(p).toContain(EXPLANATION_CONTRACT)
    expect(p).toContain('인증')
    expect(p).toContain('- src/auth')
    expect(p).toContain('- 로그인 고쳐줘')
    expect(p).toContain('"needsReview"')
    expect(p).toContain('under 22 characters')
  })

  it('읽기 전용을 문장으로 못박는다', () => {
    expect(buildExplainPrompt(req)).toContain('never modify anything')
  })

  it('첫 생성(변화 없음)이면 변화 절이 아예 없다', () => {
    const p = buildExplainPrompt({ ...req, recentChangeBodies: [] })
    expect(p).not.toContain('Recent changes')
  })
})

describe('buildDiscoverPrompt', () => {
  it('루트·계약·초안 성격·출력 모양이 실린다', () => {
    const p = buildDiscoverPrompt('D:/p')
    expect(p).toContain('D:/p')
    expect(p).toContain(EXPLANATION_CONTRACT)
    expect(p).toContain('implementationPaths')
    expect(p).toContain('draft')
    expect(p).toContain('never modify anything')
  })
})
