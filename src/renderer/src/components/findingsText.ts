// The readings Settings › Security & Access › Findings and the Agent profiles mark make of the report the Host answers
// (lifecycle design §7), apart from the components so each is tested as text. The Host computes every finding and keeps
// the ignores; this side groups them, words them in the person's language and says where each one opens. Nothing here
// acts on a finding (§1, §9).
import { CATALOGS, type Message, type MessageKey, type MessageParams } from '../../../core/i18n'
import type { CoverageRow } from '../../../core/audit/types'
import type { Finding, FindingPlace, FindingRule, FindingSource, FindingSubject, FindingsReport, InfoLine, SubjectKind } from '../../../core/findings/types'
import type { OrchSnapshot, PluginsCallAnswer } from '../../../core/types'
import { failureLine } from './extensionsText'
import { coverageRowLabel } from './securityText'

type T = (key: MessageKey, params?: MessageParams) => string

/** The section's groups, in the order §7 lists the subject kinds, a coverage gap's CLI last. */
export const GROUP_ORDER = ['profiles', 'extensions', 'runtimes', 'credentials', 'jobs', 'clis'] as const
export type FindingGroupKind = (typeof GROUP_ORDER)[number]

/** Each subject kind's group: a duplicate group sits with the profiles, and a Task with the Jobs and Runs. */
const GROUP_OF: Record<SubjectKind, FindingGroupKind> = {
  profile: 'profiles',
  profiles: 'profiles',
  extension: 'extensions',
  runtime: 'runtimes',
  credential: 'credentials',
  job: 'jobs',
  task: 'jobs',
  run: 'jobs',
  cli: 'clis'
}

export const GROUP_KEYS: Record<FindingGroupKind, MessageKey> = {
  profiles: 'findings.kind.profiles',
  extensions: 'findings.kind.extensions',
  runtimes: 'findings.kind.runtimes',
  credentials: 'findings.kind.credentials',
  jobs: 'findings.kind.jobs',
  clis: 'findings.kind.clis'
}

/** A button names the place it opens (§7): a tab, a section of this one, or a Job or Run. */
const OPEN_KEYS: Record<FindingPlace['kind'], MessageKey> = {
  profiles: 'findings.open.profiles',
  job: 'findings.open.job',
  run: 'findings.open.run',
  extension: 'findings.open.extension',
  policies: 'findings.open.policies',
  runtimes: 'findings.open.runtimes',
  credentials: 'findings.open.credentials'
}

const CLI_SUBJECT = /^(claude|codex)-(terminal|chat)$/

/** How the section names a subject: a coverage gap's CLI and session kind as Policies labels its row, in the person's
 *  language (the Host names it in English for the CLI); any other as the Host named it. */
export function subjectName(s: FindingSubject, t: T): string {
  const cli = s.kind === 'cli' ? CLI_SUBJECT.exec(s.id) : null
  return cli === null ? s.name : coverageRowLabel({ provider: cli[1] as CoverageRow['provider'], kind: cli[2] as CoverageRow['kind'] }, t)
}

/** The open button's words; null for a place this app does not know (a newer Host's), which then gets no button. */
export const openLabelKey = (p: FindingPlace): MessageKey | null => (Object.hasOwn(OPEN_KEYS, p.kind) ? OPEN_KEYS[p.kind] : null)

/** Where a place is on screen: another Settings tab (Agent profiles with the profiles to show), a section of Security &
 *  Access, or a row of the Jobs view by the Job's or Run's id. */
export type FindingTarget =
  | { tab: 'agentProfiles'; profileIds: string[] }
  | { tab: 'extensions' | 'remote' }
  | { section: 'policies' | 'credentials' }
  | { jobs: string }

export function targetOf(p: FindingPlace): FindingTarget | null {
  switch (p.kind) {
    case 'profiles':
      return { tab: 'agentProfiles', profileIds: p.profileIds }
    case 'extension':
      return { tab: 'extensions' }
    case 'runtimes':
      return { tab: 'remote' }
    case 'policies':
      return { section: 'policies' }
    case 'credentials':
      return { section: 'credentials' }
    case 'job':
      return { jobs: p.jobId }
    case 'run':
      return { jobs: p.runId }
    default:
      return null
  }
}

/** The Jobs view's row a Job or Run opens as, as a click on it opens it: the Job's own row, a Job row folded onto its one
 *  Run (JobRow.foldedRunId), or a fire under its scheduled Job. Undefined when the open project's Jobs have none of
 *  them: the finding is about another project's Job, or about one gone since. */
export function jobsRowOf(snapshot: Pick<OrchSnapshot, 'runs'>, id: string): string | undefined {
  for (const row of snapshot.runs) {
    if (row.id === id || row.foldedRunId === id) return row.id
    const fire = row.children?.find((k) => k.id === id)
    if (fire !== undefined) return fire.id
  }
  return undefined
}

/** What App does, at each render, with the Job or Run a finding's button asked for (§7). It waits for the open project's
 *  list, opens the row that holds it as a click on that row does, or says it is not there (another project's Job, or one
 *  gone since): a detail opened on a row the list does not have would close at once (detailRunGone). It drops the ask
 *  when the Jobs view left or Settings came back before the list arrived, so no detail opens later unasked. */
export function pendingJobStep(a: {
  id: string
  /** The Jobs view is on screen: its view is chosen and the sidebar is open. */
  jobsShown: boolean
  settingsShown: boolean
  /** The open project's list; null while it is read. */
  snapshot: Pick<OrchSnapshot, 'runs'> | null
}): { do: 'wait' } | { do: 'drop' } | { do: 'notHere' } | { do: 'open'; row: string } {
  if (!a.jobsShown || a.settingsShown) return { do: 'drop' }
  if (a.snapshot === null) return { do: 'wait' }
  const row = jobsRowOf(a.snapshot, a.id)
  return row === undefined ? { do: 'notHere' } : { do: 'open', row }
}

/** What an ignore or a Show again that came back says (§6). Nothing when it landed. A key no current finding has (the
 *  Host's 404: the report changed since it was read) closes the note and says so. Any other failure keeps the note and
 *  says why. The section reads the report again either way. */
export function ignoreOutcome(r: PluginsCallAnswer, t: T): { closeNote: boolean; toast?: { kind: 'info' | 'error'; line: string } } {
  if (r.ok) return { closeNote: true }
  if (r.code === 'NOT_FOUND') return { closeNote: true, toast: { kind: 'info', line: t('findings.ignoreGone') } }
  return { closeNote: false, toast: { kind: 'error', line: failureLine(r, t) } }
}

/** The rules the Agent profiles mark counts (ruling 7): a profile's own findings. A coverage gap is its CLI's, and would
 *  mark every profile of that CLI alike; a broken Job or Task is the Job's to fix, not the profile's. */
const MARKED: ReadonlySet<FindingRule> = new Set<FindingRule>(['unused-profile', 'duplicate-profile', 'broken-reference', 'failing-profile', 'over-broad-profile'])

/** Each profile's open findings, by id: a finding counts for every profile it concerns, so a duplicate marks each
 *  member, and each over-broad line counts on its own. */
export function profileMarks(report: Pick<FindingsReport, 'findings'>): Map<string, Finding[]> {
  const marks = new Map<string, Finding[]>()
  for (const f of report.findings) {
    if (f.ignored || !MARKED.has(f.rule)) continue
    if (f.rule === 'broken-reference' && f.subject.kind !== 'profile') continue
    for (const id of new Set(f.profileIds)) {
      const own = marks.get(id)
      if (own === undefined) marks.set(id, [f])
      else own.push(f)
    }
  }
  return marks
}

type Words = (m: Message) => string | null

const isMessage = (v: unknown): v is Message => typeof v === 'object' && v !== null && typeof (v as Message).key === 'string'

/** Whether this app can word the Message: its key and the key of every Message inside it are in the catalogs. */
function known(m: Message): boolean {
  if (!Object.hasOwn(CATALOGS.ko.messages, m.key)) return false
  return Object.values(m.params ?? {}).every((v) => typeof v === 'string' || typeof v === 'number' || (isMessage(v) && known(v)))
}

/** A Message in the person's language, or the English the Host sent beside it when this app does not know its key (a
 *  newer Host's): never a key, never nothing. */
export const wordsOf = (m: Message, english: string, tm: Words): string => (known(m) ? (tm(m) ?? english) : english)

/** The mark's tooltip: each reason on a line of its own. */
export const markTitle = (findings: readonly Finding[], tm: Words): string => findings.map((f) => wordsOf(f.message, f.reason, tm)).join('\n')

/** One subject's lines: its open findings, then its information lines. */
export interface SubjectLines {
  subject: FindingSubject
  findings: Finding[]
  info: InfoLine[]
}

export interface FindingGroup {
  kind: FindingGroupKind
  subjects: SubjectLines[]
}

/** The open findings and the information lines by subject, in the report's order, the subjects grouped by kind in §7's
 *  order. A subject's lines stay under it: an over-broad profile's lines are separate findings with separate keys
 *  (ruling 11), shown under one heading. */
export function findingGroups(report: Pick<FindingsReport, 'findings' | 'info'>): FindingGroup[] {
  const bySubject = new Map<string, SubjectLines>()
  const at = (s: FindingSubject): SubjectLines => {
    const k = `${s.kind}:${s.id}`
    let lines = bySubject.get(k)
    if (lines === undefined) {
      lines = { subject: s, findings: [], info: [] }
      bySubject.set(k, lines)
    }
    return lines
  }
  for (const f of report.findings) if (!f.ignored) at(f.subject).findings.push(f)
  for (const i of report.info) at(i.subject).info.push(i)
  const subjects = [...bySubject.values()]
  return GROUP_ORDER.map((kind) => ({ kind, subjects: subjects.filter((s) => GROUP_OF[s.subject.kind] === kind) })).filter((g) => g.subjects.length > 0)
}

/** The longest note an ignore keeps (the Host's, lifecycle ruling 12). */
export const IGNORE_NOTE_MAX = 200

/** A note as the Host takes it: one line, trimmed, none when blank. */
export function ignoreNote(typed: string): string | undefined {
  const line = typed.replace(/[\r\n]+/g, ' ').trim()
  return line === '' ? undefined : line.slice(0, IGNORE_NOTE_MAX)
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string')
const isSubject = (v: unknown): v is FindingSubject =>
  isObject(v) && typeof v.kind === 'string' && Object.hasOwn(GROUP_OF, v.kind) && typeof v.id === 'string' && typeof v.name === 'string'
const isFinding = (v: unknown): v is Finding =>
  isObject(v) &&
  typeof v.key === 'string' &&
  typeof v.rule === 'string' &&
  isSubject(v.subject) &&
  isStrings(v.profileIds) &&
  isMessage(v.message) &&
  typeof v.reason === 'string' &&
  isMessage(v.suggestion) &&
  typeof v.action === 'string' &&
  isObject(v.open) &&
  typeof v.open.kind === 'string' &&
  typeof v.ignored === 'boolean'
const isInfo = (v: unknown): v is InfoLine => isObject(v) && isSubject(v.subject) && isMessage(v.message) && typeof v.reason === 'string'

/** agent-profiles-audit's answer as a report, or null when it is not one. A finding or line it cannot read as such (a
 *  subject kind this app does not know) is left out rather than drawn half. */
export function reportOf(body: unknown): FindingsReport | null {
  if (!isObject(body) || !Array.isArray(body.findings) || !Array.isArray(body.info) || !Array.isArray(body.unread)) return null
  const o = body.observe
  if (!isObject(o) || typeof o.on !== 'boolean' || typeof o.days !== 'number') return null
  return {
    findings: body.findings.filter(isFinding),
    info: body.info.filter(isInfo),
    observe: { on: o.on, days: o.days },
    unread: body.unread.filter((s): s is FindingSource => typeof s === 'string'),
    computedAt: typeof body.computedAt === 'string' ? body.computedAt : ''
  }
}
