// Settings › Security & Access › Findings and the Agent profiles mark (lifecycle design §7): the readings of the Host's
// report the section and the mark show, apart from the components so each is tested as text.
import { describe, it, expect } from 'vitest'
import { t as translate, type Message } from '../../../core/i18n'
import { finding, infoLine } from '../../../core/findings/make'
import type { Finding, FindingSubject, FindingsReport } from '../../../core/findings/types'
import type { JobRow } from '../../../core/types'
import { GROUP_ORDER, findingGroups, ignoreNote, jobsRowOf, markTitle, openLabelKey, profileMarks, reportOf, subjectName, targetOf, wordsOf } from './findingsText'

const profile = (id: string, name = id): FindingSubject => ({ kind: 'profile', id, name })
const say = (key: Message['key'], params?: Message['params']): Message => (params === undefined ? { key } : { key, params })

const unused = (id: string): Finding =>
  finding({
    rule: 'unused-profile',
    subject: profile(id),
    profileIds: [id],
    message: say('findings.reason.unusedProfile', { days: 120 }),
    suggestion: say('findings.do.archiveProfile'),
    open: { kind: 'profiles', profileIds: [id] }
  })
const duplicate = (ids: string[]): Finding =>
  finding({
    rule: 'duplicate-profile',
    subject: { kind: 'profiles', id: 'fp-0123456789ab', name: ids.join(', ') },
    profileIds: ids,
    message: say('findings.reason.duplicateProfile', { names: ids.join(', ') }),
    suggestion: say('findings.do.keepOne'),
    open: { kind: 'profiles', profileIds: ids }
  })
const gap = (ids: string[]): Finding =>
  finding({
    rule: 'coverage-gap',
    subject: { kind: 'cli', id: 'codex-terminal', name: 'Codex terminal' },
    profileIds: ids,
    part: 'r1',
    message: say('findings.reason.coverageGapNone', { rule: 'r1', action: 'git push', cli: 'Codex terminal' }),
    suggestion: say('findings.do.openPolicies'),
    open: { kind: 'policies' }
  })
const brokenJob = (jobId: string, profileId: string): Finding =>
  finding({
    rule: 'broken-reference',
    subject: { kind: 'job', id: jobId, name: 'Nightly review' },
    profileIds: [profileId],
    message: say('findings.reason.profileGone', { id: profileId }),
    suggestion: say('findings.do.repointJob'),
    open: { kind: 'job', jobId }
  })
const brokenProfile = (id: string): Finding =>
  finding({
    rule: 'broken-reference',
    subject: profile(id),
    profileIds: [id],
    message: say('findings.reason.removedAccount', { ids: 'acc_gone' }),
    suggestion: say('findings.do.editProfile'),
    open: { kind: 'profiles', profileIds: [id] }
  })
const overBroad = (id: string, part: string): Finding =>
  finding({
    rule: 'over-broad-profile',
    subject: profile(id),
    profileIds: [id],
    part,
    message: say('findings.reason.overBroadBypass', { days: 30 }),
    suggestion: say('findings.do.askPermission'),
    open: { kind: 'profiles', profileIds: [id] }
  })
const failing = (id: string): Finding =>
  finding({
    rule: 'failing-profile',
    subject: profile(id),
    profileIds: [id],
    message: say('findings.reason.failingProfile', { failed: 4, total: 6, run: 'Nightly review #3' }),
    suggestion: say('findings.do.openRuns'),
    open: { kind: 'run', runId: 'run_3' }
  })
const of = (subject: FindingSubject, rule: Finding['rule'], open: Finding['open']): Finding =>
  finding({ rule, subject, message: say('findings.reason.unusedMcp', { days: 30 }), suggestion: say('findings.do.disableMcp'), open })

const report = (findings: Finding[], over: Partial<FindingsReport> = {}): FindingsReport => ({
  findings,
  info: [],
  observe: { on: true, days: 30 },
  unread: [],
  computedAt: '2026-10-30T09:00:00.000Z',
  ...over
})

describe('profileMarks (ruling 7)', () => {
  it('profileMarks counts a duplicate on both members and leaves coverage-gap out', () => {
    const marks = profileMarks(report([duplicate(['ap_a', 'ap_b']), gap(['ap_a', 'ap_c']), unused('ap_a')]))
    expect(marks.get('ap_a')?.map((f) => f.rule)).toEqual(['duplicate-profile', 'unused-profile'])
    expect(marks.get('ap_b')?.map((f) => f.rule)).toEqual(['duplicate-profile'])
    // A coverage gap is the CLI's: it would mark every profile of that CLI alike
    expect(marks.has('ap_c')).toBe(false)
  })

  it('counts a profile own broken reference, failing and each over-broad line, not a Job that names it or an ignored one', () => {
    const ignored = { ...unused('ap_a'), ignored: true }
    const marks = profileMarks(report([brokenProfile('ap_a'), brokenJob('job_1', 'ap_b'), failing('ap_a'), overBroad('ap_a', 'bypass'), overBroad('ap_a', 'mcp:m1'), ignored]))
    expect(marks.get('ap_a')?.map((f) => f.key)).toEqual([
      'broken-reference:ap_a',
      'failing-profile:ap_a',
      'over-broad-profile:ap_a:bypass',
      'over-broad-profile:ap_a:mcp:m1'
    ])
    // The Job is broken, not the profile it names
    expect(marks.has('ap_b')).toBe(false)
  })

  it('says each reason on a line of its own in the tooltip', () => {
    const marks = profileMarks(report([duplicate(['ap_a', 'ap_b']), unused('ap_a')]))
    const tm = (m: Message): string => translate('en', m.key, m.params)
    expect(markTitle(marks.get('ap_a') ?? [], tm)).toBe(
      'These profiles have the same accounts, MCP exclusions, permission and sandbox: ap_a, ap_b.\nNot used in 120 days.'
    )
  })
})

describe('the groups of the section (§7)', () => {
  it('groups follow the subject kind order: profiles, extensions, Runtimes, credentials, Jobs and Runs, CLIs', () => {
    expect(GROUP_ORDER).toEqual(['profiles', 'extensions', 'runtimes', 'credentials', 'jobs', 'clis'])
    const mcp = of({ kind: 'extension', id: 'm1', name: 'github' }, 'unused-mcp', { kind: 'extension', entryId: 'm1' })
    const runtime = of({ kind: 'runtime', id: 'rt1', name: 'Laptop' }, 'stale-runtime', { kind: 'runtimes', runtimeId: 'rt1' })
    const secret = of({ kind: 'credential', id: 'mcp:m1', name: 'github' }, 'stale-credential', { kind: 'credentials', entryId: 'mcp:m1' })
    const task = of({ kind: 'task', id: 'task_1', name: 'Fix the build' }, 'broken-reference', { kind: 'run', runId: 'run_1' })
    const spike = of({ kind: 'run', id: 'run_2', name: 'Nightly review #2' }, 'token-spike', { kind: 'run', runId: 'run_2' })
    const groups = findingGroups(report([gap(['ap_a']), spike, secret, brokenJob('job_1', 'ap_a'), runtime, mcp, task, duplicate(['ap_a', 'ap_b']), unused('ap_c')]))
    expect(groups.map((g) => g.kind)).toEqual(['profiles', 'extensions', 'runtimes', 'credentials', 'jobs', 'clis'])
    // A duplicate group is a profiles subject of its own; Jobs, Tasks and Runs share one group, in the report's order
    expect(groups[0].subjects.map((s) => s.subject.id)).toEqual(['fp-0123456789ab', 'ap_c'])
    expect(groups[4].subjects.map((s) => s.subject.id)).toEqual(['run_2', 'job_1', 'task_1'])
  })

  it('puts the lines of one subject under it, ignored findings out, and an information line under its subject', () => {
    const skill: FindingSubject = { kind: 'extension', id: 'sk1', name: 'review' }
    const groups = findingGroups(
      report([overBroad('ap_a', 'bypass'), unused('ap_b'), overBroad('ap_a', 'sandbox'), { ...overBroad('ap_a', 'mcp:m1'), ignored: true }], {
        info: [infoLine(skill, say('findings.info.claudeOnlyNoUse', { days: 30 }))]
      })
    )
    expect(groups.map((g) => g.kind)).toEqual(['profiles', 'extensions'])
    expect(groups[0].subjects.map((s) => [s.subject.id, s.findings.map((f) => f.part ?? '')])).toEqual([
      ['ap_a', ['bypass', 'sandbox']],
      ['ap_b', ['']]
    ])
    expect(groups[1].subjects).toEqual([{ subject: skill, findings: [], info: [expect.objectContaining({ reason: 'No recorded use in Claude in 30 days. Codex cannot tell.' })] }])
  })
})

describe('a subject name', () => {
  it('names a CLI subject as Policies labels its row, in the reader language, and any other as the Host named it', () => {
    const ko = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]): string => translate('ko', key, params)
    expect(subjectName({ kind: 'cli', id: 'claude-terminal', name: 'Claude Terminal' }, ko)).toBe('Claude 터미널')
    expect(subjectName({ kind: 'cli', id: 'codex-chat', name: 'Codex Chat' }, ko)).toBe('Codex 대화')
    // A CLI this app does not know (a newer Host's), as it was sent
    expect(subjectName({ kind: 'cli', id: 'gemini-terminal', name: 'Gemini Terminal' }, ko)).toBe('Gemini Terminal')
    expect(subjectName(profile('ap_a', 'Old helper'), ko)).toBe('Old helper')
  })
})

describe('where a finding opens (§7: it opens the place, it never acts)', () => {
  it('names each place on its button', () => {
    expect(openLabelKey({ kind: 'profiles', profileIds: ['ap_a'] })).toBe('findings.open.profiles')
    expect(openLabelKey({ kind: 'job', jobId: 'job_1' })).toBe('findings.open.job')
    expect(openLabelKey({ kind: 'run', runId: 'run_1' })).toBe('findings.open.run')
    expect(openLabelKey({ kind: 'extension', entryId: 'm1' })).toBe('findings.open.extension')
    expect(openLabelKey({ kind: 'policies' })).toBe('findings.open.policies')
    expect(openLabelKey({ kind: 'runtimes', runtimeId: 'rt1' })).toBe('findings.open.runtimes')
    expect(openLabelKey({ kind: 'credentials', entryId: 'mcp:m1' })).toBe('findings.open.credentials')
    // A place a newer Host names that this app does not know gets no button, never a blank one
    expect(openLabelKey({ kind: 'somewhere' } as never)).toBeNull()
  })

  it('takes each place to its tab, its section, or the Jobs view', () => {
    expect(targetOf({ kind: 'profiles', profileIds: ['ap_a', 'ap_b'] })).toEqual({ tab: 'agentProfiles', profileIds: ['ap_a', 'ap_b'] })
    expect(targetOf({ kind: 'extension', entryId: 'm1' })).toEqual({ tab: 'extensions' })
    expect(targetOf({ kind: 'runtimes', runtimeId: 'rt1' })).toEqual({ tab: 'remote' })
    expect(targetOf({ kind: 'policies' })).toEqual({ section: 'policies' })
    expect(targetOf({ kind: 'credentials', entryId: 'mcp:m1' })).toEqual({ section: 'credentials' })
    expect(targetOf({ kind: 'job', jobId: 'job_1' })).toEqual({ jobs: 'job_1' })
    expect(targetOf({ kind: 'run', runId: 'run_1' })).toEqual({ jobs: 'run_1' })
    expect(targetOf({ kind: 'somewhere' } as never)).toBeNull()
  })

  it('finds the Jobs view row a Job or Run opens: its own row, a Job row folded onto it, or a fire under its Job', () => {
    const row = (id: string, over: Partial<JobRow> = {}): JobRow => ({ id, ...over }) as JobRow
    const snapshot = { runs: [row('job_a'), row('job_b', { foldedRunId: 'run_b1' }), row('job_c', { children: [row('run_c1'), row('run_c2')] })] }
    expect(jobsRowOf(snapshot, 'job_a')).toBe('job_a')
    expect(jobsRowOf(snapshot, 'run_b1')).toBe('job_b')
    expect(jobsRowOf(snapshot, 'run_c2')).toBe('run_c2')
    // In another project's Jobs, or gone
    expect(jobsRowOf(snapshot, 'job_x')).toBeUndefined()
  })
})

describe('an ignore note (ruling 12)', () => {
  it('keeps one trimmed line of at most 200 characters, and none when blank', () => {
    expect(ignoreNote('  kept for the demo  ')).toBe('kept for the demo')
    expect(ignoreNote('one\r\ntwo')).toBe('one two')
    expect(ignoreNote('   ')).toBeUndefined()
    expect(ignoreNote('x'.repeat(250))).toHaveLength(200)
  })
})

describe('reading the report', () => {
  it('takes the report the Host answered, and nothing it cannot read as one', () => {
    const r = report([unused('ap_a')])
    expect(reportOf(JSON.parse(JSON.stringify(r)))).toEqual(r)
    expect(reportOf({})).toBeNull()
    expect(reportOf({ ...r, findings: 'x' })).toBeNull()
    // A finding with no place or Message is left out rather than drawn half
    expect(reportOf({ ...r, findings: [{ key: 'k' }, r.findings[0]] })?.findings).toEqual(r.findings)
  })

  it('words a Message in the reader language, and the English the Host sent for a key this app does not know', () => {
    const tm = (m: Message): string => translate('ko', m.key, m.params)
    expect(wordsOf(say('findings.reason.unusedProfile', { days: 120 }), 'Not used in 120 days.', tm)).toBe('120일 동안 쓰지 않았습니다.')
    expect(wordsOf({ key: 'findings.reason.fromNewerHost' as never }, 'A newer reason.', tm)).toBe('A newer reason.')
    // A Message inside a Message counts too: the token spike's group
    expect(wordsOf(say('findings.reason.tokenSpike', { total: 9, median: 3, times: 3, group: { key: 'findings.group.unknown' as never } }), 'Used 9 tokens.', tm)).toBe(
      'Used 9 tokens.'
    )
  })
})
