import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Account, AccountUsage } from '../../../core/types'
import { AccountRow } from './AccountRow'

vi.mock('../i18n/I18nProvider', () => ({
  useI18n: () => ({
    lang: 'en',
    t: (key: string) => key,
    tm: (m: unknown) => String(m)
  })
}))

const account = (over: Partial<Account> = {}): Account => ({
  id: 'a1',
  label: 'Work',
  configDir: 'D:/home/.claude',
  color: '#4488ff',
  createdAt: '2026-01-01T00:00:00.000Z',
  provider: 'claude',
  ...over
})

const usage = (): AccountUsage => ({
  session: { usedPercent: 12, resetsAt: null },
  weekly: { usedPercent: 41, resetsAt: null },
  readAt: '2026-09-02T12:00:00.000Z',
  remembered: false
})

const render = (
  over: Partial<React.ComponentProps<typeof AccountRow>> = {}
): string =>
  renderToStaticMarkup(
    React.createElement(AccountRow, {
      account: account(),
      loggedIn: true,
      email: 'me@example.com',
      ...over
    })
  )

describe('AccountRow', () => {
  it('a logged-in account with a usage reading renders the meter and the overlay', () => {
    const html = render({ usage: usage() })
    expect(html).toContain('acct-meter')
    expect(html).toContain('acct-detail')
  })

  // §5: nothing is drawn for an account that is not logged in — the meter cannot express this gate
  // on its own, since AccountUsageMeter only ever sees `usage`, never `loggedIn`.
  it('a logged-out account renders neither, even with a reading present', () => {
    const html = render({ loggedIn: false, usage: usage() })
    expect(html).not.toContain('acct-meter')
    expect(html).not.toContain('acct-detail')
  })

  // undefined is the state before useAccountStatus has answered — drawing nothing here is what
  // keeps the meter from flashing in and then out again once the real answer arrives.
  it('loggedIn undefined (the pre-probe state) renders neither', () => {
    const html = render({ loggedIn: undefined, usage: usage() })
    expect(html).not.toContain('acct-meter')
    expect(html).not.toContain('acct-detail')
  })

  it('detailUp adds detail-up to the row class list, and its absence does not', () => {
    expect(render({ detailUp: true })).toContain('class="account-row detail-up"')
    expect(render({ detailUp: false })).toContain('class="account-row"')
    expect(render({ detailUp: false })).not.toContain('detail-up')
    expect(render({})).toContain('class="account-row"')
  })

  // The only place the account email is shown — a deliberate ruling (spec §5.1) that the overlay
  // replaces a usage tooltip, not this identity one.
  it('the title tooltip is still present', () => {
    expect(render({ email: 'me@example.com' })).toContain('title="Work · me@example.com"')
  })
})
