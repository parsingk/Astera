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

// 오른쪽 단이 좁혀지는 것은 오직 근거 id 의 겹침이다(scope.ts). 그 id 가 여기서 만들어진다 —
// 여기서 비면 흐름도는 눌리지 않는 그림이 된다.
describe('근거 잇기 — 단계를 누를 수 있게 하는 것', () => {
  const base = {
    overview: '설명',
    userFlow: [
      { id: 'a', label: '요청', type: 'start', next: [], evidencePaths: ['src/a.ts'] },
      { id: 'b', label: '응답', type: 'success', next: [] }
    ],
    failureFlows: [],
    keyDecisions: [{ title: 't', reason: 'r', sourceLabel: 's', evidencePaths: ['src/b.ts'] }],
    implementation: [{ role: '인증', path: 'src/a.ts' }],
    evidencePaths: ['src/a.ts'],
    needsReview: false
  }
  const all = (): boolean => true

  it('단계가 댄 경로가 id 로 실린다 — 대지 않은 단계는 고를 수 없다', () => {
    const r = validateExplanation(base, all)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.userFlow[0].evidenceIds).toEqual(['file:src/a.ts'])
    expect(r.value.userFlow[1].evidenceIds).toBeUndefined()
  })

  it('결정도 자기 근거를 든다', () => {
    const r = validateExplanation(base, all)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.keyDecisions[0].evidenceIds).toEqual(['file:src/b.ts'])
  })

  // 구현 참조는 "이 기능이 이 파일에 산다"는 말이라 그 파일 말고 다른 근거가 있을 수 없다.
  // 이 기본값이 없으면 단계를 눌렀을 때 "이 단계의 구현" 칸이 늘 빈다
  it('구현 참조는 대지 않아도 자기 경로가 근거다', () => {
    const r = validateExplanation(base, all)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.implementation[0].evidenceIds).toEqual(['file:src/a.ts'])
  })

  // 항목이 댄 경로가 근거 목록에 없으면 그 id 는 아무것도 가리키지 않는 id 가 된다
  it('항목이 댄 경로가 근거 목록에 합쳐진다', () => {
    const r = validateExplanation(base, all)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.evidencePaths).toContain('src/b.ts')
    expect(r.value.evidencePaths.filter((p) => p === 'src/a.ts')).toHaveLength(1) // 겹치지 않는다
  })

  it('항목이 댄 경로도 실재해야 한다', () => {
    const r = validateExplanation(base, (p) => p !== 'src/b.ts')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('src/b.ts')
  })

  it('근거 경로가 문자열 배열이 아니면 거부한다', () => {
    const bad = { ...base, userFlow: [{ ...base.userFlow[0], evidencePaths: [1] }] }
    const r = validateExplanation(bad, all)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('evidencePaths')
  })

  // 빈 배열을 그대로 실으면 "근거가 있다"면서 아무것도 가리키지 않는 단계가 된다
  it('빈 근거 배열은 없는 것과 같이 다룬다', () => {
    const r = validateExplanation({ ...base, userFlow: [{ ...base.userFlow[0], evidencePaths: [] }] }, all)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.userFlow[0].evidenceIds).toBeUndefined()
  })
})

// **두 흐름의 규칙이 다르다.** userFlow 만 그래프로 그려지므로 자기 안에서 닫혀 있어야 하고,
// failureFlows 는 목록으로만 그려져 간선이 화면에 없다. 이 구분이 없을 때 216초짜리 생성 하나가
// "본류가 실패 칸을 가리킨다"는 이유로 통째로 버려졌다(실측).
describe('흐름 간선이 풀리는 범위', () => {
  const make = (userFlow: unknown, failureFlows: unknown): unknown => ({
    overview: '설명',
    userFlow,
    failureFlows,
    keyDecisions: [],
    implementation: [{ role: 'x', path: 'src/a.ts' }],
    evidencePaths: ['src/a.ts'],
    needsReview: false
  })
  const all = (): boolean => true

  it('본류가 없는 칸을 가리키면 거부한다 — 선이 허공으로 간다', () => {
    const r = validateExplanation(
      make([{ id: 'u1', label: '요청', type: 'start', next: [{ targetId: 'f1' }] }], [{ id: 'f1', label: '실패', type: 'failure', next: [] }]),
      all
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('f1')
  })

  it('실패 흐름이 본류로 돌아가는 것은 받는다 — 그 간선은 그려지지 않는다', () => {
    const r = validateExplanation(
      make(
        [{ id: 'u1', label: '요청', type: 'start', next: [] }],
        [{ id: 'f1', label: '재시도', type: 'failure', next: [{ targetId: 'u1' }] }]
      ),
      all
    )
    expect(r.ok).toBe(true)
  })

  it('실패 흐름이 아무 데도 없는 칸을 가리키면 그래도 거부한다', () => {
    const r = validateExplanation(
      make([{ id: 'u1', label: '요청', type: 'start', next: [] }], [{ id: 'f1', label: '재시도', type: 'failure', next: [{ targetId: '없음' }] }]),
      all
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('없음')
  })
})

// 분기 조건은 상자와 상자 사이 30px 에 앉는다. 문장이 오면 두 줄이 되고, 두 줄이 되면 첫 줄이
// 위쪽 상자 뒤로 숨어 꼬리만 보인다 — 실측으로 그렇게 깨졌다("한도에 도달하고 다음 계정이 있음"이
// "이 있음"으로 보였다). 화면 쪽은 nowrap 으로 막았고, 여기서는 문장이 된 조건을 잡는다.
describe('분기 조건 문구', () => {
  const withCondition = (condition: string): unknown => ({
    overview: '설명',
    userFlow: [
      { id: 'a', label: '시작', type: 'start', next: [{ targetId: 'b', condition }] },
      { id: 'b', label: '끝', type: 'success', next: [] }
    ],
    failureFlows: [],
    keyDecisions: [],
    implementation: [{ role: 'x', path: 'src/a.ts' }],
    evidencePaths: ['src/a.ts'],
    needsReview: false
  })
  const all = (): boolean => true

  it('딱지 길이는 그대로 실린다', () => {
    const r = validateExplanation(withCondition('한도에 도달하지 않음'), all)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.userFlow[0].next[0].condition).toBe('한도에 도달하지 않음')
  })

  // 한도가 넉넉한 이유: 실측에서 에이전트가 쓴 가장 긴 조건이 18자였고, 그것 하나로 3~4분짜리
  // 생성을 통째로 버리는 것은 값이 맞지 않는다
  it('열여덟 자는 통과한다', () => {
    expect(validateExplanation(withCondition('한도에 도달하고 다음 계정이 있음'), all).ok).toBe(true)
  })

  it('문장이 된 조건은 거부한다', () => {
    const r = validateExplanation(withCondition('사용자가 다른 계정을 고르고 그 계정이 아직 한도에 걸리지 않았을 때'), all)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('분기 조건')
  })
})
