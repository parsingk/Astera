// How It Works' GitHub block (GitHub lifecycle G8, spec §40): a lifecycle Run's record says where the work came from,
// the pull request it went to, and what verified it — the local checks, GitHub CI on the head, Astera's review — as the
// Run left them. What did not happen is marked not done, never passed. Presentational: RecordDetail hands it the record's
// `github`.
import type { EvidenceStatus, RecordGitHub as Evidence } from '../../../core/understanding/types'
import type { MessageKey } from '../../../core/i18n'
import { useI18n } from '../i18n/I18nProvider'

const MARK: Record<EvidenceStatus, string> = { passed: '✓', failed: '✗', skipped: '–' }

const short = (sha: string): string => sha.slice(0, 7)

export function RecordGitHub(p: { github: Evidence; onOpen(url: string): void }): React.JSX.Element {
  const { t } = useI18n()
  const g = p.github
  const ci =
    g.ci.status === 'skipped'
      ? g.ci.noCi && g.ci.sha
        ? t('hiw.github.ci.noCi', { sha: short(g.ci.sha) })
        : t('hiw.github.ci.skipped')
      : t(`hiw.github.ci.${g.ci.status}` as MessageKey, { sha: short(g.ci.sha ?? '') })
  const lines: { mark: EvidenceStatus; text: string }[] = [
    ...(g.local ? [{ mark: g.local, text: t(`hiw.github.local.${g.local}` as MessageKey) }] : []),
    { mark: g.ci.status, text: ci },
    { mark: g.review, text: t(`hiw.github.review.${g.review}` as MessageKey) },
    { mark: g.mergeReady ? 'passed' : 'skipped', text: t(g.mergeReady ? 'hiw.github.mergeReady' : 'hiw.github.notMergeReady') }
  ]
  return (
    <div className="hiw-github">
      <p className="hiw-lab">{t('hiw.github.title')}</p>
      {g.source && (
        <p className="hiw-github-line">
          {t('hiw.github.source')}{' '}
          {g.source.url ? (
            <button className="hiw-github-link" onClick={() => p.onOpen(g.source!.url!)}>
              {g.source.label}
            </button>
          ) : (
            g.source.label
          )}
        </p>
      )}
      <p className="hiw-github-line">
        {g.pr ? (
          <>
            {t('hiw.github.pr')}{' '}
            <button className="hiw-github-link" onClick={() => p.onOpen(g.pr!.url)}>
              #{g.pr.number}
            </button>
          </>
        ) : (
          t('hiw.github.noPr')
        )}
      </p>
      <ul className="hiw-github-checks">
        {lines.map((l) => (
          <li key={l.text}>
            <span className={`hiw-github-mark ${l.mark}`}>{MARK[l.mark]}</span>
            {l.text}
          </li>
        ))}
      </ul>
      <p className="hiw-fine">{t('hiw.github.asOf')}</p>
    </div>
  )
}
