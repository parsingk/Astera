import { GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-react'
import type { PrChecks, PrInfo, PrState } from '../../../core/github/types'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'

/** The four states a badge can be in. Not `PrState` — a draft is an open PR carrying a flag,
 *  and it reads as its own thing here, so the badge folds the two into one vocabulary. */
type BadgeState = PrState | 'draft'

const STATE_KEY: Record<BadgeState, MessageKey> = {
  open: 'github.state.open',
  merged: 'github.state.merged',
  closed: 'github.state.closed',
  draft: 'github.badge.draft'
}

/** A distinct shape per state, so the meaning survives without colour. Green and red are the
 *  one pair red-green colour blindness cannot separate, and open/closed were exactly that pair.
 *  These are GitHub's own glyphs (via lucide), for the same reason the colours are GitHub's:
 *  the reader already knows them. */
const STATE_GLYPH: Record<BadgeState, typeof GitPullRequest> = {
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
  draft: GitPullRequestDraft
}

/** Every check outcome gets a word in the title, including the two that draw nothing — "all
 *  passed" and "there are no checks" are different facts, and an absent dot alone cannot say
 *  which one it is. */
const CHECKS_KEY: Record<Exclude<PrChecks, null>, MessageKey> = {
  pending: 'github.badge.checks.pending',
  failing: 'github.badge.checks.failing',
  passing: 'github.badge.checks.passing'
}

/** Read-only PR badge for a worktree row: a state glyph, "#N", and a check mark when there is
 *  something to say. Passing checks draw nothing — quiet by default; the words ride on the
 *  title. The draft flag beats the open state (GitHub clears isDraft on merge/close, so it
 *  only means anything while the PR is open). */
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
  const state: BadgeState = pr.state === 'open' && pr.isDraft ? 'draft' : pr.state
  const Glyph = STATE_GLYPH[state]
  // Only these two earn a mark. Passing and "no checks at all" both stay silent on screen and
  // are told apart in the title below.
  const mark: 'pending' | 'failing' | null =
    pr.checks === 'pending' || pr.checks === 'failing' ? pr.checks : null
  const title = [
    `#${pr.number} ${pr.title}`,
    t(STATE_KEY[state]),
    pr.checks === null ? t('github.badge.checks.none') : t(CHECKS_KEY[pr.checks]),
    stale ? t('github.badge.stale') : null
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <button
      className={`pr-badge ${state}${stale ? ' stale' : ''}`}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation()
        onOpenMenu(e)
      }}
    >
      <Glyph className="pr-glyph" size={11} aria-hidden="true" />#{pr.number}
      {mark && <span className={`pr-checks ${mark}`} aria-hidden="true" />}
    </button>
  )
}
