import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountUsage } from '../../../core/types'
import { AccountUsageMeter, usageLevel } from './AccountUsageMeter'

const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({
  session: { usedPercent: 12, resetsAt: null },
  weekly: { usedPercent: 41, resetsAt: null },
  readAt: '2026-09-02T12:00:00.000Z',
  remembered: false,
  ...over
})

const render = (u: AccountUsage | undefined): string =>
  renderToStaticMarkup(React.createElement(AccountUsageMeter, { usage: u }))

describe('usageLevel', () => {
  // The status bar uses these exact figures; two places showing usage on two scales would be a defect.
  it('is the existing threshold set, at its boundaries', () => {
    expect(usageLevel(0)).toBe('ok')
    expect(usageLevel(69)).toBe('ok')
    expect(usageLevel(70)).toBe('warn')
    expect(usageLevel(84)).toBe('warn')
    expect(usageLevel(85)).toBe('crit')
    expect(usageLevel(100)).toBe('crit')
  })
})

describe('AccountUsageMeter', () => {
  it('draws two tracks — the 5-hour window first, weekly second', () => {
    const html = render(usage())
    expect(html).toContain('acct-meter')
    expect(html).toContain('width:12%')
    expect(html).toContain('width:41%')
    expect(html.indexOf('width:12%')).toBeLessThan(html.indexOf('width:41%'))
    expect(html.match(/<span><\/span>/g)).toBeNull()
  })

  it('colours each window on its own figure, not on the higher of the two', () => {
    const html = render(
      usage({ session: { usedPercent: 96, resetsAt: null }, weekly: { usedPercent: 30, resetsAt: null } })
    )
    expect(html).toContain('class="crit"')
    expect(html).toContain('class="ok"')
  })

  // The same convention a stale PR badge uses (.pr-badge.stale), reused rather than invented.
  it('a remembered reading dims', () => {
    expect(render(usage({ remembered: true }))).toContain('acct-meter stale')
    expect(render(usage())).not.toContain('stale')
  })

  // §5: a dash was considered and rejected — it reads as 0%, not as "no value". A Codex account, an
  // account that is not logged in, and a reading discarded past its reset all arrive as undefined.
  it('draws nothing at all when there is no reading', () => {
    expect(render(undefined)).toBe('')
  })

  it('draws nothing when both windows are absent', () => {
    expect(render(usage({ session: null, weekly: null }))).toBe('')
  })

  it('one window present still draws both tracks, the missing one empty', () => {
    const html = render(usage({ weekly: null }))
    expect(html).toContain('width:12%')
    expect(html).not.toContain('width:41%')
    // Both tracks stay in the markup so the meter keeps its 8px height and the row does not shift.
    expect(html.match(/<span><\/span>/g)).toHaveLength(1)
  })

  it('a percentage outside 0-100 is clamped to the track', () => {
    const html = render(
      usage({ session: { usedPercent: 140, resetsAt: null }, weekly: { usedPercent: -5, resetsAt: null } })
    )
    expect(html).toContain('width:100%')
    expect(html).toContain('width:0%')
  })
})
