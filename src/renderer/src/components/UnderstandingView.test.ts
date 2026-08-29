import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectUnderstanding } from '../../../core/understanding/types'
import { UnderstandingView } from './UnderstandingView'

// MarkdownPreview.test.ts 와 같은 이유 — I18nProvider 의 효과는 renderToStaticMarkup 에서 돌지 않고
// 실제 window.api 도 없다. 훅을 직접 갈아 끼우는 것이 jsdom 없이 진짜 렌더를 보는 방법이다.
// renderToStaticMarkup HTML-entity-escapes `"` even inside plain text nodes (React 19), so a mock that
// embeds JSON.stringify(params) — literal double quotes — can never satisfy an exact toContain match
// against unescaped quotes. Serializing params without quote characters sidesteps the escaping entirely
// while still proving the right key and params reached t().
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string, params?: Record<string, string | number>) =>
      params
        ? `${key}:{${Object.entries(params)
            .map(([k, v]) => `${k}:${v}`)
            .join(',')}}`
        : key,
    tm: (m: unknown) => (m === null ? null : String(m))
  })
}))

const render = (u: ProjectUnderstanding | null, selected: string | null = null): string =>
  renderToStaticMarkup(
    React.createElement(UnderstandingView, {
      understanding: u,
      selectedFeatureId: selected,
      onOpenFeature: () => {},
      onReview: () => {},
      onAnalyze: () => {}
    })
  )

const base: ProjectUnderstanding = {
  features: [
    { id: 'auth', name: '인증', summary: 'Google 로그인', status: 'up-to-date', updatedAt: '2026-08-27T00:00:00.000Z', evidenceCount: 6 },
    { id: 'pay', name: '결제', summary: '카드 결제', status: 'needs-review', updatedAt: '2026-08-27T00:00:00.000Z', evidenceCount: 3, staleReason: 'PaymentService.ts 외 2개가 바뀜' }
  ],
  explanations: {},
  analyzedAt: '2026-08-27T00:00:00.000Z',
  recentChanges: [
    { id: 'c1', at: '2026-08-29T00:00:00.000Z', sourceKind: 'session', sourceId: '182', sourceLabel: '세션 #182', body: 'JWT → 서버 세션', featureName: '인증' }
  ]
}

describe('UnderstandingView', () => {
  it('분석 전에는 분석 버튼만 보인다', () => {
    const html = render(null)
    expect(html).toContain('hiw.empty.analyze')
    expect(html).not.toContain('hiw.recent.project')
  })

  it('검토가 필요한 줄이 위에 온다', () => {
    const html = render(base)
    expect(html.indexOf('결제')).toBeLessThan(html.indexOf('인증'))
  })

  it('검토가 필요한 줄은 시각 대신 이유를 적는다', () => {
    const html = render(base)
    expect(html).toContain('PaymentService.ts 외 2개가 바뀜')
    expect(html).toContain('hiw.feature.review')
  })

  it('최신인 줄은 근거 개수를 적는다', () => {
    expect(render(base)).toContain('hiw.feature.evidence:{count:6}')
  })

  it('요약 줄이 검토 필요 개수를 센다', () => {
    expect(render(base)).toContain('hiw.summary.attention:{count:1}')
  })

  it('고른 줄에 on 이 붙는다', () => {
    expect(render(base, 'auth')).toContain('hiw-row on')
  })

  it('프로젝트 전체 최근 변경을 그린다', () => {
    expect(render(base)).toContain('hiw.recent.project')
    expect(render(base)).toContain('JWT → 서버 세션')
  })
})
