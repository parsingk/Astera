import type { AccountUsage, RateLimitWindow } from '../../../core/types'

/** The existing usage thresholds: green under 70, yellow 70–84, red at 85 and over. The status bar's
 *  UsageChip (App.tsx) uses these exact figures — two places showing usage on two scales would be a
 *  defect, so this is the same set applied per window rather than to one blended number. */
export const usageLevel = (percent: number): 'ok' | 'warn' | 'crit' =>
  percent >= 85 ? 'crit' : percent >= 70 ? 'warn' : 'ok'

/** A percentage is a CSS width here, and the API's figure is not this module's to trust. */
export const clampPercent = (n: number): number => Math.max(0, Math.min(100, n))

const track = (w: RateLimitWindow | null): React.JSX.Element => (
  <span>
    {w && <i className={usageLevel(w.usedPercent)} style={{ width: `${clampPercent(w.usedPercent)}%` }} />}
  </span>
)

/**
 * The account row's two-track usage meter (design doc §5).
 *
 * 44px wide, two 3px tracks 2px apart, 8px tall — the row's height is set by the 12px label's line
 * box (about 17px), so it sits inside it and the row does not grow. 44px is the width the status-bar
 * meter already uses, so the label loses nothing.
 *
 * The top track is always the 5-hour window and the bottom always weekly. The order never varies: the
 * overlay names them, so it has to be learned exactly once.
 *
 * Nothing at all is drawn when there is no reading — a Codex account, an account that is not logged
 * in, and a reading discarded past its reset all arrive here as `undefined`. A dash was considered
 * and rejected: it reads as 0%, not as "no value". The login dot is the row's fixed right edge, so
 * the column does not ravel.
 */
export function AccountUsageMeter({
  usage
}: {
  usage: AccountUsage | undefined
}): React.JSX.Element | null {
  if (!usage || (!usage.session && !usage.weekly)) return null
  return (
    <span className={usage.remembered ? 'acct-meter stale' : 'acct-meter'} aria-hidden="true">
      {track(usage.session)}
      {track(usage.weekly)}
    </span>
  )
}
