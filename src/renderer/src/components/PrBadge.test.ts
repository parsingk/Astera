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
    expect(render(pr({ checks: null }))).not.toContain('pr-checks')
    expect(render(pr({ checks: 'pending' }))).toContain('pr-checks pending')
    expect(render(pr({ checks: 'failing' }))).toContain('pr-checks failing')
  })

  // The two silent outcomes are different facts, and an absent dot cannot say which. Without
  // this the title would read the same for "everything passed" and "there is no CI here".
  it('the title tells a passing check apart from having no checks', () => {
    expect(render(pr({ checks: 'passing' }))).toContain('github.badge.checks.passing')
    expect(render(pr({ checks: null }))).toContain('github.badge.checks.none')
  })

  // Colour alone cannot carry open-vs-closed for a red-green colour blindness, so each state
  // must bring its own shape. lucide stamps the icon name onto the svg's class list.
  // **Match the whole class attribute, not a substring**: 'lucide-git-pull-request' is a prefix
  // of both 'lucide-git-pull-request-closed' and '-draft', so a bare substring check would pass
  // for open no matter which of the three actually rendered.
  const glyph = (name: string): string => `class="lucide lucide-${name} pr-glyph"`

  it('each state draws its own glyph, not just its own colour', () => {
    expect(render(pr({ state: 'open' }))).toContain(glyph('git-pull-request'))
    expect(render(pr({ state: 'merged' }))).toContain(glyph('git-merge'))
    expect(render(pr({ state: 'closed' }))).toContain(glyph('git-pull-request-closed'))
    expect(render(pr({ isDraft: true }))).toContain(glyph('git-pull-request-draft'))
  })

  // The draft flag beats the open state, so its glyph must swap too — not just its colour.
  it('a merged PR keeps the merge glyph even with a stale isDraft flag', () => {
    const html = render(pr({ state: 'merged', isDraft: true }))
    expect(html).toContain(glyph('git-merge'))
    expect(html).not.toContain(glyph('git-pull-request-draft'))
  })

  it('stale dims and says why in the title', () => {
    const html = render(pr(), true)
    expect(html).toContain('pr-badge open stale')
    expect(html).toContain('github.badge.stale')
  })
})
