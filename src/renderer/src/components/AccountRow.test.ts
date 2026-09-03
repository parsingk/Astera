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
      // Both real call sites always pass one; a row given no way to toggle is inert by design, and
      // the inert case is asserted explicitly below rather than by omission here.
      onToggle: () => {},
      ...over
    })
  )

describe('AccountRow', () => {
  it('a logged-in account with a usage reading renders the meter, and the detail only once expanded', () => {
    expect(render({ usage: usage() })).toContain('acct-meter')
    expect(render({ usage: usage() })).not.toContain('acct-detail')
    expect(render({ usage: usage(), expanded: true })).toContain('acct-detail')
  })

  // §5: nothing is drawn for an account that is not logged in — the meter cannot express this gate
  // on its own, since AccountUsageMeter only ever sees `usage`, never `loggedIn`.
  it('a logged-out account renders neither, even with a reading present and expanded', () => {
    const html = render({ loggedIn: false, usage: usage(), expanded: true })
    expect(html).not.toContain('acct-meter')
    expect(html).not.toContain('acct-detail')
  })

  // undefined is the state before useAccountStatus has answered — drawing nothing here is what
  // keeps the meter from flashing in and then out again once the real answer arrives.
  it('loggedIn undefined (the pre-probe state) renders neither', () => {
    const html = render({ loggedIn: undefined, usage: usage(), expanded: true })
    expect(html).not.toContain('acct-meter')
    expect(html).not.toContain('acct-detail')
  })

  // The row only advertises itself as a control when there is something to open. A row with no
  // reading — a Codex account, a logged-out one, one never read — must not look or behave clickable,
  // or a person learns that clicking sometimes does nothing.
  it('is focusable and marked expandable only when it has a detail to show', () => {
    const open = render({ usage: usage() })
    expect(open).toContain('tabindex="0"')
    expect(open).toContain('aria-expanded="false"')
    expect(render({ usage: usage(), expanded: true })).toContain('aria-expanded="true"')

    // No reading, not logged in, and no toggle handler each leave the row inert.
    for (const inert of [
      render({}),
      render({ loggedIn: false, usage: usage() }),
      render({ usage: usage(), onToggle: undefined })
    ]) {
      expect(inert).not.toContain('tabindex')
      expect(inert).not.toContain('aria-expanded')
    }
  })

  it('marks the expanded row so the open one is visible in the list', () => {
    expect(render({ usage: usage(), expanded: true })).toContain('class="account-row expanded"')
    expect(render({ usage: usage() })).toContain('class="account-row"')
    expect(render({ usage: usage() })).not.toContain('expanded"')
  })

  // The action buttons live inside the row, so a click on one would otherwise bubble up and toggle
  // the row underneath it — pressing "remove account" would also open the usage detail.
  it('wraps the action children so their clicks cannot reach the row', () => {
    const html = render({
      usage: usage(),
      children: React.createElement('button', { className: 'row-action' }, 'x')
    })
    expect(html).toContain('account-row-actions')
    expect(html.indexOf('account-row-actions')).toBeLessThan(html.indexOf('row-action'))
  })

  // The only place the account email is shown — a deliberate ruling (spec §5.1) that the detail
  // replaces a usage tooltip, not this identity one.
  it('the title tooltip is still present', () => {
    expect(render({ email: 'me@example.com' })).toContain('title="Work · me@example.com"')
  })
})
