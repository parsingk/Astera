import { describe, it, expect } from 'vitest'
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
  POLICIES_TITLE,
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
  pageOf,
  periodSince,
  recordTime,
  ruleActionChoices,
  sessionLabel,
  securityFailure,
  summaryOf,
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
    expect(DECISIONS).toEqual(['allow', 'would-deny', 'unknown'])
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
    expect(DECISIONS.map((d) => decisionLabel(d, en))).toEqual(['Allowed', 'Would be denied', 'Unknown'])
    expect(decisionLabel('later', en)).toBe('later')
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
      'What observe can see: Shell commands Seen, Reading files Seen, Writing files Seen, MCP tools Seen, Web requests Partly (web tools only)'
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

  // A 409 is a damaged rules file: starting over with the starter rules is its repair
  it('says why the rules could not be read, and offers the repair when the file is damaged', () => {
    expect(securityFailure({ ok: false, code: 'CONFLICT', message: 'audit-policy.json is damaged; a copy was kept beside it' }, en)).toEqual({
      line: en('settings.security.damaged'),
      repair: true
    })
    expect(securityFailure({ ok: false, code: 'HOST_NOT_RUNNING', message: '' }, en)).toEqual({ line: en('settings.security.noHost'), repair: false })
    expect(securityFailure({ ok: false, code: 'FAILED', message: 'disk full' }, en)).toEqual({ line: 'disk full', repair: false })
  })

  it('starts a period at the local midnight of its first day', () => {
    const now = new Date(2026, 9, 23, 15, 30)
    expect(periodSince('today', now)).toBe(new Date(2026, 9, 23).toISOString())
    expect(periodSince('week', now)).toBe(new Date(2026, 9, 17).toISOString())
    expect(periodSince('month', now)).toBe(new Date(2026, 8, 24).toISOString())
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
    expect(sessionLabel(row(), 'Fix the build', en)).toBe('Fix the build')
    expect(sessionLabel(row({ sessionId: '0123456789abcdef', provider: 'codex', kind: 'chat' }), undefined, en)).toBe('Codex Chat 01234567')
  })

  // Empty states (design §11): observe off, the Host not running, nothing yet
  it('says why there are no records, or that observe is off above records kept before', () => {
    expect(auditStateLine({ failure: { ok: false, code: 'HOST_NOT_RUNNING', message: '' }, mode: 'observe', count: 0 }, en)).toBe(en('settings.security.audit.noHost'))
    expect(auditStateLine({ failure: { ok: false, code: 'CONFLICT', message: '' }, mode: null, count: 0 }, en)).toBe(en('settings.security.audit.damaged'))
    expect(auditStateLine({ failure: null, mode: 'compatibility', count: 0 }, en)).toBe(en('settings.security.audit.off'))
    expect(auditStateLine({ failure: null, mode: 'observe', count: 0 }, en)).toBe(en('settings.security.audit.empty'))
    expect(auditStateLine({ failure: null, mode: 'compatibility', count: 3 }, en)).toBe(en('settings.security.audit.offWithRows'))
    expect(auditStateLine({ failure: null, mode: 'observe', count: 3 }, en)).toBeNull()
  })

  // Run detail (design §10): totals as the Host gives them, nothing when unknown, never zeros made up
  it('reads the token totals runs get and tasks get carry', () => {
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
