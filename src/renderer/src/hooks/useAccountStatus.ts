import { useEffect, useMemo, useState } from 'react'
import type { Account, Provider } from '../../../core/types'
import { PROVIDERS } from '../../../core/providers/meta'
import { defaultAccountIdOf } from '../../../core/accounts/defaultAccount'
import { createLatest, settledPairs } from '../lib/latest'

/** Queries the login state and email per account. Shared by the sidebar and the settings Accounts tab.
 *  Re-queries on window focus — this picks up a login or logout done in another window. */
export function useAccountStatus(accounts: Account[]): {
  loginMap: Record<string, boolean>
  emailMap: Record<string, string | null>
  defaultIdByProvider: Record<Provider, string | null>
} {
  const [loginMap, setLoginMap] = useState<Record<string, boolean>>({})
  const [emailMap, setEmailMap] = useState<Record<string, string | null>>({})

  useEffect(() => {
    let cancelled = false
    // The newest round only, and an account that fails is left out rather than failing the round (audit UI-8).
    const latest = createLatest()
    const ids = accounts.map((a) => a.id)
    const loadAccountStatus = (): void => {
      const ticket = latest.next()
      void settledPairs(ids, (id) => window.api.accounts.loginStatus(id)).then((m) => {
        if (!cancelled && latest.isCurrent(ticket)) setLoginMap(m)
      })
      void settledPairs(ids, (id) => window.api.accounts.email(id)).then((m) => {
        if (!cancelled && latest.isCurrent(ticket)) setEmailMap(m)
      })
    }
    loadAccountStatus()
    window.addEventListener('focus', loadAccountStatus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', loadAccountStatus)
    }
  }, [accounts])

  // The default account of each provider — the row that gets the `default` badge, and the account ⤓ copies
  // settings from. It is derived here rather than sent down from main because both inputs it needs (the
  // account list and the login state) are already in this hook, and it tracks a login the moment the map
  // above updates. null means that provider has no logged-in account yet.
  const defaultIdByProvider = useMemo(() => {
    const loggedInIds = new Set(
      Object.entries(loginMap)
        .filter(([, on]) => on)
        .map(([id]) => id)
    )
    return Object.fromEntries(
      PROVIDERS.map((p) => [p, defaultAccountIdOf(p, accounts, loggedInIds)])
    ) as Record<Provider, string | null>
  }, [accounts, loginMap])

  return { loginMap, emailMap, defaultIdByProvider }
}
