import type { UpdateStatus } from '../types'

/**
 * Feedback decisions for the "Check for updates" button in the settings modal (pure functions).
 *
 * When a user already on the latest version presses the button, the check round-trip is only about
 * 350ms, so 'Checking…' never registers, and the result text is the same as what was already on
 * screen — the button looked dead. So (1) there is a minimum display window and (2) the time of the
 * last check goes into the text, which makes the value change on every press.
 */

/** Keeps 'Checking…' up for at least this long after the click — so the user notices it even when the server answers faster. */
export const MIN_CHECKING_MS = 600

/** The states that count as one finished check. downloading is excluded because it streams in on every progress tick. */
export function isCheckResult(state: UpdateStatus['state']): boolean {
  return state === 'uptodate' || state === 'available' || state === 'downloaded' || state === 'error'
}

/** Shows 'Checking…' while a check is actually running, or while the minimum display window after the click is still open. */
export function showChecking(
  state: UpdateStatus['state'] | undefined,
  clickedAt: number | null,
  now: number
): boolean {
  if (state === 'checking') return true
  return clickedAt !== null && now - clickedAt < MIN_CHECKING_MS
}

/**
 * Whether to announce an already-downloaded version in a toast. The same version is announced only
 * once — re-checking reuses the cached file, so `downloaded` arrives again. With no version there is
 * nothing to announce.
 */
export function shouldNotifyDownloaded(
  version: string | undefined,
  notified: string | null
): boolean {
  if (!version) return false
  return version !== notified
}

/** The time of the last check as local HH:MM (24-hour). The date is left out — it is a recent value within the same session. */
export function formatCheckedAt(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
