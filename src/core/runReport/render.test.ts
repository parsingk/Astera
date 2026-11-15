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
  reportMarkdown,
  reportSlack
} from './render'
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
  { kind: 'outside-sandbox', task: 'T3', check: 'e2e' },
  { kind: 'review-outside-sandbox', task: 'T4' },
  { kind: 'policy-changed', task: 'T5' },
  { kind: 'suspicious-files', task: 'T6', count: 2 },
  { kind: 'unstable', task: 'T7', check: 'unit' }
]

const ctx = { roots: [], secrets: [] }
const accounts = new Map([['acc-1', 'Work Account']])

describe('the pull request version', () => {
  it('leaks nothing', () => {
    const r = report({
      tasks: [task('fix F:\\astera-work\\worktrees\\run-x\\src\\a.ts for claude2@anipen.com about ab')],
      caveats: [{ kind: 'forced', task: 'T', by: 'person', reason: 'see /Users/kim/notes.md and Work Account' }]
    })
    const scrub = { roots: ['F:\\astera-work\\worktrees\\run-x', 'D:/p'], secrets: ['Work Account', 'claude2@anipen.com', 'ab'] }
    const md = reportMarkdown(forPullRequest(r, scrub), 'en', { audience: 'pull-request', accounts })
    expect(md).toContain('src/a.ts')
    expect(md).not.toContain('F:')
    expect(md).not.toContain('/Users/')
    expect(md).not.toContain('@anipen.com')
    expect(md).not.toContain('Work Account')
    expect(md).not.toMatch(/\d{6,}|1,234,567/)
    expect(md).not.toContain('ses_')
    expect(md).toContain('about ab')
  })

  it('scrubs a root alone to a dot, other paths to an ellipsis, a drive root in any case', () => {
    expect(scrubText('in D:/p now', { roots: ['D:/p'], secrets: [] })).toBe('in . now')
    expect(scrubText('f:\\X\\y\\z.ts', { roots: ['F:/x'], secrets: [] })).toBe('y/z.ts')
    expect(scrubText('C:\\Users\\k\\a and \\\\srv\\share\\f and ~/notes', ctx)).toBe('… and … and …')
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

  it('cuts a caveat reason at 300 characters', () => {
    const c: RunReportCaveat = { kind: 'forced', task: 'T', by: 'person', reason: 'r'.repeat(1000) }
    const line = caveatLine(c, 'en')
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
    expect(reviewLine({ rounds: 2, passed: false, blocking: ['A', 'B'] }, 'ko')).toContain('A')
    expect(outcomeLine(report({ endedAt: '2026-11-15T02:05:00.000Z' }), 'ko')).toContain('1시간 5분')
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
