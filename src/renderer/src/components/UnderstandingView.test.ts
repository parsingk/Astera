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
      onRegenerate: () => {},
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
    expect(html).toContain('hiw.feature.regenerate')
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

// 만들지 못한 줄은 그 자리에서 다시 눌러 볼 수 있어야 한다 — 그러지 않으면 사유만 남고 고칠
// 길이 없다. 갱신이 있는 줄에서 새 설명을 받는 길도 이 버튼뿐이다(사람이 고친 설명은 배경
// 재생성이 덮지 않는다, 스펙 §56).
describe('[다시 만들기] 가 서는 자리', () => {
  const one = (status: ProjectUnderstanding['features'][number]['status'], staleReason?: string): ProjectUnderstanding => ({
    features: [{ id: 'x', name: '결제', summary: '카드', status, updatedAt: 'x', evidenceCount: 0, staleReason }],
    explanations: {},
    recentChanges: []
  })

  it('만들지 못한 줄에 선다 — 사유와 함께', () => {
    const html = render(one('generation-failed', '180초 안에 끝나지 않았다'))
    expect(html).toContain('hiw.feature.regenerate')
    expect(html).toContain('180초 안에 끝나지 않았다')
  })

  it('갱신이 있는 줄에도 선다', () => {
    expect(render(one('update-available'))).toContain('hiw.feature.regenerate')
  })

  it('최신인 줄에는 서지 않는다 — 손댈 것이 없는 줄에 버튼을 두지 않는다', () => {
    expect(render(one('up-to-date'))).not.toContain('hiw.feature.regenerate')
  })

  // 한때 여기 [갱신 검토] 가 함께 있었고, 그것이 하는 일은 줄을 누르는 것과 같았다 — 이미 그 탭을
  // 보고 있으면 눌러도 아무 일이 없었다. 읽는 것은 줄이 맡고 버튼은 손댈 수 있는 일만 맡는다
  it('줄의 버튼은 하나뿐이다', () => {
    const html = render(one('needs-review'))
    expect(html).not.toContain('hiw.feature.review')
    expect(html.match(/hiw-review/g) ?? []).toHaveLength(1)
  })

  it('오래됐을 수 있는 줄과 근거가 모자란 줄에도 선다 — 다시 만드는 것이 유일한 지렛대다', () => {
    for (const s of ['needs-review', 'possibly-stale'] as const)
      expect(render(one(s))).toContain('hiw.feature.regenerate')
  })

  it('만드는 중인 줄에는 서지 않는다 — 두 번 누르면 두 번 돈다', () => {
    expect(render(one('generating'))).not.toContain('hiw.feature.regenerate')
  })
})

// 생성은 3~4분 걸린다. 멈춘 화면과 도는 화면이 같아 보이면 사용자는 다시 누르거나 고장으로 읽는다 —
// 문구가 "만드는 중"이라고 적혀 있어도 그렇다.
describe('도는 동안 움직인다', () => {
  const one = (status: ProjectUnderstanding['features'][number]['status']): ProjectUnderstanding => ({
    features: [{ id: 'x', name: '결제', summary: '카드', status, updatedAt: 'x', evidenceCount: 0 }],
    explanations: {},
    recentChanges: []
  })

  it('만드는 중인 줄의 글리프가 돈다', () => {
    expect(render(one('generating'))).toContain('hiw-spin')
  })

  it('다른 상태는 돌지 않는다 — 움직임이 곧 "지금 하고 있다"여야 한다', () => {
    for (const s of ['up-to-date', 'needs-review', 'generation-failed'] as const)
      expect(render(one(s))).not.toContain('hiw-spin')
  })

  it('분석 중이면 새로 고침 버튼이 돈다', () => {
    const html = renderToStaticMarkup(
      React.createElement(UnderstandingView, {
        understanding: one('up-to-date'),
        selectedFeatureId: null,
        onOpenFeature: () => {},
          onRegenerate: () => {},
        onAnalyze: () => {},
        analyzing: true
      })
    )
    expect(html).toContain('hiw-spin')
  })

  // 첫 분석은 2분이 넘는다 — 빈 화면의 버튼도 같은 문제다
  it('빈 상태의 [프로젝트 분석] 도 도는 동안 움직인다', () => {
    const html = renderToStaticMarkup(
      React.createElement(UnderstandingView, {
        understanding: null,
        selectedFeatureId: null,
        onOpenFeature: () => {},
          onRegenerate: () => {},
        onAnalyze: () => {},
        analyzing: true
      })
    )
    expect(html).toContain('hiw-spin')
  })
})
