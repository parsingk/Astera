import type { Account, AccountUsage } from '../../../core/types'
import { AccountUsageMeter, AccountUsageDetail } from './AccountUsageMeter'
import { ProviderBadge } from './ProviderBadge'
import { useI18n } from '../i18n/I18nProvider'

/** Account row UI. Shared by the sidebar and the settings Accounts tab.
 *  The action buttons come in as children — the row does not need to know "who gets which button".
 *  loggedIn and email being undefined is the state before useAccountStatus has queried — handled with a
 *  truthy check. */
export function AccountRow({
  account,
  loggedIn,
  email,
  isDefault,
  usage,
  detailUp,
  children
}: {
  account: Account
  loggedIn: boolean | undefined
  email: string | null | undefined
  /** That provider's default account — the ⤓ source. One row per provider can carry it, so with both
   *  claude and codex registered two rows show the badge. */
  isDefault?: boolean
  /** This account's usage, keyed by configDir upstream. undefined draws nothing (design doc §5). */
  usage?: AccountUsage
  /** True for a row near the bottom of the list, where the hover detail would otherwise spill past
   *  the panel — flips the overlay to open upward instead. */
  detailUp?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <li
      className={detailUp ? 'account-row detail-up' : 'account-row'}
      title={email ? `${account.label} · ${email}` : account.configDir}
    >
      <span className="color-dot" style={{ background: account.color }} />
      <ProviderBadge provider={account.provider} />
      <span className="account-label">{account.label}</span>
      {/* Not translated, matching ProviderBadge's 'Claude'/'Codex' — these are short identifiers rather
          than prose, and the row is narrow */}
      {isDefault && <span className="badge">default</span>}
      {/* Gated on loggedIn as well as on having a reading: §5 draws nothing for an account that is
          not logged in, and `undefined` (the state before useAccountStatus has answered) draws
          nothing either, so no meter flashes in and out on mount. */}
      {loggedIn && <AccountUsageMeter usage={usage} />}
      <span
        className={loggedIn ? 'login-dot on' : 'login-dot'}
        title={loggedIn ? t('account.status.loggedIn') : t('account.status.notLoggedIn')}
      />
      {children}
      {/* Last child so it paints over the rows below rather than under a later sibling. Rendered
          only when the meter is (same gate) — an overlay with nothing in it would still catch the
          hover and flash an empty box. */}
      {loggedIn && <AccountUsageDetail usage={usage} />}
    </li>
  )
}
