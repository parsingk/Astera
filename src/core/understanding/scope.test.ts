import { describe, it, expect } from 'vitest'
import type { FeatureExplanation } from './types'
import { isScopable, scopeToStep } from './scope'

const explanation: FeatureExplanation = {
  featureId: 'auth',
  overview: '',
  userFlow: [
    { id: 'login', label: '로그인 클릭', type: 'start', next: [{ targetId: 'session' }] },
    {
      id: 'session',
      label: '서버 세션 생성',
      description: '서버가 세션을 만듭니다.',
      type: 'success',
      next: [],
      evidenceIds: ['e-store', 'e-svc']
    }
  ],
  failureFlows: [],
  keyDecisions: [
    { id: 'd1', title: '서버 세션', reason: '', source: 'adr', sourceLabel: 'ADR-012', evidenceIds: ['e-store'] },
    { id: 'd2', title: '어댑터 분리', reason: '', source: 'agent', sourceLabel: '추정', evidenceIds: ['e-oauth'] }
  ],
  implementation: [
    { role: '세션 저장', path: 'src/auth/SessionStore.ts', evidenceIds: ['e-store'] },
    { role: 'Google 연동', path: 'src/auth/GoogleOAuthProvider.ts', evidenceIds: ['e-oauth'] }
  ],
  recentChanges: [
    { id: 'c1', at: '2026-08-29T00:00:00.000Z', sourceKind: 'session', sourceId: '182', sourceLabel: '세션 #182', body: '', evidenceIds: ['e-svc'] },
    { id: 'c2', at: '2026-08-21T00:00:00.000Z', sourceKind: 'job', sourceId: '51', sourceLabel: 'Job #51', body: '', evidenceIds: ['e-oauth'] }
  ],
  evidence: [],
  userEdited: false,
  generatedAt: '2026-08-29T00:00:00.000Z'
}

describe('isScopable', () => {
  it('근거가 붙은 단계만 고를 수 있다', () => {
    expect(isScopable(explanation.userFlow[1])).toBe(true)
  })

  it('근거가 없는 단계는 고를 수 없다 — 좁힐 것이 없다', () => {
    expect(isScopable(explanation.userFlow[0])).toBe(false)
  })
})

describe('scopeToStep', () => {
  it('근거가 겹치는 것만 남긴다', () => {
    const v = scopeToStep(explanation, 'session')!
    expect(v.node.id).toBe('session')
    expect(v.decisions.map((d) => d.id)).toEqual(['d1'])
    expect(v.implementation.map((i) => i.path)).toEqual(['src/auth/SessionStore.ts'])
    expect(v.changes.map((c) => c.id)).toEqual(['c1'])
  })

  it('실패 갈래의 단계도 찾는다', () => {
    const withFailure: FeatureExplanation = {
      ...explanation,
      failureFlows: [
        { id: 'authfail', label: '인증 실패', type: 'failure', next: [], evidenceIds: ['e-oauth'] }
      ]
    }
    const v = scopeToStep(withFailure, 'authfail')!
    expect(v.decisions.map((d) => d.id)).toEqual(['d2'])
  })

  it('고를 수 없는 단계는 null', () => {
    expect(scopeToStep(explanation, 'login')).toBeNull()
  })

  it('없는 단계는 null', () => {
    expect(scopeToStep(explanation, 'nope')).toBeNull()
  })
})
