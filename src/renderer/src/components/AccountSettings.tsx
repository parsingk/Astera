import { useState } from 'react'
import type { Account } from '../../../core/types'
import { providerOf } from '../../../core/providers/meta'
import { useAccountStatus } from '../hooks/useAccountStatus'
import { AccountRow } from './AccountRow'
import { useI18n } from '../i18n/I18nProvider'
import { toast } from '../lib/toast'

/** The Accounts tab of the settings modal. It holds the delete and import-settings flows moved over from
 *  the sidebar. The sidebar (AccountPanel) is left with only listing and adding accounts. */
export function AccountSettings({ accounts }: { accounts: Account[] }): React.JSX.Element {
  const { t, tm } = useI18n()
  const { loginMap, emailMap, defaultIdByProvider } = useAccountStatus(accounts)
  const [removeTarget, setRemoveTarget] = useState<Account | null>(null)
  const [logoutToo, setLogoutToo] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [syncTarget, setSyncTarget] = useState<Account | null>(null)
  const [syncing, setSyncing] = useState(false)

  const openRemove = (account: Account): void => {
    setLogoutToo(false)
    setRemoveTarget(account)
  }

  const confirmRemove = async (): Promise<void> => {
    if (!removeTarget || removing) return
    setRemoving(true)
    try {
      if (logoutToo) {
        const r = await window.api.accounts.logout(removeTarget.id)
        if (!r.ok) {
          toast.error(t('account.logout.failed', { detail: tm(r.message ?? null) ?? '' }))
        }
      }
      // 돌아가는 세션이 그 계정을 쓰고 있으면 main 이 거부한다(ipc.ts 의 accountRemovalBlockers).
      // 거부는 실패가 아니라 사용자가 몰랐던 사실을 알리는 것이므로, 어느 세션이 막고 있는지 이름을
      // 말한다 — 이름 없이 "쓰이는 중"만 말하면 사용자가 무엇을 닫아야 할지 알 수 없다.
      const r = await window.api.accounts.remove(removeTarget.id)
      if (r && !r.ok) {
        toast.error(t('account.remove.inUse', { titles: r.titles.join(', ') }))
        return
      }
    } finally {
      setRemoving(false)
      setRemoveTarget(null)
      setLogoutToo(false)
    }
  }

  const confirmSync = async (): Promise<void> => {
    if (!syncTarget || syncing) return
    setSyncing(true)
    try {
      const r = await window.api.accounts.syncSettings(syncTarget.id)
      if (!r.ok) toast.error(t('account.sync.failed', { detail: tm(r.message ?? null) ?? '' }))
      else if (r.message) toast.info(t(r.message.key, r.message.params))
      else toast.success(t('account.sync.done'))
    } finally {
      setSyncing(false)
      setSyncTarget(null)
    }
  }

  return (
    <div className="settings-accounts">
      <span className="settings-hint">{t('settings.accounts.hint')}</span>
      <ul>
        {accounts.map((a) => {
          const defaultId = defaultIdByProvider[providerOf(a)]
          return (
          <AccountRow
            key={a.id}
            account={a}
            loggedIn={loginMap[a.id]}
            email={emailMap[a.id]}
            isDefault={defaultId === a.id}
          >
            {/* ⤓ needs a source, and that source is this provider's default account. Hidden on the default
                itself (it would be copying onto itself) and when the provider has no default yet, which
                means nothing of that CLI is logged in. */}
            {defaultId !== null && defaultId !== a.id && (
              <button
                className="ghost"
                aria-label={t('account.sync.title')}
                title={t('account.sync.title')}
                onClick={() => setSyncTarget(a)}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M8 2v7.5" />
                  <path d="M5 6.5 8 9.5l3-3" />
                  <path d="M3 12.5h10" />
                </svg>
              </button>
            )}
            <button
              className="ghost danger"
              aria-label={t('account.remove.button')}
              title={t('account.remove.button')}
              onClick={() => openRemove(a)}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <line x1="4" y1="4" x2="12" y2="12" />
                <line x1="12" y1="4" x2="4" y2="12" />
              </svg>
            </button>
          </AccountRow>
          )
        })}
        {accounts.length === 0 && <li className="empty">{t('account.panel.empty')}</li>}
      </ul>
      {removeTarget && (
        <div className="modal-backdrop" onClick={() => !removing && setRemoveTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('account.remove.title')}</h2>
            <p className="confirm-text">
              {t('account.remove.confirm', { label: removeTarget.label })}
            </p>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={logoutToo}
                onChange={(e) => setLogoutToo(e.target.checked)}
              />
              <span>{t('account.remove.logoutToo')}</span>
            </label>
            {logoutToo && <p className="warn-text">{t('account.remove.logoutWarning')}</p>}
            <div className="row right">
              <button type="button" disabled={removing} onClick={() => setRemoveTarget(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="primary"
                type="button"
                disabled={removing}
                onClick={() => void confirmRemove()}
              >
                {removing
                  ? t('account.remove.processing')
                  : logoutToo
                    ? t('account.remove.confirmWithLogout')
                    : t('account.remove.button')}
              </button>
            </div>
          </div>
        </div>
      )}
      {syncTarget && (
        <div className="modal-backdrop" onClick={() => !syncing && setSyncTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>{t('account.sync.title')}</h2>
            <p className="confirm-text">
              {t('account.sync.confirmBody', {
                source:
                  accounts.find((a) => a.id === defaultIdByProvider[providerOf(syncTarget)])?.label ??
                  '',
                label: syncTarget.label
              })}
            </p>
            {/* The two CLIs differ in kind, not degree: claude merges, codex overwrites the file. The
                codex case can lose settings, so it gets the warning style. */}
            {providerOf(syncTarget) === 'codex' ? (
              <p className="warn-text">{t('account.sync.replaceNote')}</p>
            ) : (
              <p className="confirm-text">{t('account.sync.mergeNote')}</p>
            )}
            <p className="warn-text">{t('account.sync.appliesNextSession')}</p>
            <div className="row right">
              <button type="button" disabled={syncing} onClick={() => setSyncTarget(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="primary"
                type="button"
                disabled={syncing}
                onClick={() => void confirmSync()}
              >
                {syncing ? t('account.sync.confirming') : t('account.sync.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
