import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { FeatureExplanation, ProjectFeature } from '../../../core/understanding/types'
import { FeatureDetail } from './FeatureDetail'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    // 값을 JSON.stringify 로 찍지 않는다 — renderToStaticMarkup 이 텍스트 노드의 " 를
    // &quot; 로 이스케이프해서, 따옴표가 든 단언은 어떤 구현으로도 통과하지 못한다
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? `${key}:{${Object.entries(params)
            .map(([k, v]) => `${k}:${v}`)
            .join(',')}}`
        : key,
    tm: (m: unknown) => (m === null ? null : String(m))
  })
}))

const feature: ProjectFeature = {
  id: 'auth',
  name: '인증',
  summary: 'Google 로그인',
  status: 'up-to-date',
  updatedAt: '2026-08-27T00:00:00.000Z',
  evidenceCount: 6
}

const explanation: FeatureExplanation = {
  featureId: 'auth',
  overview: '사용자는 Google 계정으로 로그인할 수 있습니다.',
  userFlow: [
    { id: 'login', label: '로그인 클릭', type: 'start', next: [{ targetId: 'session' }] },
    {
      id: 'session',
      label: '서버 세션 생성',
      description: '세션을 만듭니다.',
      type: 'success',
      next: [],
      evidenceIds: ['e1']
    }
  ],
  // 빈 배열로 두면 "여섯 조각" 테스트가 통과할 수 없다 — 실패 흐름은 있을 때만 그린다(제목만
  // 남은 빈 칸을 만들지 않는다). 여섯 번째 조각을 확인하려면 흐름이 하나는 있어야 한다
  failureFlows: [
    { id: 'denied', label: 'Google 이 거부', description: '로그인 화면으로 되돌립니다.', type: 'failure', next: [] }
  ],
  keyDecisions: [
    {
      id: 'd1',
      title: 'JWT 대신 서버 세션',
      reason: '즉시 끊을 수 있어야 해서',
      source: 'adr',
      sourceLabel: 'ADR-012',
      evidenceIds: ['e1']
    },
    {
      id: 'd2',
      title: '어댑터 분리',
      reason: '나중에 붙이려고',
      source: 'agent',
      sourceLabel: '세션 #140 · 추정'
    }
  ],
  implementation: [{ role: '세션 저장', path: 'src/auth/SessionStore.ts', evidenceIds: ['e1'] }],
  recentChanges: [
    {
      id: 'c1',
      at: '2026-08-29T00:00:00.000Z',
      sourceKind: 'session',
      sourceId: '182',
      sourceLabel: '세션 #182',
      body: 'JWT → 서버 세션',
      evidenceIds: ['e1']
    }
  ],
  evidence: [
    { id: 'e1', type: 'source-file', label: 'SessionStore.ts', path: 'src/auth/SessionStore.ts' }
  ],
  userEdited: false,
  generatedAt: '2026-08-29T00:00:00.000Z'
}

const render = (scoped: string | null = null, x: FeatureExplanation | null = explanation): string =>
  renderToStaticMarkup(
    React.createElement(FeatureDetail, {
      feature,
      explanation: x,
      scopedNodeId: scoped,
      onPickStep: () => {},
      onOpenPath: () => {}
    })
  )

describe('FeatureDetail', () => {
  it('여섯 조각을 모두 그린다', () => {
    const html = render()
    for (const key of [
      'hiw.pane.overview',
      'hiw.pane.flow',
      'hiw.pane.failures',
      'hiw.pane.decisions',
      'hiw.pane.implementation',
      'hiw.pane.changes'
    ])
      expect(html).toContain(key)
  })

  it('추정한 결정의 알약에만 low 가 붙는다', () => {
    const html = render()
    expect(html).toContain('hiw-src low')
    expect((html.match(/hiw-src/g) ?? []).length).toBe(2)
  })

  it('설명이 없으면 안내만 그린다', () => {
    const html = render(null, null)
    expect(html).toContain('hiw.pane.noExplanation')
    expect(html).not.toContain('hiw.pane.decisions')
  })

  it('단계를 고르면 오른쪽이 좁혀진다', () => {
    const html = render('session')
    expect(html).toContain('hiw.scope.whatHappens')
    expect(html).toContain('hiw.scope.clear')
    // 좁혔을 때는 추정 결정(d2, 근거 없음)이 빠진다
    expect(html).not.toContain('어댑터 분리')
    expect(html).toContain('JWT 대신 서버 세션')
  })

  it('고를 수 없는 단계를 넘기면 전체를 그린다', () => {
    const html = render('login')
    expect(html).toContain('hiw.pane.decisions')
    expect(html).not.toContain('hiw.scope.clear')
  })
})
