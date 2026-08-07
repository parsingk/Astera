import type { Account } from '../../../core/types'
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
  children
}: {
  account: Account
  loggedIn: boolean | undefined
  email: string | null | undefined
  /** That provider's default account — the ⤓ source. One row per provider can carry it, so with both
   *  claude and codex registered two rows show the badge. */
  isDefault?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <li
      className="account-row"
      title={email ? `${account.label} · ${email}` : account.configDir}
    >
      <span className="color-dot" style={{ background: account.color }} />
      <ProviderBadge provider={account.provider} />
      <span className="account-label">{account.label}</span>
      {/* Not translated, matching ProviderBadge's 'Claude'/'Codex' — these are short identifiers rather
          than prose, and the row is narrow */}
      {isDefault && <span className="badge">default</span>}
      <span
        className={loggedIn ? 'login-dot on' : 'login-dot'}
        title={loggedIn ? t('account.status.loggedIn') : t('account.status.notLoggedIn')}
      />
      {children}
    </li>
  )
}
