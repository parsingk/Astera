// The words Settings › Security & Access and Run detail's observe lines show (observe mode design §9-§11), and the small
// readings of what the Host answers, apart from the components so each is tested as text. The Host keeps the rules and
// the records and decides every call; this side only says what it answered, in the person's language.
import type { MessageKey, MessageParams } from '../../../core/i18n'
import type { AuditQuery, TokenTotals } from '../../../core/types'
import type {
  AuditAction,
  AuditDecision,
  AuditMode,
  AuditRecord,
  AuditRule,
  CoverageCell,
  CoverageClass,
  CoverageRow
} from '../../../core/audit/types'
import { ACTION_PHRASES, COVERAGE_NOTE_PHRASES } from '../../../core/audit/phrases'
import { failureLine } from './extensionsText'

type T = (key: MessageKey, params?: MessageParams) => string
type Failure = { ok: false; code: string; message: string; reason?: string }

/** The names the person chose for the tab and its sections (2026-10-22): English in every language. */
export const SECURITY_TAB = 'Security & Access'
export const POLICIES_TITLE = 'Policies'
export const AUDIT_LOGS_TITLE = 'Audit Logs'

/** A record as audit-list answers it: with the decision the rules in force give it, and the rule that gave it. */
export type AuditRow = AuditRecord & { decision: AuditDecision; ruleId?: string }

/** Every action the resolver names, in the order the CLI documents them. */
export const AUDIT_ACTIONS = Object.keys(ACTION_PHRASES) as AuditAction[]

/** The groups of actions a rule can name with a trailing `*`, said in words. Another pattern is shown as it is. */
const GROUPS: Record<string, MessageKey> = {
  'git.*': 'settings.security.group.git',
  'github.*': 'settings.security.group.github',
  'filesystem.*': 'settings.security.group.filesystem',
  '*': 'settings.security.group.all'
}

/** What a rule's action can be picked from: every action, then the groups. */
export const RULE_ACTION_CHOICES: string[] = [...AUDIT_ACTIONS, ...Object.keys(GROUPS)]

/** The choices for one rule: a pattern made elsewhere (the CLI's `git.re*`) stays among them, so editing the rule's
 *  effect or place never changes its action. */
export const ruleActionChoices = (current?: string): string[] =>
  current === undefined || RULE_ACTION_CHOICES.includes(current) ? RULE_ACTION_CHOICES : [...RULE_ACTION_CHOICES, current]

/** An action or a rule's pattern as a plain phrase; one this side does not know (a newer Host's) as it was named. */
export function actionPhrase(action: string, t: T): string {
  if (Object.hasOwn(ACTION_PHRASES, action)) return t(ACTION_PHRASES[action as AuditAction])
  if (Object.hasOwn(GROUPS, action)) return t(GROUPS[action])
  return action
}

export const DECISIONS: AuditDecision[] = ['allow', 'would-deny', 'unknown']
const DECISION_WORDS: Record<AuditDecision, MessageKey> = {
  allow: 'settings.security.decision.allow',
  'would-deny': 'settings.security.decision.would-deny',
  unknown: 'settings.security.decision.unknown'
}
export const decisionLabel = (d: string, t: T): string => (Object.hasOwn(DECISION_WORDS, d) ? t(DECISION_WORDS[d as AuditDecision]) : d)

const EFFECTS: Record<AuditRule['effect'], MessageKey> = {
  allow: 'settings.security.effect.allow',
  deny: 'settings.security.effect.deny'
}
export const effectLabel = (e: AuditRule['effect'], t: T): string => t(EFFECTS[e])

/** A rule's place; none is anywhere. */
const SCOPES: Record<NonNullable<AuditRule['scope']> | 'anywhere', MessageKey> = {
  anywhere: 'settings.security.scope.anywhere',
  'inside-project': 'settings.security.scope.inside-project',
  'outside-project': 'settings.security.scope.outside-project'
}
export const scopeLabel = (s: AuditRule['scope'], t: T): string => t(SCOPES[s ?? 'anywhere'])

export const MODES: Record<AuditMode, MessageKey> = {
  compatibility: 'settings.security.mode.compatibility',
  observe: 'settings.security.mode.observe'
}

export const COVERAGE_CLASSES: CoverageClass[] = ['shell', 'file-read', 'file-write', 'mcp', 'network']
const CLASS_WORDS: Record<CoverageClass, MessageKey> = {
  shell: 'settings.security.coverage.class.shell',
  'file-read': 'settings.security.coverage.class.file-read',
  'file-write': 'settings.security.coverage.class.file-write',
  mcp: 'settings.security.coverage.class.mcp',
  network: 'settings.security.coverage.class.network'
}
const LEVELS: Record<CoverageCell['level'], MessageKey> = {
  seen: 'settings.security.coverage.level.seen',
  partial: 'settings.security.coverage.level.partial',
  none: 'settings.security.coverage.level.none'
}
const KINDS: Record<CoverageRow['kind'], MessageKey> = {
  terminal: 'settings.security.kind.terminal',
  chat: 'settings.security.kind.chat'
}
const PROVIDERS: Record<CoverageRow['provider'], string> = { claude: 'Claude', codex: 'Codex' }

export const coverageClassLabel = (c: CoverageClass, t: T): string => t(CLASS_WORDS[c])

/** A provider and kind of session, as a coverage row and a session the screen cannot name are called. */
export const coverageRowLabel = (r: Pick<CoverageRow, 'provider' | 'kind'>, t: T): string =>
  t('settings.security.coverage.row', { provider: PROVIDERS[r.provider] ?? r.provider, kind: Object.hasOwn(KINDS, r.kind) ? t(KINDS[r.kind]) : r.kind })

/** How much of a class observe sees, with why when only partly. A level or note this side does not know is shown as it
 *  was named. */
export function coverageCellText(cell: CoverageCell | undefined, t: T): string {
  if (cell === undefined) return ''
  const level = Object.hasOwn(LEVELS, cell.level) ? t(LEVELS[cell.level]) : String(cell.level)
  if (cell.note === undefined) return level
  const note = Object.hasOwn(COVERAGE_NOTE_PHRASES, cell.note) ? t(COVERAGE_NOTE_PHRASES[cell.note]) : String(cell.note)
  return t('settings.security.coverage.withNote', { level, note })
}

/** What observe sees of one provider and kind of session, every class in one line: shown with each session in Audit
 *  Logs (design §9), so a row's absence can be read against it. Empty when the Host listed no such row. */
export function coverageLine(rows: readonly CoverageRow[], s: Pick<CoverageRow, 'provider' | 'kind'>, t: T): string {
  const row = rows.find((r) => r.provider === s.provider && r.kind === s.kind)
  if (row === undefined) return ''
  return `${t('settings.security.coverage.title')}: ${COVERAGE_CLASSES.map((c) => `${coverageClassLabel(c, t)} ${coverageCellText(row.classes?.[c], t)}`).join(', ')}`
}

/** Why the Host gave nothing, as the screen says it; `repair` when starting over with the starter rules repairs it (a
 *  damaged rules file answers 409 to every read). */
const REASONS = {
  damaged: 'settings.security.damaged',
  noHost: 'settings.security.noHost'
} as const satisfies Record<string, MessageKey>

export function securityFailure(r: Failure, t: T): { line: string; repair: boolean } {
  // Only a damaged file: the Host says so as its reason. Another 409 (a file it could not read at all) is not repaired
  // by starting over, and its own sentence says why
  if (r.reason === 'damaged') return { line: t(REASONS.damaged), repair: true }
  if (r.code === 'HOST_NOT_RUNNING') return { line: t(REASONS.noHost), repair: false }
  return { line: failureLine(r, t, { read: true }), repair: false }
}

/** A rule in words: what it does, to which action, and where when it says. */
export function ruleLine(r: AuditRule, t: T): string {
  const params = { effect: effectLabel(r.effect, t), action: actionPhrase(r.action, t) }
  return r.scope === undefined ? t('settings.security.rule.line', params) : t('settings.security.rule.lineScoped', { ...params, scope: scopeLabel(r.scope, t) })
}

/** The rule that decided a call, in words: none matched when `otherwise` decided, nothing when it could not be told, and
 *  the id of a rule the screen's copy does not have (one changed from the CLI since it was read). */
export function decidingRule(r: Pick<AuditRow, 'decision' | 'ruleId'>, rules: readonly AuditRule[], t: T): string {
  if (r.ruleId === undefined) return r.decision === 'unknown' ? '' : t('settings.security.rule.otherwise')
  const rule = rules.find((x) => x.id === r.ruleId)
  return rule ? ruleLine(rule, t) : r.ruleId
}

/** The period Audit Logs reads. */
export type Period = 'today' | 'week' | 'month'
export const PERIODS: Record<Period, MessageKey> = {
  today: 'settings.security.period.today',
  week: 'settings.security.period.week',
  month: 'settings.security.period.month'
}
/** How many days before today a period starts. The longest is the records' whole retention: the store keeps the days
 *  from today−30 (core/audit/store.ts prune), so "the last 30 days" reaches as far back as anything is kept. */
const DAYS_BACK: Record<Period, number> = { today: 0, week: 6, month: 30 }

const midnightDaysBack = (now: Date, days: number): string => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days).toISOString()

/** Where a period starts: the local midnight of its first day. */
export const periodSince = (p: Period, now: Date): string => midnightDaysBack(now, DAYS_BACK[p])

/** The oldest record the store still keeps can be from this local midnight. */
export const retentionSince = (now: Date): string => midnightDaysBack(now, DAYS_BACK.month)

/** Where Run detail's count of a Run's calls starts reading: the Run's start (`runs get`'s createdAt) or the retention,
 *  whichever is later, so the Host never reads days the Run cannot have records in. The Run's Audit Logs view reads
 *  from the retention, which holds the same records. */
export function summarySince(createdAt: unknown, now: Date): string {
  const kept = retentionSince(now)
  if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return kept
  return Date.parse(createdAt) > Date.parse(kept) ? createdAt : kept
}

/** What Run detail reads observe facts for: the Run (a Job row folded onto its one Run carries its id), or, for a Job
 *  row with no Run of its own (nested, or a schedule), the Job. Ids say which by their prefix (view.ts rowFor). */
export function observeTargetOf(foldedRunId: string | undefined, openedId: string): { runId: string } | { jobId: string } {
  const id = foldedRunId ?? openedId
  return id.startsWith('job_') ? { jobId: id } : { runId: id }
}

/** What Run detail opens Audit Logs on: the Run's calls, or a Job row's with no Run of its own, and its name for the
 *  filter's chip. */
export type AuditFocus = ReturnType<typeof observeTargetOf> & { name: string }

/** Run detail reads tokens and the would-deny count no more often than this. */
export const OBSERVE_READ_EVERY_MS = 30_000

/** When Run detail reads its observe facts again: 0 to read now, a wait in ms to read once it is over, null for no read.
 *  At once for a target it has not read; after that only when the target's coarse state (a Run's outcome and progress,
 *  a Task's status) moved, and never sooner than OBSERVE_READ_EVERY_MS after the last read. Every event of a running
 *  Run re-reads the detail, and each read here asks the Host to read the records. */
export function observeReadDue(last: { target: string; state: string; at: number } | null, next: { target: string; state: string }, now: number): number | null {
  if (last === null || last.target !== next.target) return 0
  if (last.state === next.state) return null
  return Math.max(0, OBSERVE_READ_EVERY_MS - (now - last.at))
}

/** The filters Audit Logs offers, and the Run it was opened for from Run detail. */
export type AuditFilters = Pick<AuditQuery, 'sessionId' | 'agentProfileId' | 'jobId' | 'runId' | 'decision' | 'action'>

const FILTER_KEYS = ['sessionId', 'agentProfileId', 'jobId', 'runId', 'decision', 'action'] as const

/** The filters that are set, and the period's start. */
export function auditQuery(f: AuditFilters, p: Period, now: Date): AuditQuery {
  const q: Record<string, string> = {}
  for (const k of FILTER_KEYS) {
    const v = f[k]
    if (v !== undefined && v !== '') q[k] = v
  }
  return { ...(q as AuditQuery), since: periodSince(p, now) }
}

export interface AuditCursor {
  until: string
  beforeId: string
}

/** The next page: the same query from where the last page ended (audit-list's `next`); none at the end. */
export const nextPageQuery = (q: AuditQuery, next: AuditCursor | null): AuditQuery | null =>
  next === null ? null : { ...q, until: next.until, beforeId: next.beforeId }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** audit-list's answer: the records it could read as records, and where the next page starts. */
export function pageOf(body: unknown): { records: AuditRow[]; next: AuditCursor | null } {
  const b = isObject(body) ? body : {}
  const records = (Array.isArray(b.records) ? b.records : []).filter(
    (r): r is AuditRow => isObject(r) && typeof r.id === 'string' && typeof r.at === 'string' && typeof r.action === 'string'
  )
  const n = b.next
  const next = isObject(n) && typeof n.until === 'string' && typeof n.beforeId === 'string' ? { until: n.until, beforeId: n.beforeId } : null
  return { records, next }
}

/** A later page after the rows already shown, without showing one twice. */
export function appendPage(rows: readonly AuditRow[], more: readonly AuditRow[]): AuditRow[] {
  const seen = new Set(rows.map((r) => r.id))
  return [...rows, ...more.filter((r) => !seen.has(r.id))]
}

export interface AuditCounts {
  allow: number
  wouldDeny: number
  unknown: number
  /** A day of the period stopped recording at the size limit, so it holds fewer calls than were made. */
  stoppedAtLimit: boolean
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/** audit-summary's counts by decision. */
export function summaryOf(body: unknown): AuditCounts {
  const b = isObject(body) ? body : {}
  return { allow: count(b.allow), wouldDeny: count(b.wouldDeny), unknown: count(b.unknown), stoppedAtLimit: b.stoppedAtLimit === true }
}

export interface FilterChoices {
  /** With what a session is called by when its tab is gone (sessionLabel). */
  sessions: Pick<AuditRow, 'sessionId' | 'provider' | 'kind'>[]
  jobs: { id: string; runId?: string }[]
}

/** The sessions and the Jobs the rows name, each once in the order they first appear, after those `before` holds (the
 *  ones earlier reads found, so picking one does not take the others off the list); a Job with the Run a row of it
 *  names, which the screen names it by. */
export function filterChoices(rows: readonly AuditRow[], before: FilterChoices = { sessions: [], jobs: [] }): FilterChoices {
  const sessions = [...before.sessions]
  const jobs = [...before.jobs]
  for (const r of rows) {
    if (!sessions.some((s) => s.sessionId === r.sessionId)) sessions.push({ sessionId: r.sessionId, provider: r.provider, kind: r.kind })
    if (r.jobId !== undefined && !jobs.some((j) => j.id === r.jobId)) jobs.push({ id: r.jobId, ...(r.runId !== undefined ? { runId: r.runId } : {}) })
  }
  return { sessions, jobs }
}

const two = (n: number): string => String(n).padStart(2, '0')

/** When a call happened, on the person's clock to the second, with its date: the records span days. As the CLI prints it. */
export function recordTime(iso: string): string {
  const d = new Date(iso)
  if (!Number.isFinite(d.getTime())) return iso
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** A session by its tab's title while this app has one, else by its provider and kind and the start of its id (one
 *  closed since, or a worker's). */
export const sessionLabel = (r: Pick<AuditRow, 'sessionId' | 'provider' | 'kind'>, title: string | undefined, t: T): string =>
  title ?? `${coverageRowLabel(r, t)} ${r.sessionId.slice(0, 8)}`

/** The line Audit Logs shows instead of rows, or above them: why there is nothing (the Host, a damaged rules file,
 *  observe off, an empty period), or that observe is off above records kept before. Null when the rows say it all.
 *  `mode` is null while the rules could not be read. */
export function auditStateLine(s: { failure: Failure | null; mode: AuditMode | null; count: number }, t: T): string | null {
  if (s.failure !== null) {
    if (s.failure.code === 'HOST_NOT_RUNNING') return t('settings.security.audit.noHost')
    if (s.failure.reason === 'damaged') return t('settings.security.audit.damaged')
    return failureLine(s.failure, t, { read: true })
  }
  if (s.count === 0) return s.mode === 'compatibility' ? t('settings.security.audit.off') : t('settings.security.audit.empty')
  return s.mode === 'compatibility' ? t('settings.security.audit.offWithRows') : null
}

const totalsOf = (v: unknown): TokenTotals | undefined => {
  if (!isObject(v)) return undefined
  const { input, output, total } = v
  return typeof input === 'number' && typeof output === 'number' && typeof total === 'number' ? { input, output, total } : undefined
}

/** The token totals `runs get` and `tasks get` carry (design §10); each left out when the Host does not know it, never
 *  made zeros. */
export function tokensOf(body: unknown): { tokens?: TokenTotals; coordinatorTokens?: TokenTotals } {
  const b = isObject(body) ? body : {}
  const tokens = totalsOf(b.tokens)
  const coordinatorTokens = totalsOf(b.coordinatorTokens)
  return { ...(tokens ? { tokens } : {}), ...(coordinatorTokens ? { coordinatorTokens } : {}) }
}

/** Run detail's line on how many of the Run's calls would be denied; null when it has no records to count. */
export function wouldDenyLine(c: AuditCounts, t: T): string | null {
  if (c.allow + c.wouldDeny + c.unknown === 0) return null
  return c.wouldDeny > 0 ? t('jobs.detail.wouldDeny', { count: c.wouldDeny }) : t('jobs.detail.wouldDenyNone')
}

/** Every key this file says, so a test can hold the four catalogs to them. */
export const SECURITY_KEYS: MessageKey[] = [
  ...Object.values(ACTION_PHRASES),
  ...Object.values(COVERAGE_NOTE_PHRASES),
  ...Object.values(GROUPS),
  ...Object.values(DECISION_WORDS),
  ...Object.values(EFFECTS),
  ...Object.values(SCOPES),
  ...Object.values(MODES),
  ...Object.values(CLASS_WORDS),
  ...Object.values(LEVELS),
  ...Object.values(KINDS),
  ...Object.values(REASONS),
  ...Object.values(PERIODS)
]
