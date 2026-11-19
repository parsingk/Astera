// What the Run detail makes of the Host's answer to `runs-report`: the snapshot, or nothing to draw.
import type { RunReportComment } from '../../../core/github/lifecycle'
import { RUN_REPORT_VERSION, type RunReport } from '../../../core/runReport/types'

export type RunReportView = { kind: 'none' } | { kind: 'ok'; report: RunReport; comment?: RunReportComment }

/** `ok` only for a 200 whose report is of the version this app draws; a null report, a Runtime too old to know the
 *  command, a refusal and a failed read are all `none` */
export function runReportViewOf(reply: { status: number; body: unknown } | null): RunReportView {
  if (reply === null || reply.status !== 200) return { kind: 'none' }
  const body = reply.body
  if (typeof body !== 'object' || body === null) return { kind: 'none' }
  const { report, comment } = body as { report?: unknown; comment?: unknown }
  if (typeof report !== 'object' || report === null || (report as { version?: unknown }).version !== RUN_REPORT_VERSION) return { kind: 'none' }
  const out: RunReportView = { kind: 'ok', report: report as RunReport }
  if (typeof comment === 'object' && comment !== null) out.comment = comment as RunReportComment
  return out
}
