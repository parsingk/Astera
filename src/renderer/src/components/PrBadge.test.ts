import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PrInfo } from '../../../core/github/types'
import { PrBadge } from './PrBadge'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'ko', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const pr = (over: Partial<PrInfo> = {}): PrInfo => ({
  number: 12,
  title: 'a fix',
  state: 'open',
  isDraft: false,
  url: 'https://github.com/o/r/pull/12',
  checks: null,
  ...over
})

const render = (p: PrInfo, stale = false): string =>
  renderToStaticMarkup(React.createElement(PrBadge, { pr: p, stale, onOpenMenu: () => {} }))

describe('PrBadge', () => {
  it('shows the number colored by state', () => {
    const html = render(pr())
    expect(html).toContain('#12')
    expect(html).toContain('pr-badge open')
  })

  it('the draft flag beats the open color', () => {
    expect(render(pr({ isDraft: true }))).toContain('pr-badge draft')
  })

  it('a merged draft is just merged — the flag only matters while open', () => {
    expect(render(pr({ state: 'merged', isDraft: true }))).toContain('pr-badge merged')
  })

  it('passing checks render no dot; pending and failing render one', () => {
    expect(render(pr({ checks: 'passing' }))).not.toContain('pr-checks')
    expect(render(pr({ checks: 'pending' }))).toContain('pr-checks pending')
    expect(render(pr({ checks: 'failing' }))).toContain('pr-checks failing')
  })

  it('stale dims and says why in the title', () => {
    const html = render(pr(), true)
    expect(html).toContain('pr-badge open stale')
    expect(html).toContain('github.badge.stale')
  })
})
