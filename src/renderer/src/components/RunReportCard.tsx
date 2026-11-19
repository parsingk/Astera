// The card at the top of a finished Run (run report design §6.1): how the Run got where it ended, as of its end. It says
// the same sentences every other surface says (core/runReport/render). No token line: the live token row sits right
// above it (R4), so the card shows the accounts used instead.
import type { RunReportComment } from '../../../core/github/lifecycle'
import type { Account } from '../../../core/types'
import { caveatLine, githubLine, interruptionsLine, interventionsLine, outcomeLine, reportMarkdown, taskLine, timesLine } from '../../../core/runReport/render'
import type { RunReport } from '../../../core/runReport/types'
import { useI18n } from '../i18n/I18nProvider'
import { localTime } from './findingsText'

/** A sentence with its code spans (a commit's sha) as code: the sentences carry Markdown's backticks for Copy, the pull
 *  request and Slack, and the card shows none */
function withCode(line: string): React.ReactNode[] {
  return line.split(/`([^`]*)`/).map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part))
}

export function RunReportCard(p: {
  report: RunReport
  comment?: RunReportComment
  accounts: readonly Account[] | null
  onCopy(markdown: string): void
}): React.JSX.Element {
  const { t, lang } = useI18n()
  const { report } = p
  const labels = new Map((p.accounts ?? []).map((a) => [a.id, a.label]))
  const github = githubLine(report, lang)
  const people = interventionsLine(report, lang)
  const accountNames = (report.cost?.accountIds ?? []).map((id) => labels.get(id) ?? id)
  return (
    <section className="run-report">
      <div className="run-report-head">
        <strong className="run-report-outcome">{withCode(outcomeLine(report, lang))}</strong>
        <button className="run-report-copy" onClick={() => p.onCopy(reportMarkdown(report, lang, { audience: 'app', accounts: labels, at: localTime }))}>
          {t('runReport.card.copy')}
        </button>
      </div>
      <p className="run-report-asof">{timesLine(report, lang, localTime)}</p>
      <p className="run-report-asof">{t('runReport.asOf')}</p>
      {github !== '' && <p className="run-report-line">{withCode(github)}</p>}
      {p.comment?.error !== undefined && p.comment.error !== '' && (
        <p className="run-report-line is-warning">{t('runReport.card.commentFailed', { error: p.comment.error })}</p>
      )}
      {report.caveats.length > 0 && (
        <ul className="run-report-caveats">
          {report.caveats.map((c, i) => (
            <li key={i}>{withCode(caveatLine(c, lang))}</li>
          ))}
        </ul>
      )}
      {/* Only this part scrolls: the head, the GitHub line, the comment error and every caveat stay in view (§6.1) */}
      <div className="run-report-scroll">
      {report.tasks.length > 0 && (
        <ul className="run-report-tasks">
          {report.tasks.map((task, i) => (
            <li key={i}>{withCode(taskLine(task, lang))}</li>
          ))}
        </ul>
      )}
      <p className="run-report-line">{withCode(interruptionsLine(report, lang))}</p>
      {people !== '' && <p className="run-report-line">{withCode(people)}</p>}
      {accountNames.length > 0 && <p className="run-report-line">{t('runReport.card.accounts', { names: accountNames.join(lang === 'ja' ? '、' : ', ') })}</p>}
      </div>
    </section>
  )
}
