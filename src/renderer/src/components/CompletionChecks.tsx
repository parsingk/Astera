// A Task's last round in its completion block (plugin Phase 5 C13): each check's verdict; a command check's output tail
// behind its own toggle; a plugin check's own words, its findings as `file:line message` and a link to its report. A
// check that could not be made is drawn apart with its reason, and one a person skipped says so in this app's words.
import type { CompletionCheckDetail } from '../../../core/types'
import { findingsCountOf, skipReasonOf } from '../../../core/orchestration/pluginChecks'
import { useI18n } from '../i18n/I18nProvider'
import { checkVerdict } from './checkText'

export function CompletionChecks({
  checks,
  tails,
  onToggleTail,
  onOpenLink
}: {
  checks: CompletionCheckDetail[]
  /** The checks whose output tail is open */
  tails: ReadonlySet<string>
  onToggleTail(configId: string): void
  /** Opens a plugin check's report in the browser */
  onOpenLink(url: string): void
}): React.JSX.Element | null {
  const { t } = useI18n()
  if (checks.length === 0) return null
  return (
    <ul className="detail-completion-checks">
      {checks.map((c) => {
        // A skipped check's record starts with English words the verdict already says in this app's language; a
        // summary the Host filled with the status word (the plugin gave none, C5) says only what the verdict says
        const said = c.skipped ? skipReasonOf(c.summary) : c.summary === c.status ? undefined : c.summary
        const link = c.externalUrl
        // The Host keeps 20 findings and counts the rest (5d)
        const more = findingsCountOf(c) - (c.diagnostics?.length ?? 0)
        return (
          <li key={c.configId}>
            <span className={`detail-completion-name detail-completion-name--${c.status}`}>{c.name}</span>
            <span className="detail-completion-verdict">
              {checkVerdict(c, t)}
              {c.unstable === true && ` · ${t('jobs.convergence.check.unstable')}`}
              {/* Claude Code on Windows has no sandbox: its checks ran outside one (Task K, the person's Q1) */}
              {c.outsideSandbox === true && ` · ${t('jobs.checks.outsideSandbox')}`}
            </span>
            {link !== undefined && (
              <button className="detail-completion-more" title={link} onClick={() => onOpenLink(link)}>
                {t('jobs.completion.openReport')}
              </button>
            )}
            {/* 꼬리는 검사마다 따로 접는다 — 넷이 한꺼번에 펼쳐지면 그중 무엇이 막고 있는지
                다시 찾아야 한다(설계 §2.3) */}
            {c.outputTail !== undefined && (
              <button className="detail-completion-more" onClick={() => onToggleTail(c.configId)}>
                {tails.has(c.configId) ? t('jobs.completion.hideTail') : t('jobs.completion.showTail')}
              </button>
            )}
            {c.outputTail !== undefined && tails.has(c.configId) && <pre className="detail-completion-tail">{c.outputTail}</pre>}
            {said !== undefined && said.trim() !== '' && (
              <p className={`detail-completion-summary${c.status === 'error' ? ' detail-completion-summary--error' : ''}`}>{said}</p>
            )}
            {/* What the Credentials list kept from the check, by name (Task K fix round 2): a failure for a hidden token
                or login reads as that. Only under a check that did not pass (fix round 3): a passing one carries the
                same names, and would repeat them under every check of every Task in that folder */}
            {c.status !== 'passed' && c.hiddenEnv !== undefined && c.hiddenEnv.length > 0 && (
              <p className="detail-completion-summary">{t('jobs.checks.hiddenEnv', { names: c.hiddenEnv.join(', ') })}</p>
            )}
            {c.diagnostics !== undefined && c.diagnostics.length > 0 && (
              <ul className="detail-completion-diags">
                {c.diagnostics.map((d, i) => (
                  <li key={i} className={d.severity === 'warning' ? 'warning' : undefined}>
                    {d.file !== undefined && (
                      <span className="detail-completion-where">{d.line !== undefined ? `${d.file}:${d.line}` : d.file}</span>
                    )}
                    <span>{(d.severity === 'warning' ? `${t('jobs.completion.warning')}: ` : '') + d.message}</span>
                  </li>
                ))}
              </ul>
            )}
            {more > 0 && (
              <p className="detail-completion-summary">
                {/* Where the rest are only when there is a report; a count with no list reads as a count (5d review M4) */}
                {(c.diagnostics?.length ?? 0) > 0
                  ? t(link !== undefined ? 'jobs.completion.moreFindingsReport' : 'jobs.completion.moreFindings', { n: more })
                  : t(link !== undefined ? 'jobs.completion.findingsUnlistedReport' : 'jobs.completion.findingsUnlisted', { n: more })}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
