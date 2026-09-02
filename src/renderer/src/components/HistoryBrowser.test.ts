import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectSummary } from '../../../core/types'
import { ProjectRow } from './HistoryBrowser'

// UnderstandingView.test.ts 와 같은 이유 — I18nProvider 의 효과는 renderToStaticMarkup 에서 돌지
// 않고 실제 window.api 도 없다. 훅을 갈아 끼우면 jsdom 없이 진짜 렌더를 볼 수 있다.
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'ko', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const project: ProjectSummary = {
  accountId: 'a1',
  projectPath: 'D:/work/astera',
  name: 'astera',
  updatedAt: '2026-08-31T01:00:00.000Z'
}

/** 펼친 직후의 한 프레임. 효과가 돌지 않으므로 세션 페이지는 아직 오지 않은 상태 그대로다 —
 *  이 결함이 사는 자리가 정확히 여기다. */
const renderExpanded = (): string =>
  renderToStaticMarkup(
    React.createElement(ProjectRow, {
      project,
      expanded: true,
      onToggle: () => {},
      accountId: '',
      refreshNonce: 0,
      scrollRootRef: { current: null },
      accountOf: () => undefined,
      isSeen: () => true,
      markSeen: () => {},
      onOpenPreview: () => {},
      onResume: () => {},
      onContextMenu: () => {}
    })
  )

describe('ProjectRow — 세션 목록을 기다리는 동안', () => {
  // 보고된 결함: 프로젝트를 펼치면 '세션 없음'이 잠깐 보였다가 목록으로 바뀐다. 빈 sessions 가
  // "아직 오지 않았다"와 "정말 없다" 둘 다를 뜻해서 생긴 일이다.
  it("첫 페이지가 오기 전에는 '세션 없음'을 쓰지 않는다", () => {
    expect(renderExpanded()).not.toContain('history.project.noSessions')
  })

  it('그 자리에 불러오는 중 표시를 세운다', () => {
    const html = renderExpanded()
    expect(html).toContain('history-loading')
    expect(html).toContain('loading-dots')
    expect(html).toContain('history.loading') // 글자가 없으므로 읽히는 이름은 aria-label 이 맡는다
  })
})
