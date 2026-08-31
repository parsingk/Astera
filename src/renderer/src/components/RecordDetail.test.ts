import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { RecordExplanation, WorkRecord } from '../../../core/understanding/types'
import { RecordDetail } from './RecordDetail'

// MarkdownPreview.test.ts 와 같은 이유 — I18nProvider 의 효과는 renderToStaticMarkup 에서 돌지 않고
// 실제 window.api 도 없다. 훅을 직접 갈아 끼우는 것이 jsdom 없이 진짜 렌더를 보는 방법이다.
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string) => key,
    tm: (m: unknown) => (m === null ? null : String(m))
  })
}))

const baseRecord: WorkRecord = {
  id: 'r1',
  at: '2026-08-29T00:00:00.000Z',
  source: { kind: 'session', sessionId: '182', label: '세션 #182' },
  request: '인증에 Google 로그인을 붙여줘',
  changedFiles: ['src/auth/SessionStore.ts'],
  git: { startHead: 'a', endHead: 'b' },
  status: 'ready'
}

const explanation: RecordExplanation = {
  overview: '사용자는 Google 계정으로 로그인할 수 있습니다.',
  userVisibleChanges: ['로그인 화면에 "Google로 계속하기" 버튼이 보입니다.'],
  flow: [
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
  decisions: [
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
  evidence: [
    { id: 'e1', type: 'source-file', label: 'SessionStore.ts', path: 'src/auth/SessionStore.ts' }
  ],
  userEdited: false,
  generatedAt: '2026-08-29T00:00:00.000Z'
}

const render = (scoped: string | null = null, exp: RecordExplanation | null = explanation): string =>
  renderToStaticMarkup(
    React.createElement(RecordDetail, {
      record: { ...baseRecord, explanation: exp ?? undefined },
      scopedNodeId: scoped,
      onPickStep: () => {},
      onOpenPath: () => {},
      onRegenerate: () => {},
      narrow: false,
      drawerOpen: false,
      onToggleDrawer: () => {}
    })
  )

const renderWith = (over: Partial<RecordExplanation>): string => render(null, { ...explanation, ...over })

const renderRecordWith = (over: Partial<WorkRecord>): string =>
  renderToStaticMarkup(
    React.createElement(RecordDetail, {
      record: { ...baseRecord, explanation, ...over },
      scopedNodeId: null,
      onPickStep: () => {},
      onOpenPath: () => {},
      onRegenerate: () => {},
      narrow: false,
      drawerOpen: false,
      onToggleDrawer: () => {}
    })
  )

const renderNarrow = (drawerOpen: boolean): string =>
  renderToStaticMarkup(
    React.createElement(RecordDetail, {
      record: { ...baseRecord, explanation },
      scopedNodeId: null,
      onPickStep: () => {},
      onOpenPath: () => {},
      onRegenerate: () => {},
      narrow: true,
      drawerOpen,
      onToggleDrawer: () => {}
    })
  )

describe('RecordDetail', () => {
  it('네 조각을 모두 그린다', () => {
    const html = render()
    for (const key of [
      'hiw.pane.overview',
      'hiw.pane.flow',
      'hiw.pane.decisions',
      'hiw.pane.implementation'
    ])
      expect(html).toContain(key)
  })

  it('사용자에게 보이는 변화가 있으면 그 절이 선다', () => {
    expect(render()).toContain('hiw.pane.userVisible')
  })

  it('없으면 그 절이 아예 없다', () => {
    expect(renderWith({ userVisibleChanges: [] })).not.toContain('hiw.pane.userVisible')
  })

  it('추정한 결정의 알약에만 low 가 붙는다', () => {
    const html = render()
    // 어느 쪽에 붙었는지까지 고정한다. `hiw-src low` 가 있다는 것과 알약이 둘이라는 것만 보면
    // **뒤집힌 구현(ADR 알약에 low)도 통과한다** — 추정과 결정을 같은 무게로 보여 주지 않는다는
    // 설계 §4 의 구분을 지키는 단언이 이것 하나뿐이라, 라벨까지 붙여 자리를 못박는다
    expect(html).toContain('hiw-src low">세션 #140')
    expect(html).toContain('hiw-src">ADR-012')
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

describe('좁은 페인', () => {
  it('접혀 있으면 참조 단이 없고 버튼만 있다', () => {
    const html = renderNarrow(false)
    expect(html).toContain('hiw.pane.reference')
    expect(html).not.toContain('hiw.pane.decisions')
  })

  it('열면 서랍으로 나온다', () => {
    const html = renderNarrow(true)
    expect(html).toContain('hiw-drawer')
    expect(html).toContain('hiw.pane.decisions')
  })

  it('넓을 때는 버튼이 없다', () => {
    expect(render()).not.toContain('hiw.pane.reference')
  })
})

// [다시 만들기] 를 누르면 3~4분 기다린다. 방금 누른 자리에서 움직임이 보여야 한다 —
// 잠긴 버튼만으로는 눌린 것인지 고장인지 구별되지 않는다.
describe('만드는 중', () => {
  const busy = (): string =>
    renderToStaticMarkup(
      React.createElement(RecordDetail, {
        record: { ...baseRecord, status: 'generating', explanation },
        scopedNodeId: null,
        onPickStep: () => {},
        onOpenPath: () => {},
        onRegenerate: () => {},
        narrow: false,
        drawerOpen: false,
        onToggleDrawer: () => {}
      })
    )

  it('머리의 상태 글리프와 버튼이 함께 돈다', () => {
    const html = busy()
    expect(html.match(/hiw-spin/g) ?? []).toHaveLength(2) // 상태 글리프 + 버튼 안
    expect(html).toContain('disabled') // 두 번 누르면 두 번 돈다
  })

  it('평소에는 아무것도 돌지 않는다', () => {
    expect(render()).not.toContain('hiw-spin')
  })
})

describe('검사 결과', () => {
  it('검사 결과가 있으면 앱이 돌린 것이 아니라고 함께 적는다', () => {
    // baseRecord's source is 'session' — a session's checks are the agent's own claim, never the
    // app's measurement, so the fine-print line has to say so
    const html = renderRecordWith({ verification: { status: 'verified' } })
    expect(html).toContain('hiw.verify.verified')
    expect(html).toContain('hiw.verify.reported')
  })

  it('검사 결과가 없으면 그 절이 없다', () => {
    expect(render()).not.toContain('hiw-verify')
  })

  // A record written before `verification` existed carries only the old `validation` shape — every
  // reader has to fall back to it, or these older records would silently lose their check line
  it('예전 기록의 validation 만 있어도 문장이 보인다', () => {
    const html = renderRecordWith({
      verification: undefined,
      validation: { status: 'passed', summary: '테스트 통과' }
    })
    expect(html).toContain('hiw.verify.verified')
  })

  // A Job's own validation is the app's measurement, not a claim — no "reported" caveat for it
  it('Job 기록은 검사가 있어도 보고했다는 말이 붙지 않는다', () => {
    const html = renderRecordWith({
      source: { kind: 'job', runId: 'run1', jobName: '단축키 붙이기', taskIds: ['t1'] },
      verification: { status: 'failed' }
    })
    expect(html).toContain('hiw.verify.failed')
    expect(html).not.toContain('hiw.verify.reported')
  })
})
