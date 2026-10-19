// The Run detail's GitHub block (GitHub lifecycle design §8, §33; G7b): a lifecycle Run's pull request with its draft
// badge and GitHub's merge state, the head, the checks of that head, and where Astera stands. Merge-ready is shown with
// what GitHub itself says when the two disagree (draft, blocked). The source issue is the head's SourceChip; this
// block says when it changed. Presentational: RunDetail hands it the Run's `github` view.
import type { GitHubLifecycleState, GitHubLifecycleView } from '../../../core/github/view'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'
import { invalidatedReasonKey } from './githubText'

const STATES: readonly GitHubLifecycleState[] = [
  'unbound',
  'pr-bound',
  'ci-pending',
  'ci-passed',
  'ci-failed',
  'pr-merged',
  'pr-closed',
  'external-state-unavailable',
  'pr-ready',
  'awaiting-push',
  'repairing',
  'reviewing',
  'waiting-for-user',
  'exhausted',
  'ci-infrastructure-failure',
  'merge-ready'
]
const stateKey = (s: GitHubLifecycleState): MessageKey => `jobs.github.state.${s}` as MessageKey

/** Every key the block says, for the all-languages test. */
export const GITHUB_BLOCK_KEYS: readonly string[] = [
  ...STATES.map(stateKey),
  'jobs.github.title',
  'jobs.github.head',
  'jobs.github.repairingCheck',
  'jobs.github.failing',
  'jobs.github.failingClass',
  'jobs.github.mergeReady',
  'jobs.github.githubDraft',
  'jobs.github.githubMergeState',
  'jobs.github.invalidated',
  'jobs.github.externalHead',
  'jobs.github.externalHeadNoSha',
  'jobs.github.rebound',
  'jobs.github.noCi',
  'jobs.github.sourceChanged',
  'jobs.github.noLocalCheck',
  'jobs.github.required',
  'jobs.github.noChecks'
]

const short = (sha: string): string => sha.slice(0, 7)

/** A check's mark: ✓ passed, ✗ failed, ● still going, · anything else (skipped, neutral). */
const markOf = (c: { status: string; conclusion?: string }): string =>
  c.status !== 'completed' ? '●' : c.conclusion === 'success' ? '✓' : c.conclusion === 'failure' || c.conclusion === 'timed-out' || c.conclusion === 'startup-failure' ? '✗' : '·'

export function GitHubBlock(p: {
  github: GitHubLifecycleView
  /** No ordinary Task of the Run names a local check (design §7.2 S16). */
  noLocalCheck: boolean
  onOpen(url: string): void
}): React.JSX.Element {
  const { t } = useI18n()
  const g = p.github
  // GitHub's own state beside Astera's merge-ready, when they disagree (§8): a draft, or a merge state that is not clean
  const githubSays =
    g.mergeReady && g.pr
      ? g.pr.isDraft
        ? t('jobs.github.githubDraft')
        : g.pr.mergeStateStatus && g.pr.mergeStateStatus !== 'CLEAN'
          ? t('jobs.github.githubMergeState', { state: g.pr.mergeStateStatus.toLowerCase() })
          : null
      : null
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
        {g.state === 'repairing' && g.failing && g.repair
          ? t('jobs.github.repairingCheck', { check: g.failing.check, attempt: g.repair.attempt, max: g.repair.max })
          : t(stateKey(g.state))}
      </p>
      {g.failing && (
        <p className="detail-github-line">
          {g.failing.class ? t('jobs.github.failingClass', { check: g.failing.check, class: g.failing.class }) : t('jobs.github.failing', { check: g.failing.check })}
          {g.failing.summary && <span className="detail-github-summary"> — {g.failing.summary.split('\n')[0]}</span>}
        </p>
      )}
      {g.mergeReady && (
        <p className="detail-github-line detail-github-ready">
          {t('jobs.github.mergeReady', { sha: short(g.mergeReady.headSha) })}
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
      {g.pr &&
        (g.ci && g.ci.checks.length > 0 ? (
          <ul className="detail-completion-checks">
            {g.ci.checks.map((c, i) => (
              <li key={`${c.name}-${i}`}>
                <span className="detail-github-mark">{markOf(c)}</span>
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
