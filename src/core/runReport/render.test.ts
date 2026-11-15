import { describe, it, expect } from 'vitest'
import {
  RUN_REPORT_MARKER,
  PR_COMMENT_MAX,
  SLACK_POST_MAX,
  CAVEAT_TEXT_MAX,
  scrubText,
  forPullRequest,
  outcomeLine,
  githubLine,
  taskLine,
  checkLine,
  reviewLine,
  interruptionsLine,
  interventionsLine,
  caveatLine,
  costLine,
  timesLine,
  reportMarkdown,
  reportSlack
} from './render'
import { buildRunReport } from './build'
import { emptyState, type OrchState } from '../orchestration/state'
import { FAILURE_LIMIT, type Dispatch, type JobRun, type Task } from '../orchestration/types'
import type { RunReport, RunReportCaveat, RunReportTask } from './types'

const task = (title: string, extra: Partial<RunReportTask> = {}): RunReportTask => ({
  title,
  status: 'completed',
  attempts: 1,
  repairs: { check: 0, review: 0 },
  grantedExtra: 0,
  checks: [{ name: 'unit', final: 'passed', failedRounds: 0 }],
  ...extra
})

const report = (extra: Partial<RunReport> = {}): RunReport => ({
  version: 1,
  runId: 'run-1',
  job: 'Ship it',
  ordinal: 3,
  outcome: 'completed',
  startedAt: '2026-11-15T01:00:00.000Z',
  endedAt: '2026-11-15T01:42:00.000Z',
  tasks: [task('Add the button')],
  github: {
    pr: { number: 12, url: 'https://github.com/o/r/pull/12' },
    ci: { verdict: 'passed', sha: 'abc1234def5678abc1234def5678abc1234def56' },
    ciFailedRounds: 0,
    reruns: { astera: 0, person: 0 },
    mergeReady: { headSha: 'abc1234def5678abc1234def5678abc1234def56' }
  },
  interruptions: { limitWaits: 0, waitedMs: 0, switches: 0, restarts: 0 },
  interventions: { answers: { person: 0, coordinator: 1, astera: 0, unknown: 0 }, forced: [], noPersonSteppedIn: true },
  caveats: [],
  cost: { tokens: { input: 1, output: 2, total: 1234567 }, accountIds: ['acc-1'] },
  ...extra
})

const caveatsOfEveryKind: RunReportCaveat[] = [
  { kind: 'forced', task: 'T1', by: 'person', reason: 'the flaky one' },
  { kind: 'check-skipped', task: 'T2', check: 'lint' },
  { kind: 'ci-skipped' },
  { kind: 'outside-sandbox', task: 'T3', checks: ['e2e', 'lint'] },
  { kind: 'review-outside-sandbox', task: 'T4' },
  { kind: 'policy-changed', task: 'T5' },
  { kind: 'suspicious-files', task: 'T6', count: 2 },
  { kind: 'unstable', task: 'T7', check: 'unit' }
]

const ctx = { roots: [], prefixes: [], secrets: [] }
const accounts = new Map([['acc-1', 'Work Account']])
const HANGUL = /[가-힣]/

/** A finished Run as the state holds it, for the tests that go through the builder */
const T0 = '2026-11-15T01:00:00.000Z'
const END = '2026-11-15T01:42:00.000Z'
const stateOf = (o: { objective?: string; tasks: Partial<Task>[]; dispatches?: Partial<Dispatch>[]; run?: Partial<JobRun> }): OrchState => ({
  ...emptyState(),
  jobs: [{ id: 'job_1', objective: o.objective ?? 'Ship it', cwd: '/w', github: {} } as never],
  runs: [{ id: 'run_1', jobId: 'job_1', ordinal: 3, createdAt: T0, endedAt: END, ...o.run } as never],
  tasks: o.tasks.map((t, i) => ({ id: `t${i}`, runId: 'run_1', title: `Task ${i}`, spec: '', deps: [], status: 'completed', createdAt: T0, updatedAt: END, ...t }) as Task),
  dispatches: (o.dispatches ?? []) as Dispatch[]
})

describe('the pull request version', () => {
  it('leaks nothing', () => {
    const r = report({
      tasks: [task('fix F:\\astera-work\\worktrees\\run-x\\src\\a.ts for claude2@anipen.com about ab')],
      caveats: [{ kind: 'forced', task: 'T', by: 'person', reason: 'see /Users/kim/notes.md and Work Account' }]
    })
    const scrub = { roots: ['F:\\astera-work\\worktrees\\run-x', 'D:/p'], prefixes: [], secrets: ['Work Account', 'claude2@anipen.com', 'ab'] }
    const md = reportMarkdown(forPullRequest(r, scrub), 'en', { audience: 'pull-request', accounts })
    expect(md).toContain('src/a.ts')
    expect(md).not.toContain('F:')
    expect(md).not.toContain('/Users/')
    expect(md).not.toContain('@anipen.com')
    expect(md).not.toContain('Work Account')
    expect(md).not.toMatch(/\d{6,}|1,234,567/)
    expect(md).toContain('about ab')
  })

  // Spec §11: the comment version holds no session id, built from a state whose Dispatches and Run carry them
  it('carries no session id', () => {
    const s = stateOf({
      run: { coordinatorSessionId: 'ses_coord_1', externalCoordinatorSessionId: 'ses_outside_2' } as Partial<JobRun>,
      tasks: [{ status: 'completed' }],
      dispatches: [
        { id: 'd1', taskId: 't0', provider: 'claude', accountId: 'acc_a', sessionId: 'ses_worker_3', cwd: '/w', specPath: '/s', startedAt: T0, workerState: 'stopped', retained: false, outcome: 'succeeded', endedAt: END },
        { id: 'd2', taskId: 't0', provider: 'codex', accountId: 'acc_a', sessionId: 'ses_review_4', cwd: '/w', specPath: '/s', startedAt: T0, workerState: 'stopped', retained: false, outcome: 'succeeded', endedAt: END, review: true }
      ]
    })
    const r = buildRunReport(s, 'run_1', { spent: [{ sessionId: 'ses_worker_3', dispatchId: 'd1', input: 1, output: 1 }] })!
    const md = reportMarkdown(forPullRequest(r, ctx), 'en', { audience: 'pull-request' })
    expect(md.length).toBeGreaterThan(50)
    for (const id of ['ses_coord_1', 'ses_outside_2', 'ses_worker_3', 'ses_review_4', 'ses_']) expect(md).not.toContain(id)
  })

  it('scrubs a root alone to a dot, other paths to an ellipsis, a drive root in any case', () => {
    expect(scrubText('in D:/p now', { roots: ['D:/p'], prefixes: [], secrets: [] })).toBe('in . now')
    expect(scrubText('f:\\X\\y\\z.ts', { roots: ['F:/x'], prefixes: [], secrets: [] })).toBe('y/z.ts')
    expect(scrubText('C:\\Users\\k\\a and \\\\srv\\share\\f and ~/notes', ctx)).toBe('… and … and …')
  })

  it('takes a home folder with a space in its name whole, in either separator and any case, after the roots', () => {
    const home = { roots: [], prefixes: ['C:\\Users\\John Smith'], secrets: [] }
    expect(scrubText('see C:\\Users\\John Smith\\notes\\a.md now', home)).toBe('see … now')
    expect(scrubText('see c:/users/john smith/notes/a.md now', home)).toBe('see … now')
    expect(scrubText('/Users/John Smith/notes/a.md', { roots: [], prefixes: ['/Users/John Smith'], secrets: [] })).toBe('…')
    const worktree = { roots: ['C:\\Users\\John Smith\\wt\\run-1'], prefixes: ['C:\\Users\\John Smith', 'C:\\Users\\John Smith\\AppData\\Roaming\\astera'], secrets: [] }
    expect(scrubText('fix C:\\Users\\John Smith\\wt\\run-1\\src\\a.ts', worktree)).toBe('fix src/a.ts')
    expect(scrubText('log C:\\Users\\John Smith\\AppData\\Roaming\\astera\\host\\host.log', worktree)).toBe('log …')
  })

  it('names the Run by its ordinal only, never the Job', () => {
    const md = reportMarkdown(forPullRequest(report({ job: 'Secret plan for the launch' }), ctx), 'en', { audience: 'pull-request' })
    expect(md).not.toContain('Secret plan')
    expect(md).toContain('Run 3')
    expect(forPullRequest(report(), ctx).job).toBe('')
  })

  it('escapes angle brackets outside code spans, so no field hides another and the marker stays a comment', () => {
    const r = report({
      tasks: [task('Return Array<T> from `Array<T>` and <!-- hide')],
      caveats: [
        { kind: 'forced', task: 'T', by: 'person', reason: 'start <!-- here' },
        { kind: 'unstable', task: 'U', check: 'end --> there' }
      ]
    })
    const md = reportMarkdown(forPullRequest(r, ctx), 'en', { audience: 'pull-request' })
    const [marker, ...rest] = md.split('\n')
    expect(marker).toBe(RUN_REPORT_MARKER('run-1'))
    const body = rest.join('\n')
    expect(body).not.toContain('<!--')
    expect(body).not.toContain('-->')
    expect(body).toContain('Return Array&lt;T&gt; from `Array<T>` and &lt;!-- hide')
    expect(body).toContain('end --&gt; there')
  })

  it('cuts a caveat reason before it scrubs and wraps mentions, so no code span is cut open', () => {
    const reason = `${'x'.repeat(296)} @octocat and more`
    expect(reason.slice(297, 300)).toBe('@oc')
    const pr = forPullRequest(report({ caveats: [{ kind: 'forced', task: 'T', by: 'person', reason }] }), ctx)
    const line = caveatLine(pr.caveats[0], 'en')
    expect((line.match(/`/g) ?? []).length % 2).toBe(0)
    expect(line).not.toMatch(/(?<!`)@/)
    expect(line).not.toContain('and more')
  })

  it('takes a path after a colon and a file url whole, and keeps https links', () => {
    expect(scrubText('cwd:/Users/kim/x', ctx)).toBe('cwd:…')
    expect(scrubText('see file:///Users/kim/x now', ctx)).toBe('see … now')
    expect(scrubText('see file:///C:/Users/kim/x now', ctx)).toBe('see … now')
    expect(scrubText('see https://github.com/o/r/pull/7 and /api/users', ctx)).toBe('see https://github.com/o/r/pull/7 and /api/users')
  })

  it('keeps a route in a title', () => {
    expect(scrubText('serve /api/users', ctx)).toBe('serve /api/users')
  })

  it('keeps the pr url', () => {
    const md = reportMarkdown(forPullRequest(report(), ctx), 'en', { audience: 'pull-request' })
    expect(md).toContain('https://github.com/o/r/pull/12')
    expect(forPullRequest(report(), ctx).github?.pr?.url).toBe('https://github.com/o/r/pull/12')
  })

  it('starts with the marker and has no cost', () => {
    const md = reportMarkdown(forPullRequest(report(), ctx), 'en', { audience: 'pull-request', accounts })
    expect(md.startsWith(RUN_REPORT_MARKER('run-1'))).toBe(true)
    expect(RUN_REPORT_MARKER('run-1')).toBe('<!-- astera-run-report run=run-1 -->')
    expect(forPullRequest(report(), ctx).cost).toBeUndefined()
    expect(md).not.toContain('Work Account')
    expect(md).not.toContain('1,234,567')
  })
})

describe('mentions and long caveat text', () => {
  it('turns a mention into a code span in the pull request version only', () => {
    const r = report({ tasks: [task('ping @octocat and @org/team, mail a@b.com `@kept`')] })
    const pr = reportMarkdown(forPullRequest(r, ctx), 'en', { audience: 'pull-request' })
    expect(pr).toContain('`@octocat`')
    expect(pr).toContain('`@org/team`')
    expect(pr).toContain('`@kept`')
    expect(pr).not.toMatch(/(?<!`)@octocat/)
    expect(pr).not.toContain('@b.com')
    expect(pr).not.toContain('``')
    expect(reportMarkdown(r, 'en', { audience: 'app' })).toContain('ping @octocat and')
    expect(reportSlack(r, 'en', {})).toContain('ping @octocat and')
  })

  it('cuts a caveat reason at 300 characters in the pull request version', () => {
    const c: RunReportCaveat = { kind: 'forced', task: 'T', by: 'person', reason: 'r'.repeat(1000) }
    const line = caveatLine(forPullRequest(report({ caveats: [c] }), ctx).caveats[0], 'en')
    expect(line).toContain('r'.repeat(CAVEAT_TEXT_MAX) + '…')
    expect(line).not.toContain('r'.repeat(CAVEAT_TEXT_MAX + 1))
  })

  it('cuts caveats from the end when they alone pass the comment cap', () => {
    const caveats: RunReportCaveat[] = Array.from({ length: 200 }, (_, i) => ({
      kind: 'forced' as const,
      task: `T${i}`,
      by: 'person' as const,
      reason: 'z'.repeat(300)
    }))
    const md = reportMarkdown(forPullRequest(report({ caveats }), ctx), 'en', { audience: 'pull-request' })
    expect(md.length).toBeLessThanOrEqual(PR_COMMENT_MAX)
    const kept = md.split('\n').filter((l) => l.startsWith('- Task T')).length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(200)
    expect(md).toContain(`and ${200 - kept} more caveats; see the Run in Astera`)
  })
})

describe('the sentences', () => {
  it('shows caveats on every surface', () => {
    const r = report({ caveats: caveatsOfEveryKind })
    const app = reportMarkdown(r, 'en', { audience: 'app', accounts })
    const pr = reportMarkdown(forPullRequest(r, ctx), 'en', { audience: 'pull-request' })
    const slack = reportSlack(r, 'en', { accounts })
    for (const c of caveatsOfEveryKind) {
      const line = caveatLine(c, 'en')
      expect(app).toContain(line)
      expect(pr).toContain(line)
      expect(slack).toContain(line)
    }
  })

  it('never reads a Task with no checks and no review as passed', () => {
    const line = taskLine(task('Bare', { checks: [] }), 'en')
    expect(line).toContain('Nothing checked this Task’s work')
    expect(line).not.toMatch(/passed/i)
  })

  it('says at least for capped counts and tokens', () => {
    expect(checkLine({ name: 'unit', final: 'failed', failedRounds: 8, atLeast: true }, 'en')).toContain('at least 8')
    const g = report().github!
    expect(githubLine(report({ github: { ...g, ciFailedRounds: 4, ciFailedAtLeast: true } }), 'en')).toContain('at least 4')
    expect(githubLine(report({ github: { ...g, reruns: { astera: 5, person: 0, atLeast: true } } }), 'en')).toContain('at least 5')
    expect(costLine(report(), accounts, 'en')).toContain('at least 1,234,567')
  })

  it('names the head of merge-ready, short', () => {
    const line = githubLine(report(), 'en')
    expect(line).toContain('abc1234')
    expect(line).not.toContain('abc1234def')
  })

  it('names why merge-ready was withheld in the GitHub words', () => {
    const g = { ...report().github!, mergeReady: undefined, withheld: 'ci-failed' as const }
    expect(githubLine(report({ github: g }), 'en')).toContain('Not merge-ready: ')
  })

  it('says the waits are the workers’ and counts them', () => {
    const line = interruptionsLine(report({ interruptions: { limitWaits: 2, waitedMs: 65 * 60_000, switches: 1, restarts: 3 } }), 'en')
    expect(line).toContain('Worker')
    expect(line).toContain('1h 5m')
  })

  it('words the groups and the no person sentence', () => {
    expect(interventionsLine(report(), 'en')).toContain('No person answered a question or forced a completion')
    const r = report({
      interventions: { answers: { person: 1, coordinator: 0, astera: 0, unknown: 2 }, forced: [{ task: 'T', by: 'unknown' }], noPersonSteppedIn: false }
    })
    const line = interventionsLine(r, 'en')
    expect(line).not.toContain('No person answered')
    expect(line).toContain('unknown')
  })

  it('words the outcome and the other lines in Korean', () => {
    expect(outcomeLine(report(), 'ko')).toContain('42분')
    expect(reviewLine({ rounds: 2, passed: false, blocking: ['A', 'B'] }, 'ko')).toContain('통과를 막은 지적: A, B.')
    expect(outcomeLine(report({ endedAt: '2026-11-15T02:05:00.000Z' }), 'ko')).toContain('1시간 5분')
  })

  it('says a Task’s status as a sentence', () => {
    expect(taskLine(task('A'), 'ko')).toMatch(/^A: 완료됐습니다\. /)
    expect(taskLine(task('A', { status: 'failed' }), 'ko')).toMatch(/^A: 실패했습니다\. /)
    expect(taskLine(task('A'), 'ko')).not.toContain('상태는')
  })

  it('says how many times a worker tried, that no worker took a Task, and nothing of attempts for the lifecycle Task', () => {
    expect(taskLine(task('A', { attempts: 2 }), 'ko')).toContain('2번 시도했습니다.')
    const none = taskLine(task('A', { attempts: 0 }), 'ko')
    expect(none).toContain('맡은 워커가 없었습니다.')
    expect(none).not.toContain('0번')
    expect(taskLine(task('A', { attempts: 0 }), 'en')).toContain('No worker took it.')
    const life = task('GitHub 전달', { lifecycle: true, attempts: 0 })
    for (const lang of ['ko', 'en'] as const) {
      expect(taskLine(life, lang)).not.toMatch(/0번|시도|Attempts|No worker/)
    }
    expect(taskLine({ ...life, attempts: 1, repairs: { check: 1, review: 0 } }, 'ko')).toContain('검사 실패로 1번 고쳤습니다.')
  })

  it('names only the repairs that happened', () => {
    const ko = (check: number, review: number): string => taskLine(task('A', { repairs: { check, review } }), 'ko')
    expect(ko(1, 0)).toContain('검사 실패로 1번 고쳤습니다.')
    expect(ko(1, 0)).not.toContain('검토')
    expect(ko(0, 1)).toContain('검토 지적으로 1번 고쳤습니다.')
    expect(ko(2, 1)).toContain('검사 실패로 2번, 검토 지적으로 1번 고쳤습니다.')
    expect(ko(0, 0)).not.toContain('고쳤습니다')
  })

  it('names only the reruns that happened', () => {
    const g = report().github!
    const line = (astera: number, person: number, atLeast?: true): string =>
      githubLine(report({ github: { ...g, reruns: { astera, person, ...(atLeast ? { atLeast } : {}) } } }), 'ko')
    expect(line(1, 0)).toContain('Astera 가 CI 를 1번 다시 돌렸습니다.')
    expect(line(1, 0)).not.toContain('사람')
    expect(line(0, 2)).toContain('사람이 CI 를 2번 다시 돌렸습니다.')
    expect(line(2, 1)).toContain('Astera 가 CI 를 2번, 사람이 1번 다시 돌렸습니다.')
    expect(line(5, 0, true)).toContain('Astera 가 CI 를 최소 5번 다시 돌렸습니다.')
    expect(line(0, 0)).not.toContain('다시 돌렸습니다')
  })

  it('names only the groups that answered', () => {
    const r = report({ interventions: { answers: { person: 0, coordinator: 1, astera: 0, unknown: 0 }, forced: [], noPersonSteppedIn: true } })
    const ko = interventionsLine(r, 'ko')
    expect(ko).toContain('코디네이터가 질문 1개에 답했습니다.')
    expect(ko).not.toMatch(/사람 0|알 수 없음 0|Astera 0/)
    expect(ko).toContain('사람이 질문에 답하거나 완료를 강제한 일은 없습니다.')
    const en = interventionsLine(r, 'en')
    expect(en).not.toMatch(/person 0|unknown 0|Astera 0/)
  })

  it('says how many CI rounds failed, never that they were repaired (I-3)', () => {
    const s = stateOf({
      tasks: [
        {
          kind: 'lifecycle',
          title: 'GitHub 전달',
          status: 'failed',
          consecutiveFailures: FAILURE_LIMIT,
          validateConfigIds: ['github:ci'],
          checkHistory: { 'github:ci': ['failed', 'failed'] }
        } as Partial<Task>
      ]
    })
    const r = buildRunReport(s, 'run_1')!
    expect(r.outcome).toBe('failed')
    const en = githubLine(r, 'en')
    expect(en).toContain('2')
    expect(en).toMatch(/fail/i)
    expect(en).not.toMatch(/repair/i)
    const ko = githubLine(r, 'ko')
    expect(ko).toContain('CI 가 2번 실패했습니다.')
    expect(ko).not.toContain('고쳤습니다')
  })

  it('names the lifecycle Task in the reader’s language, in its line and its caveats (I-2)', () => {
    const s = stateOf({
      tasks: [
        {
          kind: 'lifecycle',
          title: 'GitHub 전달',
          validateConfigIds: ['github:ci', 'lint'],
          checks: [{ configId: 'lint', name: 'lint', status: 'not-run', skipped: true }, { configId: 'github:ci', name: 'CI', status: 'passed', outsideSandbox: true }],
          completionOverride: { reason: 'ship', at: T0 },
          completionOverrideBy: 'person'
        } as Partial<Task>
      ]
    })
    const r = buildRunReport(s, 'run_1')!
    expect(r.caveats.length).toBeGreaterThanOrEqual(3)
    const pr = forPullRequest(r, ctx)
    for (const x of [r, pr]) {
      const line = taskLine(x.tasks[0], 'en')
      expect(line.startsWith('Carry to GitHub: ')).toBe(true)
      expect(line).not.toMatch(HANGUL)
      for (const c of x.caveats) {
        expect(caveatLine(c, 'en')).toContain('Carry to GitHub')
        expect(caveatLine(c, 'en')).not.toMatch(HANGUL)
      }
    }
    expect(taskLine(r.tasks[0], 'ko').startsWith('GitHub 전달: ')).toBe(true)
  })

  it('lists the checks that ran outside the sandbox in one caveat', () => {
    expect(caveatLine({ kind: 'outside-sandbox', task: 'T', checks: ['e2e', 'lint'] }, 'en')).toContain('e2e, lint')
    expect(caveatLine({ kind: 'outside-sandbox', task: 'T', checks: ['e2e', 'lint'] }, 'ko')).toContain('e2e, lint')
  })

  it('says when the Run started and ended in the app version only', () => {
    const at = (iso: string): string => `<${iso.slice(11, 16)}>`
    const line = timesLine(report(), 'en', at)
    expect(line).toContain('<01:00>')
    expect(line).toContain('<01:42>')
    expect(reportMarkdown(report(), 'en', { audience: 'app', at })).toContain(line)
    const plain = timesLine(report(), 'en', (iso) => new Date(iso).toLocaleString('en'))
    expect(reportMarkdown(report(), 'en', { audience: 'app' })).toContain(plain)
    expect(reportMarkdown(forPullRequest(report(), ctx), 'en', { audience: 'pull-request' })).not.toContain(plain)
    expect(reportSlack(report(), 'en', {})).not.toContain(plain)
  })

  it('names a long objective on one short line and keeps it out of the pull request (C-1)', () => {
    const paragraph = (i: number): string => `Objectivo paragraph ${i} says what the Run must do in many words, zqx${i}.`
    let objective = ''
    for (let i = 0; objective.length < 20_000; i++) objective += `${paragraph(i)}\n\n`
    const r = buildRunReport(stateOf({ objective, tasks: [{}] }), 'run_1')!
    expect(r.job).not.toContain('\n')
    expect(Array.from(r.job).length).toBeLessThanOrEqual(61)
    expect(r.job.endsWith('…')).toBe(true)
    expect(outcomeLine(r, 'en')).toContain(r.job)
    const md = reportMarkdown(forPullRequest(r, ctx), 'en', { audience: 'pull-request' })
    expect(md).not.toContain('Objectivo')
    expect(md).not.toContain('zqx')
    expect(md.length).toBeLessThanOrEqual(PR_COMMENT_MAX)
    expect(reportSlack(r, 'en', {}).length).toBeLessThanOrEqual(SLACK_POST_MAX)
  })
})

describe('a long Run', () => {
  const caveats: RunReportCaveat[] = Array.from({ length: 12 }, (_, i) => ({
    kind: 'forced' as const,
    task: `Task ${i}`,
    by: 'person' as const,
    reason: `reason ${i} ${'x'.repeat(240)}`
  }))
  const tasks = Array.from({ length: 300 }, (_, i) => task(`Task number ${i} ${'y'.repeat(40)}`))

  it('cuts Task rows in the comment and keeps every caveat', () => {
    const md = reportMarkdown(forPullRequest(report({ tasks, caveats }), ctx), 'en', { audience: 'pull-request' })
    expect(md.length).toBeLessThanOrEqual(PR_COMMENT_MAX)
    for (const c of caveats) expect(md).toContain(caveatLine(c, 'en'))
    const rows = md.split('\n').filter((l) => l.startsWith('- Task number')).length
    expect(rows).toBeLessThan(300)
    expect(md).toContain(`and ${300 - rows} more Tasks`)
  })

  it('cuts Task rows in Slack first, then caveats beyond ten', () => {
    const slack = reportSlack(report({ tasks, caveats }), 'en', {})
    expect(slack.length).toBeLessThanOrEqual(SLACK_POST_MAX)
    expect(slack).toContain('and 300 more Tasks')
    expect(slack).toContain(caveatLine(caveats[9], 'en'))
    expect(slack).not.toContain(caveatLine(caveats[10], 'en'))
    expect(slack).toContain('and 2 more')
    expect(reportSlack(report({ tasks, caveats }), 'ko', {})).toContain('주의할 점 2건 더')
  })

  it('cuts ten full-length caveats from the end until the post fits', () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({
      kind: 'forced' as const,
      task: `Task ${i}`,
      by: 'person' as const,
      reason: `reason ${i} ${'x'.repeat(300)}`
    }))
    const r = report({
      tasks,
      caveats: ten,
      interruptions: { limitWaits: 2, waitedMs: 65 * 60_000, switches: 1, restarts: 1 },
      interventions: { answers: { person: 1, coordinator: 0, astera: 0, unknown: 0 }, forced: [{ task: 'Task 0', by: 'person' }], noPersonSteppedIn: false }
    })
    const slack = reportSlack(r, 'en', { accounts })
    expect(slack.length).toBeLessThanOrEqual(SLACK_POST_MAX)
    const kept = slack.split('\n').filter((l) => l.startsWith('• Task ') && l.includes('Reason:')).length
    expect(kept).toBeGreaterThan(0)
    expect(kept).toBeLessThan(10)
    expect(slack).toContain(`and ${10 - kept} more caveats`)
  })

  it('cuts only the Task rows when the caveats fit', () => {
    const slack = reportSlack(report({ tasks, caveats: caveats.slice(0, 2) }), 'en', {})
    expect(slack.length).toBeLessThanOrEqual(SLACK_POST_MAX)
    expect(slack).toContain(caveatLine(caveats[1], 'en'))
    expect(slack).not.toContain('and 0 more')
  })
})

describe('cost', () => {
  it('appears in the app and Slack only', () => {
    const r = report()
    expect(reportMarkdown(r, 'en', { audience: 'app', accounts })).toContain('Work Account')
    expect(reportSlack(r, 'en', { accounts })).toContain('Work Account')
    expect(reportMarkdown(forPullRequest(r, ctx), 'en', { audience: 'pull-request', accounts })).not.toContain('Work Account')
  })

  it('is empty without cost', () => {
    expect(costLine(report({ cost: undefined }), accounts, 'en')).toBe('')
  })
})

describe('slack', () => {
  it('has one bold outcome line, escaped', () => {
    const slack = reportSlack(report({ job: 'a <!channel> & b' }), 'en', {})
    expect(slack.split('\n')[0]).toMatch(/^\*.*\*$/)
    expect(slack).toContain('&lt;!channel&gt; &amp; b')
    expect(slack).not.toContain('<!channel>')
  })
})
