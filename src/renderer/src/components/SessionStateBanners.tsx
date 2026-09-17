import type { RollStateEvent, SchedStateEvent } from '../../../core/types'
import { schedRuleSummary } from '../../../core/scheduler/summary'
import { useI18n } from '../i18n/I18nProvider'

const fmtTime = (iso?: string): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
// A weekly retry can be days away, so show month/day plus the time
const fmtDateTime = (iso?: string): string =>
  iso
    ? new Date(iso).toLocaleString([], {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })
    : ''

// Whether the roll-banner is shown — the same condition as the sched-banner's below-roll offset
// decision, so it is merged into one type guard used in both places. Kept separate, a change to the
// condition would only be made on one side and the offset would silently drift.
export const rollBannerVisible = (s: RollStateEvent | null): s is RollStateEvent =>
  !!s && s.state !== 'none' && s.state !== 'nudged' && s.state !== 'stalled'

/** One banner's height in the strip — the same 25px `.sched-banner.below-roll` offsets by, measured
 *  there. Kept beside that rule so the two move together. */
const BANNER_ROW_PX = 25

/** How much room the strip needs, in pixels — 0 when neither banner is shown.
 *
 *  Both banners are absolutely positioned, which is right over a terminal: they float above scrollback,
 *  and covered pixels scroll back into view. The conversation pane's top is message content, so the pane
 *  reserves this much in its flex column instead and the thread starts below the strip. The terminal
 *  reserves nothing and is unchanged. The roll half asks rollBannerVisible rather than repeating its
 *  condition — a second copy would drift and the reserved height would stop matching what is drawn. */
export const stateBannerHeight = (
  rollState: RollStateEvent | null,
  schedState: SchedStateEvent | null
): number =>
  (rollBannerVisible(rollState) ? BANNER_ROW_PX : 0) + (schedState?.state === 'active' ? BANNER_ROW_PX : 0)

/** The rolling and schedule banners a session shows across the top of its view — the terminal's since
 *  their features existed, the chat pane's since chat-sessions slice 4 (§5.6). Both are absolutely
 *  positioned (`.roll-banner` / `.sched-banner` in styles.css), so the host element must be
 *  `position: relative` — `.terminal-wrap` is, and the conversation pane wraps this in a `relative`
 *  strip sized by stateBannerHeight above. */
export function SessionStateBanners({
  sessionId,
  rollState,
  schedState
}: {
  sessionId: string
  rollState: RollStateEvent | null
  schedState: SchedStateEvent | null
}): React.JSX.Element | null {
  const { t } = useI18n()
  if (!rollBannerVisible(rollState) && !(schedState && schedState.state === 'active')) return null
  return (
    <>
      {rollBannerVisible(rollState) && (
        <div className="roll-banner">
          {rollState.state === 'switching' &&
            t('session.terminal.rollSwitching', { label: rollState.accountLabel ?? '' })}
          {rollState.state === 'trust' && t('session.terminal.trustAccepting')}
          {/* No time and no promise, unlike 'waiting' just below: an adopted chain has neither a
              retry armed nor a reset to name. See RollStateEvent's own note on the state. */}
          {rollState.state === 'adopted' && t('session.terminal.rollAdopted')}
          {rollState.state === 'waiting' &&
            (rollState.scope === 'weekly'
              ? t('session.terminal.weeklyLimitWaiting', {
                  time: fmtDateTime(rollState.nextRetryAt)
                })
              : t('session.terminal.limitWaiting', { time: fmtTime(rollState.nextRetryAt) }))}
        </div>
      )}
      {schedState && schedState.state === 'active' && (
        <div className={`sched-banner${rollBannerVisible(rollState) ? ' below-roll' : ''}`}>
          <span>
            {schedRuleSummary(t, schedState.rule)}
            {t('session.terminal.schedNextRun', { time: fmtDateTime(schedState.nextAt) })}
          </span>
          <button onClick={() => void window.api.scheduler.disable(sessionId)}>
            {t('session.terminal.schedDisable')}
          </button>
        </div>
      )}
    </>
  )
}
