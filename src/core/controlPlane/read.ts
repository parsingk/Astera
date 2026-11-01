// A paired Runtime's report, read over the controller link (remote governance design §5.1, §5.3, §4.3). Every answer
// is either a report the parser built field by field, or a code and a sentence: an older Runtime that lacks the command
// is told to update Astera there rather than shown a bare 501, and a report this build cannot read is never kept.
import { RemoteError } from '../remote/client'
import type { RemoteLink } from '../remote/link'
import { bodyCodeOf, codeForStatus, messageFrom } from '../orchestration/cliOutput'
import { t } from '../i18n'
import { parseControlPlaneReport, REPORT_CAPABILITY, type ControlPlaneReport } from './report'

export type ReportRead = { ok: true; report: ControlPlaneReport } | { ok: false; code: string; message: string }

export async function readRuntimeReport(link: RemoteLink): Promise<ReportRead> {
  const r = await link.call('control-plane-report', {})
  if (r instanceof RemoteError) return { ok: false, code: r.code, message: r.message }
  if (r.status < 200 || r.status >= 300) {
    // The hello says what the Runtime offers (§5.1): one without the capability refused because it is older
    if (!(link.hello()?.capabilities ?? []).includes(REPORT_CAPABILITY))
      return { ok: false, code: 'RUNTIME_CAPABILITY_MISSING', message: 'this Runtime cannot report its setup; update Astera there' }
    return { ok: false, code: bodyCodeOf(r.body) ?? codeForStatus(r.status), message: messageFrom(r.body, `the Runtime answered ${r.status}`) }
  }
  const report = parseControlPlaneReport(r.body)
  if ('error' in report) {
    // A newer Runtime's report (final review F8): this computer is the one to update, and the code stays FAILED
    const version = (r.body as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version > 1) return { ok: false, code: 'FAILED', message: t('en', 'settings.remote.detail.reportNewer') }
    return { ok: false, code: 'FAILED', message: `the Runtime sent a report this computer cannot read: ${report.error}` }
  }
  return { ok: true, report }
}
