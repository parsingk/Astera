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
/** The hook's reads without React (second pass R2-9): the map main holds, then each pushed map. A first read that
 *  lands after a push is older than it and is dropped, and nothing is set once stopped. Returns the stop. */
export function followAccountUsage(o: {
  ask: () => Promise<Record<string, AccountUsage>>
  on: (cb: (m: Record<string, AccountUsage>) => void) => () => void
  set: (m: Record<string, AccountUsage>) => void
}): () => void {
  let alive = true
  let pushed = false
  const off = o.on((m) => {
    if (!alive) return
    pushed = true
    o.set(m)
  })
  o.ask().then(
    (m) => {
      if (alive && !pushed) o.set(m)
    },
    () => {}
  )
  return () => {
    alive = false
    off()
  }
}

export function useAccountUsage(): Record<string, AccountUsage> {
  const [usage, setUsage] = useState<Record<string, AccountUsage>>({})

  useEffect(() => {
    // The map main already holds, so a remount draws immediately rather than waiting for the tick
    // this subscribe is about to start.
    const stop = followAccountUsage({
      ask: () => window.api.usage.accounts(),
      on: (cb) => window.api.on('usage:accounts-updated', cb),
      set: setUsage
    })
    window.api.usage.subscribe()
    return () => {
      stop()
      window.api.usage.unsubscribe()
    }
  }, [])

  return usage
}
