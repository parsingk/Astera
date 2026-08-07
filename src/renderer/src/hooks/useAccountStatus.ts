import { useEffect, useState } from 'react'
import type { Account } from '../../../core/types'

/** Queries the login state and email per account. Shared by the sidebar and the settings Accounts tab.
 *  Re-queries on window focus — this picks up a login or logout done in another window. */
export function useAccountStatus(accounts: Account[]): {
  loginMap: Record<string, boolean>
  emailMap: Record<string, string | null>
} {
  const [loginMap, setLoginMap] = useState<Record<string, boolean>>({})
  const [emailMap, setEmailMap] = useState<Record<string, string | null>>({})

  useEffect(() => {
    let cancelled = false
    const loadAccountStatus = (): void => {
      void Promise.all(
        accounts.map(async (a) => [a.id, await window.api.accounts.loginStatus(a.id)] as const)
      ).then((pairs) => {
        if (!cancelled) setLoginMap(Object.fromEntries(pairs))
      })
      void Promise.all(
        accounts.map(async (a) => [a.id, await window.api.accounts.email(a.id)] as const)
      ).then((pairs) => {
        if (!cancelled) setEmailMap(Object.fromEntries(pairs))
      })
    }
    loadAccountStatus()
    window.addEventListener('focus', loadAccountStatus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', loadAccountStatus)
    }
  }, [accounts])

  return { loginMap, emailMap }
}
