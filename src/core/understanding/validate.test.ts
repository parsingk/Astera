import { describe, it, expect } from 'vitest'
import { validateRecord } from './validate'

/** 통과하는 최소 출력 — 각 테스트가 여기서 한 곳씩 망가뜨린다 */
const good = (): Record<string, unknown> => ({
  overview: '사용자가 로그인하면 서버가 세션을 만들어 돌려준다.',
  userVisibleChanges: [],
  flow: [
    { id: 's', label: '로그인 요청', type: 'start', description: '아이디와 비밀번호', next: [{ targetId: 'ok' }] },
    { id: 'ok', label: '세션 발급', type: 'success', next: [] }
  ],
  decisions: [{ title: '세션은 서버에 둔다', reason: '로그아웃을 서버가 강제할 수 있어야 한다', sourceLabel: 'ADR-001' }],
  implementation: [{ role: '인증 API', path: 'src/auth/login.ts' }],
  evidencePaths: ['src/auth/login.ts', 'src/auth/session.ts'],
  needsReview: false
})

const exists = (real: string[]) => (p: string): boolean => real.includes(p)
const allExist = (): boolean => true

describe('validateRecord — 스키마', () => {
  it('올바른 출력은 통과하고 값이 그대로 나온다', () => {
    const r = validateRecord(good(), allExist)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.overview).toContain('로그인')
      expect(r.value.flow).toHaveLength(2)
      expect(r.value.implementation[0].role).toBe('인증 API')
    }
  })

  it('객체가 아니면 거부한다', () => {
    expect(validateRecord('문자열', allExist).ok).toBe(false)
    expect(validateRecord(null, allExist).ok).toBe(false)
    expect(validateRecord([good()], allExist).ok).toBe(false)
  })

  it('overview 없음 · flow 빈 배열은 거부한다', () => {
    expect(validateRecord({ ...good(), overview: ' ' }, allExist).ok).toBe(false)
    expect(validateRecord({ ...good(), flow: [] }, allExist).ok).toBe(false)
  })

  // FlowNode.label 의 22자 규칙 — 화면 칸이 고정 크기다. 자르지 않고 거부한다
  it('label 이 22자를 넘으면 거부한다 — 자르지 않는다', () => {
    const g = good()
    ;(g.flow as Record<string, unknown>[])[0].label = '사용자가 아이디와 비밀번호로 로그인을 요청한다'
    const r = validateRecord(g, allExist)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('22자')
  })

  it('없는 종류의 칸과 없는 칸을 가리키는 간선은 거부한다', () => {
    const g1 = good()
    ;(g1.flow as Record<string, unknown>[])[0].type = 'wizard'
    expect(validateRecord(g1, allExist).ok).toBe(false)

    const g2 = good()
    ;(g2.flow as Record<string, unknown>[])[0].next = [{ targetId: '유령' }]
    const r = validateRecord(g2, allExist)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('유령')
  })

  it('userVisibleChanges 가 문자열 배열이 아니면 거부한다', () => {
    expect(validateRecord({ ...good(), userVisibleChanges: 'x' }, allExist).ok).toBe(false)
  })

  it('implementation 이 비면 거부한다 — 근거 없는 설명이다', () => {
    expect(validateRecord({ ...good(), implementation: [] }, allExist).ok).toBe(false)
  })

  it('needsReview 인데 사유가 없으면 거부한다 (§24-13)', () => {
    expect(validateRecord({ ...good(), needsReview: true }, allExist).ok).toBe(false)
    const r = validateRecord(
      { ...good(), needsReview: true, needsReviewReason: '테스트 커버리지 근거를 찾지 못했다' },
      allExist
    )
    expect(r.ok).toBe(true)
  })

  it('title 은 있으면 받고 없어도 통과한다 — 옛 기록과 이 값을 빠뜨린 모델을 모두 살린다', () => {
    const withTitle = validateRecord({ ...good(), title: '로그인을 서버 세션으로' }, allExist)
    expect(withTitle.ok && withTitle.value.title).toBe('로그인을 서버 세션으로')

    const without = validateRecord(good(), allExist)
    expect(without.ok && without.value.title).toBeUndefined()
  })

  it('빈 title 은 없는 것으로 본다 — 빈 제목은 줄에서 고를 수 없다', () => {
    const r = validateRecord({ ...good(), title: '   ' }, allExist)
    expect(r.ok && r.value.title).toBeUndefined()
  })
})

describe('validateRecord — 근거 검증 (§24-12)', () => {
  it('유령 경로 하나면 전체를 거부하고 그 경로를 사유에 적는다', () => {
    const r = validateRecord(good(), exists(['src/auth/login.ts'])) // session.ts 가 없다
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('src/auth/session.ts')
  })

  it('implementation 의 경로도 같은 검증을 받는다', () => {
    const r = validateRecord(good(), exists(['src/auth/session.ts'])) // login.ts 가 없다
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('src/auth/login.ts')
  })
})

// 오른쪽 단이 좁혀지는 것은 오직 근거 id 의 겹침이다(scope.ts). 그 id 가 여기서 만들어진다 —
// 여기서 비면 흐름도는 눌리지 않는 그림이 된다.
describe('근거 잇기 — 단계를 누를 수 있게 하는 것', () => {
  const base = {
    overview: '설명',
    userVisibleChanges: [],
    flow: [
      { id: 'a', label: '요청', type: 'start', next: [], evidencePaths: ['src/a.ts'] },
      { id: 'b', label: '응답', type: 'success', next: [] }
    ],
    decisions: [{ title: 't', reason: 'r', sourceLabel: 's', evidencePaths: ['src/b.ts'] }],
    implementation: [{ role: '인증', path: 'src/a.ts' }],
    evidencePaths: ['src/a.ts'],
    needsReview: false
  }
  const all = (): boolean => true

  it('단계가 댄 경로가 id 로 실린다 — 대지 않은 단계는 고를 수 없다', () => {
    const r = validateRecord(base, all)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.flow[0].evidenceIds).toEqual(['file:src/a.ts'])
    expect(r.value.flow[1].evidenceIds).toBeUndefined()
  })

  it('결정도 자기 근거를 든다', () => {
    const r = validateRecord(base, all)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.decisions[0].evidenceIds).toEqual(['file:src/b.ts'])
  })

  // 구현 참조는 "이 기능이 이 파일에 산다"는 말이라 그 파일 말고 다른 근거가 있을 수 없다.
  // 이 기본값이 없으면 단계를 눌렀을 때 "이 단계의 구현" 칸이 늘 빈다
  it('구현 참조는 대지 않아도 자기 경로가 근거다', () => {
    const r = validateRecord(base, all)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.implementation[0].evidenceIds).toEqual(['file:src/a.ts'])
  })

  // 항목이 댄 경로가 근거 목록에 없으면 그 id 는 아무것도 가리키지 않는 id 가 된다
  it('항목이 댄 경로가 근거 목록에 합쳐진다', () => {
    const r = validateRecord(base, all)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.evidencePaths).toContain('src/b.ts')
    expect(r.value.evidencePaths.filter((p) => p === 'src/a.ts')).toHaveLength(1) // 겹치지 않는다
  })

  it('항목이 댄 경로도 실재해야 한다', () => {
    const r = validateRecord(base, (p) => p !== 'src/b.ts')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('src/b.ts')
  })

  it('근거 경로가 문자열 배열이 아니면 거부한다', () => {
    const bad = { ...base, flow: [{ ...base.flow[0], evidencePaths: [1] }] }
    const r = validateRecord(bad, all)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('evidencePaths')
  })

  // 빈 배열을 그대로 실으면 "근거가 있다"면서 아무것도 가리키지 않는 단계가 된다
  it('빈 근거 배열은 없는 것과 같이 다룬다', () => {
    const r = validateRecord({ ...base, flow: [{ ...base.flow[0], evidencePaths: [] }] }, all)
    if (!r.ok) throw new Error(r.reason)
    expect(r.value.flow[0].evidenceIds).toBeUndefined()
  })
})

// 분기 조건은 상자와 상자 사이 30px 에 앉는다. 문장이 오면 두 줄이 되고, 두 줄이 되면 첫 줄이
// 위쪽 상자 뒤로 숨어 꼬리만 보인다 — 실측으로 그렇게 깨졌다("한도에 도달하고 다음 계정이 있음"이
// "이 있음"으로 보였다). 화면 쪽은 nowrap 으로 막았고, 여기서는 문장이 된 조건을 잡는다.
describe('분기 조건 문구', () => {
  const withCondition = (condition: string): unknown => ({
    overview: '설명',
    userVisibleChanges: [],
    flow: [
      { id: 'a', label: '시작', type: 'start', next: [{ targetId: 'b', condition }] },
      { id: 'b', label: '끝', type: 'success', next: [] }
    ],
    decisions: [],
    implementation: [{ role: 'x', path: 'src/a.ts' }],
    evidencePaths: ['src/a.ts'],
    needsReview: false
  })
  const all = (): boolean => true

  it('딱지 길이는 그대로 실린다', () => {
    const r = validateRecord(withCondition('한도에 도달하지 않음'), all)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.flow[0].next[0].condition).toBe('한도에 도달하지 않음')
  })

  // 한도가 넉넉한 이유: 실측에서 에이전트가 쓴 가장 긴 조건이 18자였고, 그것 하나로 3~4분짜리
  // 생성을 통째로 버리는 것은 값이 맞지 않는다
  it('열여덟 자는 통과한다', () => {
    expect(validateRecord(withCondition('한도에 도달하고 다음 계정이 있음'), all).ok).toBe(true)
  })

  it('문장이 된 조건은 거부한다', () => {
    const r = validateRecord(withCondition('사용자가 다른 계정을 고르고 그 계정이 아직 한도에 걸리지 않았을 때'), all)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('분기 조건')
  })
})

describe('validateRecord', () => {
  const ok = {
    overview: '한도 대화상자를 신호로 삼도록 바꿨다.',
    userVisibleChanges: ['한도에 걸린 세션이 스스로 풀린다'],
    flow: [{ id: 'a', label: '대화상자 감지', type: 'start', next: [], evidencePaths: ['src/a.ts'] }],
    decisions: [{ title: '문구 대신 대화상자', reason: '배너가 없는 화면이 있다', sourceLabel: '실측', evidencePaths: ['src/a.ts'] }],
    implementation: [{ role: '감지', path: 'src/a.ts' }],
    evidencePaths: ['src/a.ts'],
    needsReview: false
  }
  const all = (): boolean => true

  it('올바른 출력은 통과한다', () => {
    const r = validateRecord(ok, all)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.userVisibleChanges).toEqual(['한도에 걸린 세션이 스스로 풀린다'])
  })

  it('overview 가 없으면 거부한다', () => {
    expect(validateRecord({ ...ok, overview: '' }, all).ok).toBe(false)
  })

  // Some work has no user-visible change — internal cleanup, added tests
  it('userVisibleChanges 는 비어 있어도 된다', () => {
    expect(validateRecord({ ...ok, userVisibleChanges: [] }, all).ok).toBe(true)
  })

  it('userVisibleChanges 가 문자열 배열이 아니면 거부한다', () => {
    expect(validateRecord({ ...ok, userVisibleChanges: 'x' }, all).ok).toBe(false)
  })

  it('flow 가 비면 거부한다 — 흐름 없는 설명은 화면이 그릴 것이 없다', () => {
    expect(validateRecord({ ...ok, flow: [] }, all).ok).toBe(false)
  })

  it('유령 경로는 거부한다 (§24-12)', () => {
    const r = validateRecord(ok, (p) => p !== 'src/a.ts')
    expect(r.ok).toBe(false)
  })

  it('근거가 모자라다고 하면서 사유가 없으면 거부한다 (§24-13)', () => {
    expect(validateRecord({ ...ok, needsReview: true }, all).ok).toBe(false)
  })
})
