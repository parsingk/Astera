// 사람이 읽는 출력 (공개 CLI 설계 §6).
//
// **순수하다.** 받는 것은 봉투 안의 `data` 이고 돌려주는 것은 글자뿐이다 — 프로세스도 TTY 도
// 모른다. 무엇을 보여 줄지 정하는 것과 언제 보여 줄지 정하는 것은 다른 일이고, 뒤쪽은 run.ts 가 한다.
//
// **스크립트는 이것을 읽으면 안 된다**(명세 §23). 그래서 이 모양에는 계약이 없다 — 칸이 늘고
// 너비가 바뀌는 것이 정상이다. 기계가 읽을 것은 `--json` 의 봉투다.

import { jobNameOf } from './jobName'
import { diagnosticLine, findingsCountOf, oneLine } from './pluginChecks'
import type { CheckResult, JobSourceRef } from './types'
import type { AuditAction, CoverageNote } from '../audit/types'
import { ACTION_PHRASES, COVERAGE_NOTE_PHRASES } from '../audit/phrases'
import { t } from '../i18n'

/** 상태 한 낱말. **파생값과 플래그를 한 낱말로 접는다** — 사람이 목록에서 훑는 것이 이것이고,
 *  훑으려면 한 칸에 있어야 한다.
 *
 *  순서가 뜻이다. 멈춘 것이 먼저다(사람이 세워 둔 것은 그 사실이 다른 무엇보다 앞선다), 그다음이
 *  예약(계획 자신은 돌지 않는다), 그다음이 사람을 기다리는 상태, 마지막이 Task 에서 나온 결과. */
export function stateWord(o: {
  outcome?: string
  questionsOpen?: number
  paused?: boolean
  pendingStart?: boolean
  schedule?: unknown
}): string {
  if (o.pendingStart === true) return 'PENDING'
  // A Job whose latest Run is paused says so in its outcome (command.ts jobView); the Job's own
  // `paused` is a schedule's hold.
  if (o.paused === true || o.outcome === 'paused') return 'PAUSED'
  if (o.schedule !== undefined && o.schedule !== null) return 'SCHEDULED'
  if ((o.questionsOpen ?? 0) > 0) return 'WAITING'
  if (o.outcome === 'completed') return 'COMPLETE'
  if (o.outcome === 'failed') return 'FAILED'
  if (o.outcome === 'running') return 'RUNNING'
  // A Job with no Run (command.ts jobView)
  if (o.outcome === 'pending') return 'PENDING'
  return '-'
}

/** 마지막 칸. 사람을 기다리는 중이면 그 수가 진행률보다 급한 소식이다(설계 §6 의 예시). */
function progressWord(o: { questionsOpen?: number; progress?: { done: number; total: number } }): string {
  const open = o.questionsOpen ?? 0
  if (open > 0) return open === 1 ? '1 question' : `${open} questions`
  const p = o.progress
  return p ? `${p.done}/${p.total}` : ''
}

/**
 * 칸을 맞춘 표. 테두리는 없다 — 터미널에서 잘라 붙이는 것이 사람이 이 출력으로 하는 일이고,
 * 테두리는 그때 방해만 된다.
 *
 * **마지막 칸은 채우지 않는다.** 채우면 눈에 보이지 않는 공백이 줄 끝에 남아, 복사한 값이
 * 조용히 달라진다.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd]
]

/**
 * 터미널이 그 글자를 몇 칸으로 그리는가.
 *
 * **`length` 를 쓰면 한글 목록의 칸이 어긋난다.** 자바스크립트의 길이는 UTF-16 단위의 수고,
 * 한글·한자·가나는 한 글자가 두 칸이다 — 이 저장소의 Job 이름이 대개 한글이므로, 칸을
 * 맞추려는 모드가 바로 그 자리에서 틀어진다.
 *
 * 표는 East Asian Width 의 W·F 대역이다. 전시를 옮기지 않고 이 앱이 실제로 보여 주는 글자
 * — 한글, 한자, 가나, 전각 기호, 이모지 — 를 덮는다. 빠진 글자는 한 칸으로 세어 그 줄만 좀
 * 좁게 보일 뿐이다.
 */
export function displayWidth(text: string): number {
  let w = 0
  // 코드포인트로 돌진다 — 이모지는 UTF-16 두 칸을 차지하면서 한 글자다.
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0
    w += WIDE.some(([a, b]) => c >= a && c <= b) ? 2 : 1
  }
  return w
}

const padTo = (cell: string, to: number): string =>
  cell + ' '.repeat(Math.max(0, to - displayWidth(cell)))

export function columns(rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return ''
  const width: number[] = []
  for (const row of rows)
    row.forEach((cell, i) => {
      if (i < row.length - 1) width[i] = Math.max(width[i] ?? 0, displayWidth(cell))
    })
  return rows
    .map((row) =>
      row
        .map((cell, i) => (i < row.length - 1 ? padTo(cell, width[i] ?? 0) : cell))
        .join('  ')
        .trimEnd()
    )
    .join('\n')
}

const str = (v: unknown): string => (v === undefined || v === null ? '' : String(v))

/** 한 개체를 이름과 값의 줄로. **목록을 따로 두지 않는다** — 무엇을 내보낼지는 가림막이 이미
 *  정했고(packages/client/src/shape.ts 의 publicFor), 여기서 또 고르면 두 곳이 갈라진다. */
function fields(o: Record<string, unknown>): string {
  return columns(
    Object.entries(o).map(([k, v]) => [
      k,
      // 진행은 사람이 가장 자주 읽는 값이다 — 목록과 같은 모양으로 낸다.
      k === 'progress' && v !== null && typeof v === 'object'
        ? `${str((v as { done?: unknown }).done)}/${str((v as { total?: unknown }).total)}`
        : v !== null && typeof v === 'object'
          ? JSON.stringify(v)
          : str(v)
    ])
  )
}

const indent = (text: string): string =>
  text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')

const asList = (data: Record<string, unknown>, key: string): Record<string, unknown>[] => {
  const v = data[key]
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : []
}

/**
 * 그 명령의 사람용 출력. **모르는 명령은 null 이다** — 부르는 쪽이 JSON 으로 되돌린다. 공개
 * 표면이 아닌 명령(코디네이터의 것들)에 억지로 표를 씌우면 가이드가 시키는 것을 못 읽게 된다.
 */
/** Text for a terminal (security audit SEC-9): C0 controls but line feed and tab, DEL and C1 controls dropped, so a
 *  Runtime's Job title or turn cannot carry an escape sequence to the person's screen or clipboard. */
export function terminalSafe(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/** JSON text with DEL and the C1 controls escaped too (final review M-6): JSON.stringify leaves them as they are, and a
 *  terminal reads U+009B as the start of an escape sequence. The text parses to the same value. */
export function jsonSafe(json: string): string {
  return json.replace(/[\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
}

/** How many of a failed plugin check's findings `runs checks --human` shows under its row; JSON has them all. */
export const HUMAN_DIAGNOSTICS = 5

/** The lines a Task's plugin checks add under its `runs checks` row (plugin Phase 5 C13). Before the failure summary,
 *  in the round's order: one a person skipped, and one that could not run while its question waits (once the Task
 *  failed on it, the failure summary says so). After it: the failed one's first findings and its link, its summary being
 *  the failure summary's, so the findings sit under their own check. A round being run again shows none of the last
 *  one's. A command check has no summary and adds nothing: its failure summary says it all. */
function pluginCheckLines(validation: unknown): { before: string[]; after: string[] } {
  const v = validation !== null && typeof validation === 'object' ? (validation as { status?: unknown; checks?: unknown }) : {}
  if (!Array.isArray(v.checks) || v.status === 'running') return { before: [], after: [] }
  const plugins = (v.checks as CheckResult[]).filter((c) => typeof c.summary === 'string')
  const before = plugins.flatMap((c): string[] =>
    c.skipped === true
      ? [`  ${str(c.name)}: ${oneLine(c.summary!)}`]
      : c.status === 'error' && v.status !== 'failed'
        ? [`  ${str(c.name)} could not run: ${oneLine(c.summary!)}`]
        : []
  )
  const after = plugins
    .filter((c) => c.status === 'failed')
    .flatMap((c): string[] => {
      const found = Array.isArray(c.diagnostics) ? c.diagnostics : []
      const shown = found.slice(0, HUMAN_DIAGNOSTICS)
      // The Host keeps 20 findings and counts the rest (5d): "more" is every finding not on screen
      const more = findingsCountOf(c) - shown.length
      return [
        ...shown.map((d) => `    ${oneLine(diagnosticLine(d))}`),
        ...(more > 0 ? [`    … and ${more} more`] : []),
        ...(typeof c.externalUrl === 'string' ? [`    Details: ${c.externalUrl}`] : [])
      ]
    })
  return { before, after }
}

/** What each action is called on a person's screen (observe mode design §11): a plain phrase, never `git.remote.write`,
 *  in the English of the table Settings › Security & Access says in the person's language (audit/phrases.ts). One this
 *  build does not know (a newer Host's) as it was named. */
const phraseOf = (action: unknown): string =>
  Object.hasOwn(ACTION_PHRASES, str(action)) ? t('en', ACTION_PHRASES[str(action) as AuditAction]) : str(action)

const two = (n: number): string => String(n).padStart(2, '0')

/** An ISO time as the person's clock shows it, to the second: the records span days, so the date is kept. */
function localTime(iso: unknown): string {
  const d = new Date(str(iso))
  if (!Number.isFinite(d.getTime())) return str(iso)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** Terse column heads, not the screen's labels (en.ts `settings.security.coverage.class.*`): the CLI prints words a script reads. */
const COVERAGE_CLASSES = [
  ['shell', 'shell'],
  ['file-read', 'file read'],
  ['file-write', 'file write'],
  ['mcp', 'MCP'],
  ['network', 'network']
] as const

/** What observe can see, a row per provider and kind of session, with why a class is only partly seen. */
function coverageText(rows: Record<string, unknown>[]): string {
  return columns([
    ['', ...COVERAGE_CLASSES.map(([, name]) => name)],
    ...rows.map((row) => {
      const classes = (row.classes ?? {}) as Record<string, { level?: unknown; note?: unknown } | undefined>
      return [
        `${str(row.provider)} ${str(row.kind)}`,
        ...COVERAGE_CLASSES.map(([key]) => {
          const c = Object.hasOwn(classes, key) ? classes[key] : undefined
          const note =
            typeof c?.note === 'string' ? (Object.hasOwn(COVERAGE_NOTE_PHRASES, c.note) ? t('en', COVERAGE_NOTE_PHRASES[c.note as CoverageNote]) : c.note) : undefined
          return note === undefined ? str(c?.level) : `${str(c?.level)} (${note})`
        })
      ]
    })
  ])
}

/** The observe switch and the rules, a row each in the order they are tried, its place first (what `--at` and `--to`
 *  take); with `coverage`, as `policies show` answers, what observe can see under them, or in enforce what enforce
 *  blocks (`enforceCoverage`). */
function policyText(data: Record<string, unknown>): string {
  const p = (data.policy ?? {}) as { rules?: unknown; otherwise?: unknown }
  const rules = Array.isArray(p.rules) ? (p.rules as Record<string, unknown>[]) : []
  const parts = [
    columns([
      ['mode', str(data.mode)],
      ['otherwise', str(p.otherwise)]
    ]),
    rules.length === 0
      ? '(no rules)'
      : columns(rules.map((r, i) => [String(i), str(r.effect), str(r.action), r.scope === undefined ? 'anywhere' : str(r.scope), str(r.id)]))
  ]
  const coverage = data.mode === 'enforce' && Array.isArray(data.enforceCoverage) ? data.enforceCoverage : data.coverage
  if (Array.isArray(coverage)) parts.push(coverageText(coverage as Record<string, unknown>[]))
  return parts.join('\n\n')
}

/** `audit list`'s flags that the next page asks again, as the parser keys them and as they are typed: all but the cursor
 *  (`--until`, `--before-id`), which the answer's `next` gives. */
const AUDIT_LIST_REPEATED: ReadonlyArray<readonly [string, string]> = [
  ['session', 'session'],
  ['job', 'job'],
  ['run', 'run'],
  ['task', 'task'],
  ['agentProfile', 'agent-profile'],
  ['action', 'action'],
  ['decision', 'decision'],
  ['since', 'since'],
  ['limit', 'limit']
]

export type ShellFamily = 'powershell' | 'posix'

/** The shell a pasted line is read by: PowerShell on Windows, unless the environment names a POSIX one (Git Bash sets
 *  MSYSTEM; a `SHELL` ending in sh, as bash, zsh or dash). Elsewhere always a POSIX shell. */
export const shellOf = (platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env): ShellFamily => {
  if (platform !== 'win32') return 'posix'
  if ((env.MSYSTEM ?? '') !== '') return 'posix'
  return /(^|[\\/])(ba|z|da|k|fi|a)?sh(\.exe)?$/i.test(env.SHELL ?? '') ? 'posix' : 'powershell'
}

/** A flag's value as the shell it is pasted into reads it back: bare when it is plain, else in single quotes, which no
 *  shell expands (`$HOME` stays text). A quote inside is doubled in PowerShell (which counts the curly single quotes as
 *  quotes too), and closed, escaped and reopened in a POSIX shell. A comma or a percent sign is not plain: PowerShell reads
 *  the one as an array, cmd the other as a variable; a leading `@` is splatting there. */
export const flagValue = (v: unknown, shell: ShellFamily = shellOf()): string => {
  const s = String(v)
  if (/^[A-Za-z0-9._:/=+][A-Za-z0-9._:/@=+-]*$/.test(s)) return s
  return shell === 'powershell' ? `'${s.replace(/['‘’‚‛]/g, '$&$&')}'` : `'${s.replaceAll("'", "'\\''")}'`
}

/** A value the parser (cliArgs.ts) cannot take as a flag's value whatever the quoting: `-` is stdin, `--…` the next flag. */
const unpassable = (s: string): boolean => s === '-' || s.startsWith('--')

/** `args`: the flags the command was typed with, as the parser keys them, for an answer that names how to ask again;
 *  `shell`, the family a hint is quoted for (this machine's). The CLI's words differ from the screen's (strings in
 *  en.ts) for decisions, coverage classes and levels: they are the flag words and terse column heads a script reads back. */
export function humanFor(
  cmd: string,
  data: Record<string, unknown>,
  args: Record<string, unknown> = {},
  shell: ShellFamily = shellOf()
): string | null {
  switch (cmd) {
    // Observe mode design §12: a row per call, its time on the person's clock and its action as a phrase. Under the table,
    // the flags that ask for the next page: the filters that were used, then where it starts.
    case 'audit-list': {
      const records = asList(data, 'records')
      const table =
        records.length === 0
          ? '(no records)'
          : columns(
              records.map((r) => [localTime(r.at), str(r.sessionId), phraseOf(r.action), str(r.target), str(r.decision), typeof r.ruleId === 'string' ? r.ruleId : '-'])
            )
      const next = data.next !== null && typeof data.next === 'object' ? (data.next as { until?: unknown; beforeId?: unknown }) : null
      if (next === null) return table
      const used = AUDIT_LIST_REPEATED.filter(([key]) => typeof args[key] === 'string' || typeof args[key] === 'number')
      const left = used.filter(([key]) => unpassable(String(args[key])))
      const again = used.filter((u) => !left.includes(u)).map(([key, flag]) => `--${flag} ${flagValue(args[key], shell)}`)
      const note = left.length === 0 ? [] : [`(${left.map(([, flag]) => `--${flag}`).join(', ')} is not repeated below: its value cannot be given on the command line)`, '']
      return [table, '', ...note, ['more:', ...again, `--until ${str(next.until)} --before-id ${str(next.beforeId)}`].join(' ')].join('\n')
    }
    // The totals, then a row per action, the most seen first
    case 'audit-summary': {
      // The calls Enforce stopped, once there are any: an observe-only summary reads as it did
      const blocked = typeof data.blocked === 'number' && data.blocked > 0
      const counts = (c: Record<string, unknown>): string[] => [
        `allow ${str(c.allow)}`,
        `would-deny ${str(c.wouldDeny)}`,
        `unknown ${str(c.unknown)}`,
        ...(blocked ? [`blocked ${str(c.blocked ?? 0)}`] : [])
      ]
      const total = (c: Record<string, unknown>): number => Number(c.allow ?? 0) + Number(c.wouldDeny ?? 0) + Number(c.unknown ?? 0) + Number(c.blocked ?? 0)
      const byAction = data.byAction !== null && typeof data.byAction === 'object' ? Object.entries(data.byAction as Record<string, Record<string, unknown>>) : []
      byAction.sort(([a, x], [b, y]) => total(y) - total(x) || a.localeCompare(b))
      return [
        counts(data).join(', '),
        ...(byAction.length === 0 ? [] : ['', columns(byAction.map(([action, c]) => [phraseOf(action), action, ...counts(c)]))]),
        ...(data.stoppedAtLimit === true ? ['', '(a day of this period stopped recording at the size limit, so it holds fewer calls than were made)'] : [])
      ].join('\n')
    }
    // Credentials design §7: a row per entry (its name, kind, what it hides, where), never a value
    case 'credentials-list': {
      const entries = asList(data, 'entries')
      if (entries.length === 0) return '(nothing listed)'
      return columns(entries.map(credentialRow))
    }
    case 'credentials-show': {
      const e = data.entry !== null && typeof data.entry === 'object' ? (data.entry as Record<string, unknown>) : null
      if (e === null) return null
      const uses = asList(data, 'uses')
      return [columns([credentialRow(e)]), ...(uses.length === 0 ? [] : ['', columns(uses.map((u) => [localTime(u.at), str(u.sessionId ?? u.actor), str(u.resource), str(u.outcome)]))])].join('\n')
    }
    case 'credentials-doctor':
      return asList(data, 'lines')
        .map((l) => `${str(l.level).padEnd(6)}${str(l.text)}`)
        .join('\n')
    case 'policies-show':
    case 'policies-set-mode':
    case 'policies-set-otherwise':
    case 'policies-rules-add':
    case 'policies-rules-edit':
    case 'policies-rules-remove':
    case 'policies-rules-move':
    case 'policies-rules-reset':
      return policyText(data)
    case 'plugins-logs': {
      const lines = Array.isArray(data.lines) ? (data.lines as unknown[]).map(str) : []
      return lines.length > 0 ? lines.join('\n') : 'no log yet'
    }
    case 'plugins-settings':
    case 'plugins-configure': {
      const fields = Array.isArray(data.fields) ? (data.fields as Record<string, unknown>[]) : []
      if (fields.length === 0) return 'no settings'
      const values = (data.values ?? {}) as Record<string, unknown>
      const secrets = (data.secrets ?? {}) as Record<string, unknown>
      // A secret one says only whether it is set (spec §23): the Host never answers its value.
      const shown = (f: Record<string, unknown>): string =>
        f.secret === true
          ? secrets[str(f.key)] === 'set'
            ? '(secret, set)'
            : '(secret, not set)'
          : Object.hasOwn(values, str(f.key))
            ? str(values[str(f.key)])
            : '(not set)'
      const rows = columns(fields.map((f) => (f.required === true ? [str(f.key), shown(f), 'required'] : [str(f.key), shown(f)])))
      if (data.restarted === true) return `${rows}\n(restarted)`
      // configure says how the plugin stands after the change (2c final review M6): held back, or failed and waiting
      // for `plugins enable`.
      if (cmd !== 'plugins-configure' || typeof data.status !== 'string') return rows
      const reason = typeof data.reason === 'string' ? `: ${data.reason}` : ''
      const next = data.status === 'failed' ? `; start it again with astera plugins enable --id ${str(data.id)}` : ''
      return `${rows}\n(${data.status}${reason}${next})`
    }
    case 'plugins-doctor':
      return columns(
        (Array.isArray(data.checks) ? (data.checks as Record<string, unknown>[]) : []).map((c) => [c.ok !== true ? 'FAIL' : c.warn === true ? 'warn' : 'ok', str(c.name), str(c.detail)])
      )
    // Agent Profiles design §6: its state first, as plugins list puts it, then what a person picks it by. The sandbox
    // switch (sandbox design §6) as `on`/`off`; a Host from before it sends none, which is off
    case 'agent-profiles-list':
      return columns(
        asList(data, 'profiles').map((p) => {
          const accounts = Array.isArray(p.accountIds) ? (p.accountIds as unknown[]).map(str) : []
          return [
            str(p.status).toUpperCase(),
            str(p.id),
            str(p.name),
            str(p.permission),
            p.sandbox === true ? 'on' : 'off',
            accounts.length > 0 ? accounts.join(',') : '-'
          ]
        })
      )
    case 'plugins-list':
      return columns(
        asList(data, 'plugins').map((p) => {
          const granted = Array.isArray(p.permissions) ? (p.permissions as unknown[]).map(str) : []
          // What it offers, so a person finds the plugin:<id> a Task's checks can name (plugin Phase 5 C6)
          const offers = Array.isArray(p.capabilities) ? (p.capabilities as unknown[]).map(str) : []
          const row = [
            str(p.status).toUpperCase(),
            str(p.id),
            str(p.version),
            granted.length > 0 ? granted.join(',') : '-',
            offers.length > 0 ? offers.join(',') : '-'
          ]
          // Why it does not run, as docs/cli.md promises the list says.
          return typeof p.reason === 'string' ? [...row, p.reason] : row
        })
      )
    // Plugin Phase 4 J21. Four cells on every row, the reason empty when there is none, so the names line up.
    case 'sources-list':
      return columns(
        asList(data, 'sources').map((s) => [s.ready === true ? 'READY' : 'NOT READY', str(s.id), str(s.displayName), str(s.reason)])
      )
    // An item's Jobs, else why it cannot be picked. Under the table, a cut the Host made and the next page's cursor.
    case 'sources-items': {
      const items = asList(data, 'items')
      const table =
        items.length === 0
          ? '(no items)'
          : columns(
              items.map((i) => {
                const jobs = Array.isArray(i.jobs) ? (i.jobs as unknown[]).map(str) : []
                return [str(i.id), str(i.status), str(i.title), jobs.length > 0 ? jobs.join(',') : i.selectable === false ? `cannot be picked: ${str(i.reason)}` : '']
              })
            )
      return [
        table,
        ...(data.cut === true ? ["(cut to Astera's limits)"] : []),
        ...(typeof data.nextCursor === 'string' ? ['', `more: --cursor ${data.nextCursor}`] : [])
      ].join('\n')
    }
    // The item's own fields, then the source's fields, then its body as the text it is: a table cell would cut it.
    case 'sources-show': {
      const { body, fields: theirs, ...own } = data
      const parts = [fields(own)]
      if (theirs !== null && typeof theirs === 'object' && Object.keys(theirs).length > 0)
        parts.push(`fields\n${indent(columns(Object.entries(theirs as Record<string, unknown>).map(([k, v]) => [k, str(v)])))}`)
      if (typeof body === 'string' && body !== '') parts.push(body)
      return parts.join('\n\n')
    }
    case 'projects-list':
      return columns(asList(data, 'projects').map((p) => [str(p.id), str(p.name), str(p.path)]))
    case 'jobs-list':
      return columns(
        asList(data, 'jobs').map((j) => [
          stateWord(j),
          str(j.id),
          // A Job made from a ticket by the ticket's title (plugin 4d), not by the objective Astera wrote for it
          jobNameOf({ objective: str(j.objective), source: j.source as JobSourceRef | undefined }),
          progressWord(j)
        ])
      )
    case 'runs-list':
      return columns(
        asList(data, 'runs').map((r) => [
          stateWord(r),
          str(r.id),
          str(r.jobId),
          `#${str(r.ordinal)}`,
          progressWord(r)
        ])
      )
    case 'tasks-list':
      return columns(
        asList(data, 'tasks').map((t) => [
          String(t.status ?? '-').toUpperCase(),
          str(t.id),
          str(t.title)
        ])
      )
    // One row per Task, and under a row that failed, what failed: that line is what a person reads
    // this command for, and a table cell would cut it.
    case 'runs-checks': {
      const tasks = asList(data, 'tasks')
      if (tasks.length === 0) return `(no tasks in ${str(data.runId)})`
      const standing = (v: unknown): string =>
        v !== null && typeof v === 'object' ? str((v as { status?: unknown }).status) : ''
      const table = columns(
        tasks.map((t) => [
          String(t.status ?? '-').toUpperCase(),
          str(t.id),
          `validation ${standing(t.validation)}`,
          `review ${standing(t.review)}`,
          str(t.title)
        ])
      ).split('\n')
      return tasks
        .flatMap((t, i) => {
          const plugin = pluginCheckLines(t.validation)
          return [table[i], ...plugin.before, ...(typeof t.failureSummary === 'string' ? [`  ${t.failureSummary}`] : []), ...plugin.after]
        })
        .join('\n')
    }
    case 'questions-list':
      return columns(
        asList(data, 'questions').map((q) => [
          String(q.status ?? '-').toUpperCase(),
          str(q.id),
          str(q.taskId),
          str(q.question)
        ])
      )
    case 'accounts-list':
      return columns(
        asList(data, 'accounts').map((a) => [str(a.id), str(a.provider), str(a.label)])
      )
    case 'run-configs-list':
      return columns(
        asList(data, 'runConfigs').map((c) => [str(c.id), str(c.type), str(c.name)])
      )
    case 'sessions-list':
      return columns(
        asList(data, 'sessions').map((x) => [
          x.alive === true ? 'ALIVE' : 'ENDED',
          str(x.state),
          str(x.id),
          str(x.kind),
          str(x.title)
        ])
      )
    // 프롬프트 하나에 한 줄. 앱에 묻지 못했으면 목록이 짧을 수 있다고 표 아래에 적는다 — 빈 목록이
    // "열린 것이 없다" 로 읽히면 안 된다.
    case 'chats-pending': {
      const rows = asList(data, 'prompts').map((x) => [str(x.sessionId), str(x.id), str(x.kind), str(x.tool), str(x.summary)])
      const short = data.complete === false ? ['Astera could not be asked, so this list may be short'] : []
      if (rows.length === 0) return short.length > 0 ? short[0] : '(no open prompts)'
      return [columns(rows), ...short].join('\n')
    }
    // 읽으라고 부른 화면이다 — 표로 싸면 사람이 읽으려던 것을 가린다.
    // 위의 줄들이 먼저, 그 아래 화면 — 터미널에서 보던 순서다.
    // 대화 세션은 화면이 아니라 턴이다 — 누가 말했는지 줄을 세우고, 글은 들여 쓰고, 도구는 한 줄씩.
    // 열린 카드는 맨 끝이다: 사람이 그 세션에서 가장 먼저 알아야 할 것이 거기 있다.
    case 'sessions-read': {
      if (data.kind !== 'chat') return [...asList(data, 'scrollback'), ...asList(data, 'screen')].map(str).join('\n')
      const turns = asList(data, 'turns').map((t) =>
        [
          `${str(t.role)}:`,
          ...(str(t.text) === '' ? [] : [str(t.text).split('\n').map((l) => (l === '' ? '' : `  ${l}`)).join('\n')]),
          ...(Array.isArray(t.tools) ? (t.tools as unknown[]).map((x) => `  [tool] ${str(x)}`) : [])
        ].join('\n')
      )
      const p = data.pending !== null && typeof data.pending === 'object' ? (data.pending as Record<string, unknown>) : null
      const tail = p === null ? [] : [`waiting on ${p.kind === 'approval' ? 'an approval' : 'a question'}: ${str(p.summary)}`]
      const body = [...turns, ...tail]
      return body.length === 0 ? '(no turns yet)' : body.join('\n\n')
    }
    // 계정×스킬 한 줄씩. install 은 설정이 꺼져 심지 않은 것과 그것을 켜는 설정, 그리고 이미 열린
    // 세션은 새 스킬을 못 본다는 한 줄을 표 아래에 붙인다(cli/skills.ts).
    case 'skills-list':
    case 'skills-install': {
      const rows = asList(data, 'accounts').flatMap((a) =>
        asList(a, 'skills').map((s) =>
          cmd === 'skills-list'
            ? [str(a.id), str(a.provider), str(s.name), s.enabled === true ? 'on' : 'off', str(s.installed)]
            : [str(a.id), str(a.provider), str(s.name), str(s.result)]
        )
      )
      const off = asList(data, 'notEnabled')
      return [
        rows.length === 0 ? 'no accounts' : columns(rows),
        ...(off.length === 0
          ? []
          : ['', 'not enabled:', ...columns(off.map((n) => [str(n.name), str(n.setting)])).split('\n').map((l) => `  ${l}`)]),
        ...(typeof data.note === 'string' ? ['', data.note] : [])
      ].join('\n')
    }
    // 접어 실은 회차를 한 줄 JSON 으로 내면 읽으라고 만든 모드가 읽힐 수 없게 된다.
    case 'jobs-get': {
      const { run, ...job } = data
      const head = fields(job)
      return run !== null && typeof run === 'object'
        ? `${head}\n\nrun\n${indent(fields(run as Record<string, unknown>))}`
        : head
    }
    /**
     * **시한이 지난 `ask` 만 사람의 문장이 된다.**
     *
     * 답이 온 `ask` 는 `null` 로 떨어져 예전처럼 봉투로 나간다 — 그 답을 읽는 것은 워커이고,
     * 워커가 읽는 것은 JSON 이다. 시한이 지난 쪽만 다른 이유는 그 답이 **실패처럼 보이기**
     * 때문이다: 아무 일도 일어나지 않은 채 돌아온 명령을 사람도 에이전트도 "안 됐다" 로 읽고
     * 다시 묻는다. 기계가 읽을 줄은 `data.nextSteps` 가 싣고(cliOutput 의 askTimeoutBody),
     * 여기서는 같은 줄에 왜인지를 한 문장 붙인다 — 두 모드가 다른 말을 하지 않도록 문장도
     * 그 칸에서 만든다.
     */
    case 'ask': {
      if (data.timedOut !== true) return null
      const steps = Array.isArray(data.nextSteps)
        ? (data.nextSteps as unknown[]).filter((s): s is string => typeof s === 'string')
        : []
      const head = 'the deadline passed and the question is still open'
      if (steps.length === 0) {
        // `but` 로 잇는다 — 그 칸의 문장은 소문자로 시작하는 절이고(cliOutput 의 두 상수), 마침표
        // 뒤에 그대로 붙이면 문장이 소문자로 시작한다.
        const why =
          typeof data.cannotResume === 'string' ? data.cannotResume : 'it cannot be resumed safely'
        return `${head}, but ${why}`
      }
      return [`${head}. Do not ask again; keep waiting:`, ...steps.map((s) => `  ${s}`)].join('\n')
    }
    // The last line of a follow that ended well, under the event lines. The other endings are errors
    // and go out as one (run.ts), the same as `runs wait`'s.
    case 'runs-follow': {
      const p = data.progress !== null && typeof data.progress === 'object' ? (data.progress as { done?: unknown; total?: unknown }) : {}
      return `run ${str(data.runId)} ${str(data.state)}, ${str(p.done)}/${str(p.total)} tasks done`
    }
    // 잘 끝난 때만 여기까지 온다 — 나머지 끝은 종료 코드와 한 줄로 나간다(run.ts).
    case 'jobs-wait':
    case 'runs-wait':
    case 'projects-get':
    case 'plugins-get':
    case 'agent-profiles-show':
    case 'agent-profiles-create':
    case 'agent-profiles-update':
    case 'agent-profiles-archive':
    case 'agent-profiles-restore':
    case 'agent-profiles-delete':
    case 'plugins-install':
    case 'plugins-enable':
    case 'plugins-disable':
    case 'plugins-remove':
    case 'projects-find':
    case 'runs-get':
    case 'questions-get':
    case 'jobs-create':
    case 'jobs-create-from-source':
    case 'tasks-add':
    case 'sessions-send':
    case 'chats-answer':
    case 'status':
    case 'version':
    case 'host-status':
    case 'host-start':
    case 'host-stop':
    case 'mcp-status':
      return fields(data)
    default:
      return null
  }
}

/** `--quiet` — id 만, 한 줄에 하나. `for j in $(astera jobs list --quiet)` 가 jq 없이 돌게 한다.
 *
 *  **id 가 없으면 아무것도 내지 않는다.** status 나 version 처럼 id 가 없는 답이 있고, 그때
 *  없는 것을 지어내는 것보다 빈 줄이 정직하다. */
export function quietFor(data: Record<string, unknown>): string {
  const ids: string[] = []
  const take = (v: unknown): void => {
    if (v === null || typeof v !== 'object') return
    const id = (v as { id?: unknown }).id
    if (typeof id === 'string') ids.push(id)
  }
  for (const v of Object.values(data)) {
    if (Array.isArray(v)) v.forEach(take)
  }
  if (ids.length === 0) take(data)
  return ids.join('\n')
}

/** One Credentials list entry as a row: its name, its kind, what it hides, and whether and where. */
function credentialRow(e: Record<string, unknown>): string[] {
  const names = Array.isArray(e.envNames) ? (e.envNames as unknown[]).map(String) : []
  const presets = Array.isArray(e.presets) ? (e.presets as unknown[]).map((p) => `preset ${String(p)}`) : []
  const hide = e.hide !== null && typeof e.hide === 'object' ? (e.hide as { on?: unknown; projects?: unknown }) : {}
  const where = Array.isArray(hide.projects) ? `hidden in ${(hide.projects as unknown[]).map(String).join(', ')}` : 'hidden in every agent session'
  return [
    str(e.kind === 'mcp-secret' ? e.serverName : e.alias),
    e.kind === 'mcp-secret' ? 'MCP server' : 'registered',
    [...names, ...presets].join(', ') || '-',
    hide.on === true ? where : 'not hidden'
  ]
}
