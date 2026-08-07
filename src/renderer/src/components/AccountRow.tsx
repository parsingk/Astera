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
  children
}: {
  account: Account
  loggedIn: boolean | undefined
  email: string | null | undefined
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
      <span
        className={loggedIn ? 'login-dot on' : 'login-dot'}
        title={loggedIn ? t('account.status.loggedIn') : t('account.status.notLoggedIn')}
      />
      {children}
    </li>
  )
}
