import { describe, it, expect } from 'vitest'
import { validateDiscovery, validateExplanation } from './validate'

/** 통과하는 최소 출력 — 각 테스트가 여기서 한 곳씩 망가뜨린다 */
const good = (): Record<string, unknown> => ({
  overview: '사용자가 로그인하면 서버가 세션을 만들어 돌려준다.',
  userFlow: [
    { id: 's', label: '로그인 요청', type: 'start', description: '아이디와 비밀번호', next: [{ targetId: 'ok' }] },
    { id: 'ok', label: '세션 발급', type: 'success', next: [] }
  ],
  failureFlows: [],
  keyDecisions: [{ title: '세션은 서버에 둔다', reason: '로그아웃을 서버가 강제할 수 있어야 한다', sourceLabel: 'ADR-001' }],
  implementation: [{ role: '인증 API', path: 'src/auth/login.ts' }],
  evidencePaths: ['src/auth/login.ts', 'src/auth/session.ts'],
  needsReview: false
})

const exists = (real: string[]) => (p: string): boolean => real.includes(p)
const allExist = (): boolean => true

describe('validateExplanation — 스키마', () => {
  it('올바른 출력은 통과하고 값이 그대로 나온다', () => {
    const r = validateExplanation(good(), allExist)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.overview).toContain('로그인')
      expect(r.value.userFlow).toHaveLength(2)
      expect(r.value.implementation[0].role).toBe('인증 API')
    }
  })

  it('객체가 아니면 거부한다', () => {
    expect(validateExplanation('문자열', allExist).ok).toBe(false)
    expect(validateExplanation(null, allExist).ok).toBe(false)
    expect(validateExplanation([good()], allExist).ok).toBe(false)
  })

  it('overview 없음 · userFlow 빈 배열은 거부한다', () => {
    expect(validateExplanation({ ...good(), overview: ' ' }, allExist).ok).toBe(false)
    expect(validateExplanation({ ...good(), userFlow: [] }, allExist).ok).toBe(false)
  })

  // FlowNode.label 의 22자 규칙 — 화면 칸이 고정 크기다. 자르지 않고 거부한다
  it('label 이 22자를 넘으면 거부한다 — 자르지 않는다', () => {
    const g = good()
    ;(g.userFlow as Record<string, unknown>[])[0].label = '사용자가 아이디와 비밀번호로 로그인을 요청한다'
    const r = validateExplanation(g, allExist)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('22자')
  })

  it('없는 종류의 칸과 없는 칸을 가리키는 간선은 거부한다', () => {
    const g1 = good()
    ;(g1.userFlow as Record<string, unknown>[])[0].type = 'wizard'
    expect(validateExplanation(g1, allExist).ok).toBe(false)

    const g2 = good()
    ;(g2.userFlow as Record<string, unknown>[])[0].next = [{ targetId: '유령' }]
    const r = validateExplanation(g2, allExist)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('유령')
  })

  it('implementation 이 비면 거부한다 — 근거 없는 설명이다', () => {
    expect(validateExplanation({ ...good(), implementation: [] }, allExist).ok).toBe(false)
  })

  it('needsReview 인데 사유가 없으면 거부한다 (§24-13)', () => {
    expect(validateExplanation({ ...good(), needsReview: true }, allExist).ok).toBe(false)
    const r = validateExplanation({ ...good(), needsReview: true, needsReviewReason: '테스트 커버리지 근거를 찾지 못했다' }, allExist)
    expect(r.ok).toBe(true)
  })
})

describe('validateExplanation — 근거 검증 (§24-12)', () => {
  it('유령 경로 하나면 전체를 거부하고 그 경로를 사유에 적는다', () => {
    const r = validateExplanation(good(), exists(['src/auth/login.ts'])) // session.ts 가 없다
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('src/auth/session.ts')
  })

  it('implementation 의 경로도 같은 검증을 받는다', () => {
    const r = validateExplanation(good(), exists(['src/auth/session.ts'])) // login.ts 가 없다
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('src/auth/login.ts')
  })
})

describe('validateDiscovery — 첫 분석 (§21)', () => {
  const draft = (): Record<string, unknown> => ({
    features: [
      { name: '인증', summary: '로그인과 세션 관리', implementationPaths: ['src/auth'] },
      { name: '알림', summary: '슬랙 알림', implementationPaths: ['src/notifications'] }
    ]
  })

  it('올바른 초안은 통과한다', () => {
    const r = validateDiscovery(draft(), allExist)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.features.map((f) => f.name)).toEqual(['인증', '알림'])
  })

  it('빈 목록·구현 경로 없는 기능·유령 경로는 거부한다', () => {
    expect(validateDiscovery({ features: [] }, allExist).ok).toBe(false)
    const noPath = { features: [{ name: '인증', summary: 's', implementationPaths: [] }] }
    expect(validateDiscovery(noPath, allExist).ok).toBe(false)
    const r = validateDiscovery(draft(), exists(['src/auth']))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('src/notifications')
  })
})
