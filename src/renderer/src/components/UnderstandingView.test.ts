import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProjectUnderstanding } from '../../../core/understanding/types'
import { UnderstandingView } from './UnderstandingView'

// MarkdownPreview.test.ts 와 같은 이유 — I18nProvider 의 효과는 renderToStaticMarkup 에서 돌지 않고
// 실제 window.api 도 없다. 훅을 직접 갈아 끼우는 것이 jsdom 없이 진짜 렌더를 보는 방법이다.
vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'ko',
    t: (key: string) => key,
    tm: (m: unknown) => (m === null ? null : String(m))
  })
}))

const render = (u: ProjectUnderstanding | null): string =>
  renderToStaticMarkup(React.createElement(UnderstandingView, { understanding: u }))

describe('UnderstandingView', () => {
  it('기록이 없으면 빈 상태를 그린다', () => {
    expect(render({ records: [] })).toContain('hiw.empty.body')
  })
})
