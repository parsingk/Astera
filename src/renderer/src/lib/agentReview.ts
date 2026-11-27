// The words of the agent-aware review (Phase 3 Part 4): the changed-files block's attempt selector, the range it read,
// and each file's attribution badge with its evidence and its limit in the title. The limit is the person's decision
// (2026-11-27): commits a person made in the same folder are not told apart, and the badge says so.
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { Diagnostic, DiagnosticSeverity } from '../../../core/problems/diagnostic'
import type { Dispatch } from '../../../core/orchestration/types'
import { PROVIDER_META } from '../../../core/providers/meta'
import type { AttributionKind, DiffFinding, FileAttribution } from '../../../core/review/types'
import type { ReviewSeverity } from '../../../core/orchestration/types'

type T = (key: MessageKey, params?: MessageParams) => string

/** A commit as the screen names it: its first seven characters. */
export const shortSha = (sha: string | null): string => (sha ?? '').slice(0, 7)

/** "Attempt 2 · Codex · 10:20", with a repair or a retry said after it. */
export function attemptLabel(t: T, d: Dispatch, n: number): string {
  const time = new Date(d.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const label = t('agentReview.attempt', { n, provider: PROVIDER_META[d.provider].displayName, time })
  if (d.repair !== undefined) return `${label} · ${t('agentReview.attempt.repair')}`
  if (d.retryOf !== undefined) return `${label} · ${t('agentReview.attempt.retry')}`
  return label
}

/** A Run's Task part's range named with its Task, others plainly (final review M11). */
export function partRangeLabel(t: T, r: { taskId?: string; base: string; head: string | null }, taskTitle?: string): string {
  return taskTitle !== undefined ? t('agentReview.range.task', { task: taskTitle, range: rangeLabel(t, r) }) : rangeLabel(t, r)
}

/** "aaaaaaa → bbbbbbb", or up to the working tree while the range is live. */
export function rangeLabel(t: T, r: { base: string; head: string | null }): string {
  return r.head === null ? t('agentReview.range.live', { base: shortSha(r.base) }) : t('agentReview.range', { base: shortSha(r.base), head: shortSha(r.head) })
}

const WHY_KEY = {
  'no-range': 'agentReview.why.no-range',
  unread: 'agentReview.why.unread',
  'not-fast-forward': 'agentReview.why.not-fast-forward',
  'shared-folder-live': 'agentReview.why.shared-folder-live',
  overlap: 'agentReview.why.overlap'
} as const
const LEVEL_KEY = { 'recorded-range': 'agentReview.level.recorded-range', 'observe-audit': 'agentReview.level.observe-audit' } as const

/** The badge on a file: the agents that changed it, mixed or unknown; null with no attribution. */
export function attributionBadge(t: T, a: FileAttribution | undefined): { text: string; tone: AttributionKind } | null {
  if (a === undefined) return null
  if (a.kind === 'agent') {
    const providers = [...new Set(a.evidence.map((e) => PROVIDER_META[e.provider].displayName))].join(', ')
    return { text: t('agentReview.attr.agent', { provider: providers }), tone: 'agent' }
  }
  return { text: t(a.kind === 'mixed' ? 'agentReview.attr.mixed' : 'agentReview.attr.unknown'), tone: a.kind }
}

/** The badge's title: one line per attempt (provider, account, session, range), the level or the reason, then the limit. */
export function attributionTitle(t: T, a: FileAttribution): string {
  const lines = a.evidence.map((e) =>
    t('agentReview.evidence', { provider: PROVIDER_META[e.provider].displayName, account: e.accountId, session: e.sessionId, range: rangeLabel(t, e) })
  )
  if (a.level !== undefined) lines.push(t(LEVEL_KEY[a.level]))
  if (a.why !== undefined) lines.push(t(WHY_KEY[a.why]))
  lines.push(t('agentReview.limit'))
  return lines.join('\n')
}

/** A diff's findings by where they show: under a new-side line, found on another revision, or on the file. */
export function findingsByLine(findings: readonly DiffFinding[]): { inline: Map<number, DiffFinding[]>; otherRevision: DiffFinding[]; file: DiffFinding[] } {
  const inline = new Map<number, DiffFinding[]>()
  const otherRevision: DiffFinding[] = []
  const file: DiffFinding[] = []
  for (const f of findings) {
    if (f.placement === 'other-revision') otherRevision.push(f)
    else if (f.placement === 'file') file.push(f)
    else inline.set(f.placement.line, [...(inline.get(f.placement.line) ?? []), f])
  }
  return { inline, otherRevision, file }
}

/** A review's severity as the Problems rows say it (core/problems/completionProblems.ts REVIEW_SEVERITY). */
const ROW_SEVERITY: Record<ReviewSeverity, DiagnosticSeverity> = { critical: 'error', high: 'error', medium: 'warning', low: 'info', info: 'info' }

/** A diff finding as a Problems row, for Part 1's new Job draft when its Task cannot take a repair (final review M8):
 *  `path` is the diff's, relative to the repository, placed under the project. */
export function findingRow(f: DiffFinding, root: string, path: string): Diagnostic {
  return {
    schemaVersion: 1,
    id: `review:${f.taskId}:${f.ref}`,
    ref: f.ref,
    source: { kind: 'review', id: 'review', label: 'Review' },
    severity: ROW_SEVERITY[f.severity] ?? 'warning',
    message: f.title,
    path: `${root.replace(/[\\/]+$/, '')}/${path}`,
    root,
    ...(f.line !== undefined ? { line: f.line } : {})
  }
}
