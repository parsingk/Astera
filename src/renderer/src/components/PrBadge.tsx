import type { PrInfo, PrState } from '../../../core/github/types'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'

const STATE_KEY: Record<PrState, MessageKey> = {
  open: 'github.state.open',
  merged: 'github.state.merged',
  closed: 'github.state.closed'
}
const CHECKS_KEY: Record<'pending' | 'failing', MessageKey> = {
  pending: 'github.badge.checks.pending',
  failing: 'github.badge.checks.failing'
}

/** Read-only PR badge for a worktree row: mono "#N" colored by state, one dot for checks.
 *  Passing checks render nothing — quiet by default; the words ride on the title. The draft
 *  flag beats the open color (GitHub clears isDraft on merge/close, so it only matters open). */
export function PrBadge({
  pr,
  stale,
  onOpenMenu
}: {
  pr: PrInfo
  stale: boolean
  onOpenMenu: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const stateClass = pr.state === 'open' && pr.isDraft ? 'draft' : pr.state
  const checks: 'pending' | 'failing' | null =
    pr.checks === 'pending' || pr.checks === 'failing' ? pr.checks : null
  const title = [
    `#${pr.number} ${pr.title}`,
    pr.state === 'open' && pr.isDraft ? t('github.badge.draft') : t(STATE_KEY[pr.state]),
    checks ? t(CHECKS_KEY[checks]) : null,
    stale ? t('github.badge.stale') : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      className={`pr-badge ${stateClass}${stale ? ' stale' : ''}`}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onOpenMenu(e)
      }}
    >
      #{pr.number}
      {checks && <span className={`pr-checks ${checks}`} aria-hidden="true" />}
    </button>
  )
}
