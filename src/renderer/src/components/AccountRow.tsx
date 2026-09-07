import type { Account, AccountUsage } from '../../../core/types'
import { AccountUsageMeter, AccountUsageDetail, hasUsage } from './AccountUsageMeter'
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
  expanded,
  onToggle,
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
  /** Is this row's usage detail open. The list owns which one is — only one is open at a time, so
   *  the answer cannot live in the row. */
  expanded?: boolean
  /** Toggle this row's detail. Called on a click or on Enter/Space; the list decides what that
   *  means for the other rows. */
  onToggle?: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const { t } = useI18n()
  // The detail opens on a click, not on hover, so the row is only a control when there is something
  // to open: a logged-out account and one never read both draw nothing, and a row that cannot open
  // must not look or behave as if it could. Provider plays no part — claude and codex rows both carry
  // a reading when their account has one.
  const openable = Boolean(loggedIn) && hasUsage(usage)
  const toggle = openable && onToggle ? onToggle : undefined

  return (
    <li
      className={expanded && openable ? 'account-row expanded' : 'account-row'}
      title={email ? `${account.label} · ${email}` : account.configDir}
      onClick={toggle}
      // A click needs a keyboard equivalent or the figures are reachable by mouse alone. No
      // role="button": the row already contains real buttons in the settings tab, and nesting
      // buttons inside a button is a worse lie than an unnamed focusable row.
      tabIndex={toggle ? 0 : undefined}
      aria-expanded={toggle ? Boolean(expanded) : undefined}
      onKeyDown={
        toggle
          ? (e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault() // Space would otherwise scroll the panel
              toggle()
            }
          : undefined
      }
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
      {/* The actions sit inside the row, so their clicks would bubble into the row's toggle —
          pressing "remove account" would also open the usage detail. Stopped here rather than on
          each button so a caller cannot forget. */}
      {children && (
        <span className="account-row-actions" onClick={(e) => e.stopPropagation()}>
          {children}
        </span>
      )}
      {/* In flow, after the row's own content, so opening it grows the row downward instead of
          covering the rows beneath (design doc §5.1). */}
      {expanded && openable && <AccountUsageDetail usage={usage} />}
    </li>
  )
}
