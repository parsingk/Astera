import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PushBadge } from './PushBadge'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({ lang: 'ko', t: (key: string) => key, tm: (m: unknown) => String(m) })
}))

const render = (ahead: number | null, disabled = false): string =>
  renderToStaticMarkup(
    React.createElement(PushBadge, { ahead, base: 'develop', disabled, onCreate: () => {} })
  )

describe('PushBadge', () => {
  it('shows the arrow and the count', () => {
    const html = render(3)
    expect(html).toContain('↑3')
    expect(html).toContain('push-badge')
  })

  it('shows the arrow alone when the count is unknown', () => {
    const html = render(null)
    expect(html).toContain('↑')
    expect(html).not.toContain('↑0')
    expect(html).toContain('worktree.push.aheadUnknown')
  })

  it('names the base in its title so the target is never hidden', () => {
    expect(render(3)).toContain('worktree.push.createPrHint')
  })

  it('is a button, so it is keyboard reachable', () => {
    expect(render(3)).toContain('<button')
  })

  // Still ↑3 while the panel's git lock holds or gh is away: the commits are unpushed either way.
  it('goes quiet rather than disappearing when disabled', () => {
    const html = render(3, true)
    expect(html).toContain('disabled')
    expect(html).toContain('↑3')
  })
})
