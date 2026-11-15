// The Run report's renderers (run report design §4, §6): the sentences every surface shares (the app's card calls them
// too), Markdown for Copy and the pull request comment, Slack mrkdwn, and the pull request version with its scrubber.
// Pure: it imports the i18n words and the report's types, no node module and nothing from build.ts.
import { t, type Lang, type MessageKey } from '../i18n'
import type { ActorGroup } from '../orchestration/types'
import type { RunReport, RunReportCaveat, RunReportCheck, RunReportReview, RunReportTask } from './types'

export const RUN_REPORT_MARKER = (runId: string): string => `<!-- astera-run-report run=${runId} -->`

/** The comment travels as one gh argument, under Windows' 32,767 limit (R7) */
export const PR_COMMENT_MAX = 16_000
export const SLACK_POST_MAX = 3_500
/** Caveats kept in a Slack post that has to be cut after its Task rows are gone (R7) */
const SLACK_CAVEATS_KEPT = 10

// ---- the scrubber (C11, R9, R10) ----

export interface ScrubContext {
  /** Absolute paths whose inside is shown repo-relative: the Run's worktrees and the project folders */
  roots: string[]
  /** Folders taken whole with whatever path follows, after the roots: the home folder and the profile folder, whose name
   *  may hold a space the path patterns below stop at */
  prefixes: string[]
  /** Account labels and anything else Astera knows that must not leave the machine */
  secrets: string[]
}

const PATH_BODY = '[^\\s"\'`<>|]*'
const DRIVE_PATH = new RegExp(`(?<![\\w])[A-Za-z]:[\\\\/]${PATH_BODY}`, 'g')
// A file:// url to a local path goes whole, before its drive or POSIX path is taken apart
const FILE_URL = new RegExp(`file:\\/\\/\\/?${PATH_BODY}`, 'gi')
const UNC_PATH = new RegExp(`\\\\\\\\[^\\s"'\`<>|]+`, 'g')
const HOME_PATH = new RegExp(`~[\\\\/]${PATH_BODY}`, 'g')
const POSIX_PATH = new RegExp(
  `(?<=^|[\\s"'\`(\\[=,:])\\/(?:Users|home|root|tmp|var|private|mnt|media|Volumes|opt|srv|usr|etc)\\/${PATH_BODY}`,
  'g'
)
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// A GitHub user or team, not part of an email, a word or a path
const MENTION = /(?<![\w@/.\-])@([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/g
const SECRET_MIN = 3
/** A caveat's free text (a forced completion's reason) is cut here (cutCaveatText) */
export const CAVEAT_TEXT_MAX = 300

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function rootPattern(root: string): RegExp | null {
  const trimmed = root.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return null
  let source = ''
  for (const ch of trimmed) source += ch === '\\' || ch === '/' ? '[\\\\/]' : escapeRegExp(ch)
  const flags = /^[A-Za-z]:/.test(trimmed) ? 'gi' : 'g'
  return new RegExp(`${source}(?:[\\\\/](${PATH_BODY})|(?![\\w-]|\\.\\w))`, flags)
}

/** One free text of the report, made safe to leave the machine, in this order: roots to repo-relative paths, the
 *  prefixes and any other absolute path to an ellipsis, email addresses, then the secrets as whole words. */
export function scrubText(text: string, ctx: ScrubContext): string {
  let out = text
  const roots = [...ctx.roots].sort((a, b) => b.length - a.length)
  for (const root of roots) {
    const re = rootPattern(root)
    if (!re) continue
    out = out.replace(re, (_m, rest: string | undefined) => {
      const relative = (rest ?? '').replace(/\\/g, '/')
      return relative === '' ? '.' : relative
    })
  }
  for (const prefix of [...ctx.prefixes].sort((a, b) => b.length - a.length)) {
    const re = rootPattern(prefix)
    if (re) out = out.replace(re, '…')
  }
  out = out.replace(FILE_URL, '…').replace(DRIVE_PATH, '…').replace(UNC_PATH, '…').replace(HOME_PATH, '…').replace(POSIX_PATH, '…')
  out = out.replace(EMAIL, '…')
  const secrets = ctx.secrets
    .map((s) => s.trim())
    .filter((s) => s.length >= SECRET_MIN)
    .sort((a, b) => b.length - a.length)
  for (const secret of secrets) out = out.replace(new RegExp(`(?<!\\w)${escapeRegExp(secret)}(?!\\w)`, 'gi'), '…')
  // Last: a @handle becomes a code span so the comment notifies no one; text already in backticks is left as it is
  return out
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(MENTION, '`@$1`')))
    .join('')
}

/** `<` and `>` outside code spans as entities: GitHub would read `<!--` in one field and `-->` in another as a comment
 *  hiding what lies between, and `Array<T>` as a tag */
const escapeAngles = (text: string): string =>
  text
    .split(/(`[^`]*`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
    .join('')

/** The report as the pull request comment may show it: no cost (D2), no Job name (its objective may say more than the
 *  pull request should), every free text cut where it is cut, then scrubbed and escaped. The PR's own url stays. */
export function forPullRequest(report: RunReport, ctx: ScrubContext): RunReport {
  const s = (text: string): string => escapeAngles(scrubText(text, ctx))
  const { cost: _cost, ...rest } = report
  return {
    ...rest,
    job: '',
    tasks: report.tasks.map((task) => ({
      ...task,
      title: s(task.title),
      checks: task.checks.map((c) => ({ ...c, name: s(c.name) })),
      ...(task.review ? { review: { ...task.review, blocking: task.review.blocking.map(s) } } : {}),
      ...(task.override ? { override: { ...task.override, reason: s(task.override.reason) } } : {})
    })),
    interventions: { ...report.interventions, forced: report.interventions.forced.map((f) => ({ ...f, task: s(f.task) })) },
    caveats: report.caveats.map((c): RunReportCaveat => {
      switch (c.kind) {
        case 'forced':
          // Cut before the scrub wraps a mention in a code span, so the cut never lands inside one
          return { ...c, task: s(c.task), reason: s(cutCaveatText(c.reason)) }
        case 'ci-skipped':
          return c
        case 'outside-sandbox':
          return { ...c, task: s(c.task), checks: c.checks.map(s) }
        case 'check-skipped':
        case 'unstable':
          return { ...c, task: s(c.task), check: s(c.check) }
        default:
          return { ...c, task: s(c.task) }
      }
    })
  }
}

// ---- the sentences ----

const key = (k: string): MessageKey => k as MessageKey
/** A sentence's stop and a list's separator, per language: the catalog strings carry their own stops, these two are for
 *  the lines built here from pieces */
const DOT: Record<Lang, string> = { ko: '.', en: '.', ja: '。', es: '.' }
const SEP: Record<Lang, string> = { ko: ', ', en: ', ', ja: '、', es: ', ' }

/** A free text on one line: a title with a line break must not break a list row */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
/** A caveat's free text on one line, cut at CAVEAT_TEXT_MAX: by the builder, and again (a no-op on a cut text) by the
 *  pull request version before it scrubs */
export const cutCaveatText = (s: string): string => {
  const one = oneLine(s)
  return one.length > CAVEAT_TEXT_MAX ? `${one.slice(0, CAVEAT_TEXT_MAX)}…` : one
}
const shortSha = (sha: string): string => sha.slice(0, 7)

function duration(ms: number, lang: Lang): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return t(lang, 'runReport.duration.under')
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return t(lang, 'runReport.duration.min', { m })
  if (m === 0) return t(lang, 'runReport.duration.hour', { h })
  return t(lang, 'runReport.duration.hourMin', { h, m })
}

/** The outcome, naming the Run by its Job and ordinal, or by its ordinal alone when the report holds no Job name (the
 *  pull request version) */
export function outcomeLine(r: RunReport, lang: Lang): string {
  const ms = Date.parse(r.endedAt) - Date.parse(r.startedAt)
  const params = { job: oneLine(r.job), ordinal: r.ordinal, duration: duration(Number.isFinite(ms) ? ms : 0, lang) }
  if (r.job === '') return t(lang, r.outcome === 'completed' ? 'runReport.outcome.completedUnnamed' : 'runReport.outcome.failedUnnamed', params)
  return t(lang, r.outcome === 'completed' ? 'runReport.outcome.completed' : 'runReport.outcome.failed', params)
}

/** When the Run started and ended, each worded by `at`: the card and its Copy pass the reader's own clock format */
export function timesLine(r: RunReport, lang: Lang, at: (iso: string) => string): string {
  return t(lang, 'runReport.times', { start: at(r.startedAt), end: at(r.endedAt) })
}

export function githubLine(r: RunReport, lang: Lang): string {
  const g = r.github
  if (!g) return ''
  const parts: string[] = []
  if (g.pr) parts.push(t(lang, 'runReport.github.pr', { number: g.pr.number, url: g.pr.url }))
  if (g.ci) parts.push(t(lang, key(`runReport.github.ci.${g.ci.verdict}`), { sha: shortSha(g.ci.sha) }))
  // The failed rounds the CI check's history counts, repaired or not: a failed Run's last round may be one of them
  if (g.ciFailedRounds > 0) {
    parts.push(t(lang, g.ciFailedAtLeast ? 'runReport.github.ciFailedAtLeast' : 'runReport.github.ciFailed', { count: g.ciFailedRounds }))
  }
  // Only who reran it; nothing at all when no one did
  const { astera, person, atLeast } = g.reruns
  const times = (count: number): string => (atLeast ? t(lang, 'runReport.atLeast', { count }) : String(count))
  if (astera > 0 && person > 0) parts.push(t(lang, 'runReport.github.rerunsBoth', { astera: times(astera), person: times(person) }))
  else if (astera > 0) parts.push(t(lang, 'runReport.github.rerunsAstera', { astera: times(astera) }))
  else if (person > 0) parts.push(t(lang, 'runReport.github.rerunsPerson', { person: times(person) }))
  if (g.mergeReady) parts.push(t(lang, 'runReport.github.mergeReady', { sha: shortSha(g.mergeReady.headSha) }))
  else if (g.withheld) parts.push(t(lang, 'jobs.github.invalidated', { reason: t(lang, key(`jobs.github.reason.${g.withheld}`)) }) + DOT[lang])
  else parts.push(t(lang, 'runReport.github.notReady'))
  return parts.join(' ')
}

export function checkLine(c: RunReportCheck, lang: Lang): string {
  const notes: string[] = []
  if (c.failedRounds > 0) notes.push(t(lang, c.atLeast ? 'runReport.check.failedRoundsAtLeast' : 'runReport.check.failedRounds', { count: c.failedRounds }))
  if (c.skipped) notes.push(t(lang, 'runReport.check.skipped'))
  if (c.unstable) notes.push(t(lang, 'runReport.check.unstable'))
  if (c.outsideSandbox) notes.push(t(lang, 'runReport.check.outsideSandbox'))
  const base = t(lang, key(`runReport.check.final.${c.final}`), { name: oneLine(c.name) })
  return `${base}${notes.length > 0 ? ` (${notes.join(SEP[lang])})` : ''}${DOT[lang]}`
}

export function reviewLine(rv: RunReportReview, lang: Lang): string {
  const parts = [t(lang, rv.passed ? 'runReport.review.passed' : 'runReport.review.notPassed', { rounds: rv.rounds })]
  if (rv.blocking.length > 0) parts.push(t(lang, 'runReport.review.blocking', { titles: rv.blocking.map(oneLine).join(SEP[lang]) }))
  if (rv.fileToolsOnly) parts.push(t(lang, 'runReport.review.fileToolsOnly'))
  return parts.join(' ')
}

const groupWord = (g: ActorGroup, lang: Lang): string => t(lang, key(`runReport.group.${g}`))

/** A Task as the report names it: the lifecycle Task's title is stored in one language (lifecycleTask.ts), so it is
 *  named in the reader's, as the app's graph names it (taskTitleOf); any other Task by its own title */
const taskName = (title: string, lifecycle: true | undefined, lang: Lang): string => (lifecycle ? t(lang, 'jobs.lifecycle.title') : oneLine(title))

export function taskLine(task: RunReportTask, lang: Lang): string {
  const parts = [t(lang, key(`runReport.task.status.${task.status}`))]
  // The lifecycle Task is Astera's own carrying: it has a Dispatch only for a repair, which its repairs say
  if (!task.lifecycle) parts.push(task.attempts > 0 ? t(lang, 'runReport.task.attempts', { count: task.attempts }) : t(lang, 'runReport.task.noWorker'))
  const { check, review } = task.repairs
  if (check > 0 && review > 0) parts.push(t(lang, 'runReport.task.repairsBoth', { check, review }))
  else if (check > 0) parts.push(t(lang, 'runReport.task.repairsCheck', { check }))
  else if (review > 0) parts.push(t(lang, 'runReport.task.repairsReview', { review }))
  if (task.grantedExtra > 0) parts.push(t(lang, 'runReport.task.extra', { count: task.grantedExtra }))
  // Nothing absent reads as passed (§4.2): a Task nothing looked at says so
  if (task.checks.length === 0) parts.push(t(lang, task.review ? 'runReport.task.noCheckList' : 'runReport.task.noChecks'))
  for (const c of task.checks) parts.push(checkLine(c, lang))
  if (task.review) parts.push(reviewLine(task.review, lang))
  if (task.override) parts.push(t(lang, 'runReport.task.forced', { group: groupWord(task.override.by, lang) }))
  return `${taskName(task.title, task.lifecycle, lang)}: ${parts.join(' ')}`
}

export function interruptionsLine(r: RunReport, lang: Lang): string {
  const i = r.interruptions
  const parts: string[] = []
  if (i.limitWaits > 0) parts.push(t(lang, 'runReport.interruptions.waits', { count: i.limitWaits, duration: duration(i.waitedMs, lang) }))
  if (i.switches > 0) parts.push(t(lang, 'runReport.interruptions.switches', { count: i.switches }))
  if (i.restarts > 0) parts.push(t(lang, 'runReport.interruptions.restarts', { count: i.restarts }))
  return parts.length > 0 ? parts.join(' ') : t(lang, 'runReport.interruptions.none')
}

const GROUPS: ActorGroup[] = ['person', 'coordinator', 'astera', 'unknown']

export function interventionsLine(r: RunReport, lang: Lang): string {
  const { answers, forced, noPersonSteppedIn } = r.interventions
  const parts: string[] = []
  for (const g of GROUPS) if (answers[g] > 0) parts.push(t(lang, key(`runReport.interventions.answered.${g}`), { count: answers[g] }))
  if (forced.length > 0) {
    const groups = GROUPS.map((g) => ({ g, n: forced.filter((f) => f.by === g).length }))
      .filter((x) => x.n > 0)
      .map((x) => `${groupWord(x.g, lang)} ${x.n}`)
      .join(SEP[lang])
    parts.push(t(lang, 'runReport.interventions.forced', { count: forced.length, groups }))
  }
  if (noPersonSteppedIn) parts.push(t(lang, 'runReport.interventions.noPerson'))
  return parts.join(' ')
}

export function caveatLine(c: RunReportCaveat, lang: Lang): string {
  if (c.kind === 'ci-skipped') return t(lang, 'runReport.caveat.ci-skipped')
  const task = taskName(c.task, c.lifecycle, lang)
  switch (c.kind) {
    case 'forced':
      return t(lang, 'runReport.caveat.forced', { task, by: groupWord(c.by, lang), reason: oneLine(c.reason) })
    case 'outside-sandbox':
      return t(lang, 'runReport.caveat.outside-sandbox', { task, checks: c.checks.map(oneLine).join(SEP[lang]) })
    case 'check-skipped':
    case 'unstable':
      return t(lang, key(`runReport.caveat.${c.kind}`), { task, check: oneLine(c.check) })
    case 'suspicious-files':
      return t(lang, 'runReport.caveat.suspicious-files', { task, count: c.count })
    case 'review-outside-sandbox':
    case 'policy-changed':
      return t(lang, key(`runReport.caveat.${c.kind}`), { task })
  }
}

/** Tokens always say "at least" (R4); empty when the report has no cost to say */
export function costLine(r: RunReport, accounts: ReadonlyMap<string, string>, lang: Lang): string {
  const cost = r.cost
  if (!cost) return ''
  const number = new Intl.NumberFormat(lang)
  const parts: string[] = []
  if (cost.tokens && cost.coordinatorTokens) {
    parts.push(t(lang, 'runReport.cost.tokensCoordinator', { total: number.format(cost.tokens.total), coordinator: number.format(cost.coordinatorTokens.total) }))
  } else if (cost.tokens) {
    parts.push(t(lang, 'runReport.cost.tokens', { total: number.format(cost.tokens.total) }))
  } else if (cost.coordinatorTokens) {
    parts.push(t(lang, 'runReport.cost.coordinatorOnly', { coordinator: number.format(cost.coordinatorTokens.total) }))
  }
  const names = cost.accountIds.map((id) => accounts.get(id)).filter((n): n is string => !!n)
  if (names.length > 0) parts.push(t(lang, 'runReport.cost.accounts', { names: names.map(oneLine).join(SEP[lang]) }))
  return parts.join(' ')
}

// ---- Markdown ----

/** The largest n in [0, max] for which fits(n); 0 when none does (fits is monotonic: fewer rows is shorter) */
function largestFitting(max: number, fits: (n: number) => boolean): number {
  if (fits(max)) return max
  let lo = 0
  let hi = max - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

export function reportMarkdown(
  r: RunReport,
  lang: Lang,
  o: { audience: 'app' | 'pull-request'; accounts?: ReadonlyMap<string, string>; at?: (iso: string) => string }
): string {
  const pr = o.audience === 'pull-request'
  const build = (taskRows: number, caveatRows = r.caveats.length): string => {
    const blocks: string[] = []
    if (pr) blocks.push(RUN_REPORT_MARKER(r.runId))
    blocks.push(`**${outcomeLine(r, lang)}**`)
    // The comment carries its own time on GitHub
    if (!pr) blocks.push(timesLine(r, lang, o.at ?? ((iso) => new Date(iso).toLocaleString(lang))))
    const github = githubLine(r, lang)
    if (github) blocks.push(github)
    blocks.push(t(lang, 'runReport.asOf'))
    blocks.push(
      `### ${t(lang, 'runReport.section.caveats')}\n` +
        (r.caveats.length > 0
          ? [
              ...r.caveats.slice(0, caveatRows).map((c) => `- ${caveatLine(c, lang)}`),
              ...(caveatRows < r.caveats.length ? [`- ${t(lang, 'runReport.caveats.moreInApp', { count: r.caveats.length - caveatRows })}`] : [])
            ].join('\n')
          : t(lang, 'runReport.caveats.none'))
    )
    const rows = r.tasks.slice(0, taskRows).map((task) => `- ${taskLine(task, lang)}`)
    if (taskRows < r.tasks.length) rows.push(`- ${t(lang, 'runReport.tasks.more', { count: r.tasks.length - taskRows })}`)
    blocks.push(`### ${t(lang, 'runReport.section.tasks')}\n${rows.join('\n')}`)
    blocks.push(`### ${t(lang, 'runReport.section.workers')}\n${interruptionsLine(r, lang)}`)
    blocks.push(`### ${t(lang, 'runReport.section.people')}\n${interventionsLine(r, lang)}`)
    const cost = pr ? '' : costLine(r, o.accounts ?? new Map(), lang)
    if (cost) blocks.push(`### ${t(lang, 'runReport.section.cost')}\n${cost}`)
    return blocks.join('\n\n')
  }
  // Over the comment's cap the Task rows are cut first (R7). Only when the caveats alone pass it are caveats cut from the
  // end: a comment over the hard limit cannot be posted at all
  if (!pr) return build(r.tasks.length)
  const rows = largestFitting(r.tasks.length, (n) => build(n).length <= PR_COMMENT_MAX)
  if (build(rows).length <= PR_COMMENT_MAX) return build(rows)
  return build(0, largestFitting(r.caveats.length, (n) => build(0, n).length <= PR_COMMENT_MAX))
}

// ---- Slack ----

/** Slack's mrkdwn reads these three as control characters: a title with <!channel> must not ping */
const slackEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function reportSlack(r: RunReport, lang: Lang, o: { accounts?: ReadonlyMap<string, string> }): string {
  const build = (taskRows: number, caveatRows: number): string => {
    const lines: string[] = [`*${slackEscape(outcomeLine(r, lang))}*`]
    const github = githubLine(r, lang)
    if (github) lines.push(slackEscape(github))
    if (r.caveats.length === 0) lines.push(slackEscape(t(lang, 'runReport.caveats.none')))
    for (const c of r.caveats.slice(0, caveatRows)) lines.push(`• ${slackEscape(caveatLine(c, lang))}`)
    if (caveatRows < r.caveats.length) lines.push(`• ${slackEscape(t(lang, 'runReport.caveats.more', { count: r.caveats.length - caveatRows }))}`)
    lines.push(`*${slackEscape(t(lang, 'runReport.section.tasks'))}*`)
    for (const task of r.tasks.slice(0, taskRows)) lines.push(`• ${slackEscape(taskLine(task, lang))}`)
    if (taskRows < r.tasks.length) lines.push(`• ${slackEscape(t(lang, 'runReport.tasks.more', { count: r.tasks.length - taskRows }))}`)
    lines.push(slackEscape(interruptionsLine(r, lang)))
    const people = interventionsLine(r, lang)
    if (people) lines.push(slackEscape(people))
    const cost = costLine(r, o.accounts ?? new Map(), lang)
    if (cost) lines.push(slackEscape(cost))
    return lines.join('\n')
  }
  // Task rows are cut first; only when none is left do the caveats beyond ten go (R7)
  const rows = largestFitting(r.tasks.length, (n) => build(n, r.caveats.length).length <= SLACK_POST_MAX)
  if (build(rows, r.caveats.length).length <= SLACK_POST_MAX) return build(rows, r.caveats.length)
  // Still over: caveats beyond ten go, then more from the end until the post fits, the "and N more" line counted
  const kept = largestFitting(Math.min(SLACK_CAVEATS_KEPT, r.caveats.length), (n) => build(0, n).length <= SLACK_POST_MAX)
  return build(0, kept)
}
