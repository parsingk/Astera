import { afterEach, describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { t as translate, CATALOGS, LANGS, type MessageKey, type MessageParams } from '../../../core/i18n'
import type { AuditRule, CoverageRow } from '../../../core/audit/types'
import {
  AUDIT_ACTIONS,
  AUDIT_LOGS_TITLE,
  COVERAGE_CLASSES,
  DECISIONS,
  OBSERVE_NAME,
  POLICIES_TITLE,
  RULES_TITLE,
  RULE_ACTION_CHOICES,
  SECURITY_KEYS,
  SECURITY_TAB,
  actionPhrase,
  appendPage,
  auditQuery,
  auditStateLine,
  coverageCellText,
  coverageClassLabel,
  coverageLine,
  coverageRowLabel,
  decidingRule,
  decisionLabel,
  filterChoices,
  nextPageQuery,
  observeReadDue,
  OBSERVE_READ_EVERY_MS,
  observeTargetOf,
  pageOf,
  periodSince,
  afterObserveRead,
  startObserveRead,
  OBSERVE_RETRIES,
  jobFilterView,
  modeLabel,
  chooseJob,
  auditScrollDue,
  runDetailInstanceKey,
  FOCUS_VALUE,
  focusedFilters,
  recordTime,
  retentionSince,
  rowTime,
  ruleActionChoices,
  sessionLabel,
  observeReadIsCurrent,
  resetBodyKey,
  securityFailure,
  summaryOf,
  summarySince,
  tokensOf,
  wouldDenyLine,
  type AuditRow
} from './securityText'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = (rel: string): string => readFileSync(path.join(here, rel), 'utf8')
const en = (key: MessageKey, params?: MessageParams): string => translate('en', key, params)
const ko = (key: MessageKey, params?: MessageParams): string => translate('ko', key, params)

const row = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: 'au_1',
  at: '2026-10-23T03:00:01.000Z',
  sessionId: 'sess_a',
  provider: 'claude',
  kind: 'terminal',
  accountId: 'acc_1',
  source: 'claude-hook',
  providerTool: 'Bash',
  action: 'git.remote.write',
  target: 'git push',
  confidence: 'high',
  status: 'ok',
  decision: 'would-deny',
  ruleId: 'starter-git-remote-write',
  ...over
})

const RULES: AuditRule[] = [
  { id: 'starter-git-remote-write', effect: 'deny', action: 'git.remote.write' },
  { id: 'starter-write-outside', effect: 'deny', action: 'filesystem.write', scope: 'outside-project' },
  { id: 'ar_1', effect: 'allow', action: 'git.*' }
]

describe('securityText', () => {
  // 2026-10-26, the person: Observe and Rules are named in English too, as Policies and Audit Logs are
  it('names the observe mode and the rules in English in every language', () => {
    expect([OBSERVE_NAME, RULES_TITLE]).toEqual(['Observe', 'Rules'])
    for (const lang of LANGS) expect(modeLabel('observe', (k, p) => translate(lang, k, p))).toBe('Observe')
    expect(modeLabel('compatibility', ko)).toBe('끔')
    const screen = source('SecuritySettings.tsx')
    expect(screen).toContain('{RULES_TITLE}')
    expect(screen).toContain('{modeLabel(m, t)}')
    expect(screen).not.toContain("t('settings.security.rules.title')")
  })

  it('says Observe and Rule in the Korean screen and Run detail, never 관찰 or 규칙', () => {
    const shown = (lang: 'ko' | 'ja' | 'es'): Array<[string, string]> =>
      Object.entries(CATALOGS[lang].messages as Record<string, string>).filter(
        ([k]) => k.startsWith('settings.security.') || k.startsWith('jobs.detail.wouldDeny')
      )
    expect(shown('ko').length).toBeGreaterThan(50)
    expect(shown('ko').filter(([, v]) => /관찰|규칙/.test(v))).toEqual([])
    // Japanese and Spanish name the mode Observe too, and keep their own word for a rule
    expect(shown('ja').filter(([, v]) => /観察/.test(v))).toEqual([])
    expect(shown('es').filter(([, v]) => /observ(?!e\b)/i.test(v))).toEqual([])
  })

  // 2026-10-26, the person: the sentences say 기록 without the mode as their subject, the table is 기록 범위, and the
  // hint no longer adds that nothing is blocked; the name Observe stays on the switch alone
  it('words the Korean sentences around recording, not around Observe as a subject', () => {
    const shown = Object.entries(CATALOGS.ko.messages as Record<string, string>).filter(([k]) => k.startsWith('settings.security.'))
    expect(shown.filter(([, v]) => /Observe/.test(v))).toEqual([])
    expect(ko('settings.security.hint')).toBe('에이전트 세션의 도구 호출을 기록하고, Rules 대로라면 각각 어떻게 됐을지 보여 줍니다.')
    expect(ko('settings.security.coverage.title')).toBe('기록 범위')
    expect(ko('settings.security.audit.off')).toBe('기록이 꺼져 있습니다. 위의 Policies 에서 켤 수 있습니다.')
    // No language's hint says it any more
    for (const lang of LANGS) expect(translate(lang, 'settings.security.hint'), lang).not.toMatch(/막지|never blocks|ブロックしません|bloquea/)
  })

  // The constraints: the tab and its two sections keep the names the person chose, in English in every language
  it('names the tab and its sections in English', () => {
    expect([SECURITY_TAB, POLICIES_TITLE, AUDIT_LOGS_TITLE]).toEqual(['Security & Access', 'Policies', 'Audit Logs'])
    const app = source('../App.tsx')
    expect(app).toContain("['security', SECURITY_TAB]")
    // After Agent profiles
    expect(app.indexOf("['security', SECURITY_TAB]")).toBeGreaterThan(app.indexOf("['agentProfiles', t('settings.tab.agentProfiles')]"))
  })

  it('has words for every action, decision, coverage level, class, note and reason in every language', () => {
    expect(SECURITY_KEYS.length).toBeGreaterThan(30)
    for (const lang of LANGS) {
      const messages = CATALOGS[lang].messages as Record<string, string | undefined>
      expect(SECURITY_KEYS.filter((k) => !messages[k]), lang).toEqual([])
    }
    // Every action the resolver names, every decision and every class is among them
    expect(AUDIT_ACTIONS).toHaveLength(14)
    expect(DECISIONS).toEqual(['allow', 'would-deny', 'unknown', 'blocked'])
    expect(COVERAGE_CLASSES).toEqual(['shell', 'file-read', 'file-write', 'mcp', 'network'])
  })

  // Design §11: a plain phrase, never `git.remote.write`
  it('shows an action as a plain phrase, a group of them in words, and an unknown one as it is', () => {
    expect(actionPhrase('git.remote.write', en)).toBe('git push to a remote')
    expect(actionPhrase('filesystem.write', en)).toBe('write a file')
    expect(actionPhrase('git.*', en)).toBe('anything with git')
    expect(actionPhrase('*', en)).toBe('any action')
    expect(actionPhrase('git.re*', en)).toBe('git.re*')
    expect(actionPhrase('new.action', en)).toBe('new.action')
    for (const lang of LANGS)
      for (const a of RULE_ACTION_CHOICES) expect(actionPhrase(a, (k, p) => translate(lang, k, p)), `${lang} ${a}`).not.toContain('.')
  })

  // The CLI's --human output and this screen say the same English (the ledger's Task 7 note): one table
  it('the CLI speaks the same English phrases from the same table', () => {
    const cli = readFileSync(path.join(here, '../../../core/orchestration/cliHuman.ts'), 'utf8')
    expect(cli).toContain("from '../audit/phrases'")
    expect(cli).not.toContain("'git push to a remote'")
  })

  it('offers every action and the groups when picking a rule’s action, and keeps one the list does not have', () => {
    expect(RULE_ACTION_CHOICES).toEqual([...AUDIT_ACTIONS, 'git.*', 'github.*', 'filesystem.*', '*'])
    expect(ruleActionChoices('git.*')).toEqual(RULE_ACTION_CHOICES)
    expect(ruleActionChoices('git.re*')).toEqual([...RULE_ACTION_CHOICES, 'git.re*'])
  })

  it('says each decision in words', () => {
    expect(DECISIONS.map((d) => decisionLabel(d, en))).toEqual(['Allowed', 'Would be denied', 'Unknown', 'Blocked'])
    expect(decisionLabel('later', en)).toBe('later')
    const said = (lang: (typeof LANGS)[number]): string => decisionLabel('would-deny', (k, p) => translate(lang, k, p))
    // The person's ruling D1 (2026-10-24): the Korean and Japanese labels say what the rules deny; English and Spanish stay
    expect([said('ko'), said('ja'), said('es')]).toEqual(['거부 대상', '拒否対象', 'Se denegaría'])
  })

  // Design §9, the Host's COVERAGE
  it('puts a coverage cell in words, with why it is only partly seen', () => {
    expect(coverageCellText({ level: 'seen' }, en)).toBe('Seen')
    expect(coverageCellText({ level: 'partial', note: 'web-tools-only' }, en)).toBe('Partly (web tools only)')
    expect(coverageCellText({ level: 'partial' }, en)).toBe('Partly')
    expect(coverageCellText({ level: 'none' }, en)).toBe('Not seen')
    expect(coverageClassLabel('file-read', en)).toBe('Reading files')
    const r: CoverageRow = { provider: 'codex', kind: 'chat', classes: {} as CoverageRow['classes'] }
    expect(coverageRowLabel(r, en)).toBe('Codex Chat')
    expect(coverageRowLabel({ ...r, provider: 'claude', kind: 'terminal' }, ko)).toBe('Claude 터미널')
  })

  // Design §9: the coverage is also shown with each session in Audit Logs
  it('says in one line what observe sees of a session’s provider and kind', () => {
    const seen = { level: 'seen' } as const
    const rows: CoverageRow[] = [
      { provider: 'claude', kind: 'terminal', classes: { shell: seen, 'file-read': seen, 'file-write': seen, mcp: seen, network: { level: 'partial', note: 'web-tools-only' } } }
    ]
    expect(coverageLine(rows, { provider: 'claude', kind: 'terminal' }, en)).toBe(
      'What Observe can see: Shell commands Seen, Reading files Seen, Writing files Seen, MCP tools Seen, Web requests Partly (web tools only)'
    )
    expect(coverageLine(rows, { provider: 'codex', kind: 'chat' }, en)).toBe('')
  })

  it('names the rule that decided a call, or says none matched', () => {
    expect(decidingRule(row(), RULES, en)).toBe('Deny: git push to a remote')
    expect(decidingRule(row({ action: 'filesystem.write', ruleId: 'starter-write-outside' }), RULES, en)).toBe('Deny: write a file (Outside the project)')
    expect(decidingRule(row({ decision: 'allow', ruleId: undefined }), RULES, en)).toBe('No rule matched')
    expect(decidingRule(row({ decision: 'unknown', ruleId: undefined }), RULES, en)).toBe('')
    // A rule the screen's copy does not have (changed from the CLI since): its id
    expect(decidingRule(row({ ruleId: 'ar_gone' }), RULES, en)).toBe('ar_gone')
  })

  // Fix round 1, ruling 1: only a damaged file (the Host's reason) is repaired by starting over; another 409 is said in
  // the Host's own words
  it('says why the rules could not be read, and offers the repair only for a damaged file', () => {
    expect(securityFailure({ ok: false, code: 'CONFLICT', message: 'audit-policy.json is damaged; a copy was kept beside it', reason: 'damaged' }, en)).toEqual({
      line: en('settings.security.damaged'),
      repair: true
    })
    expect(securityFailure({ ok: false, code: 'CONFLICT', message: 'audit-policy.json could not be read (EISDIR)' }, en)).toEqual({
      line: 'audit-policy.json could not be read (EISDIR)',
      repair: false
    })
    expect(securityFailure({ ok: false, code: 'HOST_NOT_RUNNING', message: '' }, en)).toEqual({ line: en('settings.security.noHost'), repair: false })
    expect(securityFailure({ ok: false, code: 'FAILED', message: 'disk full' }, en)).toEqual({ line: 'disk full', repair: false })
  })

  // Fix round 1, ruling 4: the longest period is the records' whole retention (the store drops days before today−30)
  it('starts a period at the local midnight of its first day, the longest thirty calendar days', () => {
    const now = new Date(2026, 9, 23, 15, 30)
    expect(periodSince('today', now)).toBe(new Date(2026, 9, 23).toISOString())
    expect(periodSince('week', now)).toBe(new Date(2026, 9, 17).toISOString())
    // a day boundary: just after midnight still counts today as the first of the thirty
    expect(periodSince('month', new Date(2026, 9, 23, 0, 0, 1))).toBe(new Date(2026, 8, 24).toISOString())
    expect(retentionSince(now)).toBe(new Date(2026, 8, 23).toISOString())
    // "Last 30 days" is today and the 29 before it, thirty calendar days, not thirty-one
    expect(periodSince('month', now)).toBe(new Date(2026, 8, 24).toISOString())
  })

  // Fix round 1, I1: Run detail's count reads no further back than the Run or the retention, whichever is later
  it('bounds a Run’s count by its start or the retention, whichever is later', () => {
    const now = new Date(2026, 9, 23, 15, 30)
    expect(summarySince('2026-10-20T01:02:03.000Z', now)).toBe('2026-10-20T01:02:03.000Z')
    expect(summarySince('2026-01-01T00:00:00.000Z', now)).toBe(retentionSince(now))
    expect(summarySince(undefined, now)).toBe(retentionSince(now))
    expect(summarySince('later', now)).toBe(retentionSince(now))
  })

  // Fix round 1, ruling 8: a Job row folded onto its Run is read as that Run; a Job row with none, or nested, as the Job
  it('reads a Run’s calls by its Run, and a Job row without one by the Job', () => {
    expect(observeTargetOf('run_1', 'job_1')).toEqual({ runId: 'run_1' })
    expect(observeTargetOf(undefined, 'run_2')).toEqual({ runId: 'run_2' })
    expect(observeTargetOf(undefined, 'job_1')).toEqual({ jobId: 'job_1' })
  })

  // Fix round 1, I1 and rulings 6, 7: the screens wire these as tested here (no jsdom for the components themselves)
  it('Run detail reads on the throttle, not on every detail, and Audit Logs keeps its filters when the focus clears', () => {
    const detail = source('./RunDetail.tsx')
    expect(detail).toContain('}, [targetId, runState, readAgain, runtimeId, door])')
    expect(detail).toContain('}, [selectedId, selectedState, readTaskAgain, runtimeId, door])')
    expect(detail).toContain('summarySince(createdAt, new Date())')
    const app = source('../App.tsx')
    const element = app.slice(app.indexOf('<SecuritySettings'), app.indexOf('onClearFocus='))
    expect(element.length).toBeGreaterThan(0)
    expect(element).not.toContain('key=')
  })

  // Fix round 1, I1: the throttle
  it('reads a Run’s observe facts at once, then only when its state moved, and at most every 30 seconds', () => {
    expect(OBSERVE_READ_EVERY_MS).toBe(30_000)
    const at = 1_000_000
    // Never read, or another Run: now
    expect(observeReadDue(null, { target: 'run_1', state: 'running|0/3' }, at)).toBe(0)
    expect(observeReadDue({ target: 'run_1', state: 'running|0/3', at }, { target: 'run_2', state: 'running|0/3' }, at + 1)).toBe(0)
    // Nothing moved: never, however long it has been
    expect(observeReadDue({ target: 'run_1', state: 'running|0/3', at }, { target: 'run_1', state: 'running|0/3' }, at + 3_600_000)).toBeNull()
    // Moved soon after the last read: once the 30 seconds are up
    expect(observeReadDue({ target: 'run_1', state: 'running|0/3', at }, { target: 'run_1', state: 'running|1/3' }, at + 10_000)).toBe(20_000)
    // Moved later: now
    expect(observeReadDue({ target: 'run_1', state: 'running|0/3', at }, { target: 'run_1', state: 'completed|3/3' }, at + 30_000)).toBe(0)
  })

  // The filter helper: what audit-list and audit-summary are sent
  it('sends only the filters that are set, with the period’s start', () => {
    const now = new Date(2026, 9, 23, 15, 30)
    expect(auditQuery({}, 'today', now)).toEqual({ since: new Date(2026, 9, 23).toISOString() })
    expect(
      auditQuery({ sessionId: 'sess_a', agentProfileId: 'ap_1', jobId: 'job_1', runId: 'run_1', decision: 'would-deny', action: 'git.remote.write' }, 'week', now)
    ).toEqual({
      sessionId: 'sess_a',
      agentProfileId: 'ap_1',
      jobId: 'job_1',
      runId: 'run_1',
      decision: 'would-deny',
      action: 'git.remote.write',
      since: new Date(2026, 9, 17).toISOString()
    })
    expect(auditQuery({ sessionId: '', decision: undefined }, 'today', now)).toEqual({ since: new Date(2026, 9, 23).toISOString() })
  })

  // The cursor: the next page is the same query from where the last page ended
  it('asks for the next page from where the last one ended, and for none at the end', () => {
    const q = { runId: 'run_1', since: '2026-10-17T00:00:00.000Z' }
    expect(nextPageQuery(q, { until: '2026-10-23T03:00:01.000Z', beforeId: 'au_1' })).toEqual({ ...q, until: '2026-10-23T03:00:01.000Z', beforeId: 'au_1' })
    expect(nextPageQuery(q, null)).toBeNull()
  })

  it('reads a page of records and its cursor, and adds a later page without repeats', () => {
    const page = pageOf({ records: [row(), { nope: true }, row({ id: 'au_2' })], truncated: true, next: { until: '2026-10-23T03:00:01.000Z', beforeId: 'au_2' } })
    expect(page.records.map((r) => r.id)).toEqual(['au_1', 'au_2'])
    expect(page.next).toEqual({ until: '2026-10-23T03:00:01.000Z', beforeId: 'au_2' })
    expect(pageOf({ records: [], truncated: false, next: null })).toEqual({ records: [], next: null })
    expect(pageOf({})).toEqual({ records: [], next: null })
    expect(appendPage([row()], [row(), row({ id: 'au_3' })]).map((r) => r.id)).toEqual(['au_1', 'au_3'])
  })

  // The summary helper
  it('reads the summary’s counts and whether a day stopped at the size limit', () => {
    expect(summaryOf({ allow: 4, wouldDeny: 2, unknown: 1, byAction: {}, stoppedAtLimit: true })).toEqual({ allow: 4, wouldDeny: 2, unknown: 1, stoppedAtLimit: true })
    expect(summaryOf({})).toEqual({ allow: 0, wouldDeny: 0, unknown: 0, stoppedAtLimit: false })
  })

  it('offers the sessions and Jobs the records name, each once', () => {
    const rows = [row(), row({ id: 'au_2', sessionId: 'sess_b', jobId: 'job_1', runId: 'run_1' }), row({ id: 'au_3', jobId: 'job_1', runId: 'run_2' })]
    const s = (sessionId: string, provider: 'claude' | 'codex' = 'claude'): AuditRow => row({ sessionId, provider })
    const pick = (r: AuditRow): Pick<AuditRow, 'sessionId' | 'provider' | 'kind'> => ({ sessionId: r.sessionId, provider: r.provider, kind: r.kind })
    expect(filterChoices(rows)).toEqual({ sessions: [pick(s('sess_a')), pick(s('sess_b'))], jobs: [{ id: 'job_1', runId: 'run_1' }] })
    // After a filter narrowed the rows, the choices earlier reads found stay
    expect(filterChoices([s('sess_c', 'codex')], filterChoices(rows))).toEqual({
      sessions: [pick(s('sess_a')), pick(s('sess_b')), pick(s('sess_c', 'codex'))],
      jobs: [{ id: 'job_1', runId: 'run_1' }]
    })
  })

  it('shows a row’s time on the person’s clock and its session by its tab’s title, else by what it was', () => {
    const d = new Date(2026, 9, 23, 9, 5, 7)
    expect(recordTime(d.toISOString())).toBe('2026-10-23 09:05:07')
    expect(recordTime('later')).toBe('later')
    // In the rows, newest first: the time of day, and the date where a day's rows start (the screen finding: a full
    // timestamp on every row left the action and the rule no room)
    const iso = (h: number, m: number, day = 23): string => new Date(2026, 9, day, h, m, 0).toISOString()
    expect(rowTime(iso(9, 5), undefined)).toEqual({ time: '09:05:00', date: '2026-10-23' })
    expect(rowTime(iso(9, 1), iso(9, 5))).toEqual({ time: '09:01:00' })
    expect(rowTime(iso(23, 59, 22), iso(9, 1))).toEqual({ time: '23:59:00', date: '2026-10-22' })
    expect(rowTime('later', iso(9, 1))).toEqual({ time: 'later' })
    expect(sessionLabel(row(), 'Fix the build', en)).toBe('Fix the build')
    expect(sessionLabel(row({ sessionId: '0123456789abcdef', provider: 'codex', kind: 'chat' }), undefined, en)).toBe('Codex Chat 01234567')
  })

  // Empty states (design §11): observe off, the Host not running, nothing yet
  it('says why there are no records, or that observe is off above records kept before', () => {
    expect(auditStateLine({ failure: { ok: false, code: 'HOST_NOT_RUNNING', message: '' }, mode: 'observe', count: 0 }, en)).toBe(en('settings.security.audit.noHost'))
    expect(auditStateLine({ failure: { ok: false, code: 'CONFLICT', message: '', reason: 'damaged' }, mode: null, count: 0 }, en)).toBe(en('settings.security.audit.damaged'))
    expect(auditStateLine({ failure: { ok: false, code: 'CONFLICT', message: 'could not be read' }, mode: null, count: 0 }, en)).toBe('could not be read')
    expect(auditStateLine({ failure: null, mode: 'compatibility', count: 0 }, en)).toBe(en('settings.security.audit.off'))
    expect(auditStateLine({ failure: null, mode: 'observe', count: 0 }, en)).toBe(en('settings.security.audit.empty'))
    expect(auditStateLine({ failure: null, mode: 'compatibility', count: 3 }, en)).toBe(en('settings.security.audit.offWithRows'))
    expect(auditStateLine({ failure: null, mode: 'observe', count: 3 }, en)).toBeNull()
  })

  // Run detail (design §10): totals as the Host gives them, nothing when unknown, never zeros made up
  it('reads the token totals runs get and tasks-get carry', () => {
    expect(tokensOf({ id: 'run_1', tokens: { input: 10, output: 5, total: 15 }, coordinatorTokens: { input: 3, output: 1, total: 4 } })).toEqual({
      tokens: { input: 10, output: 5, total: 15 },
      coordinatorTokens: { input: 3, output: 1, total: 4 }
    })
    expect(tokensOf({ id: 'run_1' })).toEqual({})
    expect(tokensOf({ tokens: { input: '10', output: 5, total: 15 } })).toEqual({})
    expect(tokensOf(null)).toEqual({})
  })

  it('says how many of a Run’s calls would be denied, and nothing when it has no records', () => {
    expect(wouldDenyLine({ allow: 3, wouldDeny: 2, unknown: 0, stoppedAtLimit: false }, en)).toBe(en('jobs.detail.wouldDeny', { count: 2 }))
    expect(wouldDenyLine({ allow: 3, wouldDeny: 0, unknown: 1, stoppedAtLimit: false }, en)).toBe(en('jobs.detail.wouldDenyNone'))
    expect(wouldDenyLine({ allow: 0, wouldDeny: 0, unknown: 0, stoppedAtLimit: false }, en)).toBeNull()
  })
})

// The Job focus Run detail opens Audit Logs on is the Job filter's own choice, not a chip beside the filters
describe('the Job focus', () => {
  it('shows as the selected Job filter, and the focus is the Job filter, not another filter over it', () => {
    const focus = { runId: 'run_1', name: 'Fix it' }
    expect(focusedFilters({ jobId: 'job_9', decision: 'allow' }, focus)).toEqual({ decision: 'allow', runId: 'run_1' })
    expect(focusedFilters({ jobId: 'job_9', runId: 'run_7' }, { jobId: 'job_2', name: 'x' })).toEqual({ jobId: 'job_2' })
    expect(focusedFilters({ jobId: 'job_9' }, undefined)).toEqual({ jobId: 'job_9' })
    expect(FOCUS_VALUE).not.toBe('')
  })

  const jobs = [
    { id: 'job_1', runId: 'run_1' },
    { id: 'job_2', runId: 'run_2' }
  ]
  const nameOf = (runId: string): string | undefined => (runId === 'run_1' ? 'Fix it' : undefined)
  const labels = { all: 'All Jobs', focus: (name: string) => `Only ${name}` }

  it('offers the focus as the Job filter’s selected choice, once, among the Jobs read', () => {
    const v = jobFilterView({ focus: { runId: 'run_1', name: 'Fix it' }, filters: { jobId: 'job_9' }, jobs, runName: nameOf, labels })
    expect(v.value).toBe(FOCUS_VALUE)
    expect(v.items).toEqual([
      { value: '', label: 'All Jobs' },
      { value: FOCUS_VALUE, label: 'Only Fix it' },
      { value: 'job_2', label: 'job_2' }
    ])
    const byJob = jobFilterView({ focus: { jobId: 'job_2', name: 'Job two' }, filters: {}, jobs, runName: nameOf, labels })
    expect(byJob.items.map((i) => i.value)).toEqual(['', FOCUS_VALUE, 'job_1'])
  })

  it('shows the filter the person set when there is no focus', () => {
    const v = jobFilterView({ focus: undefined, filters: { jobId: 'job_2' }, jobs, runName: nameOf, labels })
    expect(v.value).toBe('job_2')
    expect(v.items).toEqual([
      { value: '', label: 'All Jobs' },
      { value: 'job_1', label: 'Fix it' },
      { value: 'job_2', label: 'job_2' }
    ])
    expect(jobFilterView({ focus: undefined, filters: {}, jobs, runName: nameOf, labels }).value).toBe('')
  })

  it('clears the focus when the Job filter is changed to another Job or to all Jobs, and keeps it when it is picked again', () => {
    const f = { decision: 'allow' as const, jobId: 'job_9' }
    const focus = { runId: 'run_1', name: 'Fix it' }
    expect(chooseJob('job_3', focus, f)).toEqual({ clearFocus: true, filters: { decision: 'allow', jobId: 'job_3' } })
    expect(chooseJob('', focus, f)).toEqual({ clearFocus: true, filters: { decision: 'allow' } })
    expect(chooseJob(FOCUS_VALUE, focus, f)).toEqual({ clearFocus: false, filters: f })
    expect(chooseJob('job_3', undefined, f)).toEqual({ clearFocus: false, filters: { decision: 'allow', jobId: 'job_3' } })
    expect(chooseJob('', undefined, f)).toEqual({ clearFocus: false, filters: { decision: 'allow' } })
  })
})

// Run detail's facts: one component per Run it shows, and a read that failed is not final
describe('Run detail reads', () => {
  it('is keyed by the Run it shows, and by its Runtime, so switching Runs never shows the last one’s tokens', () => {
    expect(runDetailInstanceKey({ runId: 'run_1' })).not.toBe(runDetailInstanceKey({ runId: 'run_2' }))
    expect(runDetailInstanceKey({ runId: 'run_1' })).not.toBe(runDetailInstanceKey({ runId: 'run_1', runtimeId: 'rt_1' }))
    expect(runDetailInstanceKey({ runId: 'run_1', runtimeId: 'rt_1' })).toBe(runDetailInstanceKey({ runId: 'run_1', runtimeId: 'rt_1' }))
  })

  const key = { target: 'run_1', state: 'completed|3/3' }

  it('keeps a good read as it is: nothing is read again until the Run moves', () => {
    const first = startObserveRead(null, key, 1000)
    const done = afterObserveRead(first, true)
    expect(done.retryIn).toBeNull()
    expect(observeReadDue(done.last, key, 1000 + 5000)).toBeNull()
  })

  it('tries a failed read again once the wait is over, up to the cap, then only when the Run moves', () => {
    let last = startObserveRead(null, key, 1000)
    const retries: Array<number | null> = []
    for (let i = 0; i < OBSERVE_RETRIES + 1; i++) {
      const out = afterObserveRead(last, false)
      retries.push(out.retryIn)
      // the retry reads the same state at the end of the wait, which the read finds due
      expect(observeReadDue(out.last, key, last.at + 5000)).toBe(OBSERVE_READ_EVERY_MS - 5000)
      expect(observeReadDue(out.last, key, last.at + OBSERVE_READ_EVERY_MS)).toBe(0)
      last = startObserveRead(out.last, key, last.at + OBSERVE_READ_EVERY_MS)
    }
    expect(retries).toEqual([OBSERVE_READ_EVERY_MS, OBSERVE_READ_EVERY_MS, OBSERVE_READ_EVERY_MS, null])
  })

  it('counts failures per Run, and a good read starts the count again', () => {
    const failed = afterObserveRead(startObserveRead(null, key, 0), false).last
    expect(startObserveRead(failed, key, 40_000).failures).toBe(1)
    expect(startObserveRead(failed, { target: 'run_2', state: 'x' }, 40_000).failures).toBe(0)
    const good = afterObserveRead(startObserveRead(failed, key, 40_000), true).last
    expect(startObserveRead(good, { ...key, state: 'later' }, 80_000).failures).toBe(0)
  })
})

// "Today and the 29 before" is counted on the person's clock: where the local day and the UTC day differ
describe('the 30 days on the person’s clock', () => {
  const was = process.env.TZ
  afterEach(() => {
    if (was === undefined) delete process.env.TZ
    else process.env.TZ = was
  })

  it('starts at the local midnight 29 days back where the local day is behind UTC', () => {
    process.env.TZ = 'America/Los_Angeles'
    // 2026-10-24T03:00Z is still the evening of the 23rd in Los Angeles (UTC-7)
    expect(periodSince('month', new Date('2026-10-24T03:00:00Z'))).toBe('2026-09-24T07:00:00.000Z')
    expect(periodSince('today', new Date('2026-10-24T03:00:00Z'))).toBe('2026-10-23T07:00:00.000Z')
  })

  it('starts at the local midnight 29 days back where the local day is ahead of UTC', () => {
    process.env.TZ = 'Asia/Seoul'
    // 2026-10-23T16:00Z is already the 24th at 01:00 in Seoul (UTC+9)
    expect(periodSince('month', new Date('2026-10-23T16:00:00Z'))).toBe('2026-09-24T15:00:00.000Z')
    expect(periodSince('today', new Date('2026-10-23T16:00:00Z'))).toBe('2026-10-23T15:00:00.000Z')
  })
})

describe('the start over confirmation', () => {
  it('says recording stays off after the repair of a damaged file, and that the mode stays otherwise', () => {
    expect(resetBodyKey(true)).toBe('settings.security.reset.bodyDamaged')
    expect(resetBodyKey(false)).toBe('settings.security.reset.body')
    expect(en('settings.security.reset.bodyDamaged')).toMatch(/nothing is recorded/)
    // The banner says nothing is recorded while damaged, never that recording comes back by itself after the repair
    for (const lang of ['en', 'ko', 'ja', 'es'] as const) {
      const banner = translate(lang, 'settings.security.damaged')
      expect(banner, lang).not.toMatch(/paused|until it is repaired|고쳐질 때까지|修復されるまで|Mientras no se repare/)
    }
    expect(en('settings.security.damaged')).toMatch(/nothing is recorded while it is damaged/i)
  })
})

describe('an observe read that finishes after Run detail closed', () => {
  it('is dropped, as is one for another target, so no state is set and no retry is scheduled', () => {
    expect(observeReadIsCurrent(true, 'run_1', 'run_1')).toBe(true)
    expect(observeReadIsCurrent(false, 'run_1', 'run_1')).toBe(false)
    expect(observeReadIsCurrent(true, 'run_2', 'run_1')).toBe(false)
  })
})

// Found on the dev app: Run detail's link opened Security & Access at Policies, the Run's calls a scroll below
describe('bringing Audit Logs into view for a focus', () => {
  it('is due once per focus, after the rules have loaded, and never without a focus', () => {
    const run = { runId: 'run_1', name: 'Fix it' }
    expect(auditScrollDue(run, false, null)).toBeNull()
    expect(auditScrollDue(run, true, null)).toBe('run:run_1')
    expect(auditScrollDue(run, true, 'run:run_1')).toBeNull()
    expect(auditScrollDue({ jobId: 'job_2', name: 'Other' }, true, 'run:run_1')).toBe('job:job_2')
    expect(auditScrollDue(undefined, true, null)).toBeNull()
  })
})
