// The Run detail's GitHub block (GitHub lifecycle design §8, §33; G7b): a lifecycle Run's pull request with its draft
// badge and GitHub's merge state, the head, the checks of that head, and where Astera stands. Merge-ready is shown with
// what GitHub itself says when the two disagree (draft, blocked). The source issue is the head's SourceChip; this
// block says when it changed. Presentational: RunDetail hands it the Run's `github` view.
import type { GitHubLifecycleState, GitHubLifecycleView } from '../../../core/github/view'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'
import { invalidatedReasonKey } from './githubText'
import { coarseDuration } from '../../../core/usage/relativeTime'

/** Every state, as a Record over the union so a new state does not compile without its words (final review M7). */
const STATE_WORDS: Record<GitHubLifecycleState, true> = {
  unbound: true,
  'pr-bound': true,
  'ci-pending': true,
  'ci-passed': true,
  'ci-failed': true,
  'pr-merged': true,
  'pr-closed': true,
  'external-state-unavailable': true,
  'pr-ready': true,
  'awaiting-push': true,
  repairing: true,
  reviewing: true,
  'waiting-for-user': true,
  exhausted: true,
  'ci-infrastructure-failure': true,
  'merge-ready': true
}
const STATES = Object.keys(STATE_WORDS) as GitHubLifecycleState[]
const stateKey = (s: GitHubLifecycleState): MessageKey => `jobs.github.state.${s}` as MessageKey

/** Every key the block says, for the all-languages test. */
/** GitHub's own review decision on the pull request, in words (acceptance fixes Task 3); a decision GitHub adds later says
 *  nothing. Shown beside Astera's review, never instead of it. */
const GITHUB_REVIEW_KEY: Partial<Record<string, MessageKey>> = {
  APPROVED: 'jobs.github.githubReview.approved',
  CHANGES_REQUESTED: 'jobs.github.githubReview.changesRequested',
  REVIEW_REQUIRED: 'jobs.github.githubReview.reviewRequired'
}

export const GITHUB_BLOCK_KEYS: readonly string[] = [
  ...STATES.map(stateKey),
  'jobs.github.title',
  'jobs.github.head',
  'jobs.github.repairingCheck',
  'jobs.github.repairingCi',
  'jobs.github.repairingLocal',
  'jobs.github.repairingReview',
  'jobs.github.repairingAttempt',
  'jobs.github.failing',
  'jobs.github.failingClass',
  'jobs.github.mergeReady',
  'jobs.github.githubDraft',
  'jobs.github.mergeState.blocked',
  'jobs.github.mergeState.behind',
  'jobs.github.mergeState.dirty',
  'jobs.github.mergeState.unstable',
  'jobs.github.ciOtherCommit',
  'jobs.github.invalidated',
  'jobs.github.externalHead',
  'jobs.github.externalHeadNoSha',
  'jobs.github.rebound',
  'jobs.github.noCi',
  'jobs.github.review.passed',
  'jobs.github.repairsDone',
  'jobs.github.evaluatedAgo',
  'jobs.github.review.foundIssues',
  ...Object.values(GITHUB_REVIEW_KEY).filter((k): k is MessageKey => k !== undefined),
  'jobs.github.sourceChanged',
  'jobs.github.noLocalCheck',
  'jobs.github.required',
  'jobs.github.noChecks'
]

const short = (sha: string): string => sha.slice(0, 7)

/** A repair under way, by what it repairs, with the attempt against the budget (final review I1). */
function repairLine(r: NonNullable<GitHubLifecycleView['repair']>, t: (key: MessageKey, p?: Record<string, string | number>) => string): string {
  const n = { attempt: r.attempt, max: r.max }
  switch (r.subject?.kind) {
    case 'ci':
      return r.subject.check !== undefined ? t('jobs.github.repairingCheck', { check: r.subject.check, ...n }) : t('jobs.github.repairingCi', n)
    case 'local':
      return t('jobs.github.repairingLocal', { check: r.subject.check, ...n })
    case 'review':
      return t('jobs.github.repairingReview', n)
    default:
      return t('jobs.github.repairingAttempt', n)
  }
}

/** A check's mark by the verdict's own rules (ciVerdict.ts; final review M2): ● while it goes (stale included: GitHub
 *  runs it again), ✓ for what branch protection counts as passing, ✗ for every other conclusion. */
export const checkMarkOf = (c: { status: string; conclusion?: string }): string =>
  c.status !== 'completed' || c.conclusion === undefined || c.conclusion === 'stale'
    ? '●'
    : c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped'
      ? '✓'
      : '✗'

/** GitHub's merge states that disagree with merge-ready, in words (final review M3); clean, hooks and a state GitHub is
 *  still computing (UNKNOWN, after each push) are no disagreement. */
const MERGE_STATE_KEY: Partial<Record<string, MessageKey>> = {
  BLOCKED: 'jobs.github.mergeState.blocked',
  BEHIND: 'jobs.github.mergeState.behind',
  DIRTY: 'jobs.github.mergeState.dirty',
  UNSTABLE: 'jobs.github.mergeState.unstable'
}

export function GitHubBlock(p: {
  github: GitHubLifecycleView
  /** No ordinary Task of the Run names a local check (design §7.2 S16). */
  noLocalCheck: boolean
  onOpen(url: string): void
}): React.JSX.Element {
  const { t, lang } = useI18n()
  const g = p.github
  // GitHub's own state beside Astera's merge-ready, when they disagree (§8): a draft, or a merge state that is not clean
  const githubSays =
    g.mergeReady && g.pr
      ? g.pr.isDraft
        ? t('jobs.github.githubDraft')
        : g.pr.mergeStateStatus && MERGE_STATE_KEY[g.pr.mergeStateStatus]
          ? t(MERGE_STATE_KEY[g.pr.mergeStateStatus]!)
          : null
      : null
  const githubReview = g.pr?.reviewDecision ? GITHUB_REVIEW_KEY[g.pr.reviewDecision] : undefined
  return (
    <div className="detail-completion detail-github">
      <div className="detail-github-head">
        <b>{t('jobs.github.title')}</b>
        {g.pr && (
          <button className="detail-github-pr" onClick={() => p.onOpen(g.pr!.url)}>
            #{g.pr.number}
          </button>
        )}
        {g.pr?.isDraft && <span className="detail-chip">{t('github.badge.draft')}</span>}
        {g.headSha && <span className="detail-github-sha">{t('jobs.github.head', { sha: short(g.headSha) })}</span>}
      </div>
      <p className="detail-github-state">
        {g.state === 'repairing' && g.repair ? repairLine(g.repair, t) : t(stateKey(g.state))}
      </p>
      {/* The repairs made stay counted once none runs: while CI waits on a repair's push, in the review, on a finished Run
          (acceptance fixes Task 4) */}
      {g.repair && g.state !== 'repairing' && <p className="detail-github-line">{t('jobs.github.repairsDone', { attempt: g.repair.attempt, max: g.repair.max })}</p>}
      {g.failing && (
        <p className="detail-github-line">
          {g.failing.class ? t('jobs.github.failingClass', { check: g.failing.check, class: g.failing.class }) : t('jobs.github.failing', { check: g.failing.check })}
          {g.failing.summary && <span className="detail-github-summary"> — {g.failing.summary.split('\n')[0]}</span>}
        </p>
      )}
      {/* Where Astera's review stands once it has spoken; while it runs, the state line says so (acceptance fixes Task 3) */}
      {g.review?.state === 'passed' && <p className="detail-github-line detail-github-ready">{t('jobs.github.review.passed')}</p>}
      {g.review?.state === 'found-issues' && <p className="detail-github-line warn-text">{t('jobs.github.review.foundIssues', { count: g.review.blocking })}</p>}
      {githubReview && <p className={`detail-github-line${g.pr?.reviewDecision === 'CHANGES_REQUESTED' ? ' warn-text' : ''}`}>{t(githubReview)}</p>}
      {g.mergeReady && (
        <p className="detail-github-line detail-github-ready">
          {t('jobs.github.mergeReady', { sha: short(g.mergeReady.headSha) })}
          {/* When it was decided: a withdrawal needs a Host reading GitHub, and with none the line would otherwise look
              current however old it is (acceptance fixes Task 4) */}
          <span className="modal-hint"> · {t('jobs.github.evaluatedAgo', { ago: coarseDuration(Date.now() - Date.parse(g.mergeReady.evaluatedAt), lang) })}</span>
          {githubSays && <span className="detail-github-warn"> · {githubSays}</span>}
        </p>
      )}
      {g.invalidated && <p className="detail-github-line warn-text">{t('jobs.github.invalidated', { reason: t(invalidatedReasonKey(g.invalidated.reason)) })}</p>}
      {g.externalHead && (
        <p className="detail-github-line warn-text">
          {g.externalHead.sha ? t('jobs.github.externalHead', { sha: short(g.externalHead.sha) }) : t('jobs.github.externalHeadNoSha')}
        </p>
      )}
      {g.base?.reboundAt && <p className="detail-github-line">{t('jobs.github.rebound', { branch: g.base.branch })}</p>}
      {g.noCi && <p className="detail-github-line">{t('jobs.github.noCi')}</p>}
      {g.sourceChanged && <p className="detail-github-line">{t('jobs.github.sourceChanged')}</p>}
      {p.noLocalCheck && <p className="detail-github-line warn-text">{t('jobs.github.noLocalCheck')}</p>}
      {/* Checks of a commit that is not the head yet, just after a push (final review M6) */}
      {g.ci && g.headSha && g.ci.sha !== g.headSha && <p className="detail-github-line modal-hint">{t('jobs.github.ciOtherCommit', { sha: short(g.ci.sha) })}</p>}
      {g.pr &&
        (g.ci && g.ci.checks.length > 0 ? (
          <ul className="detail-completion-checks">
            {g.ci.checks.map((c, i) => (
              <li key={`${c.name}-${i}`}>
                <span className="detail-github-mark">{checkMarkOf(c)}</span>
                <span className="detail-completion-name">{c.name}</span>
                {c.required && <span className="detail-chip">{t('jobs.github.required')}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="modal-hint">{t('jobs.github.noChecks')}</p>
        ))}
    </div>
  )
}
