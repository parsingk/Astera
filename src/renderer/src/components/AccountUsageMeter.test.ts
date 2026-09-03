import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccountUsage } from '../../../core/types'
import { AccountUsageMeter, AccountUsageDetail, usageLevel } from './AccountUsageMeter'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'en',
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}(${Object.values(params).join(',')})` : key,
    tm: (m: unknown) => String(m)
  })
}))

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

describe('AccountUsageDetail', () => {
  const NOW = Date.parse('2026-09-02T12:00:00.000Z')
  const HOUR = 3_600_000

  const detail = (u: AccountUsage | undefined): string =>
    renderToStaticMarkup(React.createElement(AccountUsageDetail, { usage: u }))

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })
  afterEach(() => vi.useRealTimers())

  const both = (): AccountUsage => ({
    session: { usedPercent: 78, resetsAt: new Date(NOW + 47 * 60_000).toISOString() },
    weekly: { usedPercent: 36, resetsAt: new Date(NOW + 4 * 24 * HOUR).toISOString() },
    readAt: new Date(NOW - 3 * HOUR).toISOString(),
    remembered: false
  })

  it('is one line per window, the 5-hour window first', () => {
    const html = detail(both())
    expect(html.indexOf('account.usage.fiveHour')).toBeGreaterThan(-1)
    expect(html.indexOf('account.usage.fiveHour')).toBeLessThan(html.indexOf('account.usage.weekly'))
    expect(html).toContain('78%')
    expect(html).toContain('36%')
  })

  it('each line carries its own bar at its own threshold colour', () => {
    const html = detail(both())
    expect(html).toContain('class="warn"') // 78
    expect(html).toContain('class="ok"') // 36
  })

  it('names when each window rolls, in that window\'s own units', () => {
    const html = detail(both())
    expect(html).toContain('account.usage.resetsIn(47m)')
    expect(html).toContain('account.usage.resetsIn(4d)')
  })

  // The overlay's "updated N ago" is where a person learns the figure is not live — the one thing
  // that lets them notice an account used outside Astera (§3.1).
  it('a remembered reading adds a third line saying how old it is', () => {
    const html = detail({ ...both(), remembered: true })
    expect(html).toContain('acct-detail-stale')
    expect(html).toContain('account.usage.refreshedAgo(3h)')
  })

  it('a live reading has no third line', () => {
    expect(detail(both())).not.toContain('acct-detail-stale')
  })

  it('a window with no reset time shows its figure and no time', () => {
    const html = detail({ ...both(), session: { usedPercent: 78, resetsAt: null } })
    expect(html).toContain('78%')
    expect(html).not.toContain('account.usage.resetsIn(47m)')
  })

  it('a reset time already in the past shows no time rather than a negative one', () => {
    const html = detail({
      ...both(),
      session: { usedPercent: 78, resetsAt: new Date(NOW - HOUR).toISOString() }
    })
    expect(html).not.toContain('account.usage.resetsIn(1h)')
    expect(html).toContain('78%')
  })

  it('renders nothing when the meter renders nothing', () => {
    expect(detail(undefined)).toBe('')
    expect(detail({ ...both(), session: null, weekly: null })).toBe('')
  })
})
