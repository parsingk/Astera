import { useEffect, useState } from 'react'
import type { AccountUsage } from '../../../core/types'

/**
 * Per-account usage for the account rows (design doc §4). Keyed by `configDir`, matching main's cache
 * key — a row reads `usage[account.configDir]`.
 *
 * Subscribing on mount and unsubscribing on unmount is what paces the feature: the panel is not
 * always on screen (the sidebar closes, and the rail swaps it for Jobs or How It Works), and a panel
 * nobody is looking at should not be spending requests. This is the zero-subscriber stop githubPrs
 * already has, for the same reason.
 *
 * There is no `accounts` argument and no refresh: main decides which accounts it can answer for, and
 * pushes the whole map whenever it changes. A failed fetch is silent by design (§9) — the row falls
 * back to its remembered reading, or to nothing.
 */
export function useAccountUsage(): Record<string, AccountUsage> {
  const [usage, setUsage] = useState<Record<string, AccountUsage>>({})

  useEffect(() => {
    // The map main already holds, so a remount draws immediately rather than waiting for the tick
    // this subscribe is about to start.
    void window.api.usage
      .accounts()
      .then(setUsage)
      .catch(() => {})
    const off = window.api.on('usage:accounts-updated', setUsage)
    window.api.usage.subscribe()
    return () => {
      off()
      window.api.usage.unsubscribe()
    }
  }, [])

  return usage
}
